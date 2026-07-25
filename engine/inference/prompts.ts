import type { CompletionRequest } from './types.ts';

/** Append engine-owned allowlists to a provider-neutral system prompt. */
export function withChoiceConstraints(request: CompletionRequest): string {
  if (!request.choices) return request.system;
  const lines = Object.entries(request.choices)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => `- ${key}: ${values.join(', ')}`);
  if (lines.length === 0) return request.system;
  return `${request.system}\n\nChoose only from these known values:\n${lines.join('\n')}`;
}
