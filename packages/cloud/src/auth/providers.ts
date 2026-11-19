export const defaultWorkspacePlan = 'self-hosted'

/**
 * Social sign-in providers enabled for this edition. This is the single
 * server-side source: Better Auth receives exactly this object, and the
 * sign-up / login pages render a button per provider listed here. The OSS
 * stub enables none (auth is email/password and passkey), so no social
 * buttons render; a deploy that configures Google or Microsoft adds the
 * provider here (via the edition overlay) and the UI follows automatically.
 */
export const socialProviders: Record<string, unknown> = {}

/** Social providers the UI knows how to render a button for. */
export const SOCIAL_PROVIDER_NAMES = ['google', 'microsoft'] as const
export type SocialProviderName = (typeof SOCIAL_PROVIDER_NAMES)[number]

export const SOCIAL_PROVIDER_LABELS: Record<SocialProviderName, string> = {
  google: 'Continue with Google',
  microsoft: 'Continue with Microsoft',
}

/**
 * Filter a Better Auth socialProviders config down to the providers the UI
 * renders buttons for. Pure so it can be pinned in tests: with an empty
 * config the result is empty and no button renders.
 */
export function selectEnabledSocialProviders(
  configured: Record<string, unknown>,
): SocialProviderName[] {
  return SOCIAL_PROVIDER_NAMES.filter((name) => configured[name] != null)
}

/** Providers actually configured server-side for this deployment. */
export function enabledSocialProviders(): SocialProviderName[] {
  return selectEnabledSocialProviders(socialProviders)
}
