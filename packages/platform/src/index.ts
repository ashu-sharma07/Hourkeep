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
export { SuffixMatcher, type Match, type SuffixSpec } from './dns/matcher.js';
export { RCODE, TYPE, buildQuery, parseQuery, rcodeOf, type Query } from './dns/packet.js';
export { startDnsServer, type DnsServer, type DnsServerOptions, type QueryEvent, type Upstream } from './dns/server.js';
