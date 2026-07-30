/** Server-owned inference choices that may be attached to a private world. */

export const SELECTABLE_INFERENCE_PROFILES = ['azure_terra', 'bedrock_sonnet'] as const;
export type SelectableInferenceProfile = typeof SELECTABLE_INFERENCE_PROFILES[number];

/** `stub` is reserved for tests and offline development; it is never a UI choice. */
export type WorldInferenceProfile = SelectableInferenceProfile | 'stub';

export function isSelectableInferenceProfile(
  value: unknown,
): value is SelectableInferenceProfile {
  return typeof value === 'string'
    && SELECTABLE_INFERENCE_PROFILES.includes(value as SelectableInferenceProfile);
}

/**
 * Azure is the supported public path while Bedrock model access is pending.
 * Enabling Bedrock is deliberately one server-owned environment change; the
 * browser cannot turn on a provider that deployment has disabled.
 */
export function isInferenceProfileEnabled(
  profile: SelectableInferenceProfile,
  bedrockEnabled = process.env.BEDROCK_ENABLED,
): boolean {
  return profile === 'azure_terra' || (profile === 'bedrock_sonnet' && isTrue(bedrockEnabled));
}

export function enabledInferenceProfiles(
  bedrockEnabled = process.env.BEDROCK_ENABLED,
): SelectableInferenceProfile[] {
  return SELECTABLE_INFERENCE_PROFILES.filter((profile) =>
    isInferenceProfileEnabled(profile, bedrockEnabled));
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
