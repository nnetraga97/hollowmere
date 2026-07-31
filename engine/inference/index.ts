/**
 * Inference client selection.
 *
 * The engine never constructs a client directly; it asks for one and gets
 * whatever `INFERENCE_MODE` dictates. That keeps the stub a first-class
 * runtime configuration rather than a test-only fixture, which is what makes
 * "run the whole simulation with no AWS account" true rather than aspirational.
 */

import { createBedrockClient, type BedrockOptions } from './bedrock.ts';
import { createAzureOpenAIClient, type AzureOpenAIOptions } from './azure.ts';
import { createStubClient, type StubOptions } from './stub.ts';
import { errorLogFields, logDebug, logError, logInfo } from '../core/log.ts';
import { completionRequestHash, completionRequestSnapshot } from './prompts.ts';
import type {
  CompletionRequest, InferenceClient, InferenceMode, StreamUsage,
} from './types.ts';

export * from './types.ts';
export { createStubClient, stubEmbed } from './stub.ts';
export { createBedrockClient } from './bedrock.ts';
export { createAzureOpenAIClient } from './azure.ts';

export interface InferenceOptions extends StubOptions, BedrockOptions, AzureOpenAIOptions {
  mode?: InferenceMode;
}

function resolveMode(explicit?: InferenceMode): InferenceMode {
  if (explicit) return explicit;
  const configured = process.env.INFERENCE_MODE;
  if (configured === 'bedrock' || configured === 'azure' || configured === 'stub' || configured === 'replay') {
    return configured;
  }
  // Defaulting to the stub is deliberate: an unconfigured environment should
  // never start spending money on inference by accident.
  return 'stub';
}

export function createInferenceClient(options: InferenceOptions = {}): InferenceClient {
  const mode = resolveMode(options.mode);
  let client: InferenceClient;

  switch (mode) {
    case 'bedrock':
      client = createBedrockClient(options);
      break;

    case 'azure':
      client = createAzureOpenAIClient(options);
      break;

    case 'stub':
      client = createStubClient(options);
      break;

    case 'replay':
      // Replay is served by the cognition layer, which reads recorded decisions
      // from cognition_records and never reaches this client. Falling back to
      // the stub here would silently fabricate decisions for any gap in the
      // recording, so refuse instead.
      throw new Error(
        'replay mode is handled by the cognition layer, not by createInferenceClient',
      );
  }

  logInfo('inference_client_created', {
    mode: client.mode,
    reasoningModelId: client.reasoningModelId,
    embeddingModelId: client.embeddingModelId,
    dimensions: client.dimensions,
  });
  return withInferenceLogging(client);
}

function withInferenceLogging(client: InferenceClient): InferenceClient {
  const successLog = client.mode === 'stub' ? logDebug : logInfo;
  return {
    mode: client.mode,
    reasoningModelId: client.reasoningModelId,
    embeddingModelId: client.embeddingModelId,
    dimensions: client.dimensions,

    async complete(request) {
      const startedAt = Date.now();
      try {
        logLocalInferencePrompt(client, request, 'complete');
        const response = await client.complete(request);
        successLog('inference_completion_succeeded', {
          mode: client.mode,
          task: request.task,
          promptVersion: request.promptVersion,
          modelId: response.modelId,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          stopReason: response.stopReason,
          latencyMs: response.latencyMs,
          wallTimeMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        logInferenceFailure('inference_completion_failed', client, request, startedAt, error);
        throw error;
      }
    },

    async *stream(request): AsyncGenerator<string, StreamUsage, void> {
      const startedAt = Date.now();
      let chunks = 0;
      try {
        logLocalInferencePrompt(client, request, 'stream');
        const stream = client.stream(request);
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            successLog('inference_stream_succeeded', {
              mode: client.mode,
              task: request.task,
              promptVersion: request.promptVersion,
              modelId: next.value.modelId,
              tokensIn: next.value.tokensIn,
              tokensOut: next.value.tokensOut,
              stopReason: next.value.stopReason,
              latencyMs: next.value.latencyMs,
              wallTimeMs: Date.now() - startedAt,
              chunks,
            });
            return next.value;
          }
          chunks++;
          yield next.value;
        }
      } catch (error) {
        logInferenceFailure('inference_stream_failed', client, request, startedAt, error);
        throw error;
      }
    },

    async embed(texts) {
      const startedAt = Date.now();
      try {
        const response = await client.embed(texts);
        successLog('inference_embedding_succeeded', {
          mode: client.mode,
          modelId: response.modelId,
          inputs: texts.length,
          inputCharacters: texts.reduce((sum, text) => sum + text.length, 0),
          tokensIn: response.tokensIn,
          latencyMs: response.latencyMs,
          wallTimeMs: Date.now() - startedAt,
        });
        return response;
      } catch (error) {
        logError('inference_embedding_failed', {
          mode: client.mode,
          modelId: client.embeddingModelId,
          inputs: texts.length,
          inputCharacters: texts.reduce((sum, text) => sum + text.length, 0),
          wallTimeMs: Date.now() - startedAt,
          ...errorLogFields(error),
        });
        throw error;
      }
    },
  };
}

function logLocalInferencePrompt(
  client: InferenceClient,
  request: CompletionRequest,
  operation: 'complete' | 'stream',
): void {
  if (process.env.LOG_INFERENCE_PROMPTS !== 'true' || process.env.NODE_ENV === 'production') {
    return;
  }
  logInfo('inference_prompt_sent', {
    mode: client.mode,
    modelId: client.reasoningModelId,
    operation,
    promptHash: completionRequestHash(request),
    request: completionRequestSnapshot(request),
  });
}

function logInferenceFailure(
  event: string,
  client: InferenceClient,
  request: CompletionRequest,
  startedAt: number,
  error: unknown,
): void {
  logError(event, {
    mode: client.mode,
    task: request.task,
    promptVersion: request.promptVersion,
    modelId: client.reasoningModelId,
    wallTimeMs: Date.now() - startedAt,
    ...errorLogFields(error),
  });
}
