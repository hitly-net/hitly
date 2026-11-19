'use client'

import * as React from 'react'
import { SOCIAL_PROVIDER_LABELS, enabledSocialProviders } from './providers'

/**
 * Social sign-in buttons for the sign-up and login pages.
 *
 * Renders one button per provider that is actually configured server-side in
 * Better Auth's `socialProviders` (the shared source in ./providers). With
 * no provider configured — the OSS default — nothing renders: the sign-in
 * surface is email/password and passkey only. Do not add hard-coded
 * provider buttons here; configure the provider in ./providers instead.
 */
export function SocialAuthButtons() {
  const providers = enabledSocialProviders()
  if (providers.length === 0) return null
  return React.createElement(
    'div',
    { className: 'space-y-2' },
    providers.map((provider) =>
      React.createElement(
        'button',
        {
          key: provider,
          type: 'button',
          'data-social-provider': provider,
          className:
            'w-full rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
        },
        SOCIAL_PROVIDER_LABELS[provider],
      ),
    ),
  )
}
