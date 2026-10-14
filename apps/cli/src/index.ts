import { PROTOCOL_VERSION } from '@hourkeep/ipc';

/** Version line. Placeholder until M1. */
export function versionLine(): string {
  return `hourkeep (protocol v${PROTOCOL_VERSION})`;
}
