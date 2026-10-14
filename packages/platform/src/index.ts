export type {
  EnforcerOptions,
  Observed,
  PlatformEnforcer,
  ReconcileIntent,
  ReconcileResult,
  TamperKind,
} from './enforcer.js';
export { HostsFileEnforcer, type HostsEnforcerOptions } from './linux/hosts-enforcer.js';
export { atomicWriteFile, type FileOps, type WriteMethod } from './linux/atomic-write.js';
export {
  BEGIN_MARKER,
  END_MARKER,
  applyBlock,
  findBlock,
  parseBlockDomains,
  renderBlock,
} from './linux/hosts-block.js';
