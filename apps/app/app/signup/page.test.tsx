/**
 * Page-level render tests for /signup (Test MUST-4 + soft S176-A + MUST-5).
 *
 * Renders the REAL SignupPage with its data/layout modules mocked, so a
 * regression that drops the "By signing up you agree to the Terms and
 * Privacy Notice" consent line (or changes its absolute https://hitly.net
 * hrefs) fails HERE — not just in a source scan. Also pins the disabled
 * path (isSignupEnabled() false shows the early-access form and NO consent
 * line) and that no social sign-in button renders while no provider is
 * configured server-side (Better Auth socialProviders is empty in this
 * edition).
 *
 * Requires --experimental-test-module-mocks (enabled in the package test
 * script), following the settings/security page-test pattern.
 */
import 'global-jsdom/register'
import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'

const state = { signupEnabled: true }

mock.module(new URL('../../lib/signup.ts', import.meta.url).href, {
  namedExports: {
    isSignupEnabled: () => state.signupEnabled,
    inviteAcceptPathFromSignup: () => null,
  },
})
mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string): never => {
      throw new Error(`unexpected redirect to ${url}`)
    },
  },
})
mock.module(new URL('../../components/auth-form.tsx', import.meta.url).href, {
  namedExports: {
    AuthForm: () => <div data-testid="auth-form" />,
  },
})
mock.module(new URL('../../components/auth-layout.tsx', import.meta.url).href, {
  namedExports: {
    AuthLayout: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
})
mock.module(new URL('../../components/early-access-form.tsx', import.meta.url).href, {
  namedExports: {
    EarlyAccessForm: () => <div data-testid="early-access-form">Join the early access list</div>,
  },
})

async function SignupPage() {
  const { default: Page } = await import('./page')
  return Page({ searchParams: Promise.resolve({}) })
}

afterEach(() => {
  cleanup()
})

test('enabled sign-up shows the consent line with the pinned terms and privacy hrefs (MUST-4)', async () => {
  state.signupEnabled = true
  render(await SignupPage())
  // The exact consent sentence (L5 mutant: removing it fails here).
  screen.getByText(/By signing up you agree to the/)
  const terms = screen.getByRole('link', { name: 'Terms' })
  const privacy = screen.getByRole('link', { name: 'Privacy Notice' })
  assert.equal(terms.getAttribute('href'), 'https://hitly.net/terms')
  assert.equal(privacy.getAttribute('href'), 'https://hitly.net/privacy')
  // Links open in a new tab without leaking the referrer.
  assert.equal(terms.getAttribute('target'), '_blank')
  assert.equal(terms.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(privacy.getAttribute('target'), '_blank')
  assert.equal(privacy.getAttribute('rel'), 'noopener noreferrer')
  // The account form is present; the early-access form is not.
  screen.getByTestId('auth-form')
  assert.equal(screen.queryByTestId('early-access-form'), null)
})

test('disabled sign-up shows the early-access form and no consent line (S176-A)', async () => {
  state.signupEnabled = false
  render(await SignupPage())
  screen.getByTestId('early-access-form')
  assert.equal(screen.queryByTestId('auth-form'), null)
  assert.equal(screen.queryByText(/By signing up you agree to the/), null)
  assert.equal(screen.queryByRole('link', { name: 'Terms' }), null)
  assert.equal(screen.queryByRole('link', { name: 'Privacy Notice' }), null)
})

test('no social sign-in button renders while no provider is configured (MUST-5)', async () => {
  state.signupEnabled = true
  const html = (await import('react-dom/server')).renderToStaticMarkup(
    await SignupPage(),
  )
  assert.ok(!html.includes('data-social-provider'), 'no social buttons when socialProviders is empty')
  assert.ok(!/Continue with (Google|Microsoft)/.test(html), 'no hard-coded social buttons')
})
