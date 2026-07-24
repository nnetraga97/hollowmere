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
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

import {
  InferenceError,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingResponse,
  type InferenceClient,
} from './types.ts';

const ANTHROPIC_VERSION = 'bedrock-2023-05-31';

interface ClaudeResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface TitanResponse {
  embedding?: number[];
  inputTextTokenCount?: number;
}

export interface BedrockOptions {
  region?: string;
  reasoningModelId?: string;
  embeddingModelId?: string;
  dimensions?: number;
}

/**
 * Constraints are appended to the system prompt rather than trusted to the
 * model's imagination: the engine can only act on keys it already knows, so a
 * hallucinated location or claim key is a wasted call.
 */
function withChoiceConstraints(request: CompletionRequest): string {
  if (!request.choices) return request.system;
  const lines = Object.entries(request.choices)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `- ${key}: ${values.join(', ')}`);
  if (lines.length === 0) return request.system;
  return `${request.system}\n\nChoose only from these known values:\n${lines.join('\n')}`;
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

  const client = new BedrockRuntimeClient({ region });
  const decoder = new TextDecoder();

  const buildBody = (request: CompletionRequest): string =>
    JSON.stringify({
      anthropic_version: ANTHROPIC_VERSION,
      max_tokens: request.maxTokens,
      system: withChoiceConstraints(request),
      messages: [{ role: 'user', content: request.user }],
      // Zero temperature does not make Bedrock reproducible, but it does keep
      // NPC behaviour stable enough to reason about while tuning. True
      // reproducibility comes from replaying cognition_records.
      temperature: 0,
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
          new InvokeModelCommand({
            modelId: reasoningModelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: buildBody(request),
          }),
        );

        const parsed = JSON.parse(decoder.decode(response.body)) as ClaudeResponse;
        const text = (parsed.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        if (!text) {
          throw new InferenceError(request.task, 'model returned no text content');
        }

        return {
          text,
          tokensIn: parsed.usage?.input_tokens ?? 0,
          tokensOut: parsed.usage?.output_tokens ?? 0,
          modelId: reasoningModelId,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof InferenceError) throw error;
        throw new InferenceError(request.task, describe(error), { cause: error });
      }
    },

    async *stream(request: CompletionRequest): AsyncIterable<string> {
      let response;
      try {
        response = await client.send(
          new InvokeModelWithResponseStreamCommand({
            modelId: reasoningModelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: buildBody(request),
          }),
        );
      } catch (error) {
        throw new InferenceError(request.task, describe(error), { cause: error });
      }

      for await (const event of response.body ?? []) {
        const bytes = event.chunk?.bytes;
        if (!bytes) continue;
        const chunk = JSON.parse(decoder.decode(bytes)) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          yield chunk.delta.text;
        }
      }
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
        throw new InferenceError('embed', describe(error), { cause: error });
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
function describe(error: unknown): string {
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
      `should normally keep it below this.`;
  }

  return base;
}
