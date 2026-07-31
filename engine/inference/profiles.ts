/** Server-owned inference choices that may be attached to a private world. */

export const SELECTABLE_INFERENCE_PROFILES = ['azure_terra', 'azure_sol'] as const;
export type SelectableInferenceProfile = typeof SELECTABLE_INFERENCE_PROFILES[number];

/** Bedrock remains a valid runtime profile for the eventual AWS deployment. */
export type WorldInferenceProfile = SelectableInferenceProfile | 'bedrock_sonnet' | 'stub';

export function isSelectableInferenceProfile(
  value: unknown,
): value is SelectableInferenceProfile {
  return typeof value === 'string'
    && SELECTABLE_INFERENCE_PROFILES.includes(value as SelectableInferenceProfile);
}

/**
 * The public Azure build exposes only the two deployed GPT-5.6 profiles.
 * Bedrock remains server-routable for existing worlds and the AWS deployment,
 * but is intentionally not a browser-selectable profile here.
 */
export function isInferenceProfileEnabled(
  profile: WorldInferenceProfile,
  bedrockEnabled = process.env.BEDROCK_ENABLED,
): boolean {
  return profile === 'azure_sol'
    || profile === 'azure_terra'
    || (profile === 'bedrock_sonnet' && isTrue(bedrockEnabled));
}

export function enabledInferenceProfiles(): SelectableInferenceProfile[] {
  return [...SELECTABLE_INFERENCE_PROFILES];
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
