import {
  MAX_ATTEMPTS,
  checkAnswer,
  issueChallenge,
  phaseOf,
  planTimes,
  type ChallengeKindId,
  type PublicChallenge,
  type Rng,
  type Timing,
} from '@hourkeep/core';
import type { ErrorCode, PendingView } from '@hourkeep/ipc';
import { changeKey, formatDuration, summarize, type Change } from './changes.js';
import type { Logger } from './log.js';
import type { PendingRow, Store } from './store.js';

export type Failure = { readonly ok: false; readonly code: ErrorCode; readonly message: string };
export type Res<T> = { readonly ok: true; readonly value: T } | Failure;

const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, code, message });

export interface PendingDeps {
  readonly store: Store;
  readonly clock: () => number;
  readonly rng: Rng;
  readonly kinds: readonly ChallengeKindId[];
  readonly timing?: Partial<Timing> | undefined;
  readonly logger: Logger;
}

export type AnswerResult =
  | { readonly status: 'correct'; readonly row: PendingRow; readonly reflection: string | null }
  | {
      readonly status: 'wrong';
      readonly hint: string;
      readonly attemptsLeft: number;
      readonly newChallenge: PublicChallenge | null;
    };

/**
 * The pending-change state machine: cooldown, then challenge, then apply. It owns what is
 * stored and what the user may do at each moment; applying the change is the caller's job.
 */
export class PendingChanges {
  constructor(private readonly d: PendingDeps) {}

  /** Create a pending change. `cooldownMs` is 0 for passes. */
  request(change: Change, uid: number | null, cooldownMs: number): PendingRow {
    const now = this.d.clock();
    const times = planTimes(now, cooldownMs);
    const summary = summarize(change);
    const id = this.d.store.createPending({
      kind: change.kind,
      payload: change,
      summary,
      requestedByUid: uid,
      requestedAt: times.requestedAt,
      cooldownEndsAt: times.cooldownEndsAt,
      expiresAt: times.expiresAt,
      attemptsLeft: MAX_ATTEMPTS,
    });
    this.d.store.recordEvent('change_requested', now, uid, {
      id,
      kind: change.kind,
      summary,
      cooldownMs,
    });
    return this.d.store.getPending(id) as PendingRow;
  }

  /** An open request for exactly this change, if any. */
  findOpen(change: Change): PendingRow | null {
    const key = changeKey(change);
    return (
      this.d.store
        .openPending()
        .find((r) => r.kind === change.kind && changeKey(r.payload as Change) === key) ?? null
    );
  }

  change(row: PendingRow): Change {
    return row.payload as Change;
  }

  view(row: PendingRow): PendingView {
    const now = this.d.clock();
    return {
      id: row.id,
      kind: row.kind as PendingView['kind'],
      summary: row.summary,
      requestedAt: row.requestedAt,
      requestedByUid: row.requestedByUid,
      cooldownEndsAt: row.cooldownEndsAt,
      expiresAt: row.expiresAt,
      phase: phaseOf(row, now) === 'cooldown' ? 'cooldown' : 'ready',
      challengeIssued: row.challenge !== null,
      attemptsLeft: row.attemptsLeft,
    };
  }

  /** Mark every open change whose window has closed as expired. Returns how many. */
  expireDue(): number {
    const now = this.d.clock();
    let n = 0;
    for (const row of this.d.store.openPending()) {
      if (phaseOf(row, now) === 'expired') {
        this.d.store.resolvePending(row.id, 'expired', now);
        this.d.store.recordEvent('change_expired', now, null, { id: row.id, kind: row.kind });
        n++;
      }
    }
    return n;
  }

  list(): PendingView[] {
    this.expireDue();
    return this.d.store.openPending().map((r) => this.view(r));
  }

  cancel(id: number, uid: number | null): Res<string> {
    this.expireDue();
    const row = this.d.store.getPending(id);
    if (!row || row.status !== 'pending') return fail('not_found', `no open pending change #${id}`);
    const now = this.d.clock();
    this.d.store.resolvePending(id, 'cancelled', now);
    this.d.store.recordEvent('change_cancelled', now, uid, {
      id,
      kind: row.kind,
      summary: row.summary,
    });
    return { ok: true, value: `Cancelled #${id}: ${row.summary}.` };
  }

  /** Open row that may be confirmed now, or the reason it cannot be. */
  private confirmable(id: number): Res<PendingRow> {
    this.expireDue();
    const row = this.d.store.getPending(id);
    if (!row) return fail('not_found', `no pending change #${id}`);
    if (row.status === 'expired') {
      return fail('expired', `#${id} expired. Request the change again.`);
    }
    if (row.status !== 'pending') return fail('not_found', `#${id} is already ${row.status}`);
    const now = this.d.clock();
    if (phaseOf(row, now) === 'cooldown') {
      return fail(
        'cooldown_active',
        `#${id} is in its cooldown for another ${formatDuration(row.cooldownEndsAt - now)}`,
      );
    }
    return { ok: true, value: row };
  }

  private issue(row: PendingRow): PendingRow {
    const now = this.d.clock();
    const issued = issueChallenge(this.d.kinds, {
      rng: this.d.rng,
      now,
      subject: row.summary,
      ...(this.d.timing ? { timing: this.d.timing } : {}),
    });
    this.d.store.setChallenge(row.id, issued, MAX_ATTEMPTS);
    this.d.store.recordEvent('challenge_issued', now, null, {
      id: row.id,
      challenge: issued.public.id,
      kind: issued.public.data.kind,
    });
    return this.d.store.getPending(row.id) as PendingRow;
  }

  /** The current challenge, issuing one the first time. Stable until answered or exhausted. */
  challenge(id: number): Res<{ challenge: PublicChallenge; attemptsLeft: number }> {
    const r = this.confirmable(id);
    if (!r.ok) return r;
    const row = r.value.challenge ? r.value : this.issue(r.value);
    return {
      ok: true,
      value: {
        challenge: (row.challenge as NonNullable<PendingRow['challenge']>).public,
        attemptsLeft: row.attemptsLeft,
      },
    };
  }

  /** Check an answer. Applying the change on `correct` is up to the caller. */
  answer(id: number, response: string): Res<AnswerResult> {
    const r = this.confirmable(id);
    if (!r.ok) return r;
    const row = r.value;
    if (!row.challenge) return fail('bad_request', `ask for the challenge for #${id} first`);
    const now = this.d.clock();
    const check = checkAnswer(row.challenge, response, now);
    if (check.status === 'too_early') {
      return fail('too_early', `wait ${formatDuration(check.retryAt - now)} before answering`);
    }
    if (check.status === 'correct') {
      return { ok: true, value: { status: 'correct', row, reflection: check.reflection ?? null } };
    }
    const left = row.attemptsLeft - 1;
    this.d.store.recordEvent('challenge_failed', now, null, {
      id,
      challenge: row.challenge.public.id,
      kind: row.challenge.public.data.kind,
    });
    if (left > 0) {
      this.d.store.setAttempts(id, left);
      return {
        ok: true,
        value: { status: 'wrong', hint: check.hint, attemptsLeft: left, newChallenge: null },
      };
    }
    const fresh = this.issue(row);
    return {
      ok: true,
      value: {
        status: 'wrong',
        hint: check.hint,
        attemptsLeft: fresh.attemptsLeft,
        newChallenge: (fresh.challenge as NonNullable<PendingRow['challenge']>).public,
      },
    };
  }
}
