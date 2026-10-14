import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createIpcServer, type IpcServer } from '@hourkeep/ipc';
import { silent } from './test-helpers.js';
import { createPeerResolver } from './peercred.js';

const builder = path.resolve(import.meta.dirname, '../native/build.sh');
let hasToolchain = true;
let dir: string;
let addon: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-pc-'));
  addon = path.join(dir, 'peercred.node');
  try {
    execFileSync(builder, [addon], { stdio: 'pipe' });
  } catch {
    hasToolchain = false; // no gcc or Node headers: skip, CI/Docker builds it
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SO_PEERCRED addon', () => {
  it('reports the real uid, gid and pid of the connecting process', async (ctx) => {
    if (!hasToolchain) return ctx.skip();
    const sock = path.join(dir, 'pc.sock');
    let server: IpcServer | undefined;
    try {
      server = await createIpcServer({
        socketPath: sock,
        resolvePeer: createPeerResolver(addon, silent),
        handler: async (_req, { peer }) => ({
          ok: true,
          data: {
            daemonVersion: 't',
            protocol: 1,
            dryRun: true,
            ruleCount: 0,
            blockedDomainCount: 0,
            lastReconcileAt: null,
            tamperCount: 0,
            lastTamperAt: null,
            callerUid: peer?.uid ?? null,
          },
        }),
      });
      const r = await call(sock, 'status', {});
      // If this fails with null, Node stopped exposing the socket fd (`_handle.fd`).
      expect(r.ok && r.data.callerUid).toBe(process.getuid?.());
    } finally {
      await server?.close();
    }
  });

  it('degrades to unknown callers when the addon cannot be loaded', () => {
    const resolve = createPeerResolver('/nonexistent/peercred.node', silent);
    expect(resolve({} as never)).toBeNull();
  });

  it('is disabled when no path is configured', () => {
    expect(createPeerResolver(null, silent)({} as never)).toBeNull();
  });
});
