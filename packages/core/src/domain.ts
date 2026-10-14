import { err, ok, type Result } from './result.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED = new Set(['localhost', 'localhost.localdomain', 'broadcasthost']);

/**
 * Validate and normalise a hostname that may be written into a hosts file.
 *
 * Strict on purpose: the result is interpolated into `/etc/hosts`, so anything that is not a
 * plain ASCII hostname (whitespace, `#`, newlines, wildcards, URLs, IP addresses) is rejected.
 * Internationalised names must be given in punycode (`xn--...`).
 */
export function normalizeDomain(input: string): Result<string> {
  let d = input.trim().toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (d.length === 0) return err('domain is empty');
  if (d.includes('*')) {
    return err(`wildcards are not supported in the hosts layer: "${input.trim()}"`);
  }
  if (d.includes('://') || d.includes('/')) {
    return err(`pass a bare domain such as example.com, not a URL: "${input.trim()}"`);
  }
  if (!/^[\x21-\x7e]+$/.test(d)) {
    return err('domain must be ASCII with no whitespace (use punycode for international names)');
  }
  if (d.length > 253) return err('domain is longer than 253 characters');
  const labels = d.split('.');
  if (labels.length < 2) return err(`"${d}" is not a fully qualified domain (needs a dot)`);
  for (const label of labels) {
    if (!LABEL.test(label)) return err(`invalid label "${label}" in "${d}"`);
  }
  const tld = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(tld)) return err('IP addresses are not supported, use a domain name');
  if (RESERVED.has(d) || tld === 'localhost') return err(`"${d}" is reserved`);
  return ok(d);
}
