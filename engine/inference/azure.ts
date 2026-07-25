/** Azure OpenAI inference through the stable OpenAI v1 API. */

import OpenAI from 'openai';

import { withChoiceConstraints } from './prompts.ts';
import {
  InferenceError,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingResponse,
  type InferenceClient,
  type StreamUsage,
} from './types.ts';

const DEFAULT_REASONING_DEPLOYMENT = 'hollowmere-gpt-5-mini';
const DEFAULT_EMBEDDING_DEPLOYMENT = 'hollowmere-embedding-3-small';

export interface AzureOpenAIOptions {
  endpoint?: string;
  apiKey?: string;
  reasoningModelId?: string;
  embeddingModelId?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export function azureOpenAIBaseURL(endpoint: string): string {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/openai/v1') ? `${path}/` : `${path}/openai/v1/`;
  return url.toString();
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function requestBody(request: CompletionRequest, model: string) {
  return {
    model,
    messages: [
      { role: 'system' as const, content: withChoiceConstraints(request) },
      { role: 'user' as const, content: request.user },
    ],
    max_completion_tokens: request.maxTokens,
    // GPT-5 reasoning tokens count against max_completion_tokens. Minimal keeps
    // short engine decisions from spending their whole allowance internally.
    reasoning_effort: 'minimal' as const,
  };
}

export function createAzureOpenAIClient(
  options: AzureOpenAIOptions = {},
): InferenceClient {
  const endpoint = required(
    options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
    'AZURE_OPENAI_ENDPOINT',
  );
  const apiKey = required(
    options.apiKey ?? process.env.AZURE_OPENAI_API_KEY,
    'AZURE_OPENAI_API_KEY',
  );
  const reasoningModelId = options.reasoningModelId ??
    process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? DEFAULT_REASONING_DEPLOYMENT;
  const embeddingModelId = options.embeddingModelId ??
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? DEFAULT_EMBEDDING_DEPLOYMENT;
  const dimensions = options.dimensions ??
    Number(process.env.AZURE_OPENAI_EMBEDDING_DIM ?? 1024);

  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(`invalid Azure embedding dimension: ${dimensions}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: azureOpenAIBaseURL(endpoint),
    timeout: options.timeoutMs ?? Number(process.env.AZURE_OPENAI_TIMEOUT_MS ?? 30_000),
    maxRetries: options.maxRetries ?? Number(process.env.AZURE_OPENAI_MAX_RETRIES ?? 3),
  });

  return {
    mode: 'azure',
    reasoningModelId,
    embeddingModelId,
    dimensions,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const startedAt = Date.now();
      try {
        const response = await client.chat.completions.create(requestBody(request, reasoningModelId));
        const text = response.choices[0]?.message.content ?? '';
        if (!text) throw new InferenceError(request.task, 'model returned no text content');
        return {
          text,
          tokensIn: response.usage?.prompt_tokens ?? 0,
          tokensOut: response.usage?.completion_tokens ?? 0,
          modelId: reasoningModelId,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof InferenceError) throw error;
        throw new InferenceError(request.task, describe(error), { cause: error });
      }
    },

    async *stream(request: CompletionRequest): AsyncGenerator<string, StreamUsage, void> {
      const startedAt = Date.now();
      let response;
      try {
        response = await client.chat.completions.create({
          ...requestBody(request, reasoningModelId),
          stream: true,
          stream_options: { include_usage: true },
        });
      } catch (error) {
        throw new InferenceError(request.task, describe(error), { cause: error });
      }

      let tokensIn = 0;
      let tokensOut = 0;
      try {
        for await (const chunk of response) {
          if (chunk.usage) {
            tokensIn = chunk.usage.prompt_tokens;
            tokensOut = chunk.usage.completion_tokens;
          }
          const text = chunk.choices[0]?.delta.content;
          if (text) yield text;
        }
      } catch (error) {
        throw new InferenceError(request.task, describe(error), { cause: error });
      }
      return { tokensIn, tokensOut, modelId: reasoningModelId, latencyMs: Date.now() - startedAt };
    },

    async embed(texts: readonly string[]): Promise<EmbeddingResponse> {
      const startedAt = Date.now();
      if (texts.length === 0) {
        return { vectors: [], tokensIn: 0, modelId: embeddingModelId, latencyMs: 0 };
      }
      try {
        const response = await client.embeddings.create({
          model: embeddingModelId,
          input: [...texts],
          dimensions,
          encoding_format: 'float',
        });
        const vectors = [...response.data]
          .sort((left, right) => left.index - right.index)
          .map((item) => item.embedding);
        if (vectors.length !== texts.length) {
          throw new InferenceError(
            'embed',
            `expected ${texts.length} vectors, got ${vectors.length}`,
          );
        }
        for (const vector of vectors) {
          if (vector.length !== dimensions) {
            throw new InferenceError(
              'embed',
              `expected a ${dimensions}-dimension vector, got ${vector.length}`,
            );
          }
        }
        return {
          vectors,
          tokensIn: response.usage.prompt_tokens,
          modelId: embeddingModelId,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error instanceof InferenceError) throw error;
        throw new InferenceError('embed', describe(error), { cause: error });
      }
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    const request = error.requestID ? ` (request ${error.requestID})` : '';
    return `${error.status ?? 'HTTP'} ${error.name}: ${error.message}${request}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
