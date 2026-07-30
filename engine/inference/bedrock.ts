/**
 * AWS Bedrock inference: Claude for reasoning and dialogue, Titan Text
 * Embeddings V2 for memory vectors.
 *
 * Credentials are resolved by the AWS SDK's default chain (environment,
 * ~/.aws/credentials, SSO, instance role). This module never reads or stores a
 * key itself.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  InvokeModelCommand,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

import {
  InferenceError,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingResponse,
  type InferenceClient,
  type StreamUsage,
} from './types.ts';
import { withChoiceConstraints } from './prompts.ts';

/**
 * Timeouts, because the SDK ships without them.
 *
 * `NodeHttpHandler` defaults both of these to 0, meaning "wait forever". A
 * Bedrock call that never answers would then hang inside `runTick` step 4 while
 * the scheduler still holds that world's lease — the world stops advancing and
 * nothing times out to say so. On Fargate that is a stuck task, not an error.
 *
 * `requestTimeout` is socket *inactivity*, not total duration, so it bounds a
 * hung connection without cutting off a long stream that is still producing
 * tokens.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Total attempts, not retries. The adaptive SDK strategy owns backoff. */
const DEFAULT_MAX_ATTEMPTS = 5;

interface TitanResponse {
  embedding?: number[];
  inputTextTokenCount?: number;
}

export interface BedrockOptions {
  region?: string;
  reasoningModelId?: string;
  embeddingModelId?: string;
  dimensions?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  runtimeClient?: Pick<BedrockRuntimeClient, 'send'>;
}

export function bedrockRuntimeClientConfig(options: BedrockOptions = {}) {
  return {
    region: options.region ?? process.env.AWS_REGION ?? 'us-east-1',
    maxAttempts: positiveInteger(
      options.maxAttempts ?? Number(process.env.BEDROCK_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS),
      'BEDROCK_MAX_ATTEMPTS',
    ),
    retryMode: 'adaptive' as const,
    requestHandler: {
      connectionTimeout: positiveInteger(
        options.connectTimeoutMs
          ?? Number(process.env.BEDROCK_CONNECT_TIMEOUT_MS ?? DEFAULT_CONNECT_TIMEOUT_MS),
        'BEDROCK_CONNECT_TIMEOUT_MS',
      ),
      requestTimeout: positiveInteger(
        options.requestTimeoutMs
          ?? Number(process.env.BEDROCK_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS),
        'BEDROCK_REQUEST_TIMEOUT_MS',
      ),
    },
  };
}

export function createBedrockClient(options: BedrockOptions = {}): InferenceClient {
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const reasoningModelId =
    options.reasoningModelId ??
    process.env.BEDROCK_REASONING_MODEL ??
    'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  const embeddingModelId =
    options.embeddingModelId ??
    process.env.BEDROCK_EMBEDDING_MODEL ??
    'amazon.titan-embed-text-v2:0';
  const dimensions = options.dimensions ?? Number(process.env.BEDROCK_EMBEDDING_DIM ?? 1024);

  const client = options.runtimeClient
    ?? new BedrockRuntimeClient(bedrockRuntimeClientConfig({ ...options, region }));
  const decoder = new TextDecoder();

  const converseInput = (request: CompletionRequest) => ({
    modelId: reasoningModelId,
    system: [{ text: withChoiceConstraints(request) }],
    messages: [{ role: 'user' as const, content: [{ text: request.user }] }],
    inferenceConfig: {
      // Always explicit: Bedrock reserves quota from maxTokens at request start.
      maxTokens: request.maxTokens,
      // Replay, not provider sampling, is the deterministic contract.
      temperature: 0,
    },
  });

  return {
    mode: 'bedrock',
    reasoningModelId,
    embeddingModelId,
    dimensions,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const startedAt = Date.now();
      try {
        const response = await client.send(
          new ConverseCommand(converseInput(request)),
        );

        const text = (response.output?.message?.content ?? [])
          .map((block) => block.text ?? '')
          .join('');

        if (!text) {
          throw new InferenceError(request.task, 'model returned no text content');
        }

        return {
          text,
          tokensIn: response.usage?.inputTokens ?? 0,
          tokensOut: response.usage?.outputTokens ?? 0,
          modelId: reasoningModelId,
          latencyMs: Date.now() - startedAt,
          ...(response.stopReason ? { stopReason: response.stopReason } : {}),
        };
      } catch (error) {
        if (error instanceof InferenceError) throw error;
        throw new InferenceError(request.task, describeBedrockError(error), { cause: error });
      }
    },

    async *stream(request: CompletionRequest): AsyncGenerator<string, StreamUsage, void> {
      const startedAt = Date.now();
      let response;
      try {
        response = await client.send(
          new ConverseStreamCommand(converseInput(request)),
        );
      } catch (error) {
        throw new InferenceError(request.task, describeBedrockError(error), { cause: error });
      }

      let tokensIn = 0;
      let tokensOut = 0;
      let stopReason: string | undefined;

      try {
        for await (const event of response.stream ?? []) {
          const modeledError = streamError(event);
          if (modeledError) throw modeledError;
          const text = event.contentBlockDelta?.delta?.text;
          if (text) yield text;
          if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
          if (event.metadata?.usage) {
            tokensIn = event.metadata.usage.inputTokens ?? tokensIn;
            tokensOut = event.metadata.usage.outputTokens ?? tokensOut;
          }
        }
      } catch (error) {
        // A mid-stream failure was previously raw. The caller distinguishes
        // inference failures from engine failures by type, so it has to be
        // wrapped here as well as at the initial send.
        throw new InferenceError(request.task, describeBedrockError(error), { cause: error });
      }

      return {
        tokensIn,
        tokensOut,
        modelId: reasoningModelId,
        latencyMs: Date.now() - startedAt,
        ...(stopReason ? { stopReason } : {}),
      };
    },

    async embed(texts: readonly string[]): Promise<EmbeddingResponse> {
      const startedAt = Date.now();
      const vectors: number[][] = [];
      let tokensIn = 0;

      try {
        // Titan embeds one input per call. Requests are issued sequentially to
        // stay well inside per-account rate limits; batching happens at the
        // call site by embedding a whole tick's memories together.
        for (const text of texts) {
          const response = await client.send(
            new InvokeModelCommand({
              modelId: embeddingModelId,
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
            }),
          );

          const parsed = JSON.parse(decoder.decode(response.body)) as TitanResponse;
          if (!parsed.embedding || parsed.embedding.length !== dimensions) {
            throw new InferenceError(
              'embed',
              `expected a ${dimensions}-dimension vector, got ${parsed.embedding?.length ?? 0}`,
            );
          }
          vectors.push(parsed.embedding);
          tokensIn += parsed.inputTextTokenCount ?? 0;
        }
      } catch (error) {
        if (error instanceof InferenceError) throw error;
        throw new InferenceError('embed', describeBedrockError(error), { cause: error });
      }

      return {
        vectors,
        tokensIn,
        modelId: embeddingModelId,
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * Bedrock reports several very different problems with near-identical wording,
 * so map them to the actual remedy. The error name is always included: a wrong
 * hint costs more time than no hint.
 */
export function describeBedrockError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const base = `${error.name}: ${error.message}`;

  // "Operation not allowed" means the model agreement has not been accepted for
  // this account. Confusingly it arrives as a ValidationException, and it is
  // NOT about inference profiles.
  if (/operation not allowed/i.test(error.message)) {
    return `${base}\n        Model access is not granted for this model. Check with:\n` +
      `          aws bedrock get-foundation-model-availability --model-id <id> --region <region>\n` +
      `        If authorizationStatus is NOT_AUTHORIZED, enable it in the Bedrock console\n` +
      `        under Model access. See docs/aws-setup.md.`;
  }

  if (error.name === 'AccessDeniedException') {
    return `${base}\n        Either model access is not enabled in this region, or the caller ` +
      `lacks bedrock:InvokeModel.`;
  }

  if (error.name === 'ValidationException') {
    return `${base}\n        If this names an unknown model, newer Anthropic models must be ` +
      `invoked through a cross-region inference profile (the "us." prefix).`;
  }

  if (error.name === 'ThrottlingException') {
    return `${base}\n        Rate limited. The engine's per-world budget and cognition cap ` +
      `should normally keep it below this; the SDK has already applied adaptive retries.`;
  }

  if (isRetryableBedrockError(error)) {
    return `${base}\n        Bedrock remained unavailable after adaptive SDK retries.`;
  }

  return base;
}

export function isRetryableBedrockError(error: unknown): boolean {
  return error instanceof Error && new Set([
    'ThrottlingException',
    'ModelTimeoutException',
    'ServiceUnavailableException',
    'InternalServerException',
  ]).has(error.name);
}

function streamError(event: ConverseStreamOutput): Error | null {
  const modeled = event.internalServerException
    ?? event.modelStreamErrorException
    ?? event.validationException
    ?? event.throttlingException
    ?? event.serviceUnavailableException;
  if (!modeled) return null;
  const error = new Error(modeled.message ?? 'Bedrock stream failed');
  error.name = event.internalServerException ? 'InternalServerException'
    : event.modelStreamErrorException ? 'ModelStreamErrorException'
      : event.validationException ? 'ValidationException'
        : event.throttlingException ? 'ThrottlingException'
          : 'ServiceUnavailableException';
  return error;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
