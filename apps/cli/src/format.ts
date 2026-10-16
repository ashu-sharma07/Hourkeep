import type {
  ChangeOutcome,
  DataOf,
  DnsStatus,
  PendingView,
  PublicChallengeWire,
  StatsData,
} from '@hourkeep/ipc';

/** "3s ago", "5m ago", ... relative to `now`. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "4m 12s", "45s", "1h 5m": a span of time. */
export function span(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

const when = (ts: number | null, now: number): string =>
  ts === null ? 'never' : `${new Date(ts).toISOString()} (${ago(ts, now)})`;

const n = (x: number): string => x.toLocaleString('en-US');

/** The DNS layer in one or two lines, saying plainly when it is not doing its job. */
export function formatDns(d: DnsStatus): string[] {
  if (!d.enabled)
    return [
      'DNS layer:         off (start hourkeepd with --dns to block whole domains such as *.googlevideo.com)',
    ];
  if (d.listening === null)
    return [`DNS layer:         on, but NOT running: ${d.problem ?? 'unknown reason'}`];
  const how = `${d.listening}, ${d.strategy ?? 'unknown method'}, ${d.upstreamCount} upstream${d.upstreamCount === 1 ? '' : 's'}`;
  if (d.inEffect === false)
    return [
      `DNS layer:         configured (${how}) but NOT in effect`,
      `                   ${d.problem ?? ''}`.trimEnd(),
    ];
  return [`DNS layer:         on (${how})${d.inEffect ? ', in effect' : ''}`];
}

export function formatStatus(d: DataOf<'status'>, now: number): string {
  return [
    `hourkeepd ${d.daemonVersion} (protocol ${d.protocol})`,
    `Mode:              ${d.dryRun ? 'dry run (nothing is written to the system)' : 'enforcing'}`,
    `Rules:             ${d.ruleCount}`,
    `Blocked domains:   ${d.blockedDomainCount} right now (hosts layer)`,
    ...formatDns(d.dns),
    ...(d.dns.enabled ? [`Blocked today:     ${n(d.dns.blockedToday)} lookups`] : []),
    `Pending changes:   ${d.pendingCount}${d.pendingCount > 0 ? '  (see: hourkeep pending)' : ''}`,
    `Passes today:      ${d.passesUsedToday} of ${d.passesPerDay} used`,
    `Last check:        ${when(d.lastReconcileAt, now)}`,
    `Tamper events:     ${d.tamperCount}${d.lastTamperAt === null ? '' : `, last ${when(d.lastTamperAt, now)}`}`,
    `You are:           ${d.callerUid === null ? 'uid unknown' : `uid ${d.callerUid}`}`,
  ].join('\n');
}

export function formatList(d: DataOf<'list'>, now: number): string {
  const out: string[] = [];
  if (d.rules.length === 0)
    out.push('No rules. Block something with: hourkeep block <domain|group>');
  else {
    out.push('Rules:');
    for (const r of d.rules) {
      const state =
        r.passEndsAt !== null
          ? `pass running, ${span(r.passEndsAt - now)} left`
          : r.blockingNow
            ? 'blocking now'
            : 'not blocking now (outside its schedule)';
      out.push(`  ${r.target}  (${r.kind})  ${state}`);
      out.push(`      schedule: ${r.scheduleText}`);
      out.push(
        `      daily limit: ${r.dailyLimitMinutes === null ? 'none' : `${r.dailyLimitMinutes} pass minutes`}`,
      );
    }
    out.push(`${d.blockedDomains.length} domains blocked right now.`);
  }
  out.push('', 'Available groups:');
  for (const g of d.groups) out.push(`  ${g.id.padEnd(20)} ${g.name}, ${g.domainCount} domains`);
  return out.join('\n');
}

/** The hosts layer cannot do everything; say so whenever a group is blocked. */
export const GROUP_LIMITS_NOTE =
  'Note: this layer uses the hosts file. It cannot block wildcard subdomains (such as *.googlevideo.com) and browsers using DNS-over-HTTPS may bypass it.';

export function formatBlock(d: DataOf<'block'>): string {
  const what = `${d.rule.target} (${d.rule.kind})`;
  const head = d.added ? `Blocked ${what}.` : `${what} was already blocked.`;
  const lines = [`${head} ${d.blockedDomainCount} domains are blocked right now.`];
  if (d.rule.kind === 'group') lines.push(GROUP_LIMITS_NOTE);
  return lines.join('\n');
}

export function formatPending(v: PendingView, now: number): string {
  const lines = [`#${v.id}  ${v.summary}`];
  if (v.phase === 'cooldown') {
    lines.push(`    cooldown: ${span(v.cooldownEndsAt - now)} left, then you take a challenge`);
  } else {
    lines.push(
      `    ready: confirm within ${span(v.expiresAt - now)} (${v.challengeIssued ? `challenge issued, ${v.attemptsLeft} attempts left` : 'no challenge yet'})`,
    );
  }
  return lines.join('\n');
}

export function formatPendingList(changes: readonly PendingView[], now: number): string {
  if (changes.length === 0) return 'No pending changes.';
  return [
    ...changes.map((c) => formatPending(c, now)),
    '',
    'Confirm with: hourkeep confirm <id>.  Cancel with: hourkeep pending cancel <id>.',
  ].join('\n');
}

/** What to tell the user after asking for a change. */
export function formatOutcome(o: ChangeOutcome, now: number): string {
  switch (o.status) {
    case 'applied':
    case 'noop':
      return o.message;
    case 'pending': {
      const c = o.change;
      const next =
        c.phase === 'cooldown'
          ? `Wait ${span(c.cooldownEndsAt - now)}, then run: hourkeep confirm ${c.id}   (or: hourkeep confirm ${c.id} --wait)`
          : `It is ready now. Run: hourkeep confirm ${c.id}`;
      return [
        'This loosens protection, so it does not happen yet.',
        formatPending(c, now),
        next,
        `Changed your mind? hourkeep pending cancel ${c.id}`,
      ].join('\n');
    }
  }
}

export function formatChallenge(c: PublicChallengeWire): string {
  const d = c.data;
  const lines = [c.instructions];
  switch (d.kind) {
    case 'typing':
      lines.push('', `    ${d.text}`);
      break;
    case 'arithmetic':
      lines.push('', ...d.problems.map((p, i) => `    ${i + 1}) ${p}`));
      break;
    case 'reflection':
      lines.push('', `    ${d.question}`);
      break;
  }
  return lines.join('\n');
}

export function formatSettings(s: DataOf<'settings_get'>): string {
  return [
    `cooldown:        ${s.cooldownSeconds / 60} minutes`,
    `passes-per-day:  ${s.passesPerDay}`,
    `pass-minutes:    ${s.passMinutes}`,
    `timezone:        ${s.timezone}`,
  ].join('\n');
}

// ---- stats ---------------------------------------------------------------------------------

/** "6d 3h", "12m", "45s": a length of time from whole seconds. */
export function dur(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** A bar of at most `width` blocks, scaled so that `max` fills it. A non-zero value always shows. */
export function bar(value: number, max: number, width = 24): string {
  if (value <= 0 || max <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)));
}

const BLOCKS = '▁▂▃▄▅▆▇█';

/** Hour-of-day histogram as a one-line sparkline with an hour ruler beneath it. */
export function hourChart(hours: readonly number[]): string[] {
  const max = Math.max(...hours, 0);
  const line = hours
    .map((v) =>
      v === 0 || max === 0 ? '·' : (BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))] as string),
    )
    .join('');
  const ruler = hours.map((_, i) => (i % 3 === 0 ? String(i).padStart(2, '0')[0] : ' ')).join('');
  const ruler2 = hours.map((_, i) => (i % 3 === 0 ? String(i).padStart(2, '0')[1] : ' ')).join('');
  return [line, ruler, ruler2];
}

function rangeLabel(d: StatsData): string {
  switch (d.range) {
    case 'today':
      return `today (${d.to})`;
    case 'week':
      return `last 7 days (${d.from} to ${d.to})`;
    case 'month':
      return `last 30 days (${d.from} to ${d.to})`;
    case 'all':
      return d.from ? `everything since ${d.from}` : 'everything so far';
  }
}

const name = (r: { kind: string; target: string }): string => `${r.target} (${r.kind})`;

export function formatStats(d: StatsData): string {
  const out: string[] = [`Hourkeep stats: ${rangeLabel(d)}, times in ${d.timezone}`, ''];

  out.push('Blocked lookups');
  if (!d.dns.enabled) {
    out.push('  The DNS layer is off, so lookups are not counted. Start hourkeepd with --dns.');
  } else {
    out.push(
      `  ${n(d.dns.blocked)} blocked, ${n(d.dns.forwarded)} allowed and forwarded (names are never recorded)`,
    );
    out.push(
      '  One page load makes several lookups (A, AAAA, HTTPS), so this counts lookups, not visits.',
    );
    if (d.dns.byRule.length > 0) {
      const max = Math.max(...d.dns.byRule.map((r) => r.blocked));
      out.push('', '  By rule');
      for (const r of d.dns.byRule)
        out.push(
          `    ${name(r).padEnd(28)} ${String(n(r.blocked)).padStart(8)}  ${bar(r.blocked, max, 20)}`,
        );
    }
    if (d.dns.bySuffix.length > 0) {
      out.push('', '  Most blocked domains (everything under them is counted here)');
      for (const s of d.dns.bySuffix.slice(0, 10))
        out.push(`    ${s.suffix.padEnd(28)} ${String(n(s.blocked)).padStart(8)}`);
    }
    if (d.dns.blocked > 0) {
      out.push(
        '',
        '  By hour of day (local time)',
        ...hourChart(d.dns.hourOfDay).map((l) => `    ${l}`),
      );
    }
    if (d.dns.daily.length > 1) {
      const max = Math.max(...d.dns.daily.map((x) => x.blocked));
      out.push('', '  By day');
      for (const x of d.dns.daily.slice(-14))
        out.push(`    ${x.day}  ${String(n(x.blocked)).padStart(8)}  ${bar(x.blocked, max, 20)}`);
    }
  }

  out.push('', 'Time under each rule (only while hourkeepd was running)');
  if (d.time.rules.length === 0) out.push('  Nothing recorded yet.');
  for (const r of d.time.rules) {
    out.push(`  ${name(r)}`);
    out.push(
      `    blocking ${dur(r.blockingSeconds)}, on a pass ${dur(r.passSeconds)}, outside its schedule ${dur(r.scheduledOffSeconds)}`,
    );
  }
  if (d.time.cooldownSeconds > 0)
    out.push(`  Waiting out a cooldown: ${dur(d.time.cooldownSeconds)}`);

  const f = d.friction;
  out.push('', 'Friction');
  out.push(
    `  Changes asked for: ${f.requested}. Applied: ${f.applied}, cancelled: ${f.cancelled}, expired unanswered: ${f.expired}. Passes started: ${f.passesStarted}.`,
  );
  for (const c of f.byChange)
    out.push(`    ${c.kind.padEnd(14)} requested ${c.requested}, applied ${c.applied}`);
  if (f.challenges.length > 0) {
    out.push('  Challenges');
    for (const c of f.challenges) {
      out.push(
        `    ${c.kind.padEnd(11)} issued ${c.issued}, solved ${c.solved}, wrong answers ${c.wrongAnswers}, solve rate ${c.solveRate === null ? 'n/a' : `${c.solveRate}%`}`,
      );
    }
  }

  const s = d.streak;
  out.push('', 'Streak');
  out.push(
    s.totalDays === 0
      ? '  No protected days yet.'
      : `  ${s.current} clean day${s.current === 1 ? '' : 's'} in a row, longest ${s.longest}. Clean days: ${s.cleanDays} of ${s.totalDays}.`,
  );
  out.push(
    '  A clean day: hourkeepd ran with at least one rule, nothing tampered with, no clock changes, no protection loosened. Passes do not count against you.',
  );

  const t = d.tamper;
  out.push('', 'Tamper');
  out.push(
    t.count === 0 && t.clockJumps === 0
      ? '  None.'
      : `  ${t.count} event${t.count === 1 ? '' : 's'}${t.byDay.length ? ` (${t.byDay.map((x) => `${x.day}: ${x.count}`).join(', ')})` : ''}. System clock changes: ${t.clockJumps}.`,
  );
  return out.join('\n');
}
