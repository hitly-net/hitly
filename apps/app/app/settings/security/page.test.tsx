/**
 * Page-level render tests for /settings/security (must N1).
 *
 * These render the REAL SecurityPage (its data hooks are module-mocked;
 * the real MfaSetup component renders), so a regression that hides the
 * Authenticator-app section for an ENROLLED user when the `mfa` feature is
 * denied — i.e. the page reverting from shouldShowAuthenticatorSection() to
 * a bare canForCurrentWorkspace() result — fails HERE. The pure-helper and
 * live-DB tests cannot see the page wiring; this file can.
 *
 * Requires --experimental-test-module-mocks (enabled in the package test
 * script), following the actions/*-gate.test.ts pattern from #164.
 */
import 'global-jsdom/register'
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'

const state: { enabled: boolean; allowed: boolean; features: string[] } = {
  enabled: true,
  allowed: false,
  features: [],
}

mock.module(new URL('../../../lib/context.ts', import.meta.url).href, {
  namedExports: {
    requireSessionUser: async () => ({
      id: 'user-security-1',
      email: 'security@example.com',
      emailVerified: true,
    }),
  },
})
mock.module(new URL('../../../lib/mfa-route.ts', import.meta.url).href, {
  namedExports: {
    getMfaStatus: async () => ({
      enabled: state.enabled,
      pending: false,
      recoveryCodesRemaining: 8,
    }),
  },
})
mock.module(new URL('../../../lib/passkey-route.ts', import.meta.url).href, {
  namedExports: { listPasskeysForUser: async () => [] },
})
mock.module(new URL('../../../lib/tier-entitlements.ts', import.meta.url).href, {
  namedExports: {
    canForCurrentWorkspace: async (feature: string) => {
      // M3: record the feature argument — the page must ask for exactly
      // 'mfa'. A page checking 'sso' (mutant G1d) fails the per-test
      // deepEqual below.
      state.features.push(feature)
      return state.allowed
    },
  },
})
mock.module(new URL('../../../components/app-shell.tsx', import.meta.url).href, {
  namedExports: {
    AppShell: ({ children }: { children?: ReactNode }) => children ?? null,
  },
})
mock.module(new URL('../../../components/change-email-form.tsx', import.meta.url).href, {
  namedExports: { ChangeEmailForm: () => null },
})
mock.module(new URL('../../../components/change-password-form.tsx', import.meta.url).href, {
  namedExports: { ChangePasswordForm: () => null },
})
mock.module(new URL('../../../components/unverified-email-notice.tsx', import.meta.url).href, {
  namedExports: { UnverifiedEmailNotice: () => null },
})
mock.module(new URL('../../../components/passkey-setup.tsx', import.meta.url).href, {
  namedExports: { PasskeySetup: () => null },
})

async function SecurityPage() {
  const { default: Page } = await import('./page')
  return Page()
}

afterEach(() => {
  cleanup()
})

describe('Security page — entitlement gate covers new enrolment only (N1)', () => {
  // Mutant G1: page.tsx replacing shouldShowAuthenticatorSection(mfa,
  // mfaAllowed) with the bare mfaAllowed makes the first test below fail —
  // the enrolled user's Disable/Regenerate forms disappear on deny.
  it('an enrolled user keeps Disable MFA and Regenerate recovery codes while mfa is denied', async () => {
    state.enabled = true
    state.allowed = false
    state.features = []
    render(await SecurityPage())
    assert.deepEqual(state.features, ['mfa'], 'the page must gate on exactly the mfa feature')
    screen.getByRole('heading', { name: 'Authenticator app' })
    screen.getByText(/Authenticator app MFA is on/)
    screen.getByText('Regenerate recovery codes')
    screen.getByText('Disable MFA')
  })

  it('a not-enrolled user with mfa denied loses the enrolment affordance', async () => {
    state.enabled = false
    state.allowed = false
    state.features = []
    render(await SecurityPage())
    assert.deepEqual(state.features, ['mfa'], 'the page must gate on exactly the mfa feature')
    assert.equal(screen.queryByRole('heading', { name: 'Authenticator app' }), null)
    assert.equal(screen.queryByText('Enable authenticator app'), null)
  })

  it('a not-enrolled user with mfa allowed sees the enrolment affordance', async () => {
    state.enabled = false
    state.allowed = true
    state.features = []
    render(await SecurityPage())
    assert.deepEqual(state.features, ['mfa'], 'the page must gate on exactly the mfa feature')
    screen.getByRole('heading', { name: 'Authenticator app' })
    screen.getByText('Enable authenticator app')
  })
})
