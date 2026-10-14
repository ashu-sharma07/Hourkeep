import type { DataOf } from '@hourkeep/ipc';

/** "3s ago", "5m ago", ... relative to `now`. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const when = (ts: number | null, now: number): string =>
  ts === null ? 'never' : `${new Date(ts).toISOString()} (${ago(ts, now)})`;

export function formatStatus(d: DataOf<'status'>, now: number): string {
  return [
    `hourkeepd ${d.daemonVersion} (protocol ${d.protocol})`,
    `Mode:              ${d.dryRun ? 'dry run (nothing is written to the system)' : 'enforcing'}`,
    `Rules:             ${d.ruleCount}`,
    `Blocked domains:   ${d.blockedDomainCount}`,
    `Last check:        ${when(d.lastReconcileAt, now)}`,
    `Tamper events:     ${d.tamperCount}${d.lastTamperAt === null ? '' : `, last ${when(d.lastTamperAt, now)}`}`,
    `You are:           ${d.callerUid === null ? 'uid unknown' : `uid ${d.callerUid}`}`,
  ].join('\n');
}

export function formatList(d: DataOf<'list'>): string {
  const out: string[] = [];
  if (d.rules.length === 0)
    out.push('No rules. Block something with: hourkeep block <domain|group>');
  else {
    out.push('Rules:');
    for (const r of d.rules) {
      out.push(`  ${r.target.padEnd(28)} ${r.kind}  since ${new Date(r.createdAt).toISOString()}`);
    }
    out.push(`${d.blockedDomains.length} domains blocked in total.`);
  }
  out.push('', 'Available groups:');
  for (const g of d.groups) out.push(`  ${g.id.padEnd(28)} ${g.name}, ${g.domainCount} domains`);
  return out.join('\n');
}

/** The hosts layer cannot do everything; say so whenever a group is blocked. */
export const GROUP_LIMITS_NOTE =
  'Note: this layer uses the hosts file. It cannot block wildcard subdomains (such as *.googlevideo.com) and browsers using DNS-over-HTTPS bypass it.';

export function formatBlock(d: DataOf<'block'>): string {
  const what = `${d.rule.target} (${d.rule.kind})`;
  const head = d.added ? `Blocked ${what}.` : `${what} was already blocked.`;
  const lines = [`${head} ${d.blockedDomainCount} domains are now blocked.`];
  if (d.rule.kind === 'group') lines.push(GROUP_LIMITS_NOTE);
  return lines.join('\n');
}

export function formatUnblock(d: DataOf<'unblock'>): string {
  const what = `${d.rule.target} (${d.rule.kind})`;
  return d.removed
    ? `Unblocked ${what}. ${d.blockedDomainCount} domains are still blocked.`
    : `No rule for ${what}; nothing to unblock. See: hourkeep list`;
}
