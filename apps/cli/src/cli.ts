import { Command, CommanderError } from 'commander';
import {
  IpcClientError,
  call as ipcCall,
  type Op,
  type RequestParams,
  type Response,
} from '@hourkeep/ipc';
import { formatBlock, formatList, formatStatus, formatUnblock } from './format.js';

export const DEFAULT_SOCKET = '/run/hourkeep/hourkeep.sock';
export const CLI_VERSION = '0.1.0-dev';

/** Everything the CLI needs from the outside world, injectable for tests. */
export interface CliIo {
  call<O extends Op>(socket: string, op: O, params: RequestParams<O>): Promise<Response<O>>;
  stdout(text: string): void;
  stderr(text: string): void;
  now(): number;
  env: NodeJS.ProcessEnv;
}

export const realIo: CliIo = {
  call: (socket, op, params) => ipcCall(socket, op, params),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  now: () => Date.now(),
  env: process.env,
};

/** Exit codes: 0 success, 1 daemon or connection error, 2 bad usage. */
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
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      writeErr: (s) => io.stderr(s),
    });

  /** Send one request, print the result, set the exit code. */
  async function run<O extends Op>(
    op: O,
    params: RequestParams<O>,
    human: (data: Extract<Response<O>, { ok: true }>['data']) => string,
  ): Promise<void> {
    const opts = program.opts<{ socket?: string; json?: boolean }>();
    const socket = opts.socket ?? io.env['HOURKEEP_SOCKET'] ?? DEFAULT_SOCKET;
    let res: Response<O>;
    try {
      res = await io.call(socket, op, params);
    } catch (e) {
      const message = e instanceof IpcClientError ? e.message : (e as Error).message;
      if (opts.json)
        io.stdout(JSON.stringify({ ok: false, error: { code: 'client', message } }) + '\n');
      else io.stderr(`hourkeep: ${message}\n`);
      code = 1;
      return;
    }
    if (opts.json) {
      io.stdout(
        JSON.stringify(res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error }) +
          '\n',
      );
      code = res.ok ? 0 : 1;
      return;
    }
    if (res.ok) io.stdout(human(res.data) + '\n');
    else {
      io.stderr(`hourkeep: ${res.error.message}\n`);
      code = 1;
    }
  }

  program
    .command('status')
    .description('show daemon state')
    .action(() => run('status', {}, (d) => formatStatus(d, io.now())));

  program
    .command('list')
    .description('show rules and available groups')
    .action(() => run('list', {}, formatList));

  program
    .command('block')
    .argument('<target>', 'a domain (example.com) or a group (youtube)')
    .description('block a domain or group')
    .action((target: string) => run('block', { target }, formatBlock));

  program
    .command('unblock')
    .argument('<target>', 'a domain or group to unblock')
    .description('remove a rule (instant for now; cooldowns arrive in a later release)')
    .action((target: string) => run('unblock', { target }, formatUnblock));

  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
  return code;
}
