import { test } from 'node:test'
import assert from 'node:assert'
import { openshellPlugin, __setOpenShellClientFactory, type OpenShellClientFactory } from './index.js'
import type { OriginRef, DecisionPayload, ResumeResponse } from '@hitly/core'
import type * as grpc from '@grpc/grpc-js'

// Mock gRPC client for tests
function createMockClient(behavior: {
  approveSuccess?: boolean
  rejectSuccess?: boolean
  approveError?: string
  rejectError?: string
  policyVersion?: number
  policyHash?: string
}): OpenShellClientFactory {
  return {
    async connect() {
      return {
        client: {
          ApproveDraftChunk(request: any, metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            if (behavior.approveSuccess === false || behavior.approveError) {
              const error: any = new Error(behavior.approveError || 'Mock approve failed')
              error.code = 9 // FAILED_PRECONDITION
              callback(error)
            } else {
              callback(null, {
                policy_version: behavior.policyVersion ?? 42,
                policy_hash: behavior.policyHash ?? 'abc123',
              })
            }
          },
          RejectDraftChunk(request: any, metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            if (behavior.rejectSuccess === false || behavior.rejectError) {
              const error: any = new Error(behavior.rejectError || 'Mock reject failed')
              error.code = 13 // INTERNAL
              callback(error)
            } else {
              callback(null, {})
            }
          },
        },
        connection: {
          close() {},
        },
      } as any
    },
  }
}

test('openshellPlugin.ingest parses chunk data', () => {
  const raw = {
    workspace: 'test-workspace',
    sandbox: 'test-sandbox',
    chunkId: 'chunk_abc123',
    reviewToken: 'rt_xyz789',
    gatewayAddr: 'localhost:50051',
    projectId: 'prj_test',
    actionName: 'approve-chunk',
    rationale: 'Agent needs API access',
    securityNotes: ['External API'],
    contextMarkdown: '# Test Chunk',
  }

  const result = openshellPlugin.ingest(raw)

  assert.strictEqual(result.origin.plugin, 'openshell')
  assert.strictEqual(result.origin.projectId, 'prj_test')
  assert.strictEqual(result.origin.runId, 'test-sandbox:chunk_abc123')
  assert.strictEqual(result.action.name, 'approve-chunk')
  assert.strictEqual(result.action.args.chunkId, 'chunk_abc123')
  assert.strictEqual(result.action.args.rationale, 'Agent needs API access')
  assert.strictEqual(result.contextMarkdown, '# Test Chunk')
})

test('openshellPlugin.ingest throws on missing required fields', () => {
  assert.throws(() => {
    openshellPlugin.ingest({ workspace: 'test' })
  }, /requires workspace, sandbox, chunkId, and reviewToken/)
})

test('openshellPlugin.resume calls ApproveDraftChunk on accept', async () => {
  __setOpenShellClientFactory(createMockClient({ approveSuccess: true, policyVersion: 42, policyHash: 'abc' }))

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'accept',
  }

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', token: 'bearer_token' })) as ResumeResponse

  assert.strictEqual(result.status, 200)
  assert.strictEqual((result.body as any)?.policyVersion, 42)
  assert.strictEqual((result.body as any)?.policyHash, 'abc')
  assert.strictEqual(result.error, undefined)
})

test('openshellPlugin.resume calls RejectDraftChunk on reject', async () => {
  __setOpenShellClientFactory(createMockClient({ rejectSuccess: true }))

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'reject',
    response: 'Not safe',
  }

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', token: 'bearer_token' })) as ResumeResponse

  assert.strictEqual(result.status, 200)
  assert.strictEqual((result.body as any)?.rejected, true)
  assert.strictEqual(result.error, undefined)
})

test('openshellPlugin.resume handles ApproveDraftChunk failure', async () => {
  __setOpenShellClientFactory(createMockClient({ approveSuccess: false, approveError: 'Stale review token' }))

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'accept',
  }

  const result = (await openshellPlugin.resume(origin, payload)) as ResumeResponse

  assert.strictEqual(result.status, 9)
  assert.ok(result.error?.includes('Stale review token'))
})

test('openshellPlugin.resume handles RejectDraftChunk failure', async () => {
  __setOpenShellClientFactory(createMockClient({ rejectSuccess: false, rejectError: 'Internal error' }))

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'reject',
  }

  const result = (await openshellPlugin.resume(origin, payload)) as ResumeResponse

  assert.strictEqual(result.status, 13)
  assert.ok(result.error?.includes('Internal error'))
})

test('openshellPlugin.resume rejects unsupported decisions', async () => {
  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'edit' as any,
  }

  const result = (await openshellPlugin.resume(origin, payload)) as ResumeResponse

  assert.strictEqual(result.status, 400)
  assert.ok(result.error?.includes('Unsupported decision'))
})

test('openshellPlugin.healthcheck returns ok on success', async () => {
  __setOpenShellClientFactory(createMockClient({}))

  const result = await openshellPlugin.healthcheck({
    plugin: 'openshell',
    address: 'localhost:50051',
    token: 'bearer',
  })

  assert.strictEqual(result, 'ok')
})

test('openshellPlugin.healthcheck returns error on missing address', async () => {
  const result = await openshellPlugin.healthcheck({
    plugin: 'openshell',
  })

  assert.strictEqual(result, 'error')
})
