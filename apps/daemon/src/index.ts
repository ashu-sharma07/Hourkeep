import { PROTOCOL_VERSION } from '@hourkeep/ipc';

/** Startup banner. Placeholder until M1. */
export function banner(): string {
  return `hourkeepd (protocol v${PROTOCOL_VERSION})`;
}
