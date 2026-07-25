/** Tiny live checks for Azure OpenAI completion, streaming, and embeddings. */

import { createAzureOpenAIClient } from '../engine/inference/azure.ts';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

function pass(label: string, detail = ''): void {
  console.log(`  ${GREEN}PASS${RESET}  ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.log(`  ${RED}FAIL${RESET}  ${label}\n        ${detail}`);
}

console.log('Azure OpenAI preflight');
console.log('======================\n');

let failures = 0;
let client;
try {
  client = createAzureOpenAIClient();
  console.log(`  endpoint:   ${process.env.AZURE_OPENAI_ENDPOINT}`);
  console.log(`  reasoning:  ${client.reasoningModelId}`);
  console.log(`  embeddings: ${client.embeddingModelId}\n`);
} catch (error) {
  fail('configuration', error);
  process.exit(1);
}

try {
  const result = await client.embed(['the prince is dead']);
  const vector = result.vectors[0] ?? [];
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (vector.length !== 1024) throw new Error(`expected 1024 dimensions, got ${vector.length}`);
  pass('embeddings', `${vector.length} dims · |v|=${magnitude.toFixed(3)} · ${result.tokensIn} tokens`);
} catch (error) {
  fail('embeddings', error);
  failures++;
}

try {
  const result = await client.complete({
    task: 'dialogue', promptVersion: 'azure-preflight',
    system: 'Reply with exactly the single word ready.', user: 'Are you ready?',
    maxTokens: 128, seed: 0,
  });
  pass('completion', `"${result.text.trim().slice(0, 60)}" · ${result.tokensIn}in/${result.tokensOut}out · ${result.latencyMs}ms`);
} catch (error) {
  fail('completion', error);
  failures++;
}

try {
  const result = await client.complete({
    task: 'plan', promptVersion: 'azure-preflight',
    system: 'Choose the best destination and return only JSON in the form {"targetLocationKey":"..."}.',
    user: 'Move somewhere public to hear the latest news.',
    choices: { targetLocationKey: ['tavern', 'quay'] },
    maxTokens: 128, seed: 0,
  });
  const decision = JSON.parse(result.text) as { targetLocationKey?: unknown };
  if (!['tavern', 'quay'].includes(String(decision.targetLocationKey))) {
    throw new Error(`unexpected constrained choice: ${result.text}`);
  }
  pass('structured choice', `${decision.targetLocationKey} · ${result.tokensIn}in/${result.tokensOut}out · ${result.latencyMs}ms`);
} catch (error) {
  fail('structured choice', error);
  failures++;
}

try {
  let chunks = 0;
  let text = '';
  const stream = client.stream({
    task: 'dialogue', promptVersion: 'azure-preflight',
    system: 'Reply with one short sentence.', user: 'Greet a stranger arriving in Hollowmere.',
    maxTokens: 128, seed: 0,
  });
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      pass('streaming', `${chunks} chunks · ${next.value.tokensIn}in/${next.value.tokensOut}out · "${text.trim().slice(0, 60)}"`);
      break;
    }
    chunks++;
    text += next.value;
  }
  if (chunks === 0 || !text.trim()) throw new Error('stream returned no text chunks');
} catch (error) {
  fail('streaming', error);
  failures++;
}

console.log();
if (failures === 0) {
  console.log(`${GREEN}Azure OpenAI is ready.${RESET} Set INFERENCE_MODE=azure to use it.\n`);
} else {
  console.log(`${RED}${failures} check(s) failed.${RESET}\n`);
  process.exitCode = 1;
}
