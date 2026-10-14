import * as fs from 'node:fs';
import * as net from 'node:net';
import { FrameTooLargeError, LineDecoder, encodeMessage } from './framing.js';
import {
  PROTOCOL_VERSION,
  RequestSchema,
  peekEnvelope,
  type DataOf,
  type ErrorCode,
  type Op,
  type Request,
} from './protocol.js';

/** Who is on the other end of a connection, as far as the OS can tell. */
export interface PeerInfo {
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
}

export interface RequestContext {
  /** Null when peer credentials are unavailable. */
  readonly peer: PeerInfo | null;
}

export type HandlerResult<O extends Op> =
  | { readonly ok: true; readonly data: DataOf<O> }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** Handles one validated request. Throwing is reported to the client as `internal`. */
export type RequestHandler = (
  request: Request,
  context: RequestContext,
) => Promise<HandlerResult<Op>>;

export interface IpcServerOptions {
  readonly socketPath: string;
  /** Permission bits for the socket file (default 0o660). */
  readonly mode?: number;
  readonly handler: RequestHandler;
  /**
   * Identify the peer of an accepted connection. OS specific, so injected: this package
   * contains no platform code.
   */
  readonly resolvePeer?: (socket: net.Socket) => PeerInfo | null;
  /** Called once the socket exists and is listening, e.g. to change its group. */
  readonly onListening?: (socketPath: string) => void;
  /** Receives unexpected errors (handler exceptions, socket errors). */
  readonly onError?: (error: unknown) => void;
  /** Drop idle connections after this long (default 10 s). */
  readonly idleTimeoutMs?: number;
  /** Refuse connections beyond this many at once (default 32). */
  readonly maxConnections?: number;
}

export interface IpcServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

async function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(path);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** Remove a leftover socket file from a crashed run, but never one that is in use. */
async function clearStaleSocket(path: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (await isSocketAlive(path))
    throw new Error(`another hourkeepd is already listening on ${path}`);
  fs.unlinkSync(path);
}

/** Start serving requests on a Unix domain socket. */
export async function createIpcServer(options: IpcServerOptions): Promise<IpcServer> {
  const mode = options.mode ?? 0o660;
  const idleMs = options.idleTimeoutMs ?? 10_000;
  const report = options.onError ?? (() => undefined);
  await clearStaleSocket(options.socketPath);

  const server = net.createServer();
  server.maxConnections = options.maxConnections ?? 32;
  const open = new Set<net.Socket>();

  server.on('connection', (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const peer = options.resolvePeer?.(socket) ?? null;
    const decoder = new LineDecoder();
    let chain: Promise<void> = Promise.resolve();
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on('error', (e) => report(e));

    const send = (message: unknown, thenClose = false): void => {
      if (socket.destroyed) return;
      try {
        socket.write(encodeMessage(message), () => thenClose && socket.end());
      } catch (e) {
        report(e);
        socket.destroy();
      }
    };
    const fail = (id: string, code: ErrorCode, message: string, close = false): void =>
      send({ v: PROTOCOL_VERSION, id, ok: false, error: { code, message } }, close);

    const handleLine = async (line: string): Promise<void> => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return fail('', 'bad_request', 'message is not valid JSON', true);
      }
      const { v, id } = peekEnvelope(raw);
      if (v !== PROTOCOL_VERSION) {
        return fail(id, 'unsupported_version', `server speaks protocol ${PROTOCOL_VERSION}`, true);
      }
      const parsed = RequestSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
        return fail(id, 'bad_request', `invalid request${where}: ${issue?.message ?? 'unknown'}`);
      }
      try {
        const result = await options.handler(parsed.data, { peer });
        if (result.ok)
          send({ v: PROTOCOL_VERSION, id: parsed.data.id, ok: true, data: result.data });
        else fail(parsed.data.id, result.code, result.message);
      } catch (e) {
        report(e);
        fail(parsed.data.id, 'internal', 'internal error');
      }
    };

    socket.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (e) {
        if (e instanceof FrameTooLargeError) fail('', 'too_large', e.message, true);
        else socket.destroy();
        return;
      }
      for (const line of lines) {
        chain = chain.then(() => handleLine(line));
      }
    });
  });

  const previousUmask = process.umask(0o777 & ~mode);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previousUmask);
  }
  fs.chmodSync(options.socketPath, mode);
  options.onListening?.(options.socketPath);
  server.on('error', (e) => report(e));

  return {
    socketPath: options.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const s of open) s.destroy();
        try {
          fs.unlinkSync(options.socketPath);
        } catch {
          /* already gone */
        }
      }),
  };
}
