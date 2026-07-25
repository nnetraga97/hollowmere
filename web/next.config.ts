import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: dirname(here),
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
};

export default config;
