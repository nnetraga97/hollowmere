/**
 * Inference client selection.
 *
 * The engine never constructs a client directly; it asks for one and gets
 * whatever `INFERENCE_MODE` dictates. That keeps the stub a first-class
 * runtime configuration rather than a test-only fixture, which is what makes
 * "run the whole simulation with no AWS account" true rather than aspirational.
 */

import { createBedrockClient, type BedrockOptions } from './bedrock.ts';
import { createStubClient, type StubOptions } from './stub.ts';
import type { InferenceClient, InferenceMode } from './types.ts';

export * from './types.ts';
export { createStubClient, stubEmbed } from './stub.ts';
export { createBedrockClient } from './bedrock.ts';

export interface InferenceOptions extends StubOptions, BedrockOptions {
  mode?: InferenceMode;
}

function resolveMode(explicit?: InferenceMode): InferenceMode {
  if (explicit) return explicit;
  const configured = process.env.INFERENCE_MODE;
  if (configured === 'bedrock' || configured === 'stub' || configured === 'replay') {
    return configured;
  }
  // Defaulting to the stub is deliberate: an unconfigured environment should
  // never start spending money on inference by accident.
  return 'stub';
}

export function createInferenceClient(options: InferenceOptions = {}): InferenceClient {
  const mode = resolveMode(options.mode);

  switch (mode) {
    case 'bedrock':
      return createBedrockClient(options);

    case 'stub':
      return createStubClient(options);

    case 'replay':
      // Replay is served by the cognition layer, which reads recorded decisions
      // from cognition_records and never reaches this client. Falling back to
      // the stub here would silently fabricate decisions for any gap in the
      // recording, so refuse instead.
      throw new Error(
        'replay mode is handled by the cognition layer, not by createInferenceClient',
      );
  }
}
