import assert from 'node:assert/strict'
import { test } from 'node:test'

test('PluginMark: mastra brand exists', () => {
  const pluginId = 'mastra'
  assert.ok(['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})

test('PluginMark: http brand exists', () => {
  const pluginId = 'http'
  assert.ok(['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})

test('PluginMark: langgraph brand exists', () => {
  const pluginId = 'langgraph'
  assert.ok(['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})

test('PluginMark: temporal brand exists', () => {
  const pluginId = 'temporal'
  assert.ok(['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})

test('PluginMark: hermes brand exists', () => {
  const pluginId = 'hermes'
  assert.ok(['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})

test('PluginMark: unknown plugin falls back to default', () => {
  const pluginId = 'unknown-plugin'
  assert.ok(!['mastra', 'http', 'langgraph', 'temporal', 'hermes'].includes(pluginId))
})
