/**
 * Verify Bedrock is usable before the engine depends on it.
 *
 * Makes two deliberately tiny calls — one embedding, one ~10-token completion —
 * costing a fraction of a cent in total. Model access and credentials fail in
 * very similar-looking ways, so this separates them and says which is wrong.
 *
 *   node --env-file-if-exists=.env scripts/check-bedrock.ts
 */

import { createBedrockClient } from '../engine/inference/bedrock.ts';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${GREEN}PASS${RESET}  ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label: string, detail: string): void {
  console.log(`  ${RED}FAIL${RESET}  ${label}\n        ${detail}`);
}

const region = process.env.AWS_REGION ?? 'us-east-1';
const hasStaticKeys = Boolean(process.env.AWS_ACCESS_KEY_ID);
const hasProfile = Boolean(process.env.AWS_PROFILE);

console.log('Bedrock preflight');
console.log('=================\n');
console.log(`  region:    ${region}`);
console.log(`  credentials: ${
  hasStaticKeys ? 'environment variables' : hasProfile ? `profile ${process.env.AWS_PROFILE}` : 'default chain (~/.aws, SSO, or instance role)'
}\n`);

const client = createBedrockClient({ region });
let failures = 0;

console.log('Embeddings');
try {
  const result = await client.embed(['the prince is dead']);
  const vector = result.vectors[0] ?? [];
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  pass(`${client.embeddingModelId}`, `${vector.length} dims, |v|=${magnitude.toFixed(3)}`);

  if (vector.length !== client.dimensions) {
    fail('embedding dimension matches the schema',
      `schema declares VECTOR(${client.dimensions}) but the model returned ${vector.length}. ` +
      'Set BEDROCK_EMBEDDING_DIM, or change the column, or they will never agree.');
    failures++;
  } else {
    pass('embedding dimension matches VECTOR(1024) in the schema');
  }
} catch (error) {
  fail(`${client.embeddingModelId}`, error instanceof Error ? error.message : String(error));
  failures++;
}

console.log('\nReasoning');
try {
  const result = await client.complete({
    task: 'dialogue',
    promptVersion: 'preflight',
    system: 'Reply with exactly one short word.',
    user: 'Say the word: ready',
    maxTokens: 10,
    seed: 0,
  });
  pass(`${client.reasoningModelId}`,
    `"${result.text.trim().slice(0, 40)}" · ${result.tokensIn}in/${result.tokensOut}out · ${result.latencyMs}ms`);
} catch (error) {
  fail(`${client.reasoningModelId}`, error instanceof Error ? error.message : String(error));
  failures++;
}

console.log('\nStreaming');
try {
  let chunks = 0;
  for await (const _ of client.stream({
    task: 'dialogue',
    promptVersion: 'preflight',
    system: 'Reply with a short sentence.',
    user: 'Greet a stranger arriving in a small town.',
    maxTokens: 40,
    seed: 0,
  })) {
    chunks++;
  }
  pass('response streaming', `${chunks} chunks`);
} catch (error) {
  fail('response streaming', error instanceof Error ? error.message : String(error));
  failures++;
}

console.log();
if (failures === 0) {
  console.log(`${GREEN}Bedrock is ready.${RESET} Set BEDROCK_ENABLED=true to expose it to new worlds.\n`);
} else {
  console.log(`${RED}${failures} check(s) failed.${RESET}`);
  console.log('Azure remains the only enabled world profile while you sort this out.');
  console.log('See docs/aws-setup.md.\n');
  process.exitCode = 1;
}
