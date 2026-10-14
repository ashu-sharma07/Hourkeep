// Drives real Chromium and Firefox (normal, private/incognito and guest windows) at YouTube
// and at a control site, and reports what each can reach.
//
//   node check.mjs baseline   expect everything reachable (proves the browsers and network work)
//   node check.mjs blocked    expect YouTube unreachable in every window, control still reachable
//   node check.mjs doh        probe: Firefox with DNS-over-HTTPS forced (a known bypass, reported not asserted)
import { chromium, firefox } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const phase = process.argv[2] ?? 'blocked';
const YOUTUBE = [
  'https://www.youtube.com/',
  'https://m.youtube.com/',
  'https://music.youtube.com/',
  'https://youtu.be/dQw4w9WgXcQ',
];
const CONTROL = 'https://example.org/';
const TIMEOUT = 20_000;

/** Each entry opens one kind of browser window and returns { page-maker, close }. */
const windows = [
  {
    browser: 'chromium',
    mode: 'normal window',
    open: (dir) => chromium.launchPersistentContext(dir),
  },
  {
    browser: 'chromium',
    mode: 'incognito window',
    open: (dir) => chromium.launchPersistentContext(dir, { args: ['--incognito'] }),
  },
  {
    browser: 'chromium',
    mode: 'guest window',
    open: (dir) => chromium.launchPersistentContext(dir, { args: ['--guest'] }),
  },
  {
    browser: 'firefox',
    mode: 'normal window',
    open: (dir) => firefox.launchPersistentContext(dir),
  },
  {
    browser: 'firefox',
    mode: 'private window',
    open: (dir) =>
      firefox.launchPersistentContext(dir, {
        firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true },
      }),
  },
];
if (phase === 'doh') {
  // Not a threat the hosts layer claims to stop, but we should know what actually happens.
  const trr = {
    'network.trr.mode': 3, // DoH only, no fallback to the system resolver
    'network.trr.uri': 'https://mozilla.cloudflare-dns.com/dns-query',
    'network.trr.bootstrapAddr': '104.16.249.249',
  };
  windows.length = 0;
  windows.push(
    {
      browser: 'firefox',
      mode: 'DoH forced, default prefs',
      open: (dir) => firefox.launchPersistentContext(dir, { firefoxUserPrefs: trr }),
    },
    {
      browser: 'firefox',
      mode: 'DoH forced + network.trr.exclude-etc-hosts=false',
      open: (dir) =>
        firefox.launchPersistentContext(dir, {
          firefoxUserPrefs: { ...trr, 'network.trr.exclude-etc-hosts': false },
        }),
    },
  );
}

async function visit(context, url) {
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
    return {
      url,
      reached: true,
      detail: `HTTP ${res?.status() ?? '?'} "${(await page.title()).slice(0, 40)}"`,
    };
  } catch (e) {
    const m = /(net::ERR_\w+|NS_ERROR_\w+|Timeout \d+ms exceeded)/.exec(String(e));
    return { url, reached: false, detail: m ? m[1] : String(e).split('\n')[0].slice(0, 80) };
  } finally {
    await page.close().catch(() => {});
  }
}

const rows = [];
let failures = 0;
for (const w of windows) {
  const dir = mkdtempSync(join(tmpdir(), 'hk-br-'));
  let context;
  try {
    context = await w.open(dir);
  } catch (e) {
    console.log(`SKIP  ${w.browser} / ${w.mode}: cannot launch (${String(e).split('\n')[0]})`);
    failures++;
    continue;
  }
  const control = await visit(context, CONTROL);
  let dohLine = '';
  if (phase === 'doh') {
    // Self-check: Cloudflare's help page reports whether this browser really resolves via DoH.
    const page = await context.newPage();
    try {
      await page.goto('https://one.one.one.one/help/', { timeout: TIMEOUT, waitUntil: 'load' });
      await page.waitForTimeout(4000);
      const line = (await page.innerText('body'))
        .split('\n')
        .find((l) => /Using DNS over HTTPS/.test(l));
      dohLine = line ? line.replace(/\s+/g, ' ') : 'no DoH line found';
    } catch (e) {
      dohLine = 'DoH self-check failed: ' + String(e).split('\n')[0];
    }
    await page.close().catch(() => {});
  }
  const yt = [];
  for (const u of YOUTUBE) yt.push(await visit(context, u));
  await context.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });

  const ytReached = yt.filter((r) => r.reached).length;
  let ok;
  if (phase === 'baseline') ok = control.reached && ytReached === YOUTUBE.length;
  else if (phase === 'blocked') ok = control.reached && ytReached === 0;
  else ok = true; // doh: informational
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${w.browser} / ${w.mode}  (control ${control.reached ? 'reachable' : 'UNREACHABLE: ' + control.detail})`,
  );
  for (const r of yt)
    console.log(`        ${r.reached ? 'REACHED  ' : 'blocked  '} ${r.url}  ${r.detail}`);
  if (dohLine) console.log(`        self-check: ${dohLine}`);
  rows.push({ ...w, control, yt, dohLine });
}
if (phase === 'doh') {
  for (const r of rows) {
    const n = r.yt.filter((x) => x.reached).length;
    console.log(`INFO  ${r.mode}: ${n}/${YOUTUBE.length} YouTube URLs reachable (${r.dohLine})`);
  }
  process.exit(0);
}
console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILED'} (${phase})`);
process.exit(failures === 0 ? 0 : 1);
