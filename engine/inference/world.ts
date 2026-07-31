/** Resolve the immutable provider profile selected for a private world. */

import { query } from '../database/db.ts';
import { createInferenceClient } from './index.ts';
import type { InferenceClient } from './types.ts';
import {
  isInferenceProfileEnabled, type WorldInferenceProfile,
} from './profiles.ts';

const clients = new Map<WorldInferenceProfile, InferenceClient>();

export async function inferenceForWorld(worldId: string): Promise<InferenceClient> {
  const rows = await query<{ inference_profile: WorldInferenceProfile }>(
    `SELECT inference_profile FROM worlds WHERE world_id = $1`,
    [worldId],
  );
  const profile = rows[0]?.inference_profile;
  if (!profile) throw new Error(`world ${worldId} does not exist`);
  return inferenceForProfile(profile);
}

export function inferenceForProfile(profile: WorldInferenceProfile): InferenceClient {
  // The default remains non-billable and offline-safe. A deployed per-world
  // router must opt in explicitly after both provider profiles are configured.
  const effective = effectiveWorldInferenceProfile(profile, process.env.INFERENCE_MODE);
  if (effective === 'bedrock_sonnet' && !isInferenceProfileEnabled(effective)) {
    throw new Error('bedrock_sonnet is disabled; set BEDROCK_ENABLED=true after model access is ready');
  }
  const cached = clients.get(effective);
  if (cached) return cached;

  const client = effective === 'azure_sol'
    ? createInferenceClient({
      mode: 'azure',
      reasoningModelId: required(
        process.env.AZURE_OPENAI_SOL_DEPLOYMENT,
        'AZURE_OPENAI_SOL_DEPLOYMENT',
      ),
      reasoningEffort: 'none',
    })
    : effective === 'azure_terra'
    ? createInferenceClient({
      mode: 'azure',
      reasoningModelId: required(
        process.env.AZURE_OPENAI_TERRA_DEPLOYMENT,
        'AZURE_OPENAI_TERRA_DEPLOYMENT',
      ),
      reasoningEffort: 'none',
    })
    : effective === 'bedrock_sonnet'
      ? createInferenceClient({
        mode: 'bedrock',
        reasoningModelId: required(
          process.env.BEDROCK_SONNET_REASONING_PROFILE,
          'BEDROCK_SONNET_REASONING_PROFILE',
        ),
      })
      : createInferenceClient({ mode: 'stub' });
  clients.set(effective, client);
  return client;
}

export function effectiveWorldInferenceProfile(
  profile: WorldInferenceProfile,
  configuredMode: string | undefined,
): WorldInferenceProfile {
  return configuredMode === 'world' ? profile : 'stub';
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when INFERENCE_MODE=world`);
  return value;
}
