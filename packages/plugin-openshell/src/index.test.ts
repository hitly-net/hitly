import { test } from 'node:test'
import assert from 'node:assert'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as grpcjs from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { setDestinationCheckTestHooks } from '@hitly/core/destination-check'
import {
  openshellPlugin,
  __resetOpenShellClientFactory,
  __setOpenShellClientFactory,
  type OpenShellClientFactory,
  type OpenShellDial,
} from './index.js'
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
    async connect(_gatewayAddr: string, _bearerToken?: string, _tlsConfig?: any, _insecure?: boolean) {
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

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', token: 'bearer_token', insecure: true })) as ResumeResponse

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

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', token: 'bearer_token', insecure: true })) as ResumeResponse

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

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', insecure: true })) as ResumeResponse

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

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', insecure: true })) as ResumeResponse

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

  const result = (await openshellPlugin.resume(origin, payload, { plugin: 'openshell', insecure: true })) as ResumeResponse

  assert.strictEqual(result.status, 400)
  assert.ok(result.error?.includes('Unsupported decision'))
})

test('openshellPlugin.healthcheck returns ok on success', async () => {
  __setOpenShellClientFactory(createMockClient({}))

  const result = await openshellPlugin.healthcheck({
    plugin: 'openshell',
    address: 'localhost:50051',
    token: 'bearer',
    insecure: true,
  })

  assert.strictEqual(result, 'ok')
})

test('openshellPlugin.healthcheck returns error on missing address', async () => {
  const result = await openshellPlugin.healthcheck({
    plugin: 'openshell',
  })

  assert.strictEqual(result, 'error')
})

test('openshellPlugin.resume accepts TLS configuration from credentials', async () => {
  let capturedTlsConfig: any = undefined
  let capturedInsecure: any = undefined

  const mockFactory: OpenShellClientFactory = {
    async connect(_addr: string, _token?: string, tlsConfig?: any, insecure?: boolean) {
      capturedTlsConfig = tlsConfig
      capturedInsecure = insecure
      return createMockClient({ approveSuccess: true }).connect(_addr, _token, tlsConfig, insecure)
    },
  }

  __setOpenShellClientFactory(mockFactory)

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: '127.0.0.1:17670',
      workspace: 'ws',
      sandbox: 'sb',
      chunkId: 'chunk_1',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'accept',
  }

  const credentials = {
    plugin: 'openshell' as const,
    token: 'bearer_token',
    tlsCaFile: '/path/to/ca.pem',
    tlsCertFile: '/path/to/cert.pem',
    tlsKeyFile: '/path/to/key.pem',
    tlsSslTargetNameOverride: 'openshell.local',
  }

  await openshellPlugin.resume(origin, payload, credentials)

  assert.ok(capturedTlsConfig, 'TLS config should be passed')
  assert.strictEqual(capturedTlsConfig.ca, '/path/to/ca.pem')
  assert.strictEqual(capturedTlsConfig.cert, '/path/to/cert.pem')
  assert.strictEqual(capturedTlsConfig.key, '/path/to/key.pem')
  assert.strictEqual(capturedTlsConfig.sslTargetNameOverride, 'openshell.local')
  assert.strictEqual(capturedInsecure, undefined)
})

test('openshellPlugin.resume respects insecure flag', async () => {
  let capturedInsecure: any = undefined

  const mockFactory: OpenShellClientFactory = {
    async connect(_addr: string, _token?: string, tlsConfig?: any, insecure?: boolean) {
      capturedInsecure = insecure
      return createMockClient({ approveSuccess: true }).connect(_addr, _token, tlsConfig, insecure)
    },
  }

  __setOpenShellClientFactory(mockFactory)

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

  const credentials = {
    plugin: 'openshell' as const,
    tlsInsecure: true,
  }

  await openshellPlugin.resume(origin, payload, credentials)

  assert.strictEqual(capturedInsecure, true, 'insecure flag should be true')
})

test('openshellPlugin.resume fails closed without TLS or insecure flag', async () => {
  // Reset to production factory to test actual credentials validation
  // The production factory will throw when createGrpcCredentials is called without TLS or insecure flag
  const productionFactory = {
    async connect(gatewayAddr: string, bearerToken?: string, tlsConfig?: any, insecure?: boolean) {
      // This simulates the production path where createGrpcCredentials would throw
      if (!insecure && !(tlsConfig && (tlsConfig.ca || tlsConfig.cert || tlsConfig.key))) {
        throw new Error('OpenShell gRPC client requires TLS configuration (tlsCaFile, tlsCertFile, tlsKeyFile) or explicit insecure flag (tlsInsecure=true) for dev/test only')
      }
      return createMockClient({}).connect(gatewayAddr, bearerToken, tlsConfig, insecure)
    },
  }
  __setOpenShellClientFactory(productionFactory)

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

  const credentials = {
    plugin: 'openshell' as const,
    token: 'bearer_token',
  }

  const result = (await openshellPlugin.resume(origin, payload, credentials)) as ResumeResponse

  assert.strictEqual(result.status, 500)
  assert.ok(result.error?.includes('requires TLS configuration'))
})

test('openshellPlugin.resume sets request_id to chunkId only (not sandbox-prefixed)', async () => {
  let capturedRequestId: string | undefined

  const mockFactory: OpenShellClientFactory = {
    async connect(_addr: string, _token?: string, _tlsConfig?: any, _insecure?: boolean) {
      return {
        client: {
          ApproveDraftChunk(request: any, _metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            capturedRequestId = request.request_id
            callback(null, { policy_version: 42, policy_hash: 'abc123' })
          },
          RejectDraftChunk(request: any, _metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            capturedRequestId = request.request_id
            callback(null, {})
          },
        },
        connection: {
          close() {},
        },
      } as any
    },
  }

  __setOpenShellClientFactory(mockFactory)

  const origin: OriginRef = {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sandbox:chunk',
    resumeHandle: {
      gatewayAddr: 'localhost:50051',
      workspace: 'ws',
      sandbox: 'test-sandbox',
      chunkId: '550e8400-e29b-41d4-a716-446655440000',
      reviewToken: 'rt_1',
    },
  }

  const payload: DecisionPayload = {
    decision: 'accept',
  }

  const credentials = {
    plugin: 'openshell' as const,
    insecure: true,
  }

  await openshellPlugin.resume(origin, payload, credentials)

  assert.strictEqual(capturedRequestId, '550e8400-e29b-41d4-a716-446655440000', 'request_id should be chunkId only, not sandbox-prefixed')
})

// --- pinned connections ------------------------------------------------------

const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address }))

function pinnedOrigin(gatewayAddr: string): OriginRef {
  return {
    plugin: 'openshell',
    projectId: 'prj_test',
    runId: 'sb:chunk_1',
    resumeHandle: { gatewayAddr, workspace: 'ws', sandbox: 'sb', chunkId: 'chunk_1', reviewToken: 'rt_1' },
  }
}

function recordingFactory(behavior: { failConnect?: (target: string) => boolean; approveError?: string } = {}) {
  const dials: Array<{ gatewayAddr: string; dial?: OpenShellDial }> = []
  let calls = 0
  const factory: OpenShellClientFactory = {
    async connect(gatewayAddr, _bearerToken, _tlsConfig, _insecure, dial) {
      dials.push({ gatewayAddr, dial })
      if (dial && behavior.failConnect?.(dial.target)) throw new Error('not ready')
      return {
        client: {
          ApproveDraftChunk(_request: any, _metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            calls += 1
            if (behavior.approveError) {
              const error: any = new Error(behavior.approveError)
              error.code = 14
              callback(error)
            } else callback(null, { policy_version: 1, policy_hash: 'h' })
          },
          RejectDraftChunk(_request: any, _metadata: grpc.Metadata, callback: (error: any, response?: any) => void) {
            calls += 1
            callback(null, {})
          },
        },
        connection: { close() {} },
      } as any
    },
  }
  return { factory, dials, calls: () => calls }
}

async function withHooks(hooks: Parameters<typeof setDestinationCheckTestHooks>[0], run: () => Promise<void>) {
  setDestinationCheckTestHooks(hooks)
  try {
    await run()
  } finally {
    setDestinationCheckTestHooks()
  }
}

test('openshell: dials the checked address and keeps the original host for :authority and TLS', async () => {
  await withHooks({ resolve: answers('203.0.113.9') }, async () => {
    const { factory, dials } = recordingFactory()
    __setOpenShellClientFactory(factory)
    const result = (await openshellPlugin.resume(pinnedOrigin('OpenShell.Example:50051'), { decision: 'accept' }, { plugin: 'openshell', insecure: true })) as ResumeResponse
    assert.strictEqual(result.status, 200)
    assert.strictEqual(dials.length, 1)
    assert.strictEqual(dials[0].gatewayAddr, 'OpenShell.Example:50051')
    assert.strictEqual(dials[0].dial?.target, 'ipv4:203.0.113.9:50051')
    assert.deepStrictEqual(dials[0].dial?.channelOptions, {
      'grpc.default_authority': 'OpenShell.Example:50051',
      'grpc.ssl_target_name_override': 'openshell.example',
    })
    assert.ok((dials[0].dial?.timeoutMs ?? 0) > 0)
  })
})

test('openshell: dials an IPv6 answer with the ipv6: target form', async () => {
  await withHooks({ resolve: answers('2001:db8::9') }, async () => {
    const { factory, dials } = recordingFactory()
    __setOpenShellClientFactory(factory)
    assert.strictEqual(await openshellPlugin.healthcheck({ plugin: 'openshell', address: 'openshell.example:50051', insecure: true }), 'ok')
    assert.strictEqual(dials[0].dial?.target, 'ipv6:[2001:db8::9]:50051')
  })
})

test('openshell: tries the checked addresses in order and calls once', async () => {
  await withHooks({ resolve: answers('203.0.113.1', '203.0.113.2', '203.0.113.3') }, async () => {
    const { factory, dials, calls } = recordingFactory({ failConnect: (t) => t === 'ipv4:203.0.113.1:50051' })
    __setOpenShellClientFactory(factory)
    const result = (await openshellPlugin.resume(pinnedOrigin('openshell.example:50051'), { decision: 'accept' }, { plugin: 'openshell', insecure: true })) as ResumeResponse
    assert.strictEqual(result.status, 200)
    assert.deepStrictEqual(
      dials.map((d) => d.dial?.target),
      ['ipv4:203.0.113.1:50051', 'ipv4:203.0.113.2:50051'],
    )
    assert.strictEqual(calls(), 1)
  })
})

test('openshell: does not repeat a failed call on another address', async () => {
  await withHooks({ resolve: answers('203.0.113.1', '203.0.113.2') }, async () => {
    const { factory, dials, calls } = recordingFactory({ approveError: 'unavailable' })
    __setOpenShellClientFactory(factory)
    const result = (await openshellPlugin.resume(pinnedOrigin('openshell.example:50051'), { decision: 'accept' }, { plugin: 'openshell', insecure: true })) as ResumeResponse
    assert.strictEqual(result.status, 14)
    assert.strictEqual(dials.length, 1)
    assert.strictEqual(calls(), 1)
  })
})

test('openshell: does not connect when any answer is refused', async () => {
  await withHooks({ resolve: answers('203.0.113.1', '224.0.0.1') }, async () => {
    const { factory, dials } = recordingFactory()
    __setOpenShellClientFactory(factory)
    const result = (await openshellPlugin.resume(pinnedOrigin('openshell.example:50051'), { decision: 'accept' }, { plugin: 'openshell', insecure: true })) as ResumeResponse
    assert.strictEqual(result.status, 500)
    assert.strictEqual(dials.length, 0)
  })
})

test('openshell: the real client dials the checked address and sends the original :authority', { timeout: 15_000 }, async () => {
  const protoDir = join(dirname(fileURLToPath(import.meta.url)), '../proto')
  const definition = protoLoader.loadSync(join(protoDir, 'openshell.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  })
  const service = (grpcjs.loadPackageDefinition(definition) as any).openshell.v1.OpenShell.service
  const hosts: string[] = []
  const server = new grpcjs.Server()
  server.addService(service, {
    ApproveDraftChunk(call: any, callback: (error: any, response?: any) => void) {
      hosts.push(call.getHost())
      callback(null, { policy_version: 7, policy_hash: 'pinned' })
    },
  })
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpcjs.ServerCredentials.createInsecure(), (error, bound) => (error ? reject(error) : resolve(bound)))
  )
  __resetOpenShellClientFactory()
  try {
    await withHooks({ resolve: answers('127.0.0.1'), connectTimeoutMs: 3000, totalTimeoutMs: 5000 }, async () => {
      const result = (await openshellPlugin.resume(pinnedOrigin(`openshell.example:${port}`), { decision: 'accept' }, { plugin: 'openshell', insecure: true })) as ResumeResponse
      assert.strictEqual(result.status, 200, result.error ?? '')
    })
  } finally {
    server.forceShutdown()
  }
  assert.deepStrictEqual(hosts, [`openshell.example:${port}`])
})

async function captureClientHello(run: (port: number) => Promise<void>): Promise<Buffer> {
  let hello = Buffer.alloc(0)
  const raw = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      hello = Buffer.concat([hello, chunk as Buffer])
      socket.destroy()
    })
  })
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
  try {
    await run((raw.address() as net.AddressInfo).port)
  } finally {
    raw.close()
  }
  return hello
}

test('openshell: the real client sends the original host as the TLS server name', { timeout: 15_000 }, async () => {
  __resetOpenShellClientFactory()
  const hello = await captureClientHello(async (port) => {
    await withHooks({ resolve: answers('127.0.0.1'), connectTimeoutMs: 500, totalTimeoutMs: 1000 }, async () => {
      const result = await openshellPlugin.healthcheck({ plugin: 'openshell', address: `tls-name.example:${port}`, tlsCa: tls.rootCertificates[0] })
      assert.strictEqual(result, 'error')
    })
  })
  assert.ok(hello.includes(Buffer.from('tls-name.example')), 'ClientHello carries the original host name')
})

test('openshell: a configured TLS name override still wins', { timeout: 15_000 }, async () => {
  __resetOpenShellClientFactory()
  const hello = await captureClientHello(async (port) => {
    await withHooks({ resolve: answers('127.0.0.1'), connectTimeoutMs: 500, totalTimeoutMs: 1000 }, async () => {
      const result = await openshellPlugin.healthcheck({
        plugin: 'openshell',
        address: `tls-name.example:${port}`,
        tlsCa: tls.rootCertificates[0],
        tlsSslTargetNameOverride: 'override.example',
      })
      assert.strictEqual(result, 'error')
    })
  })
  assert.ok(hello.includes(Buffer.from('override.example')))
  assert.ok(!hello.includes(Buffer.from('tls-name.example')))
})
