import assert from 'node:assert/strict'
import * as net from 'node:net'
import { after, before, describe, it } from 'node:test'
import type { DecisionPayload, HitlyPlugin, OriginRef, ResumeResponse } from '@hitly/core'
import { DestinationCheckError } from '@hitly/core/destination-check'
import { hermesPlugin } from '@hitly/plugin-hermes'
import { httpPlugin } from '@hitly/plugin-http'
import { langgraphPlugin } from '@hitly/plugin-langgraph'
import { healthcheckMastra, mastraPlugin } from '@hitly/plugin-mastra'
import { openshellPlugin } from '@hitly/plugin-openshell'
import { temporalPlugin } from '@hitly/plugin-temporal'
import { resumeFailureMessage } from './resume-error'
import {
  CANARY,
  DEVELOPMENT,
  PRODUCTION,
  PRODUCTION_ALLOWED,
  captureConsole,
  startStub,
  withEnv,
  type StubServer,
} from './destination-test-helpers'

/**
 * Plugin baseUrl / resume targets go through the destination check at send time.
 * Run with: yarn workspace @hitly/app test
 */

const payload: DecisionPayload = { decision: 'accept' }

function origin(plugin: string, resumeHandle: Record<string, unknown>): OriginRef {
  return { plugin, projectId: 'prj_1', runId: 'run_1', stepId: 'step_1', resumeHandle } as OriginRef
}

type Case = { name: string; plugin: HitlyPlugin; origin: (base: string) => OriginRef }

const cases: Case[] = [
  { name: 'http', plugin: httpPlugin, origin: (base) => origin('http', { resumeUrl: `${base}/resume?token=q1` }) },
  { name: 'hermes', plugin: hermesPlugin, origin: (base) => origin('hermes', { resumeUrl: `${base}/resume?token=q1` }) },
  {
    name: 'mastra',
    plugin: mastraPlugin,
    origin: (base) =>
      origin('mastra', { mastraBaseUrl: base, kind: 'workflow', workflowId: 'wf_1', runId: 'run_1', stepId: 'step_1' }),
  },
  {
    name: 'langgraph',
    plugin: langgraphPlugin,
    origin: (base) => origin('langgraph', { deploymentUrl: base, threadId: 'th_1', assistantId: 'as_1' }),
  },
]

let ok: StubServer
let failing: StubServer
let redirecting: StubServer
let target: StubServer

before(async () => {
  ok = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"success"}')
  })
  failing = await startStub((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(CANARY)
  })
  target = await startStub((_req, res) => res.end('{}'))
  redirecting = await startStub((_req, res) => {
    res.writeHead(302, { location: `${target.url}/elsewhere` })
    res.end(CANARY)
  })
})

after(() => {
  for (const s of [ok, failing, redirecting, target]) s.close()
})

async function resume(c: Case, base: string): Promise<{ result?: ResumeResponse; error?: unknown }> {
  try {
    return { result: (await c.plugin.resume(c.origin(base), payload)) as ResumeResponse }
  } catch (error) {
    return { error }
  }
}

for (const c of cases) {
  describe(`${c.name} plugin resume`, () => {
    it('is refused for 127.0.0.1 in production without the flag, without connecting', async () => {
      const before = ok.hits.length
      const { error } = await withEnv(PRODUCTION, () => resume(c, ok.url))
      assert.ok(error instanceof DestinationCheckError, 'resume throws a destination check error')
      assert.equal(error.code, 'refused')
      assert.ok(error.message.includes('HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS'))
      assert.equal(ok.hits.length, before)
      const recorded = resumeFailureMessage(error)
      assert.ok(recorded.startsWith('Resume failed: Destination check'))
      assert.ok(!recorded.includes('token=q1'))
    })

    it('is still refused with the flag set to "TRUE"', async () => {
      const { error } = await withEnv({ NODE_ENV: 'production', HITLY_ALLOW_PRIVATE_EVIDENCE_SINKS: 'TRUE' }, () => resume(c, ok.url))
      assert.ok(error instanceof DestinationCheckError)
    })

    it('reaches 127.0.0.1 in production with the flag set to "true"', async () => {
      const before = ok.hits.length
      const { result, error } = await withEnv(PRODUCTION_ALLOWED, () => resume(c, ok.url))
      assert.equal(error, undefined)
      assert.equal(result?.status, 200)
      assert.equal(ok.hits.length, before + 1)
    })

    it('reaches 127.0.0.1 outside production', async () => {
      const { result } = await withEnv(DEVELOPMENT, () => resume(c, ok.url))
      assert.equal(result?.status, 200)
    })

    it('does not follow redirects', async () => {
      const before = target.hits.length
      const { error } = await withEnv(DEVELOPMENT, () => resume(c, redirecting.url))
      assert.ok(error instanceof DestinationCheckError)
      assert.equal(error.code, 'redirect')
      assert.equal(target.hits.length, before)
    })

    it('error omits the response body, path and query', async () => {
      const { output, result } = await withEnv(DEVELOPMENT, () => captureConsole(() => resume(c, failing.url)))
      const response = result?.result
      assert.equal(response?.status, 500)
      assert.equal(response?.body, null)
      const shown = JSON.stringify(response)
      for (const text of [shown, output]) {
        assert.ok(!text.includes(CANARY))
        assert.ok(!text.includes('token=q1'))
      }
      assert.ok(response?.error?.includes('failed (500) for host "127.0.0.1"'))
    })
  })
}

describe('plugin healthchecks', () => {
  for (const [name, check] of [
    ['mastra', healthcheckMastra],
    ['langgraph', langgraphPlugin.healthcheck.bind(langgraphPlugin)],
  ] as const) {
    it(`${name}: refused in production without the flag, reachable outside production`, async () => {
      const before = ok.hits.length
      assert.equal(await withEnv(PRODUCTION, () => check({ plugin: name, baseUrl: ok.url })), 'error')
      assert.equal(ok.hits.length, before)
      assert.equal(await withEnv(DEVELOPMENT, () => check({ plugin: name, baseUrl: ok.url })), 'ok')
    })
  }

  it('temporal and openshell: no connection to a refused address in production', async () => {
    let connections = 0
    const raw = net.createServer((socket) => {
      connections += 1
      socket.destroy()
    })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
    const port = (raw.address() as net.AddressInfo).port
    try {
      await withEnv(PRODUCTION, async () => {
        assert.equal(await temporalPlugin.healthcheck({ plugin: 'temporal', address: `127.0.0.1:${port}` }), 'error')
        assert.equal(await openshellPlugin.healthcheck({ plugin: 'openshell', address: `127.0.0.1:${port}` }), 'error')
      })
      assert.equal(connections, 0)
    } finally {
      raw.close()
    }
  })
})

describe('resumeFailureMessage', () => {
  it('keeps the generic destination check text', () => {
    const error = new DestinationCheckError('refused', 'Destination check: this address is not allowed (host "x.example").')
    assert.equal(resumeFailureMessage(error), 'Resume failed: Destination check: this address is not allowed (host "x.example").')
  })

  it('falls back to a fixed message for non-errors', () => {
    assert.equal(resumeFailureMessage('boom'), 'Resume failed')
  })
})
