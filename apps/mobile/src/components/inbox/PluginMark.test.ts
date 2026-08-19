import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BRANDS } from './PluginMark.brands'

test('PluginMark: mastra brand exists', () => {
  assert.ok(BRANDS.mastra)
  assert.equal(BRANDS.mastra.label, 'Mastra')
})

test('PluginMark: http brand exists', () => {
  assert.ok(BRANDS.http)
  assert.equal(BRANDS.http.label, 'HTTP')
})

test('PluginMark: langgraph brand exists', () => {
  assert.ok(BRANDS.langgraph)
  assert.equal(BRANDS.langgraph.label, 'LangGraph')
})

test('PluginMark: temporal brand exists', () => {
  assert.ok(BRANDS.temporal)
  assert.equal(BRANDS.temporal.label, 'Temporal')
})

test('PluginMark: hermes brand exists', () => {
  assert.ok(BRANDS.hermes)
  assert.equal(BRANDS.hermes.label, 'Hermes')
})

test('PluginMark: unknown plugin falls back to default', () => {
  const unknownPlugin = 'unknown-plugin'
  assert.ok(!BRANDS[unknownPlugin])
})
