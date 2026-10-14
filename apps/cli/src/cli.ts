import * as readline from 'node:readline';
import { Command, CommanderError } from 'commander';
import { parseScheduleSpec } from '@hourkeep/core';
import {
  IpcClientError,
  call as ipcCall,
  type ChangeOutcome,
  type IpcError,
  type Op,
  type PublicChallengeWire,
  type RequestParams,
  type Response,
  type ScheduleWire,
} from '@hourkeep/ipc';
import {
  formatBlock,
  formatChallenge,
  formatList,
  formatOutcome,
  formatPendingList,
  formatSettings,
  formatStatus,
  span,
} from './format.js';

export const DEFAULT_SOCKET = '/run/hourkeep/hourkeep.sock';
export const CLI_VERSION = '0.2.0-dev';

/** Everything the CLI needs from the outside world, injectable for tests. */
export interface CliIo {
  call<O extends Op>(socket: string, op: O, params: RequestParams<O>): Promise<Response<O>>;
  stdout(text: string): void;
  stderr(text: string): void;
  now(): number;
  env: NodeJS.ProcessEnv;
  /** Ask one line of input. Resolves to null at end of input. */
  prompt(question: string): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  /** True when a person is at the terminal, so the CLI may prompt. */
  isInteractive: boolean;
}

let rl: readline.Interface | undefined;
export const realIo: CliIo = {
  call: (socket, op, params) => ipcCall(socket, op, params),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  now: () => Date.now(),
  env: process.env,
  prompt: (question) =>
    new Promise((resolve) => {
      rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
      const done = (): void => resolve(null);
      rl.once('close', done);
      rl.question(question, (answer) => {
        rl?.off('close', done);
        resolve(answer);
      });
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

type Reply<T> =
  { ok: true; data: T } | { ok: false; error: IpcError | { code: 'client'; message: string } };

/** Exit codes: 0 success, 1 the daemon refused or could not be reached, 2 bad usage. */
export async function runCli(argv: readonly string[], io: CliIo = realIo): Promise<number> {
  const program = new Command();
  let code = 0;

  program
    .name('hourkeep')
    .description('Control hourkeepd, the Hourkeep blocking daemon')
    .version(CLI_VERSION)
    .option('--socket <path>', 'daemon socket (env HOURKEEP_SOCKET)')
    .option('--json', 'machine-readable output')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) });

  const json = (): boolean => Boolean(program.opts<{ json?: boolean }>().json);
  const say = (text: string): void => io.stdout(text + '\n');
  const complain = (text: string): void => io.stderr(`hourkeep: ${text}\n`);

  /** Send one request. Connection problems become a reply with code "client". */
  async function rpc<O extends Op>(
    op: O,
    params: RequestParams<O>,
  ): Promise<Reply<Extract<Response<O>, { ok: true }>['data']>> {
    const socket =
      program.opts<{ socket?: string }>().socket ?? io.env['HOURKEEP_SOCKET'] ?? DEFAULT_SOCKET;
    try {
      const res = await io.call(socket, op, params);
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'client',
          message: e instanceof IpcClientError ? e.message : (e as Error).message,
        },
      };
    }
  }

  /** Print a reply (JSON or human) and set the exit code. Returns true on success. */
  function show<T>(reply: Reply<T>, human: (d: T) => string): boolean {
    if (json()) {
      say(
        JSON.stringify(
          reply.ok ? { ok: true, data: reply.data } : { ok: false, error: reply.error },
        ),
      );
    } else if (reply.ok) {
      say(human(reply.data));
    } else {
      complain(reply.error.message);
    }
    if (!reply.ok) code = 1;
    return reply.ok;
  }

  /** Run one operation and print the result. */
  async function simple<O extends Op>(
    op: O,
    params: RequestParams<O>,
    human: (d: Extract<Response<O>, { ok: true }>['data']) => string,
  ): Promise<void> {
    show(await rpc(op, params), human);
  }

  // ---- the interactive confirm flow ---------------------------------------------------------

  /** Take the challenge for a pending change and apply it. */
  async function confirm(
    id: number | undefined,
    opts: { wait?: boolean; answer?: string },
  ): Promise<void> {
    if (id === undefined) {
      const list = await rpc('pending_list', {});
      if (!list.ok) {
        show(list, () => '');
        return;
      }
      const open = list.data.changes;
      if (open.length === 0) {
        if (json())
          say(
            JSON.stringify({
              ok: false,
              error: { code: 'not_found', message: 'no pending changes' },
            }),
          );
        else say('No pending changes.');
        code = 1;
        return;
      }
      if (open.length > 1) {
        say(formatPendingList(open, io.now()));
        complain('more than one pending change: say which, as in "hourkeep confirm <id>"');
        code = 1;
        return;
      }
      id = (open[0] as { id: number }).id;
    }
    const changeId = id;

    // Scripted use: print the challenge, or submit one answer, and stop.
    if (opts.answer !== undefined) {
      const reply = await rpc('pending_answer', { changeId, response: opts.answer });
      if (
        show(reply, (d) => (d.result === 'applied' ? d.message : `Wrong: ${d.hint}`)) &&
        reply.ok &&
        reply.data.result !== 'applied'
      )
        code = 1;
      return;
    }

    for (;;) {
      const ch = await rpc('pending_challenge', { changeId });
      if (!ch.ok) {
        if (ch.error.code === 'cooldown_active' && opts.wait && !json()) {
          const list = await rpc('pending_list', {});
          const item = list.ok ? list.data.changes.find((c) => c.id === changeId) : undefined;
          const wait = item ? item.cooldownEndsAt - io.now() : 1000;
          say(
            `Waiting ${span(wait)} for the cooldown. Ctrl+C stops waiting; the request stays pending.`,
          );
          await io.sleep(Math.max(wait, 0) + 500);
          continue;
        }
        show(ch, () => '');
        if (ch.error.code === 'cooldown_active' && !json())
          complain(`or wait with: hourkeep confirm ${changeId} --wait`);
        return;
      }
      if (json()) {
        say(JSON.stringify({ ok: true, data: ch.data }));
        return;
      }
      if (!io.isInteractive) {
        say(formatChallenge(ch.data.challenge));
        complain(
          `not at a terminal: answer with: hourkeep confirm ${changeId} --answer "<your answer>"`,
        );
        code = 1;
        return;
      }
      if (await answerLoop(changeId, ch.data.challenge)) return;
    }
  }

  /** Prompt and submit until applied. Returns true when finished (applied or gave up). */
  async function answerLoop(changeId: number, first: PublicChallengeWire): Promise<boolean> {
    let challenge = first;
    say('');
    say(formatChallenge(challenge));
    for (;;) {
      const answer = await io.prompt('> ');
      if (answer === null) {
        complain('no answer given');
        code = 1;
        return true;
      }
      // An answer that is too early is not wrong: wait out the minimum time and send it again.
      for (let tries = 0; ; tries++) {
        const res = await rpc('pending_answer', { changeId, response: answer });
        if (!res.ok && res.error.code === 'too_early' && tries < 3) {
          const wait = Math.max(challenge.earliestAnswerAt - io.now(), 1000);
          say(`Too quick. Holding your answer for ${span(wait)}...`);
          await io.sleep(wait + 250);
          continue;
        }
        if (!res.ok) {
          show(res, () => '');
          return true;
        }
        if (res.data.result === 'applied') {
          say(res.data.message);
          return true;
        }
        say(`Not quite: ${res.data.hint} (${res.data.attemptsLeft} attempts left)`);
        if (res.data.newChallenge) {
          challenge = res.data.newChallenge;
          say('Too many wrong answers. Here is a new challenge.');
          say('');
          say(formatChallenge(challenge));
        }
        break;
      }
    }
  }

  // ---- commands ---------------------------------------------------------------------------

  program
    .command('status')
    .description('show daemon state')
    .action(() => simple('status', {}, (d) => formatStatus(d, io.now())));

  program
    .command('list')
    .description('show rules, schedules, limits and available groups')
    .action(() => simple('list', {}, (d) => formatList(d, io.now())));

  program
    .command('block')
    .argument('<target>', 'a domain (example.com) or a group (youtube)')
    .description('block a domain or group (instant)')
    .action((target: string) => simple('block', { target }, formatBlock));

  const outcome = (o: ChangeOutcome): string => formatOutcome(o, io.now());

  program
    .command('unblock')
    .argument('<target>', 'a domain or group to stop blocking')
    .description('ask to stop blocking: starts a cooldown, then a challenge (see "confirm")')
    .action((target: string) => simple('unblock', { target }, outcome));

  const schedule = program
    .command('schedule')
    .description('when a rule is blocking (weekly windows)');
  schedule
    .command('set')
    .argument('<target>')
    .argument(
      '<windows...>',
      'windows such as "mon-fri 09:00-17:00" (overnight like "fri 22:00-02:00" works)',
    )
    .option('--tz <zone>', 'IANA timezone (default: the daemon setting)')
    .description('block only during these windows. Shrinking coverage is a loosening change.')
    .action(async (target: string, windows: string[], o: { tz?: string }) => {
      let tz = o.tz;
      if (tz === undefined) {
        const s = await rpc('settings_get', {});
        if (!s.ok) return void show(s, () => '');
        tz = s.data.timezone;
      }
      const parsed = parseScheduleSpec(windows, tz);
      if (!parsed.ok) {
        if (json())
          say(
            JSON.stringify({ ok: false, error: { code: 'invalid_value', message: parsed.error } }),
          );
        else complain(parsed.error);
        code = 1;
        return;
      }
      await simple(
        'schedule_set',
        { target, schedule: parsed.value as unknown as ScheduleWire },
        outcome,
      );
    });
  schedule
    .command('clear')
    .argument('<target>')
    .description('block around the clock again (instant)')
    .action((target: string) => simple('schedule_clear', { target }, outcome));

  const limit = program.command('limit').description('daily limit of pass minutes for a rule');
  limit
    .command('set')
    .argument('<target>')
    .argument('<minutes>', 'whole minutes per day, 0 for no passes at all')
    .description('lowering is instant, raising goes through cooldown and challenge')
    .action(async (target: string, minutes: string) => {
      if (!/^\d+$/.test(minutes)) {
        complain('minutes must be a whole number');
        code = 2;
        return;
      }
      await simple('limit_set', { target, minutes: Number(minutes) }, outcome);
    });
  limit
    .command('clear')
    .argument('<target>')
    .description('remove the limit (a loosening change)')
    .action((target: string) => simple('limit_set', { target, minutes: null }, outcome));

  const pass = program
    .command('pass')
    .description('temporary pass: unblock a rule for a short time');
  pass
    .command('start')
    .argument('<target>')
    .option('--no-confirm', 'only request the pass; confirm separately')
    .description('needs a challenge but no cooldown. Limited per day.')
    .action(async (target: string, o: { confirm: boolean }) => {
      const reply = await rpc('pass_start', { target });
      if (!show(reply, outcome)) return;
      if (reply.ok && reply.data.status === 'pending' && o.confirm && io.isInteractive && !json()) {
        await confirm(reply.data.change.id, {});
      }
    });
  pass
    .command('end')
    .argument('<target>')
    .description('end a running pass early (instant)')
    .action((target: string) => simple('pass_end', { target }, outcome));

  const pending = program
    .command('pending')
    .description('changes waiting for cooldown or challenge');
  pending.action(() => simple('pending_list', {}, (d) => formatPendingList(d.changes, io.now())));
  pending
    .command('list')
    .description('list pending changes')
    .action(() => simple('pending_list', {}, (d) => formatPendingList(d.changes, io.now())));
  pending
    .command('cancel')
    .argument('<id>')
    .description('cancel a pending change')
    .action(async (id: string) => {
      if (!/^\d+$/.test(id)) {
        complain('id must be a number');
        code = 2;
        return;
      }
      await simple('pending_cancel', { changeId: Number(id) }, (d) => d.message);
    });

  program
    .command('confirm')
    .argument('[id]', 'pending change (optional if there is only one)')
    .option('--wait', 'wait out the cooldown instead of stopping')
    .option('--answer <text>', 'submit one answer without prompting (for scripts)')
    .description('take the challenge for a pending change and apply it')
    .action(async (id: string | undefined, o: { wait?: boolean; answer?: string }) => {
      if (id !== undefined && !/^\d+$/.test(id)) {
        complain('id must be a number');
        code = 2;
        return;
      }
      await confirm(id === undefined ? undefined : Number(id), o);
    });

  const settings = program.command('settings').description('cooldown, passes and timezone');
  settings.action(() => simple('settings_get', {}, formatSettings));
  settings
    .command('get')
    .description('show settings')
    .action(() => simple('settings_get', {}, formatSettings));
  settings
    .command('set')
    .argument('<key>', 'cooldown (minutes), passes-per-day, pass-minutes, timezone')
    .argument('<value>')
    .description('tightening is instant; loosening goes through cooldown and challenge')
    .action((key: string, value: string) => simple('settings_set', { key, value }, outcome));

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
  return code;
}
