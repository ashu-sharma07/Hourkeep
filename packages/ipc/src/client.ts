import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { LineDecoder, encodeMessage } from './framing.js';
import {
  PROTOCOL_VERSION,
  responseSchema,
  type Op,
  type RequestParams,
  type Response,
} from './protocol.js';

export type ClientErrorKind = 'not-running' | 'permission' | 'timeout' | 'protocol' | 'connect';

/** A failure to complete a request, as opposed to an error reply from the daemon. */
export class IpcClientError extends Error {
  constructor(
    readonly kind: ClientErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'IpcClientError';
  }
}

export interface RequestOptions {
  /** Give up after this many milliseconds (default 5000). */
  readonly timeoutMs?: number;
}

function connectError(e: NodeJS.ErrnoException, socketPath: string): IpcClientError {
  switch (e.code) {
    case 'ENOENT':
    case 'ECONNREFUSED':
      return new IpcClientError(
        'not-running',
        `cannot reach hourkeepd at ${socketPath}. Is the service running?`,
      );
    case 'EACCES':
    case 'EPERM':
      return new IpcClientError(
        'permission',
        `permission denied on ${socketPath}. Are you in the "hourkeep" group?`,
      );
    default:
      return new IpcClientError('connect', `cannot connect to ${socketPath}: ${e.message}`);
  }
}

/**
 * Send one request over the Unix socket and return the validated response. Resolves with an
 * error response when the daemon refuses the request; rejects with `IpcClientError` when
 * no valid answer could be obtained.
 */
export function call<O extends Op>(
  socketPath: string,
  op: O,
  params: RequestParams<O>,
  options: RequestOptions = {},
): Promise<Response<O>> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const id = randomUUID();
  const message = { v: PROTOCOL_VERSION, id, op, ...params };
  const schema = responseSchema(op);

  return new Promise((resolve, reject) => {
    const decoder = new LineDecoder();
    const socket = net.connect(socketPath);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new IpcClientError('timeout', `no reply from hourkeepd after ${timeoutMs} ms`)),
        ),
      timeoutMs,
    );

    socket.on('connect', () => {
      try {
        socket.write(encodeMessage(message));
      } catch (e) {
        finish(() => reject(new IpcClientError('protocol', (e as Error).message)));
      }
    });
    socket.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (e) {
        return finish(() => reject(new IpcClientError('protocol', (e as Error).message)));
      }
      const line = lines[0];
      if (line === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return finish(() => reject(new IpcClientError('protocol', 'daemon sent invalid JSON')));
      }
      const checked = schema.safeParse(parsed);
      if (!checked.success) {
        return finish(() =>
          reject(
            new IpcClientError(
              'protocol',
              'daemon reply did not match the protocol (version mismatch?)',
            ),
          ),
        );
      }
      const response = checked.data as Response<O>;
      if (response.id !== id && response.id !== '') {
        return finish(() =>
          reject(new IpcClientError('protocol', 'reply id does not match request')),
        );
      }
      finish(() => resolve(response));
    });
    socket.on('error', (e: NodeJS.ErrnoException) =>
      finish(() => reject(connectError(e, socketPath))),
    );
    socket.on('close', () =>
      finish(() => reject(new IpcClientError('protocol', 'connection closed before a reply'))),
    );
  });
}
