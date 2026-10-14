import type { ChangeOutcome, DataOf, PendingView, PublicChallengeWire } from '@hourkeep/ipc';

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

export function formatStatus(d: DataOf<'status'>, now: number): string {
  return [
    `hourkeepd ${d.daemonVersion} (protocol ${d.protocol})`,
    `Mode:              ${d.dryRun ? 'dry run (nothing is written to the system)' : 'enforcing'}`,
    `Rules:             ${d.ruleCount}`,
    `Blocked domains:   ${d.blockedDomainCount} right now`,
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
