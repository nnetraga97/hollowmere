import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAzureOpenAIClient } from './azure.ts';
import { streamWithUsage } from './types.ts';

test('Azure adapter completes, streams, and embeds through the v1 API', async () => {
  const requests: { path: string; body: Record<string, unknown>; authorization: string }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({
        path: request.url ?? '', body,
        authorization: String(request.headers.authorization ?? ''),
      });

      if (request.url === '/openai/v1/embeddings') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          object: 'list', model: 'embedding-deployment',
          data: [
            { object: 'embedding', index: 1, embedding: [0, 1, 0, 0] },
            { object: 'embedding', index: 0, embedding: [1, 0, 0, 0] },
          ],
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }));
        return;
      }

      if (body.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"reasoning-deployment","choices":[{"index":0,"delta":{"content":"Good "},"finish_reason":null}]}\n\n');
        response.write('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"reasoning-deployment","choices":[{"index":0,"delta":{"content":"evening."},"finish_reason":"stop"}]}\n\n');
        response.write('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"reasoning-deployment","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: '1', object: 'chat.completion', created: 1, model: 'reasoning-deployment',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"type":"inquire"}' } }],
        usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 },
      }));
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const client = createAzureOpenAIClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key', reasoningModelId: 'reasoning-deployment',
      embeddingModelId: 'embedding-deployment', dimensions: 4, maxRetries: 0,
    });
    const request = {
      task: 'classify' as const, promptVersion: 'v1', system: 'Classify.',
      user: 'Where were you?', maxTokens: 40, seed: 1,
      choices: { types: ['inquire', 'smalltalk'] },
    };

    const completed = await client.complete(request);
    assert.equal(completed.text, '{"type":"inquire"}');
    assert.equal(completed.tokensIn, 6);

    const streamed = await streamWithUsage(client, { ...request, task: 'dialogue' });
    assert.equal(streamed.text, 'Good evening.');
    assert.deepEqual(streamed.usage, {
      tokensIn: 5, tokensOut: 2, modelId: 'reasoning-deployment',
      latencyMs: streamed.usage.latencyMs,
    });

    const embedded = await client.embed(['first', 'second']);
    assert.deepEqual(embedded.vectors, [[1, 0, 0, 0], [0, 1, 0, 0]]);
    assert.equal(embedded.tokensIn, 7);

    assert.equal(requests.length, 3);
    assert.ok(requests.every((item) => item.authorization === 'Bearer test-key'));
    assert.match(JSON.stringify(requests[0]?.body), /Choose only from these known values/);
    assert.deepEqual(requests[2]?.body.dimensions, 4);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
