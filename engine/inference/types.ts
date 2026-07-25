/**
 * The inference boundary.
 *
 * Everything that talks to a model goes through this interface, which exists so
 * the entire rule engine — gossip, tension, escalation, retrieval ordering —
 * can be built and tested with zero network calls and zero AWS spend.
 *
 * Requests are *task-typed* rather than free-form prompts. A generic
 * `complete(prompt)` would force the stub to be a general language model, which
 * it cannot be; naming the task lets the stub produce a valid, deterministic
 * answer of the right shape for each one. It also gives replay a stable key.
 */

export type InferenceMode = 'stub' | 'bedrock' | 'azure' | 'replay';

/** Only live provider calls are billable; deterministic stub and replay are not. */
export function isBillableInferenceMode(mode: InferenceMode): boolean {
  return mode === 'bedrock' || mode === 'azure';
}

/**
 * The tasks the engine asks a model to perform. Adding a task here is a
 * deliberate act: the stub must be taught to answer it too, otherwise the
 * deterministic path silently diverges from the real one.
 */
export type InferenceTask =
  /** Choose an intention, a destination, and an action for one agent. */
  | 'plan'
  /** Synthesise several memories into one higher-level belief. */
  | 'reflect'
  /** Speak as an NPC to the player. */
  | 'dialogue'
  /** Decide what speech act the player just performed. */
  | 'classify'
  /** Reword a rumor as it passes from one mouth to the next. */
  | 'distort'
  /** Choose the instigator's next allowlisted move. */
  | 'strategy'
  /** Decide whether an NPC attends a hearing. */
  | 'attendance'
  /** Decide how an NPC answers a provenance inquiry. */
  | 'inquire'
  /** Produce one structured reply inside an ongoing player conversation. */
  | 'conversation_turn'
  /** Produce one structured NPC-to-NPC conversational exchange. */
  | 'npc_conversation';

export interface CompletionRequest {
  task: InferenceTask;
  /**
   * Bumped whenever a prompt's wording changes. Recorded alongside every
   * decision so replaying a world against a newer prompt is detected rather
   * than silently producing different behaviour.
   */
  promptVersion: string;
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Deterministic seed, derived from (world_id, tick, agent, task). The stub
   * uses it directly; Bedrock ignores it.
   */
  seed: number;
  /**
   * Valid options the answer must be drawn from, e.g. reachable location keys
   * or known claim keys. The stub picks from these, so it always produces a
   * usable answer without embedding scenario knowledge. Real models receive
   * them in the prompt as constraints.
   */
  choices?: Readonly<Record<string, readonly string[]>>;
}

export interface CompletionResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  modelId: string;
  latencyMs: number;
}

export interface EmbeddingResponse {
  /** One vector per input, each of length `dimensions`. */
  vectors: readonly (readonly number[])[];
  tokensIn: number;
  modelId: string;
  latencyMs: number;
}

/**
 * What a streamed call cost, delivered as the generator's *return* value once
 * the last token has been yielded.
 *
 * It has to arrive this way rather than as a resolved promise alongside the
 * stream, because the token counts do not exist until the model says it is
 * finished — Bedrock reports them on the closing chunk. A caller that only
 * wants the text can still `for await` and ignore this; a caller that has to
 * bill for it drives the iterator and reads `done.value`, which is why
 * `streamWithUsage` exists.
 */
export interface StreamUsage {
  tokensIn: number;
  tokensOut: number;
  modelId: string;
  latencyMs: number;
}

export interface InferenceClient {
  readonly mode: InferenceMode;
  readonly reasoningModelId: string;
  readonly embeddingModelId: string;
  readonly dimensions: number;

  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Token-by-token output for player-facing dialogue. */
  stream(request: CompletionRequest): AsyncGenerator<string, StreamUsage, void>;
  embed(texts: readonly string[]): Promise<EmbeddingResponse>;
}

/**
 * Consume a stream to completion, forwarding each token and returning both the
 * assembled text and what it cost.
 *
 * `for await ... of` silently discards a generator's return value, so every
 * caller that needs the usage would otherwise have to hand-roll the same
 * `while (!done)` loop — and one that forgot would under-report spend without
 * failing anything. Having a single helper is what keeps that from happening.
 */
export async function streamWithUsage(
  client: InferenceClient,
  request: CompletionRequest,
  onToken?: (token: string) => void,
): Promise<{ text: string; usage: StreamUsage }> {
  const stream = client.stream(request);
  let text = '';
  for (;;) {
    const next = await stream.next();
    if (next.done) return { text, usage: next.value };
    text += next.value;
    onToken?.(next.value);
  }
}

/** Thrown when a model returns something the engine cannot use. */
export class InferenceError extends Error {
  readonly task: InferenceTask | 'embed';
  constructor(task: InferenceTask | 'embed', message: string, options?: { cause?: unknown }) {
    super(`inference failed (${task}): ${message}`, options);
    this.name = 'InferenceError';
    this.task = task;
  }
}
