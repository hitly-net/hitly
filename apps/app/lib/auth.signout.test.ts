import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Regression tests for sign-out session cleanup (issue #68).
 *
 * These tests verify that the sign-out implementation:
 * 1. Clears better-auth session cookies (both variants)
 * 2. Clears hitly-workspace-id cookie
 * 3. Uses credentials: 'include' for the fetch
 * 4. Checks response.ok and fails closed
 * 5. Uses hard navigation (window.location.href)
 *
 * Run with: yarn workspace @hitly/app test
 */

describe('sign-out fetch requirements', () => {
  it('must include credentials', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '../components/sign-out-button.tsx'),
      'utf-8'
    )
    assert.ok(
      code.includes("credentials: 'include'"),
      'sign-out fetch must include credentials: "include"'
    )
  })

  it('must check response.ok', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '../components/sign-out-button.tsx'),
      'utf-8'
    )
    assert.ok(
      code.includes('response.ok'),
      'sign-out must check response.ok and fail closed'
    )
  })

  it('must use hard navigation', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '../components/sign-out-button.tsx'),
      'utf-8'
    )
    assert.ok(
      code.includes('window.location.href'),
      'sign-out must use window.location.href for hard navigation'
    )
  })

  it('must clear hitly-workspace-id cookie', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '../components/sign-out-button.tsx'),
      'utf-8'
    )
    assert.ok(
      code.includes('hitly-workspace-id'),
      'sign-out must explicitly clear hitly-workspace-id cookie'
    )
  })

  it('must clear better-auth session cookie variants', () => {
    const code = fs.readFileSync(
      path.join(__dirname, '../components/sign-out-button.tsx'),
      'utf-8'
    )
    assert.ok(
      code.includes('better-auth.session_token') &&
        code.includes('__Secure-better-auth.session_token'),
      'sign-out must clear both better-auth session cookie variants'
    )
  })
})
