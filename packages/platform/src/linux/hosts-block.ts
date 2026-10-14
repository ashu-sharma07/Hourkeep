/** Marker lines delimiting the section owned by hourkeepd. */
export const BEGIN_MARKER =
  '# BEGIN HOURKEEP MANAGED BLOCK (do not edit; hourkeepd reverts changes)';
export const END_MARKER = '# END HOURKEEP MANAGED BLOCK';

/** Render the managed section (markers included, trailing newline included). */
export function renderBlock(domains: readonly string[]): string {
  const lines = [BEGIN_MARKER];
  for (const d of domains) {
    lines.push(`0.0.0.0 ${d}`, `:: ${d}`);
  }
  lines.push(END_MARKER);
  return lines.join('\n') + '\n';
}

export type BlockState =
  | { kind: 'absent' }
  | { kind: 'present'; block: string; start: number; end: number }
  | { kind: 'malformed' };

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);
const isBegin = (line: string): boolean =>
  stripCr(line).startsWith('# BEGIN HOURKEEP MANAGED BLOCK');
const isEnd = (line: string): boolean => stripCr(line).startsWith('# END HOURKEEP MANAGED BLOCK');

/**
 * Locate the managed section. Exactly one BEGIN followed by exactly one END is `present`;
 * no markers is `absent`; anything else (duplicates, a lone marker, END before BEGIN) is
 * `malformed`. `start`/`end` are line indexes (end exclusive) into `content.split('\n')`.
 */
export function findBlock(content: string): BlockState {
  const lines = content.split('\n');
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (isBegin(line)) begins.push(i);
    else if (isEnd(line)) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return { kind: 'absent' };
  const b = begins[0];
  const e = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || b === undefined || e === undefined || e < b) {
    return { kind: 'malformed' };
  }
  return { kind: 'present', block: lines.slice(b, e + 1).join('\n') + '\n', start: b, end: e + 1 };
}

/** Domains listed inside a managed block, taken from its `0.0.0.0` lines. */
export function parseBlockDomains(block: string): string[] {
  const out: string[] = [];
  for (const raw of block.split('\n')) {
    const m = /^0\.0\.0\.0\s+(\S+)\s*$/.exec(stripCr(raw));
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** Remove every marker line and everything between balanced marker pairs. */
function stripAll(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (isBegin(line)) {
      inside = true;
      continue;
    }
    if (isEnd(line)) {
      inside = false;
      continue;
    }
    if (!inside) out.push(line);
  }
  return out;
}

/**
 * Return `content` with the managed section set to `block` (or removed when `block` is
 * empty). Text outside the section is preserved byte for byte, except that a malformed
 * section is cleaned up first. A missing section is appended at the end.
 */
export function applyBlock(content: string, block: string): string {
  const state = findBlock(content);
  if (state.kind === 'present') {
    const lines = content.split('\n');
    const before = lines.slice(0, state.start).join('\n');
    const after = lines.slice(state.end).join('\n');
    const head = state.start === 0 ? '' : before + '\n';
    return head + block + after;
  }
  const base = state.kind === 'malformed' ? stripAll(content.split('\n')).join('\n') : content;
  if (block === '') return base;
  const sep = base === '' || base.endsWith('\n') ? '' : '\n';
  return base + sep + block;
}
