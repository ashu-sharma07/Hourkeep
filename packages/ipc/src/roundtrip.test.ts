import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpcClientError, call } from './client.js';
import { createIpcServer, type IpcServer, type RequestHandler } from './server.js';

let dir: string;
let sock: string;
let server: IpcServer | undefined;
const errors: unknown[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-ipc-'));
  sock = path.join(dir, 's.sock');
  errors.length = 0;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const statusData = {
  daemonVersion: 't',
  protocol: 1 as const,
  dryRun: true,
  ruleCount: 0,
  blockedDomainCount: 0,
  lastReconcileAt: null,
  tamperCount: 0,
  lastTamperAt: null,
};

const handler: RequestHandler = async (req, ctx) => {
  switch (req.op) {
    case 'status':
      return { ok: true, data: { ...statusData, callerUid: ctx.peer?.uid ?? null } };
    case 'block':
      if (req.target === 'boom') throw new Error('secret internal detail');
      if (req.target === 'bad') return { ok: false, code: 'invalid_target', message: 'nope' };
      return {
        ok: true,
        data: {
          rule: { kind: 'domain', target: req.target, createdAt: 1 },
          added: true,
          blockedDomainCount: 1,
        },
      };
    default:
      return { ok: false, code: 'not_found', message: 'unsupported in test' };
  }
};

async function start(extra: Partial<Parameters<typeof createIpcServer>[0]> = {}) {
  server = await createIpcServer({
    socketPath: sock,
    handler,
    onError: (e) => errors.push(e),
    resolvePeer: () => ({ uid: 4242, gid: 1, pid: 99 }),
    ...extra,
  });
}

/** Send raw bytes; resolve once `lines` reply lines arrived or the server closed the socket. */
function raw(bytes: string | Buffer, lines = 1): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    let out = '';
    const done = (): void => {
      s.destroy();
      resolve(out);
    };
    s.on('data', (d) => {
      out += d;
      if (out.split('\n').length - 1 >= lines) done();
    });
    s.on('connect', () => s.write(bytes));
    s.on('error', () => undefined);
    s.on('close', done);
    setTimeout(done, 2000);
  });
}

describe('ipc client and server', () => {
  it('round-trips a request and reports the peer uid', async () => {
    await start();
    const r = await call(sock, 'status', {});
    expect(r.ok && r.data.callerUid).toBe(4242);
  });

  it('creates the socket with mode 0660', async () => {
    await start();
    expect(fs.statSync(sock).mode & 0o777).toBe(0o660);
  });

  it('honours a different mode and calls onListening', async () => {
    let seen = '';
    await start({ mode: 0o600, onListening: (p) => (seen = p) });
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    expect(seen).toBe(sock);
  });

  it('passes handler errors to the client with a code', async () => {
    await start();
    const r = await call(sock, 'block', { target: 'bad' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
  });

  it('hides exception details behind an internal error and reports them locally', async () => {
    await start();
    const r = await call(sock, 'block', { target: 'boom' });
    expect(r).toMatchObject({ ok: false, error: { code: 'internal', message: 'internal error' } });
    expect(String((errors[0] as Error).message)).toContain('secret internal detail');
  });

  it('answers pipelined requests on one connection in order', async () => {
    await start();
    const lines =
      [1, 2, 3].map((n) => JSON.stringify({ v: 1, id: `r${n}`, op: 'status' })).join('\n') + '\n';
    const out = (await raw(lines))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(out.map((o) => o.id)).toEqual(['r1', 'r2', 'r3']);
  });

  describe('hostile input', () => {
    it('rejects invalid JSON and closes', async () => {
      await start();
      const out = JSON.parse(await raw('{nope\n'));
      expect(out).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    });

    it('rejects an unsupported protocol version and echoes the id', async () => {
      await start();
      const out = JSON.parse(await raw(JSON.stringify({ v: 99, id: 'zz', op: 'status' }) + '\n'));
      expect(out).toMatchObject({ id: 'zz', ok: false, error: { code: 'unsupported_version' } });
    });

    it('rejects unknown fields without running the handler', async () => {
      let calls = 0;
      await start({ handler: async (...a) => (calls++, handler(...a)) });
      const out = JSON.parse(
        await raw(JSON.stringify({ v: 1, id: 'a', op: 'status', admin: true }) + '\n'),
      );
      expect(out).toMatchObject({ ok: false, error: { code: 'bad_request' } });
      expect(calls).toBe(0);
    });

    it('keeps the connection usable after a validation error', async () => {
      await start();
      const out = (
        await raw(
          JSON.stringify({ v: 1, id: 'a', op: 'nope' }) +
            '\n' +
            JSON.stringify({ v: 1, id: 'b', op: 'status' }) +
            '\n',
        )
      )
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(out.map((o) => o.ok)).toEqual([false, true]);
    });

    it('cuts off an oversize message with too_large', async () => {
      await start();
      const out = JSON.parse(await raw('x'.repeat(70_000)));
      expect(out).toMatchObject({ ok: false, error: { code: 'too_large' } });
    });

    it('drops idle connections', async () => {
      await start({ idleTimeoutMs: 50 });
      const closed = await new Promise<boolean>((resolve) => {
        const s = net.connect(sock);
        s.on('close', () => resolve(true));
        s.on('error', () => undefined);
        setTimeout(() => resolve(false), 1000);
      });
      expect(closed).toBe(true);
    });
  });

  describe('socket file handling', () => {
    it('removes the socket file on close', async () => {
      await start();
      await server?.close();
      server = undefined;
      expect(fs.existsSync(sock)).toBe(false);
    });

    it('replaces a stale socket left by a crashed daemon', async () => {
      // A process killed with SIGKILL leaves its socket file behind.
      const child = spawn(
        process.execPath,
        [
          '-e',
          `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      await new Promise((r) => child.stdout.once('data', r));
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      expect(fs.existsSync(sock)).toBe(true);
      await start();
      expect((await call(sock, 'status', {})).ok).toBe(true);
    });

    it('refuses to start on a live socket', async () => {
      await start();
      await expect(createIpcServer({ socketPath: sock, handler })).rejects.toThrow(
        /already listening/,
      );
    });

    it('refuses to replace a regular file', async () => {
      fs.writeFileSync(sock, 'precious');
      await expect(createIpcServer({ socketPath: sock, handler })).rejects.toThrow(/not a socket/);
      expect(fs.readFileSync(sock, 'utf8')).toBe('precious');
    });
  });

  describe('client errors', () => {
    it('reports not-running when nothing listens', async () => {
      await expect(call(sock, 'status', {})).rejects.toMatchObject({ kind: 'not-running' });
    });

    it('times out when the server never answers', async () => {
      await start({ handler: () => new Promise(() => undefined) });
      await expect(call(sock, 'status', {}, { timeoutMs: 100 })).rejects.toMatchObject({
        kind: 'timeout',
      });
    });

    it('rejects replies that do not match the schema', async () => {
      const fake = net.createServer((c) =>
        c.on('data', () => c.write('{"v":1,"id":"","ok":true,"data":{}}\n')),
      );
      await new Promise<void>((r) => fake.listen(sock, r));
      try {
        await expect(call(sock, 'status', {})).rejects.toBeInstanceOf(IpcClientError);
      } finally {
        fake.close();
      }
    });

    it('rejects a reply with the wrong id', async () => {
      const fake = net.createServer((c) =>
        c.on('data', () =>
          c.write(
            JSON.stringify({
              v: 1,
              id: 'other',
              ok: true,
              data: { ...statusData, callerUid: null },
            }) + '\n',
          ),
        ),
      );
      await new Promise<void>((r) => fake.listen(sock, r));
      try {
        await expect(call(sock, 'status', {})).rejects.toMatchObject({ kind: 'protocol' });
      } finally {
        fake.close();
      }
    });
  });
});
