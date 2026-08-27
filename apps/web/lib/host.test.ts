import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCloudHost } from './host'

test('isCloudHost: cloud.hitly.net → true', () => {
  assert.strictEqual(isCloudHost('cloud.hitly.net'), true)
})

test('isCloudHost: www.cloud.hitly.net → true', () => {
  assert.strictEqual(isCloudHost('www.cloud.hitly.net'), true)
})

test('isCloudHost: cloud.hitly.net:3000 → true (strips port)', () => {
  assert.strictEqual(isCloudHost('cloud.hitly.net:3000'), true)
})

test('isCloudHost: www.cloud.hitly.net:443 → true (strips port)', () => {
  assert.strictEqual(isCloudHost('www.cloud.hitly.net:443'), true)
})

test('isCloudHost: hitly.net → false', () => {
  assert.strictEqual(isCloudHost('hitly.net'), false)
})

test('isCloudHost: www.hitly.net → false', () => {
  assert.strictEqual(isCloudHost('www.hitly.net'), false)
})

test('isCloudHost: localhost → false', () => {
  assert.strictEqual(isCloudHost('localhost'), false)
})

test('isCloudHost: localhost:3000 → false', () => {
  assert.strictEqual(isCloudHost('localhost:3000'), false)
})

test('isCloudHost: null → false', () => {
  assert.strictEqual(isCloudHost(null), false)
})

test('isCloudHost: empty string → false', () => {
  assert.strictEqual(isCloudHost(''), false)
})
