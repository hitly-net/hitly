import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as http from 'node:http'
import * as net from 'node:net'
import { after, afterEach, before, describe, it } from 'node:test'
import {
  DESTINATION_ALLOW_PRIVATE_FLAG,
  DestinationCheckError,
  addressRefused,
  assertHostPortAllowed,
  checkedFetch,
  connectInOrder,
  destinationPolicyStartupNotice,
  grpcPinnedChannelOptions,
  grpcPinnedTarget,
  normalizeHost,
  parseCheckedUrl,
  parseHostPort,
  pinnedHostPort,
  pinnedNodeTransport,
  resolveAndCheck,
  resolveDestinationPolicy,
  resolveHostPortAllowed,
  setDestinationCheckTestHooks,
  type DestinationPolicy,
} from './destination-check.ts'

const PROD: DestinationPolicy = { allowPrivate: false, production: true }
const DEV: DestinationPolicy = { allowPrivate: true, production: false }

function refusedIn(policy: DestinationPolicy, url: string): boolean {
  try {
    parseCheckedUrl(url, policy)
    return false
  } catch (error) {
    assert.ok(error instanceof DestinationCheckError)
    return error.code === 'refused'
  }
}

describe('policy', () => {
  it('allows private targets outside production', () => {
    assert.equal(resolveDestinationPolicy({}).allowPrivate, true)
    assert.equal(resolveDestinationPolicy({ NODE_ENV: 'development' }).allowPrivate, true)
    assert.equal(resolveDestinationPolicy({ NODE_ENV: 'test' }).allowPrivate, true)
  })

  it('blocks private targets in production unless the flag is exactly "true"', () => {
    assert.equal(resolveDestinationPolicy({ NODE_ENV: 'production' }).allowPrivate, false)
    for (const value of ['1', 'TRUE', 'True', 'yes', ' true', 'false', '']) {
      assert.equal(
        resolveDestinationPolicy({ NODE_ENV: 'production', [DESTINATION_ALLOW_PRIVATE_FLAG]: value }).allowPrivate,
        false,
        `flag value ${JSON.stringify(value)} must not allow private targets`,
      )
    }
    assert.equal(
      resolveDestinationPolicy({ NODE_ENV: 'production', [DESTINATION_ALLOW_PRIVATE_FLAG]: 'true' }).allowPrivate,
      true,
    )
  })

  it('prints a startup line only when the flag allows private targets in production', () => {
    assert.equal(destinationPolicyStartupNotice({}), null)
    assert.equal(destinationPolicyStartupNotice({ NODE_ENV: 'production' }), null)
    const line = destinationPolicyStartupNotice({ NODE_ENV: 'production', [DESTINATION_ALLOW_PRIVATE_FLAG]: 'true' })
    assert.ok(line?.includes(DESTINATION_ALLOW_PRIVATE_FLAG))
  })
})

describe('address classes (production, flag off)', () => {
  const refused = [
    'http://127.0.0.1/',
    'http://127.255.255.254/',
    'http://[::1]/',
    'http://0.0.0.0/',
    'http://0.1.2.3/',
    'http://[::]/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://169.254.0.1/',
    'http://169.254.169.254/',
    'http://[fe80::1]/',
    'http://[febf::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://224.0.0.1/',
    'http://239.255.255.255/',
    'http://[ff02::1]/',
    'http://255.255.255.255/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[2002:7f00:1::]/',
    'http://[2002:c0a8:101::1]/',
    'http://localhost/',
    'http://localhost:3001/',
    'http://api.localhost/',
  ]
  for (const url of refused) {
    it(`refuses ${url}`, () => assert.equal(refusedIn(PROD, url), true))
  }

  const allowed = [
    'https://203.0.113.10/',
    'http://172.32.0.1/',
    'http://172.15.255.255/',
    'http://100.128.0.1/',
    'http://169.255.0.1/',
    'http://[2001:db8::1]/',
    'http://[64:ff9b::cb00:710a]/',
    'http://[2002:cb00:710a::]/',
    'https://sink.example.com/',
  ]
  for (const url of allowed) {
    it(`allows ${url}`, () => assert.equal(refusedIn(PROD, url), false))
  }
})

describe('IPv4 spellings', () => {
  const spellings = [
    '2130706433',
    '0177.0.0.1',
    '0x7f.1',
    '0x7f000001',
    '0X7F.0.0.1',
    '127.1',
    '127.0.1',
    '127.0.0.1.',
    '017700000001',
  ]
  for (const spelling of spellings) {
    it(`normalises ${spelling} and refuses it`, () => {
      assert.equal(normalizeHost(spelling), '127.0.0.1')
      assert.equal(refusedIn(PROD, `http://${spelling}/`), true)
    })
  }

  it('normalises upper case, brackets and a trailing dot', () => {
    assert.equal(normalizeHost('LOCALHOST.'), 'localhost')
    assert.equal(normalizeHost('[::FFFF:7F00:1]'), '::ffff:7f00:1')
    assert.equal(refusedIn(PROD, 'http://LOCALHOST./'), true)
    assert.equal(refusedIn(PROD, 'http://[::FFFF:127.0.0.1]/'), true)
    assert.equal(refusedIn(PROD, 'http://0xA9.0xFE.0xA9.0xFE/'), true)
    assert.equal(refusedIn(PROD, 'http://2852039166/'), true)
  })

  it('treats a non-IP literal passed to addressRefused as refused', () => {
    assert.equal(addressRefused('not-an-ip', DEV), true)
  })
})

describe('outside production', () => {
  it('allows loopback, private and localhost', () => {
    for (const url of ['http://127.0.0.1:3001/', 'http://localhost:1234/v1', 'http://10.0.0.5/', 'http://[::1]/']) {
      assert.equal(refusedIn(DEV, url), false, url)
    }
  })

  it('still refuses multicast and broadcast', () => {
    for (const url of ['http://224.0.0.1/', 'http://255.255.255.255/', 'http://[ff02::1]/']) {
      assert.equal(refusedIn(DEV, url), true, url)
    }
  })
})

describe('URL rules', () => {
  it('allows only http and https', () => {
    for (const url of ['ftp://203.0.113.10/', 'file:///etc/hosts', 'gopher://203.0.113.10/']) {
      assert.throws(() => parseCheckedUrl(url, DEV), (e: DestinationCheckError) => e.code === 'scheme')
    }
  })

  it('refuses a user name or password in the URL', () => {
    assert.throws(() => parseCheckedUrl('https://u-name-42:p-word-42@sink.example.com/', DEV), (e: DestinationCheckError) => {
      assert.equal(e.code, 'userinfo')
      assert.ok(!e.message.includes('p-word-42'))
      assert.ok(!e.message.includes('u-name-42'))
      return true
    })
  })

  it('checks non-default ports the same way', () => {
    assert.equal(refusedIn(PROD, 'http://127.0.0.1:8443/'), true)
    assert.equal(refusedIn(PROD, 'http://203.0.113.10:8443/'), false)
  })

  it('names the flag and the host in the refusal, and omits path and query', () => {
    try {
      parseCheckedUrl('http://127.0.0.1:9/private-path?token=abc', PROD)
      assert.fail('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      assert.ok(message.includes(DESTINATION_ALLOW_PRIVATE_FLAG))
      assert.ok(message.includes('127.0.0.1'))
      assert.ok(!message.includes('private-path'))
      assert.ok(!message.includes('token'))
    }
  })
})

describe('name resolution', () => {
  it('refuses a name when any answer is refused (public first, private second)', async () => {
    await assert.rejects(
      resolveAndCheck('mixed.example', PROD, async () => [{ address: '203.0.113.10' }, { address: '10.0.0.1' }]),
      (e: DestinationCheckError) => e.code === 'refused' && e.message.includes('mixed.example'),
    )
  })

  it('refuses a name with an IPv6 answer in a refused range', async () => {
    await assert.rejects(
      resolveAndCheck('v6.example', PROD, async () => [{ address: '2001:db8::1' }, { address: '::ffff:127.0.0.1' }]),
      (e: DestinationCheckError) => e.code === 'refused',
    )
  })

  it('reports a resolution failure without details', async () => {
    await assert.rejects(
      resolveAndCheck('missing.example', PROD, async () => {
        throw new Error('ENOTFOUND internal detail')
      }),
      (e: DestinationCheckError) => e.code === 'resolve' && !e.message.includes('internal detail'),
    )
  })

  it('returns all answers when every one is allowed', async () => {
    assert.deepEqual(
      await resolveAndCheck('ok.example', PROD, async () => [{ address: '203.0.113.10' }, { address: '2001:db8::1' }]),
      ['203.0.113.10', '2001:db8::1'],
    )
  })
})

// --- against 127.0.0.1 stub servers ----------------------------------------

type Hit = { host?: string; path?: string }

function startServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number; hits: Hit[] }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    hits.push({ host: req.headers.host, path: req.url })
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, hits }))
  })
}

const CANARY = 'canary-7f3e1c9a-body-text'

describe('checkedFetch against a 127.0.0.1 stub server', () => {
  let ok: Awaited<ReturnType<typeof startServer>>
  let other: Awaited<ReturnType<typeof startServer>>
  let redirector: Awaited<ReturnType<typeof startServer>>
  let failing: Awaited<ReturnType<typeof startServer>>
  let silent: Awaited<ReturnType<typeof startServer>>
  let large: Awaited<ReturnType<typeof startServer>>
  let endless: Awaited<ReturnType<typeof startServer>>
  let endlessSentLength: boolean | undefined

  before(async () => {
    ok = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    other = await startServer((_req, res) => res.end('second server'))
    redirector = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${other.port}/next` })
      res.end(CANARY)
    })
    failing = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(CANARY)
    })
    silent = await startServer(() => {
      // never answers
    })
    large = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write(`${CANARY}${'x'.repeat(4096)}`)
      res.end('x'.repeat(4096))
    })
    // Streams without a content-length and never ends on its own.
    endless = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      endlessSentLength = res.hasHeader('content-length')
      const chunk = `${CANARY}${'x'.repeat(1024)}`
      const timer = setInterval(() => res.write(chunk), 5)
      res.on('close', () => clearInterval(timer))
    })
  })

  after(() => {
    for (const s of [ok, other, redirector, failing, silent, large, endless]) {
      s.server.closeAllConnections()
      s.server.close()
    }
  })

  afterEach(() => setDestinationCheckTestHooks())

  it('refuses 127.0.0.1 in production with the flag off and does not connect', async () => {
    const before = ok.hits.length
    await assert.rejects(
      checkedFetch(`http://127.0.0.1:${ok.port}/`, {}, { policy: resolveDestinationPolicy({ NODE_ENV: 'production' }) }),
      (e: DestinationCheckError) => e.code === 'refused' && e.message.includes(DESTINATION_ALLOW_PRIVATE_FLAG),
    )
    assert.equal(ok.hits.length, before)
  })

  it('still refuses in production with the flag set to "1" or "TRUE"', async () => {
    for (const value of ['1', 'TRUE']) {
      const policy = resolveDestinationPolicy({ NODE_ENV: 'production', [DESTINATION_ALLOW_PRIVATE_FLAG]: value })
      await assert.rejects(checkedFetch(`http://127.0.0.1:${ok.port}/`, {}, { policy }), (e: DestinationCheckError) => e.code === 'refused')
    }
  })

  it('allows 127.0.0.1 in production with the flag set to "true"', async () => {
    const policy = resolveDestinationPolicy({ NODE_ENV: 'production', [DESTINATION_ALLOW_PRIVATE_FLAG]: 'true' })
    const response = await checkedFetch(`http://127.0.0.1:${ok.port}/`, {}, { policy })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  })

  it('allows 127.0.0.1 and localhost outside production', { timeout: 10_000 }, async () => {
    const policy = resolveDestinationPolicy({ NODE_ENV: 'development' })
    assert.equal((await checkedFetch(`http://127.0.0.1:${ok.port}/`, {}, { policy, totalTimeoutMs: 5000 })).status, 200)
    assert.equal((await checkedFetch(`http://localhost:${ok.port}/`, {}, { policy, totalTimeoutMs: 5000 })).status, 200)
  })

  it('tries each checked address in order until one connects (IPv6 loopback first)', { timeout: 10_000 }, async () => {
    const before = ok.hits.length
    const response = await checkedFetch(
      `http://localhost:${ok.port}/both`,
      {},
      {
        policy: DEV,
        totalTimeoutMs: 5000,
        resolveAddresses: async () => [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ],
      },
    )
    assert.equal(response.status, 200)
    assert.equal(ok.hits.length, before + 1)
    assert.equal(ok.hits.at(-1)!.path, '/both')
  })

  it('tries the next address for a dual-stack name', { timeout: 10_000 }, async () => {
    const response = await checkedFetch(
      `http://dual.example:${ok.port}/`,
      {},
      {
        policy: DEV,
        totalTimeoutMs: 5000,
        resolveAddresses: async () => [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ],
      },
    )
    assert.equal(response.status, 200)
    assert.equal(ok.hits.at(-1)!.host, `dual.example:${ok.port}`)
  })

  it('reports a fixed connect error when no checked address connects', { timeout: 10_000 }, async () => {
    const closed = await startServer(() => {})
    const port = closed.port
    closed.server.close()
    await assert.rejects(
      checkedFetch(`http://dual.example:${port}/`, {}, {
        policy: DEV,
        totalTimeoutMs: 5000,
        resolveAddresses: async () => [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
      (e: DestinationCheckError) => e.code === 'connect' && !e.message.includes('ECONNREFUSED'),
    )
  })

  it('does not try another address once a connection answered', { timeout: 10_000 }, async () => {
    const before = ok.hits.length
    const response = await checkedFetch(
      `http://dual.example:${failing.port}/`,
      {},
      {
        policy: DEV,
        totalTimeoutMs: 5000,
        resolveAddresses: async () => [
          { address: '127.0.0.1', family: 4 },
          { address: '::1', family: 6 },
        ],
      },
    )
    assert.equal(response.status, 500)
    assert.equal(ok.hits.length, before)
  })

  it('connects to no address when any answer is refused', async () => {
    const tried: string[] = []
    setDestinationCheckTestHooks({
      transport: async (request) => {
        tried.push(request.address)
        return { status: 200, statusText: 'OK', headers: new Headers(), body: new Uint8Array(0) }
      },
    })
    await assert.rejects(
      checkedFetch('https://sink.example.com/', {}, {
        policy: PROD,
        resolveAddresses: async () => [{ address: '203.0.113.10' }, { address: '::1' }],
      }),
      (e: DestinationCheckError) => e.code === 'refused',
    )
    assert.deepEqual(tried, [])
  })

  it('sends method, headers and body', async () => {
    const echo = await startServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => res.end(JSON.stringify({ method: req.method, h: req.headers['x-test'], body })))
    })
    const response = await checkedFetch(
      `http://127.0.0.1:${echo.port}/in`,
      { method: 'post', headers: { 'x-test': 'yes' }, body: 'hello' },
      { policy: DEV },
    )
    assert.deepEqual(await response.json(), { method: 'POST', h: 'yes', body: 'hello' })
    echo.server.close()
  })

  it('refuses redirects and does not contact the redirect target', async () => {
    const before = other.hits.length
    await assert.rejects(checkedFetch(`http://127.0.0.1:${redirector.port}/`, {}, { policy: DEV }), (e: DestinationCheckError) => {
      assert.equal(e.code, 'redirect')
      assert.equal(e.status, 302)
      assert.ok(!e.message.includes(CANARY))
      assert.ok(!e.message.includes(String(other.port)))
      return true
    })
    assert.equal(other.hits.length, before)
  })

  it('refuses an allowed host that redirects to a refused address', async () => {
    setDestinationCheckTestHooks({
      resolve: async () => [{ address: '203.0.113.10' }],
      transport: async () => ({
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: `http://127.0.0.1:${other.port}/` }),
        body: new Uint8Array(0),
      }),
    })
    const before = other.hits.length
    await assert.rejects(checkedFetch('https://sink.example.com/in', {}, { policy: PROD }), (e: DestinationCheckError) => e.code === 'redirect')
    assert.equal(other.hits.length, before)
  })

  it('pins the checked address even if the name would resolve differently later', { timeout: 10_000 }, async () => {
    let calls = 0
    const resolve = async () => {
      calls += 1
      return calls === 1 ? [{ address: '127.0.0.1' }] : [{ address: '203.0.113.99' }]
    }
    const response = await checkedFetch(`http://pinned.example:${ok.port}/path?q=1`, {}, {
      policy: DEV,
      resolveAddresses: resolve,
      connectTimeoutMs: 2000,
      totalTimeoutMs: 3000,
    })
    assert.equal(response.status, 200)
    assert.equal(calls, 1)
    const hit = ok.hits.at(-1)!
    assert.equal(hit.host, `pinned.example:${ok.port}`)
    assert.equal(hit.path, '/path?q=1')
  })

  it('keeps the TLS server name when connecting to the pinned address', { timeout: 10_000 }, async () => {
    let hello = Buffer.alloc(0)
    const raw = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        hello = Buffer.concat([hello, chunk as Buffer])
        socket.destroy()
      })
    })
    await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()))
    const port = (raw.address() as net.AddressInfo).port
    try {
      await assert.rejects(
        checkedFetch(`https://tls-name.example:${port}/`, {}, {
          policy: DEV,
          resolveAddresses: async () => [{ address: '127.0.0.1' }],
          connectTimeoutMs: 2000,
          totalTimeoutMs: 3000,
        }),
        (e: DestinationCheckError) => e.code === 'connect',
      )
    } finally {
      raw.close()
    }
    assert.ok(hello.includes(Buffer.from('tls-name.example')), 'ClientHello carries the original host name')
  })

  it('returns a non-2xx status; the error path never sees the body', async () => {
    const response = await checkedFetch(`http://127.0.0.1:${failing.port}/`, {}, { policy: DEV })
    assert.equal(response.status, 500)
  })

  it('caps the response size and omits the body from the error', async () => {
    await assert.rejects(
      checkedFetch(`http://127.0.0.1:${large.port}/`, {}, { policy: DEV, maxResponseBytes: 1024 }),
      (e: DestinationCheckError) => e.code === 'size' && !e.message.includes(CANARY),
    )
  })

  it('caps a streamed body that has no content-length', { timeout: 10_000 }, async () => {
    const started = Date.now()
    await assert.rejects(
      checkedFetch(`http://127.0.0.1:${endless.port}/`, {}, { policy: DEV, maxResponseBytes: 4096, totalTimeoutMs: 3000 }),
      (e: DestinationCheckError) => {
        assert.equal(e.code, 'size')
        assert.ok(!e.message.includes(CANARY))
        return true
      },
    )
    assert.equal(endlessSentLength, false)
    assert.ok(Date.now() - started < 2500, 'stopped by the size cap, not the total timeout')
  })

  it('stops at the total timeout', async () => {
    const started = Date.now()
    await assert.rejects(
      checkedFetch(`http://127.0.0.1:${silent.port}/`, {}, { policy: DEV, totalTimeoutMs: 200 }),
      (e: DestinationCheckError) => e.code === 'timeout',
    )
    assert.ok(Date.now() - started < 2000)
  })

  it('stops at the connect timeout', async () => {
    setDestinationCheckTestHooks({
      transport: (request) =>
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new DestinationCheckError('timeout', 'Destination check: the connection timed out.')), request.connectTimeoutMs)
          request.signal.addEventListener('abort', () => clearTimeout(timer))
        }),
    })
    await assert.rejects(
      checkedFetch('http://203.0.113.10/', {}, { policy: PROD, connectTimeoutMs: 50, totalTimeoutMs: 5000 }),
      (e: DestinationCheckError) => e.code === 'timeout',
    )
  })

  it('a connection failure reports a fixed message', async () => {
    const closed = await startServer(() => {})
    const port = closed.port
    closed.server.close()
    await assert.rejects(checkedFetch(`http://127.0.0.1:${port}/x?secret=1`, {}, { policy: DEV }), (e: DestinationCheckError) => {
      assert.equal(e.code, 'connect')
      assert.ok(!e.message.includes('secret'))
      assert.ok(!e.message.includes('ECONNREFUSED'))
      return true
    })
  })
})

// --- trying checked addresses over real sockets -----------------------------

/** A 127.0.0.1 listener that never accepts: its queue is full, so new connections stall. */
const STALLED_LISTENER = [
  "const net = require('net')",
  "const s = net.createServer()",
  "s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {",
  "  require('fs').writeSync(1, String(s.address().port) + '\\n')",
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)',
  '})',
].join('\n')

async function startStalledListener(): Promise<{ port: number; close: () => void }> {
  const child = spawn(process.execPath, ['-e', STALLED_LISTENER], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once('data', (data) => resolve(Number(String(data).trim())))
    child.once('error', reject)
  })
  const fillers: net.Socket[] = []
  for (let i = 0; i < 4; i++) {
    const socket = net.connect(port, '127.0.0.1')
    socket.on('error', () => {})
    fillers.push(socket)
  }
  await new Promise((r) => setTimeout(r, 150))
  return {
    port,
    close: () => {
      for (const socket of fillers) socket.destroy()
      child.kill('SIGKILL')
    },
  }
}

function startRawServer(onSocket: (socket: net.Socket) => void): Promise<{ server: net.Server; port: number; connections: () => number }> {
  let count = 0
  const server = net.createServer((socket) => {
    count += 1
    socket.on('error', () => {})
    onSocket(socket)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port, connections: () => count }))
  })
}

/**
 * Sends each checked documentation address to a local port through the real
 * socket transport, and records the order the addresses were tried in.
 */
function routeAddresses(routes: Record<string, number>, tried: string[]) {
  setDestinationCheckTestHooks({
    transport: (request) => {
      tried.push(request.address)
      const port = routes[request.address]
      assert.ok(port, `no route for ${request.address}`)
      return pinnedNodeTransport({ ...request, address: '127.0.0.1', port })
    },
  })
}

const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address }))

describe('checkedFetch tries checked addresses in order over real sockets', () => {
  let ok: Awaited<ReturnType<typeof startServer>>
  let second: Awaited<ReturnType<typeof startServer>>
  let stalled: Awaited<ReturnType<typeof startStalledListener>>
  let closedPort: number

  before(async () => {
    ok = await startServer((_req, res) => res.end('first'))
    second = await startServer((_req, res) => res.end('second'))
    stalled = await startStalledListener()
    const closed = await startServer(() => {})
    closedPort = closed.port
    await new Promise<void>((r) => closed.server.close(() => r()))
  })

  after(() => {
    for (const s of [ok, second]) {
      s.server.closeAllConnections()
      s.server.close()
    }
    stalled.close()
  })

  afterEach(() => setDestinationCheckTestHooks())

  it('does not try another address when the connection resets after the request was sent', { timeout: 10_000 }, async () => {
    const reset = await startRawServer((socket) => socket.once('data', () => socket.resetAndDestroy()))
    const tried: string[] = []
    routeAddresses({ '192.0.2.1': reset.port, '192.0.2.2': second.port }, tried)
    const before = second.hits.length
    try {
      await assert.rejects(
        checkedFetch('http://multi.example/', { method: 'POST', body: 'once' }, { policy: DEV, resolveAddresses: answers('192.0.2.1', '192.0.2.2'), totalTimeoutMs: 5000 }),
        (e: DestinationCheckError) => e.code === 'connect',
      )
    } finally {
      reset.server.close()
    }
    assert.deepEqual(tried, ['192.0.2.1'])
    assert.equal(second.hits.length, before)
  })

  it('does not try another address after a TLS handshake failure', { timeout: 10_000 }, async () => {
    const notTls = await startRawServer((socket) => socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')))
    const counter = await startRawServer((socket) => socket.destroy())
    const tried: string[] = []
    routeAddresses({ '192.0.2.1': notTls.port, '192.0.2.2': counter.port }, tried)
    try {
      await assert.rejects(
        checkedFetch('https://multi.example/', {}, { policy: DEV, resolveAddresses: answers('192.0.2.1', '192.0.2.2'), totalTimeoutMs: 5000 }),
        (e: DestinationCheckError) => e.code === 'connect',
      )
    } finally {
      notTls.server.close()
      counter.server.close()
    }
    assert.deepEqual(tried, ['192.0.2.1'])
    assert.equal(notTls.connections(), 1)
    assert.equal(counter.connections(), 0)
  })

  it('does not try another address after a partial response', { timeout: 10_000 }, async () => {
    const partial = await startServer((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' })
      res.write('only part of the body')
      setTimeout(() => res.socket?.destroy(), 20)
    })
    const tried: string[] = []
    routeAddresses({ '192.0.2.1': partial.port, '192.0.2.2': second.port }, tried)
    const before = second.hits.length
    try {
      await assert.rejects(
        checkedFetch('http://multi.example/', {}, { policy: DEV, resolveAddresses: answers('192.0.2.1', '192.0.2.2'), totalTimeoutMs: 5000 }),
        (e: DestinationCheckError) => e.code === 'connect',
      )
    } finally {
      partial.server.closeAllConnections()
      partial.server.close()
    }
    assert.deepEqual(tried, ['192.0.2.1'])
    assert.equal(partial.hits.length, 1)
    assert.equal(second.hits.length, before)
  })

  it('moves to the next address when the connect timeout passes', { timeout: 10_000 }, async () => {
    const tried: string[] = []
    routeAddresses({ '192.0.2.1': stalled.port, '192.0.2.2': ok.port }, tried)
    const started = Date.now()
    const response = await checkedFetch('http://multi.example/', {}, {
      policy: DEV,
      resolveAddresses: answers('192.0.2.1', '192.0.2.2'),
      connectTimeoutMs: 200,
      totalTimeoutMs: 5000,
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'first')
    assert.deepEqual(tried, ['192.0.2.1', '192.0.2.2'])
    assert.ok(Date.now() - started >= 150, 'waited for the connect timeout')
  })

  it('the total timeout covers every attempt', { timeout: 10_000 }, async () => {
    const tried: string[] = []
    routeAddresses({ '192.0.2.1': stalled.port, '192.0.2.2': stalled.port, '192.0.2.3': stalled.port }, tried)
    const started = Date.now()
    await assert.rejects(
      checkedFetch('http://multi.example/', {}, {
        policy: DEV,
        resolveAddresses: answers('192.0.2.1', '192.0.2.2', '192.0.2.3'),
        connectTimeoutMs: 400,
        totalTimeoutMs: 500,
      }),
      (e: DestinationCheckError) => e.code === 'timeout',
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 750, `stopped at the total timeout (took ${elapsed} ms)`)
    assert.deepEqual(tried, ['192.0.2.1', '192.0.2.2'])
  })

  it('keeps the resolver order', { timeout: 10_000 }, async () => {
    const tried: string[] = []
    routeAddresses({ '192.0.2.3': closedPort, '192.0.2.1': ok.port, '192.0.2.2': second.port }, tried)
    const before = second.hits.length
    const response = await checkedFetch('http://multi.example/', {}, {
      policy: DEV,
      resolveAddresses: answers('192.0.2.3', '192.0.2.1', '192.0.2.2'),
      totalTimeoutMs: 5000,
    })
    assert.equal(await response.text(), 'first')
    assert.deepEqual(tried, ['192.0.2.3', '192.0.2.1'])
    assert.equal(second.hits.length, before)
  })

  it('reports an immediate connect error without an uncaught exception', { timeout: 10_000 }, async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      await assert.rejects(
        checkedFetch('http://unroutable.example/', {}, {
          policy: DEV,
          resolveAddresses: async () => [{ address: '2001:db8::1', family: 6 }],
          connectTimeoutMs: 300,
          totalTimeoutMs: 1000,
        }),
        (e: DestinationCheckError) => e.code === 'connect' || e.code === 'timeout',
      )
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    assert.deepEqual(uncaught, [])
  })
})

// --- gRPC targets ------------------------------------------------------------

describe('pinned gRPC targets', () => {
  it('returns every checked address in resolver order with the original host', async () => {
    const checked = await resolveHostPortAllowed('Temporal.Example.com:7233', {
      policy: PROD,
      resolveAddresses: answers('2001:db8::7', '203.0.113.7'),
    })
    assert.deepEqual(checked, {
      host: 'Temporal.Example.com',
      serverName: 'temporal.example.com',
      port: 7233,
      addresses: ['2001:db8::7', '203.0.113.7'],
    })
    assert.deepEqual(grpcPinnedChannelOptions(checked), {
      'grpc.default_authority': 'Temporal.Example.com:7233',
      'grpc.ssl_target_name_override': 'temporal.example.com',
      'grpc.enable_http_proxy': 0,
    })
  })

  it('keeps an IP literal without resolving it', async () => {
    let lookups = 0
    const checked = await resolveHostPortAllowed('[2001:db8::1]:443', {
      policy: PROD,
      resolveAddresses: async () => {
        lookups += 1
        return []
      },
    })
    assert.equal(lookups, 0)
    assert.deepEqual(checked.addresses, ['2001:db8::1'])
    assert.equal(grpcPinnedChannelOptions(checked)['grpc.default_authority'], '[2001:db8::1]:443')
  })

  it('applies the same checks as assertHostPortAllowed', async () => {
    await assert.rejects(resolveHostPortAllowed('dns:sink.example.com:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'bad_url')
    await assert.rejects(
      resolveHostPortAllowed('grpc.example.com:50051', { policy: PROD, resolveAddresses: answers('203.0.113.10', '127.0.0.1') }),
      (e: DestinationCheckError) => e.code === 'refused',
    )
  })

  it('builds targets that dial the checked address', () => {
    assert.equal(grpcPinnedTarget('203.0.113.7', 7233), 'ipv4:203.0.113.7:7233')
    assert.equal(grpcPinnedTarget('2001:db8::7', 443), 'ipv6:[2001:db8::7]:443')
    assert.equal(grpcPinnedTarget('[2001:db8::7]', 443), 'ipv6:[2001:db8::7]:443')
    assert.equal(pinnedHostPort('203.0.113.7', 7233), '203.0.113.7:7233')
    assert.equal(pinnedHostPort('2001:db8::7', 443), '[2001:db8::7]:443')
    assert.throws(() => grpcPinnedTarget('sink.example.com', 443), (e: DestinationCheckError) => e.code === 'bad_url')
    assert.throws(() => pinnedHostPort('sink.example.com', 443), (e: DestinationCheckError) => e.code === 'bad_url')
  })
})

describe('connectInOrder', () => {
  it('tries addresses in order and stops at the first that opens', async () => {
    const tried: string[] = []
    const opened = await connectInOrder(['192.0.2.1', '192.0.2.2', '192.0.2.3'], async (address) => {
      tried.push(address)
      if (address === '192.0.2.1') throw new Error('refused')
      return `conn:${address}`
    })
    assert.equal(opened, 'conn:192.0.2.2')
    assert.deepEqual(tried, ['192.0.2.1', '192.0.2.2'])
  })

  it('moves on when one attempt passes its timeout and discards a late connection', async () => {
    const tried: string[] = []
    const discarded: unknown[] = []
    const opened = await connectInOrder(
      ['192.0.2.1', '192.0.2.2'],
      (address, timeoutMs) => {
        tried.push(address)
        if (address === '192.0.2.1') return new Promise((resolve) => setTimeout(() => resolve('late'), timeoutMs + 50))
        return Promise.resolve('second')
      },
      { connectTimeoutMs: 100, totalTimeoutMs: 2000, discard: (c) => discarded.push(c) },
    )
    assert.equal(opened, 'second')
    assert.deepEqual(tried, ['192.0.2.1', '192.0.2.2'])
    await new Promise((r) => setTimeout(r, 120))
    assert.deepEqual(discarded, ['late'])
  })

  it('gives each attempt no more than the time left', async () => {
    const timeouts: number[] = []
    const started = Date.now()
    await assert.rejects(
      connectInOrder(
        ['192.0.2.1', '192.0.2.2', '192.0.2.3'],
        (_address, timeoutMs) => {
          timeouts.push(timeoutMs)
          return new Promise<never>(() => {})
        },
        { connectTimeoutMs: 300, totalTimeoutMs: 450, host: 'multi.example' },
      ),
      (e: DestinationCheckError) => e.code === 'timeout' && e.message.includes('multi.example'),
    )
    assert.ok(Date.now() - started < 800)
    assert.equal(timeouts.length, 2)
    assert.equal(timeouts[0], 300)
    assert.ok(timeouts[1] <= 150)
  })

  it('reports the last error when no address opens', async () => {
    await assert.rejects(
      connectInOrder(['192.0.2.1', '192.0.2.2'], async (address) => {
        throw new Error(`failed ${address}`)
      }),
      /failed 192\.0\.2\.2/,
    )
  })

  it('uses the test-hook timeouts by default', async () => {
    setDestinationCheckTestHooks({ connectTimeoutMs: 50, totalTimeoutMs: 80 })
    try {
      const started = Date.now()
      await assert.rejects(
        connectInOrder(['192.0.2.1'], () => new Promise<never>(() => {})),
        (e: DestinationCheckError) => e.code === 'timeout',
      )
      assert.ok(Date.now() - started < 500)
    } finally {
      setDestinationCheckTestHooks()
    }
  })
})

describe('shared classifier ranges on the destination path', () => {
  const refusedInProd = [
    'http://198.18.0.1/',
    'http://198.19.255.254/',
    'http://192.0.0.1/',
    'http://240.0.0.1/',
    'http://254.255.255.255/',
    'http://[fec0::1]/',
    'http://[::ffff:0:808:808]/',
    'http://[64:ff9b:1::808:808]/',
    'http://[::8.8.8.8]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::c612:1]/',
    'http://[2002:c612:1::]/',
  ]
  for (const url of refusedInProd) {
    it(`refuses ${url} in production`, () => assert.equal(refusedIn(PROD, url), true))
    it(`allows ${url} outside production`, () => assert.equal(refusedIn(DEV, url), false))
  }

  const refusedEverywhere = [
    'http://224.0.0.1/',
    'http://239.255.255.255/',
    'http://255.255.255.255/',
    'http://[ff02::1]/',
    'http://[::ffff:224.0.0.1]/',
    'http://[2002:e000:1::]/',
    'http://[64:ff9b::e000:1]/',
  ]
  for (const url of refusedEverywhere) {
    it(`refuses ${url} in every environment`, () => {
      assert.equal(refusedIn(PROD, url), true)
      assert.equal(refusedIn(DEV, url), true)
    })
  }

  const publicTargets = [
    'http://8.8.8.8/',
    'http://198.20.0.1/',
    'http://[2606:4700:4700::1111]/',
    'http://[64:ff9b::808:808]/',
    'http://[64:ff9b::1.1.1.1]/',
    'http://[2002:808:808::]/',
  ]
  for (const url of publicTargets) {
    it(`allows ${url} in production`, () => assert.equal(refusedIn(PROD, url), false))
  }

  it('refuses a resolved answer in a newly covered range', async () => {
    await assert.rejects(
      resolveAndCheck('sink.example.com', PROD, async () => [{ address: '198.18.0.1', family: 4 }]),
      (error: unknown) => error instanceof DestinationCheckError && error.code === 'refused',
    )
    const ok = await resolveAndCheck('sink.example.com', PROD, async () => [{ address: '8.8.8.8', family: 4 }])
    assert.deepEqual(ok, ['8.8.8.8'])
  })
})

describe('host:port addresses', () => {
  const publicAnswer = async () => [{ address: '203.0.113.10' }]

  it('accepts a bare host:port or [IPv6]:port', async () => {
    for (const address of ['sink.example.com:7233', 'temporal_server:7233', '203.0.113.10:50051', '[2001:db8::1]:443', 'sink.example.com.:443']) {
      const checked = await assertHostPortAllowed(address, { policy: PROD, resolveAddresses: publicAnswer })
      assert.ok(checked.port > 0, address)
    }
    assert.deepEqual(parseHostPort('[2001:db8::1]:443'), { host: '[2001:db8::1]', port: 443 })
    assert.deepEqual(parseHostPort('sink.example.com:7233'), { host: 'sink.example.com', port: 7233 })
  })

  const refusedForms = [
    'dns://203.0.113.53/127.0.0.1:50051',
    'dns://203.0.113.53:53/localhost:50051',
    'dns:///127.0.0.1:50051',
    'dns:127.0.0.1:50051',
    'dns:localhost:50051',
    'DNS:sink.example.com:50051',
    'dns:50051',
    'unix:/tmp/hitly.sock',
    'unix:///tmp/hitly.sock',
    'unix:hitly.sock',
    'unix:50051',
    'unix-abstract:hitly',
    'unix-abstract:50051',
    'ipv4:127.0.0.1:50051',
    'ipv4:203.0.113.10:50051',
    'ipv4:203.0.113.10:50051,127.0.0.1:50051',
    'ipv6:[::1]:50051',
    'ipv6:[2001:db8::1]:50051',
    'IPV4:203.0.113.10:50051',
    'vsock:2:50051',
    'xds:///sink.example.com',
    'http://sink.example.com:7233',
    'https://sink.example.com:7233',
    'grpc://sink.example.com:7233',
    '//sink.example.com:7233',
    '/sink.example.com:7233',
    'sink.example.com:7233/',
    'sink.example.com:7233/path',
    'user@sink.example.com:7233',
    'sink.example.com:7233,other.example.com:7233',
    'sink.example.com:7233?x=1',
    'sink.example.com:7233#x',
    ' sink.example.com:7233',
    'sink.example.com:7233 ',
    'sink example.com:7233',
    'sink.example.com',
    'sink.example.com:',
    ':7233',
    'sink.example.com:0',
    'sink.example.com:65536',
    'sink.example.com:123456',
    '-sink.example.com:7233',
    '2001:db8::1:443',
    '[2001:db8::1]',
    '[2001:db8::1%eth0]:443',
    '[sink.example.com]:7233',
    '[203.0.113.10]:7233',
    '',
  ]

  for (const address of refusedForms) {
    it(`refuses ${JSON.stringify(address)} without resolving`, async () => {
      for (const policy of [PROD, DEV]) {
        let lookups = 0
        await assert.rejects(
          assertHostPortAllowed(address, {
            policy,
            resolveAddresses: async () => {
              lookups += 1
              return [{ address: '203.0.113.10' }]
            },
          }),
          (e: unknown) => e instanceof DestinationCheckError && e.code === 'bad_url',
        )
        assert.equal(lookups, 0)
      }
    })
  }

  it('still applies the address check to host:port', async () => {
    await assert.rejects(assertHostPortAllowed('127.0.0.1:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'refused')
    await assert.rejects(assertHostPortAllowed('[::1]:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'refused')
    await assert.rejects(assertHostPortAllowed('0x7f.1:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'refused')
    await assert.rejects(assertHostPortAllowed('localhost:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'refused')
    await assert.rejects(
      assertHostPortAllowed('grpc.example.com:50051', { policy: PROD, resolveAddresses: async () => [{ address: '127.0.0.1' }] }),
      (e: DestinationCheckError) => e.code === 'refused',
    )
    await assert.rejects(assertHostPortAllowed('[::ffff:127.0.0.1]:50051', { policy: PROD }), (e: DestinationCheckError) => e.code === 'refused')
    await assertHostPortAllowed('127.0.0.1:50051', { policy: DEV })
    await assertHostPortAllowed('localhost:50051', { policy: DEV, resolveAddresses: async () => [{ address: '127.0.0.1' }] })
  })
})
