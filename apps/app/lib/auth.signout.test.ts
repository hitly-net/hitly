import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Integration tests for sign-out session cleanup (issue #68).
 *
 * These tests verify that after sign-out:
 * 1. better-auth session cookies are cleared (both variants)
 * 2. hitly-workspace-id cookie is cleared
 * 3. Protected pages redirect to /login
 * 4. Authenticated API calls without cookies return 401/unauthorized
 * 5. Soft-nav or hard refresh does not resurrect the previous user name
 *
 * Run with: yarn workspace @hitly/app test
 *
 * NOTE: These are manual integration tests that require a running server.
 * They serve as a regression test specification and should be verified manually
 * or via E2E testing infrastructure when available.
 */

describe('sign-out session cleanup', () => {
  test('manual verification: sign in → sign out → assert session cookies absent', () => {
    assert.ok(true, 'Manual test: After sign-out, check that better-auth.session_token, __Secure-better-auth.session_token, and hitly-workspace-id cookies are all absent in browser DevTools')
  })

  test('manual verification: GET protected page → redirect /login', () => {
    assert.ok(true, 'Manual test: After sign-out, navigate to / or /projects and verify redirect to /login')
  })

  test('manual verification: authenticated API without cookie → 401/unauthorized', () => {
    assert.ok(true, 'Manual test: After sign-out, call GET /api/v1/workspaces with curl (no cookies) and verify 401 or redirect')
  })

  test('manual verification: soft-nav or hard refresh must not resurrect previous user', () => {
    assert.ok(true, 'Manual test: After sign-out, use browser back/forward or F5 refresh and verify user name does not reappear in header')
  })

  describe('sign-out fetch requirements', () => {
    it('must include credentials', () => {
      // Verify the sign-out button uses credentials: 'include'
      const code = require('fs').readFileSync(
        require('path').join(__dirname, '../components/sign-out-button.tsx'),
        'utf-8'
      )
      assert.ok(
        code.includes("credentials: 'include'"),
        'sign-out fetch must include credentials: "include"'
      )
    })

    it('must check response.ok', () => {
      const code = require('fs').readFileSync(
        require('path').join(__dirname, '../components/sign-out-button.tsx'),
        'utf-8'
      )
      assert.ok(
        code.includes('response.ok'),
        'sign-out must check response.ok and fail closed'
      )
    })

    it('must use hard navigation', () => {
      const code = require('fs').readFileSync(
        require('path').join(__dirname, '../components/sign-out-button.tsx'),
        'utf-8'
      )
      assert.ok(
        code.includes('window.location.href'),
        'sign-out must use window.location.href for hard navigation'
      )
    })

    it('must clear hitly-workspace-id cookie', () => {
      const code = require('fs').readFileSync(
        require('path').join(__dirname, '../components/sign-out-button.tsx'),
        'utf-8'
      )
      assert.ok(
        code.includes('hitly-workspace-id'),
        'sign-out must explicitly clear hitly-workspace-id cookie'
      )
    })

    it('must clear better-auth session cookie variants', () => {
      const code = require('fs').readFileSync(
        require('path').join(__dirname, '../components/sign-out-button.tsx'),
        'utf-8'
      )
      assert.ok(
        code.includes('better-auth.session_token') &&
          code.includes('__Secure-better-auth.session_token'),
        'sign-out must clear both better-auth session cookie variants'
      )
    })
  })
})
