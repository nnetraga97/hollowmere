/** Start Next from the repository root with the root development environment. */

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { logInfo } from '../engine/core/log.ts';

const command = process.argv[2] ?? 'dev';
if (!['dev', 'build', 'start'].includes(command)) {
  throw new Error(`unsupported Next command: ${command}`);
}

if (existsSync('.env')) loadEnvFile('.env');
process.env.SERVICE_NAME ??= 'hollowmere-web';
logInfo('web_process_starting', { command, pid: process.pid });

// The Next CLI reads process.argv when its module loads. Keeping it in this
// process avoids forwarding --env-file through NODE_OPTIONS to its dev child.
process.argv = [process.execPath, 'next', command, 'web'];
await import(new URL('../node_modules/next/dist/bin/next', import.meta.url).href);
