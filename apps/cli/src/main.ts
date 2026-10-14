#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(`hourkeep: ${e.message}`);
    process.exitCode = 1;
  },
);
