/** Source of randomness in [0, 1). Injected so challenges are testable. */
export type Rng = () => number;

/** Deterministic generator (mulberry32) for tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cryptographically secure generator for production use. */
export function secureRng(): Rng {
  const buf = new Uint32Array(1);
  return () => {
    globalThis.crypto.getRandomValues(buf);
    return (buf[0] as number) / 4294967296;
  };
}

const int = (rng: Rng, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

export const CHALLENGE_KIND_IDS = ['typing', 'arithmetic', 'reflection'] as const;
export type ChallengeKindId = (typeof CHALLENGE_KIND_IDS)[number];

/** What the user sees. Never contains the answer. */
export type ChallengeData =
  | { readonly kind: 'typing'; readonly text: string }
  | { readonly kind: 'arithmetic'; readonly problems: readonly string[] }
  | {
      readonly kind: 'reflection';
      readonly question: string;
      readonly minWords: number;
      readonly minChars: number;
    };

export interface PublicChallenge {
  readonly id: string;
  readonly issuedAt: number;
  /** Answers before this instant are rejected without counting as an attempt. */
  readonly earliestAnswerAt: number;
  readonly instructions: string;
  readonly data: ChallengeData;
}

/** Answer material, kept by the daemon only. JSON-serialisable. */
export type ChallengeSecret =
  | { readonly kind: 'typing'; readonly text: string }
  | { readonly kind: 'arithmetic'; readonly answers: readonly number[] }
  | { readonly kind: 'reflection' };

export interface IssuedChallenge {
  readonly public: PublicChallenge;
  readonly secret: ChallengeSecret;
}

export interface Timing {
  /** Minimum time before a typing or arithmetic answer is accepted. */
  readonly minAnswerMs: number;
  /** How long the reflection screen makes you wait. */
  readonly reflectionWaitMs: number;
}

export const DEFAULT_TIMING: Timing = { minAnswerMs: 5_000, reflectionWaitMs: 30_000 };

export interface ChallengeContext {
  readonly rng: Rng;
  readonly now: number;
  /** What the user is trying to do, as a verb phrase: "stop blocking youtube". */
  readonly subject: string;
  readonly timing?: Partial<Timing>;
}

const TYPING_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1
export const REFLECTION_MIN_WORDS = 8;
export const REFLECTION_MIN_CHARS = 40;
const REFLECTION_MIN_DISTINCT_WORDS = 5;

function newId(rng: Rng): string {
  return Array.from({ length: 8 }, () => int(rng, 0, 15).toString(16)).join('');
}

function issueTyping(ctx: ChallengeContext, t: Timing, id: string): IssuedChallenge {
  const groups = Array.from({ length: 6 }, () =>
    Array.from({ length: 6 }, () => pick(ctx.rng, [...TYPING_ALPHABET])).join(''),
  );
  const text = groups.join('-');
  return {
    public: {
      id,
      issuedAt: ctx.now,
      earliestAnswerAt: ctx.now + t.minAnswerMs,
      instructions: `Type this exactly to ${ctx.subject}:`,
      data: { kind: 'typing', text },
    },
    secret: { kind: 'typing', text },
  };
}

function issueArithmetic(ctx: ChallengeContext, t: Timing, id: string): IssuedChallenge {
  const problems: string[] = [];
  const answers: number[] = [];
  for (let i = 0; i < 5; i++) {
    switch (int(ctx.rng, 0, 2)) {
      case 0: {
        const a = int(ctx.rng, 12, 49);
        const b = int(ctx.rng, 3, 9);
        const c = int(ctx.rng, 10, 99);
        problems.push(`${a} × ${b} + ${c}`);
        answers.push(a * b + c);
        break;
      }
      case 1: {
        const a = int(ctx.rng, 100, 899);
        const b = int(ctx.rng, 100, 899);
        const c = int(ctx.rng, 10, 99);
        problems.push(`${a} + ${b} − ${c}`);
        answers.push(a + b - c);
        break;
      }
      default: {
        const a = int(ctx.rng, 5, 29);
        const b = int(ctx.rng, 5, 29);
        const c = int(ctx.rng, 3, 9);
        problems.push(`(${a} + ${b}) × ${c}`);
        answers.push((a + b) * c);
      }
    }
  }
  return {
    public: {
      id,
      issuedAt: ctx.now,
      earliestAnswerAt: ctx.now + t.minAnswerMs,
      instructions: `Solve all five, answers separated by spaces or commas, to ${ctx.subject}:`,
      data: { kind: 'arithmetic', problems },
    },
    secret: { kind: 'arithmetic', answers },
  };
}

function issueReflection(ctx: ChallengeContext, t: Timing, id: string): IssuedChallenge {
  const waitS = Math.round(t.reflectionWaitMs / 1000);
  return {
    public: {
      id,
      issuedAt: ctx.now,
      earliestAnswerAt: ctx.now + t.reflectionWaitMs,
      instructions: `Take ${waitS} seconds. Then say why in your own words (at least ${REFLECTION_MIN_WORDS} words).`,
      data: {
        kind: 'reflection',
        question: `Why do you want to ${ctx.subject}?`,
        minWords: REFLECTION_MIN_WORDS,
        minChars: REFLECTION_MIN_CHARS,
      },
    },
    secret: { kind: 'reflection' },
  };
}

/** Issue a challenge of a kind picked at random from `kinds`. */
export function issueChallenge(
  kinds: readonly ChallengeKindId[],
  ctx: ChallengeContext,
): IssuedChallenge {
  if (kinds.length === 0) throw new Error('no challenge kinds enabled');
  const timing: Timing = { ...DEFAULT_TIMING, ...ctx.timing };
  const kind = pick(ctx.rng, kinds);
  const id = newId(ctx.rng);
  switch (kind) {
    case 'typing':
      return issueTyping(ctx, timing, id);
    case 'arithmetic':
      return issueArithmetic(ctx, timing, id);
    case 'reflection':
      return issueReflection(ctx, timing, id);
  }
}

export type AnswerCheck =
  | { readonly status: 'too_early'; readonly retryAt: number }
  | { readonly status: 'wrong'; readonly hint: string }
  | { readonly status: 'correct'; readonly reflection?: string };

/** Check a response. Pure: attempt counting and persistence belong to the caller. */
export function checkAnswer(issued: IssuedChallenge, response: string, now: number): AnswerCheck {
  if (now < issued.public.earliestAnswerAt) {
    return { status: 'too_early', retryAt: issued.public.earliestAnswerAt };
  }
  const secret = issued.secret;
  switch (secret.kind) {
    case 'typing':
      return response.trim() === secret.text
        ? { status: 'correct' }
        : { status: 'wrong', hint: 'The text did not match exactly.' };
    case 'arithmetic': {
      const given = (response.match(/-?\d+/g) ?? []).map(Number);
      const right =
        given.length === secret.answers.length && given.every((v, i) => v === secret.answers[i]);
      return right
        ? { status: 'correct' }
        : { status: 'wrong', hint: 'At least one answer is wrong.' };
    }
    case 'reflection': {
      const text = response.trim();
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length < REFLECTION_MIN_WORDS || text.length < REFLECTION_MIN_CHARS) {
        return {
          status: 'wrong',
          hint: `Write at least ${REFLECTION_MIN_WORDS} words (${REFLECTION_MIN_CHARS} characters).`,
        };
      }
      if (new Set(words.map((w) => w.toLowerCase())).size < REFLECTION_MIN_DISTINCT_WORDS) {
        return { status: 'wrong', hint: 'Say it in your own words, not by repeating a few.' };
      }
      return { status: 'correct', reflection: text };
    }
  }
}
