import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

import {
  bedrockRuntimeClientConfig,
  createBedrockClient,
  describeBedrockError,
  isRetryableBedrockError,
} from './bedrock.ts';
import { InferenceError, streamWithUsage, type CompletionRequest } from './types.ts';

const encoder = new TextEncoder();

const REQUEST: CompletionRequest = {
  task: 'dialogue',
  promptVersion: 'bedrock-test-v1',
  system: 'Speak as the town archivist.',
  user: 'What did you remember?',
  maxTokens: 96,
  seed: 17,
  choices: { claims: ['physician_was_paid'] },
};

function runtimeClient(
  send: (command: unknown) => Promise<unknown>,
): Pick<BedrockRuntimeClient, 'send'> {
  return { send } as unknown as Pick<BedrockRuntimeClient, 'send'>;
}

test('Bedrock uses Converse for text and InvokeModel only for Titan embeddings', async () => {
  const commands: unknown[] = [];
  const client = createBedrockClient({
    reasoningModelId: 'us.anthropic.claude-sonnet-test',
    embeddingModelId: 'amazon.titan-embed-text-v2:0',
    dimensions: 4,
    runtimeClient: runtimeClient(async (command) => {
      commands.push(command);
      if (command instanceof ConverseCommand) {
        return {
          output: { message: { role: 'assistant', content: [{ text: 'I remember the quay.' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
          metrics: { latencyMs: 4 },
        };
      }
      if (command instanceof ConverseStreamCommand) {
        return {
          stream: (async function* () {
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'The ' } } };
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'quay.' } } };
            yield { messageStop: { stopReason: 'end_turn' } };
            yield {
              metadata: {
                usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
                metrics: { latencyMs: 3 },
              },
            };
          })(),
        };
      }
      if (command instanceof InvokeModelCommand) {
        return {
          body: encoder.encode(JSON.stringify({
            embedding: [1, 0, 0, 0], inputTextTokenCount: 2,
          })),
        };
      }
      throw new Error('unexpected command');
    }),
  });

  const completed = await client.complete(REQUEST);
  const streamed = await streamWithUsage(client, REQUEST);
  const embedded = await client.embed(['the quay']);

  assert.equal(completed.text, 'I remember the quay.');
  assert.equal(completed.tokensIn, 11);
  assert.equal(completed.tokensOut, 5);
  assert.equal(completed.stopReason, 'end_turn');
  assert.equal(streamed.text, 'The quay.');
  assert.equal(streamed.usage.tokensIn, 9);
  assert.equal(streamed.usage.tokensOut, 3);
  assert.equal(streamed.usage.stopReason, 'end_turn');
  assert.deepEqual(embedded.vectors, [[1, 0, 0, 0]]);

  const completionCommand = commands[0];
  const streamCommand = commands[1];
  const embeddingCommand = commands[2];
  assert.ok(completionCommand instanceof ConverseCommand);
  assert.ok(streamCommand instanceof ConverseStreamCommand);
  assert.ok(embeddingCommand instanceof InvokeModelCommand);
  assert.equal(completionCommand.input.inferenceConfig?.maxTokens, REQUEST.maxTokens);
  assert.equal(streamCommand.input.inferenceConfig?.maxTokens, REQUEST.maxTokens);
  assert.match(completionCommand.input.system?.[0]?.text ?? '', /Choose only from these known values/);
  assert.equal(completionCommand.input.messages?.[0]?.content?.[0]?.text, REQUEST.user);
  const encodedTitanBody = embeddingCommand.input.body;
  assert.equal(typeof encodedTitanBody, 'string');
  const titanBody = JSON.parse(encodedTitanBody as string) as {
    inputText: string; dimensions: number; normalize: boolean;
  };
  assert.deepEqual(titanBody, { inputText: 'the quay', dimensions: 4, normalize: true });
});

test('Bedrock runtime uses five adaptive attempts and preserves both timeouts', () => {
  const config = bedrockRuntimeClientConfig({
    region: 'us-east-1', connectTimeoutMs: 1_250, requestTimeoutMs: 8_000,
  });
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.maxAttempts, 5);
  assert.equal(config.retryMode, 'adaptive');
  assert.deepEqual(config.requestHandler, {
    connectionTimeout: 1_250,
    requestTimeout: 8_000,
  });
});

describe('Bedrock error handling', () => {
  for (const name of [
    'ThrottlingException',
    'ModelTimeoutException',
    'ServiceUnavailableException',
    'InternalServerException',
  ]) {
    test(`${name} is retryable by the adaptive SDK policy`, () => {
      const error = namedError(name, 'try again');
      assert.equal(isRetryableBedrockError(error), true);
      assert.match(describeBedrockError(error), /adaptive/i);
    });
  }

  for (const name of ['AccessDeniedException', 'ValidationException', 'ResourceNotFoundException']) {
    test(`${name} is not classified as retryable`, () => {
      assert.equal(isRetryableBedrockError(namedError(name, 'not allowed')), false);
    });
  }

  test('authorization failures retain an actionable, secret-free classification', async () => {
    const client = createBedrockClient({
      runtimeClient: runtimeClient(async () => {
        throw namedError('AccessDeniedException', 'not authorized');
      }),
    });
    await assert.rejects(
      client.complete(REQUEST),
      (error: unknown) => error instanceof InferenceError
        && /model access|bedrock:InvokeModel/i.test(error.message),
    );
  });

  test('an empty Converse response is rejected as malformed model output', async () => {
    const client = createBedrockClient({
      runtimeClient: runtimeClient(async () => ({
        output: { message: { role: 'assistant', content: [] } },
        stopReason: 'malformed_model_output',
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      })),
    });
    await assert.rejects(client.complete(REQUEST), /model returned no text content/);
  });
});

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
