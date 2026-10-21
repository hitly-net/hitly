import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as net from 'node:net'
import { after, afterEach, before, describe, it } from 'node:test'
import {
  DESTINATION_ALLOW_PRIVATE_FLAG,
  DestinationCheckError,
  addressRefused,
  checkedFetch,
  destinationPolicyStartupNotice,
  normalizeHost,
  parseCheckedUrl,
  resolveAndCheck,
  resolveDestinationPolicy,
  setDestinationCheckTestHooks,
  type DestinationPolicy,
} from './destination-check'

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
