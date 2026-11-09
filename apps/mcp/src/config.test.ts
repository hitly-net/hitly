import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { DEFAULT_API_URL, DEFAULT_LISTEN_HOST, DEFAULT_PORT, loadConfig } from './config.ts'
import { createLogger } from './logger.ts'
import { createMcpHttpServer } from './server.ts'

test('port defaults to 3006, listen host to loopback, API to Cloud', () => {
  const config = loadConfig({})
  assert.equal(DEFAULT_PORT, 3006)
  assert.equal(config.port, 3006)
  assert.equal(config.listenHost, DEFAULT_LISTEN_HOST)
  assert.equal(config.apiUrl, DEFAULT_API_URL)
  assert.equal(config.appUrl, DEFAULT_API_URL)
  assert.equal(config.publicUrl, undefined)
  assert.equal(config.capabilities.size, 0)
})

test('listen host, port and URLs come from env', () => {
  const config = loadConfig({
    HITLY_MCP_HOST: '0.0.0.0',
    HITLY_MCP_PORT: '4123',
    HITLY_API_URL: 'https://hitly.example/',
    HITLY_APP_URL: 'https://app.hitly.example',
    HITLY_MCP_PUBLIC_URL: 'https://mcp.hitly.example/',
    HITLY_HOST_CAPABILITIES: 'cb_auth_token, expires_at',
  })
  assert.equal(config.listenHost, '0.0.0.0')
  assert.equal(config.port, 4123)
  assert.equal(config.apiUrl, 'https://hitly.example')
  assert.equal(config.appUrl, 'https://app.hitly.example')
  assert.equal(config.publicUrl, 'https://mcp.hitly.example')
  assert.deepEqual([...config.capabilities].sort(), ['cb_auth_token', 'expires_at'])
})

test('invalid port and unknown capability are refused', () => {
  assert.throws(() => loadConfig({ HITLY_MCP_PORT: 'abc' }), /HITLY_MCP_PORT/)
  assert.throws(() => loadConfig({ HITLY_MCP_PORT: '70000' }), /HITLY_MCP_PORT/)
  assert.throws(() => loadConfig({ HITLY_HOST_CAPABILITIES: 'decide' }), /Unknown/)
})

test('server listens on the configured port', async () => {
  // Pick a free port, then start the real server on exactly that port from env.
  const probe = createMcpHttpServer(loadConfig({ HITLY_MCP_PORT: '0' }), { logger: createLogger(() => undefined) })
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const free = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const logs: string[] = []
  const config = loadConfig({ HITLY_MCP_HOST: '127.0.0.1', HITLY_MCP_PORT: String(free) })
  const server = createMcpHttpServer(config, { logger: createLogger((line) => logs.push(line)) })
  await new Promise<void>((resolve) => server.listen(config.port, config.listenHost, resolve))
  try {
    assert.equal((server.address() as AddressInfo).port, free)
    const health = await fetch(`http://127.0.0.1:${free}/healthz`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok' })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
