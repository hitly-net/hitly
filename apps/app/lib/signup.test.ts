import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inviteAcceptPathFromSignup, isSignupEnabled } from './signup'

test('isSignupEnabled returns true when HITLY_SIGNUP_ENABLED is unset', () => {
  delete process.env.HITLY_SIGNUP_ENABLED
  assert.equal(isSignupEnabled(), true)
})

test('isSignupEnabled returns true when HITLY_SIGNUP_ENABLED is "1"', () => {
  process.env.HITLY_SIGNUP_ENABLED = '1'
  assert.equal(isSignupEnabled(), true)
})

test('isSignupEnabled returns true when HITLY_SIGNUP_ENABLED is "true"', () => {
  process.env.HITLY_SIGNUP_ENABLED = 'true'
  assert.equal(isSignupEnabled(), true)
})

test('isSignupEnabled returns false when HITLY_SIGNUP_ENABLED is "0"', () => {
  process.env.HITLY_SIGNUP_ENABLED = '0'
  assert.equal(isSignupEnabled(), false)
})

test('isSignupEnabled returns false when HITLY_SIGNUP_ENABLED is "false"', () => {
  process.env.HITLY_SIGNUP_ENABLED = 'false'
  assert.equal(isSignupEnabled(), false)
})

test('isSignupEnabled returns false when HITLY_SIGNUP_ENABLED is "off"', () => {
  process.env.HITLY_SIGNUP_ENABLED = 'off'
  assert.equal(isSignupEnabled(), false)
})

test('isSignupEnabled returns true for unknown values', () => {
  process.env.HITLY_SIGNUP_ENABLED = 'unknown'
  assert.equal(isSignupEnabled(), true)
})

test('inviteAcceptPathFromSignup maps /signup?invite=<token> to the accept page', () => {
  const token = 'A'.repeat(43)
  assert.equal(inviteAcceptPathFromSignup(token), `/invite/${token}`)
  assert.equal(inviteAcceptPathFromSignup(undefined), null)
  assert.equal(inviteAcceptPathFromSignup(''), null)
  assert.equal(inviteAcceptPathFromSignup(['x']), null)
  assert.equal(inviteAcceptPathFromSignup('../../evil'), null)
  assert.equal(inviteAcceptPathFromSignup('//evil.example'), null)
})
