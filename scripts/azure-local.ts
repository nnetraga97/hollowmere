/**
 * Launch a local Hollowmere process with Azure OpenAI credentials supplied by
 * the authenticated Azure CLI. The resource key is never printed or written.
 */

import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const RESOURCE_GROUP = 'hollowmere-test-rg';
const ACCOUNT = 'hollowmere-ai-nnetraga97';
const ENDPOINT = 'https://hollowmere-ai-nnetraga97.openai.azure.com/';

const target = process.argv[2];
const commands: Record<string, string[]> = {
  check: ['scripts/check-azure.ts'],
  scheduler: ['scheduler/worker.ts'],
  web: ['scripts/web.ts', 'dev'],
};
const args = target ? commands[target] : undefined;
if (!args) {
  throw new Error('usage: node scripts/azure-local.ts <check|scheduler|web>');
}

const apiKey = process.env.AZURE_OPENAI_API_KEY ?? execFileSync(
  'az',
  [
    'cognitiveservices', 'account', 'keys', 'list',
    '--resource-group', RESOURCE_GROUP,
    '--name', ACCOUNT,
    '--query', 'key1',
    '--output', 'tsv',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
).trim();

if (!apiKey) throw new Error('Azure CLI returned an empty Azure OpenAI key');

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    INFERENCE_MODE: 'azure',
    AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT ?? ENDPOINT,
    AZURE_OPENAI_API_KEY: apiKey,
    AZURE_OPENAI_REASONING_DEPLOYMENT:
      process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? 'hollowmere-gpt-5-mini',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT:
      process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? 'hollowmere-embedding-3-small',
    AZURE_OPENAI_EMBEDDING_DIM: process.env.AZURE_OPENAI_EMBEDDING_DIM ?? '1024',
  },
});

const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
if (signal) process.kill(process.pid, signal);
else process.exitCode = code ?? 1;
