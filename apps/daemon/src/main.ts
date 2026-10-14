#!/usr/bin/env node
import { HostsFileEnforcer } from '@hourkeep/platform';
import { ConfigError, USAGE, parseConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { createLogger } from './log.js';
import { createNotifier } from './notify.js';
import { createPeerResolver } from './peercred.js';
import { DAEMON_VERSION } from './version.js';

async function main(): Promise<void> {
  const logger = createLogger();
  let parsed;
  try {
    parsed = parseConfig(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`hourkeepd: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { command, config } = parsed;

  if (command === 'help') return void console.log(USAGE);
  if (command === 'version') return void console.log(`hourkeepd ${DAEMON_VERSION}`);

  if (command === 'teardown') {
    // Uninstall hook: remove what we manage in the hosts file and leave the database alone.
    const r = await new HostsFileEnforcer({ root: config.root, dryRun: config.dryRun }).teardown();
    logger.log('info', 'teardown complete', { removed: r.drifted, written: r.written });
    return;
  }

  const notifier = createNotifier(process.env, logger);
  const daemon = await startDaemon(config, {
    logger,
    notifier,
    resolvePeer: createPeerResolver(config.peercredPath, logger),
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.log('info', 'shutting down', { signal });
    daemon.stop().then(
      () => process.exit(0),
      (e: Error) => {
        logger.log('error', 'shutdown failed', { error: e.message });
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: Error) => {
  // Exit non-zero so systemd restarts us.
  console.error(`hourkeepd: fatal: ${e.message}`);
  process.exit(1);
});
