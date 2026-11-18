/**
 * SocialAuthButtons gate tests (Test MUST-5).
 *
 * The sign-up / login pages render social sign-in buttons ONLY for
 * providers actually configured server-side in Better Auth's
 * `socialProviders` (the shared source in @hitly/cloud/auth/providers).
 * With none configured (the OSS default) zero buttons render; with one
 * configured, exactly that one renders.
 *
 * Requires --experimental-test-module-mocks (enabled in the package test
 * script). The providers module is mocked ONCE with a mutable config; the
 * button filter logic stays the REAL `selectEnabledSocialProviders`, only
 * the `socialProviders` config is substituted.
 */
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as realProviders from '../../../packages/cloud/src/auth/providers'

const providersUrl = new URL(
  '../../../packages/cloud/src/auth/providers.ts',
  import.meta.url,
).href
const buttonsUrl = new URL(
  '../../../packages/cloud/src/auth/buttons.tsx',
  import.meta.url,
).href

const state = { configured: {} as Record<string, unknown> }

mock.module(providersUrl, {
  namedExports: {
    ...realProviders,
    // The component asks the module which providers are configured; this
    // closure feeds the scenario config through the REAL filter.
    enabledSocialProviders: () =>
      realProviders.selectEnabledSocialProviders(state.configured),
  },
})

let buttonsModule: { SocialAuthButtons: () => ReturnType<typeof createElement> } | null = null
async function renderButtons(configured: Record<string, unknown>): Promise<string> {
  state.configured = configured
  if (!buttonsModule) buttonsModule = (await import(buttonsUrl)) as never
  return renderToStaticMarkup(createElement(buttonsModule.SocialAuthButtons))
}

test('no providers configured -> no social buttons render', async () => {
  // The real OSS module ships an empty config: that is the prod default.
  assert.deepEqual(realProviders.socialProviders, {})
  assert.deepEqual(realProviders.enabledSocialProviders(), [])
  const html = await renderButtons({})
  assert.equal(html, '')
  assert.ok(!html.includes('Continue with'))
})

test('only Google configured -> only the Google button renders', async () => {
  const html = await renderButtons({ google: { clientId: 'x', clientSecret: '***' } })
  assert.ok(html.includes('data-social-provider="google"'), 'google button renders')
  assert.ok(html.includes('Continue with Google'))
  assert.ok(!html.includes('data-social-provider="microsoft"'), 'no microsoft button')
  assert.ok(!html.includes('Continue with Microsoft'))
})

test('only Microsoft configured -> only the Microsoft button renders', async () => {
  const html = await renderButtons({ microsoft: { clientId: 'x', clientSecret: '***' } })
  assert.ok(html.includes('data-social-provider="microsoft"'), 'microsoft button renders')
  assert.ok(html.includes('Continue with Microsoft'))
  assert.ok(!html.includes('data-social-provider="google"'), 'no google button')
  assert.ok(!html.includes('Continue with Google'))
})

test('unknown providers render no UI; both configured render both buttons', async () => {
  const unknown = await renderButtons({ someOtherOidc: {} })
  assert.equal(unknown, '', 'providers the UI does not know render nothing')
  const both = await renderButtons({ google: {}, microsoft: {} })
  assert.ok(both.includes('Continue with Google'))
  assert.ok(both.includes('Continue with Microsoft'))
  assert.equal((both.match(/<button/g) ?? []).length, 2)
})
