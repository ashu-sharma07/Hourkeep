import * as net from 'node:net';
import type { PeerInfo } from '@hourkeep/ipc';
import type { Logger } from './log.js';

interface Addon {
  getPeerCred(fd: number): { pid: number; uid: number; gid: number };
}

/**
 * Build a peer resolver backed by the SO_PEERCRED addon (apps/daemon/native/peercred.c).
 * Without the addon every caller is reported as unknown (null); access is then still gated
 * by the socket's group permissions, which is the primary control.
 */
export function createPeerResolver(
  addonPath: string | null,
  logger: Logger,
): (socket: net.Socket) => PeerInfo | null {
  if (addonPath === null) return () => null;
  const mod: { exports: Partial<Addon> } = { exports: {} };
  try {
    process.dlopen(mod as NodeJS.Module, addonPath);
  } catch (e) {
    logger.log('warn', 'peer credential addon not loaded; caller UIDs will be unknown', {
      path: addonPath,
      error: (e as Error).message,
    });
    return () => null;
  }
  const addon = mod.exports as Addon;
  return (socket) => {
    // `_handle.fd` is undocumented but is the only way to reach the descriptor from Node.
    // A test fails loudly if it disappears (see peercred.test.ts).
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    if (typeof fd !== 'number' || fd < 0) return null;
    try {
      return addon.getPeerCred(fd);
    } catch (e) {
      logger.log('warn', 'SO_PEERCRED lookup failed', { error: (e as Error).message });
      return null;
    }
  };
}
