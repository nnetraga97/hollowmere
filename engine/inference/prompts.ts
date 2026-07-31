import { createHash } from 'node:crypto';

import type { CompletionRequest } from './types.ts';

export interface CompletionRequestSnapshot {
  task: CompletionRequest['task'];
  promptVersion: string;
  system: string;
  user: string;
  maxTokens: number;
  seed: number;
  choices: CompletionRequest['choices'] | null;
}

/** Append engine-owned allowlists to a provider-neutral system prompt. */
export function withChoiceConstraints(request: CompletionRequest): string {
  if (!request.choices) return request.system;
  const lines = Object.entries(request.choices)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `- ${key}: ${values.join(', ')}`);
  if (lines.length === 0) return request.system;
  return `${request.system}\n\nChoose only from these known values:\n${lines.join('\n')}`;
}

/**
 * The complete provider-neutral request after engine-owned choice constraints
 * have been appended. Azure and Bedrock serialize this into different wire
 * formats, but both receive these exact system and user strings.
 */
export function completionRequestSnapshot(
  request: CompletionRequest,
): CompletionRequestSnapshot {
  return {
    task: request.task,
    promptVersion: request.promptVersion,
    system: withChoiceConstraints(request),
    user: request.user,
    maxTokens: request.maxTokens,
    seed: request.seed,
    choices: request.choices ?? null,
  };
}

/** Fingerprint the full request rather than only the latest player sentence. */
export function completionRequestHash(request: CompletionRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(completionRequestSnapshot(request)))
    .digest('hex');
}
