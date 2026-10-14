import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_KIND_IDS,
  checkAnswer,
  issueChallenge,
  secureRng,
  seededRng,
  type IssuedChallenge,
} from './challenge.js';

const NOW = 1_000_000;
const ctx = (seed = 1, over = {}) => ({
  rng: seededRng(seed),
  now: NOW,
  subject: 'stop blocking youtube',
  ...over,
});

/** Find a seed that makes `issueChallenge` pick the wanted kind. */
function issue(kind: 'typing' | 'arithmetic' | 'reflection', seed = 1): IssuedChallenge {
  return issueChallenge([kind], ctx(seed));
}

describe('seededRng / secureRng', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seededRng(1)()).not.toBe(seededRng(2)());
  });

  it('secure generator stays in range and varies', () => {
    const r = secureRng();
    const xs = Array.from({ length: 200 }, () => r());
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBeGreaterThan(190);
  });
});

describe('issueChallenge', () => {
  it('is reproducible with the same seed and differs between seeds', () => {
    expect(issue('typing', 7)).toEqual(issue('typing', 7));
    expect(issue('typing', 7).public.data).not.toEqual(issue('typing', 8).public.data);
  });

  it('refuses an empty kind list', () => {
    expect(() => issueChallenge([], ctx())).toThrow();
  });

  it('picks among the enabled kinds only and eventually uses all of them', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 200; seed++)
      seen.add(issueChallenge(CHALLENGE_KIND_IDS, ctx(seed)).public.data.kind);
    expect([...seen].sort()).toEqual([...CHALLENGE_KIND_IDS].sort());
    for (let seed = 1; seed < 50; seed++) {
      expect(issueChallenge(['typing', 'reflection'], ctx(seed)).public.data.kind).not.toBe(
        'arithmetic',
      );
    }
  });

  it('never leaks the answer in the public part', () => {
    const arith = issue('arithmetic');
    const json = JSON.stringify(arith.public);
    expect(
      arith.secret.kind === 'arithmetic' &&
        arith.secret.answers.some((a) => json.includes(`"${a}"`)),
    ).toBe(false);
    expect(json).not.toContain('"answers"');
  });

  it('gives each challenge an 8 character id and records when it was issued', () => {
    const c = issue('typing');
    expect(c.public.id).toMatch(/^[0-9a-f]{8}$/);
    expect(c.public.issuedAt).toBe(NOW);
  });

  it('puts the subject in the instructions', () => {
    expect(issue('typing').public.instructions).toContain('stop blocking youtube');
    const r = issue('reflection').public.data;
    expect(r.kind === 'reflection' && r.question).toBe('Why do you want to stop blocking youtube?');
  });

  it('timing can be shortened for tests', () => {
    const c = issueChallenge(['reflection'], ctx(1, { timing: { reflectionWaitMs: 1000 } }));
    expect(c.public.earliestAnswerAt).toBe(NOW + 1000);
  });
});

describe('typing', () => {
  const c = issue('typing', 3);
  const text = c.secret.kind === 'typing' ? c.secret.text : '';
  const later = NOW + 60_000;

  it('is a long random string without look-alike characters', () => {
    expect(text).toMatch(/^([a-z2-9]{6}-){5}[a-z2-9]{6}$/);
    expect(text).not.toMatch(/[ilo01]/);
  });

  it('accepts the exact text, ignoring surrounding whitespace', () => {
    expect(checkAnswer(c, text, later)).toEqual({ status: 'correct' });
    expect(checkAnswer(c, `  ${text}\n`, later)).toEqual({ status: 'correct' });
  });

  it.each([
    ['', 'empty'],
    ['x', 'short'],
    ['TEXT', 'wrong case'],
  ])('rejects %j (%s)', (resp) => {
    expect(checkAnswer(c, resp === 'TEXT' ? text.toUpperCase() : resp, later).status).toBe('wrong');
  });

  it('rejects one wrong character', () => {
    const bad = (text[0] === 'a' ? 'b' : 'a') + text.slice(1);
    expect(checkAnswer(c, bad, later).status).toBe('wrong');
  });

  it('rejects answers that arrive too fast, telling when to retry', () => {
    expect(checkAnswer(c, text, NOW + 1000)).toEqual({ status: 'too_early', retryAt: NOW + 5000 });
  });
});

describe('arithmetic', () => {
  const c = issue('arithmetic', 5);
  const answers = c.secret.kind === 'arithmetic' ? c.secret.answers : [];
  const later = NOW + 60_000;

  it('has five problems whose answers are consistent with the displayed text', () => {
    const data = c.public.data;
    expect(data.kind === 'arithmetic' && data.problems).toHaveLength(5);
    expect(answers).toHaveLength(5);
    const problems = data.kind === 'arithmetic' ? data.problems : [];
    problems.forEach((p, i) => {
      const expr = p.replace(/×/g, '*').replace(/−/g, '-');
      expect(Function(`"use strict"; return (${expr});`)()).toBe(answers[i]);
    });
  });

  it('accepts space, comma and mixed separators', () => {
    expect(checkAnswer(c, answers.join(' '), later).status).toBe('correct');
    expect(checkAnswer(c, answers.join(', '), later).status).toBe('correct');
    expect(checkAnswer(c, answers.join(',\n'), later).status).toBe('correct');
  });

  it('rejects a wrong value, a missing value and an extra value', () => {
    expect(
      checkAnswer(c, [...answers.slice(0, 4), (answers[4] as number) + 1].join(' '), later).status,
    ).toBe('wrong');
    expect(checkAnswer(c, answers.slice(0, 4).join(' '), later).status).toBe('wrong');
    expect(checkAnswer(c, [...answers, 1].join(' '), later).status).toBe('wrong');
    expect(checkAnswer(c, 'a b c d e', later).status).toBe('wrong');
  });

  it('rejects answers in the wrong order', () => {
    const swapped = [answers[1], answers[0], ...answers.slice(2)];
    if (answers[0] !== answers[1])
      expect(checkAnswer(c, swapped.join(' '), later).status).toBe('wrong');
  });

  it('always has positive answers', () => {
    for (let seed = 1; seed < 100; seed++) {
      const x = issue('arithmetic', seed);
      expect(x.secret.kind === 'arithmetic' && x.secret.answers.every((a) => a > 0)).toBe(true);
    }
  });
});

describe('reflection', () => {
  const c = issue('reflection');
  const wait = 30_000;
  const good = 'I want to watch one lecture that my professor assigned for tomorrow morning';

  it('makes you wait before it accepts anything', () => {
    expect(checkAnswer(c, good, NOW + wait - 1)).toEqual({
      status: 'too_early',
      retryAt: NOW + wait,
    });
    expect(checkAnswer(c, good, NOW + wait).status).toBe('correct');
  });

  it('returns the reflection text so it can be logged', () => {
    expect(checkAnswer(c, `  ${good}  `, NOW + wait)).toEqual({
      status: 'correct',
      reflection: good,
    });
  });

  it.each([
    ['too few words', 'because I am bored right now ok'],
    ['too few characters', 'a b c d e f g h i j'],
    ['empty', ''],
    ['one word repeated', 'blah blah blah blah blah blah blah blah blah blah blah'],
  ])('rejects %s', (_n, text) => {
    expect(checkAnswer(c, text, NOW + wait).status).toBe('wrong');
  });
});
