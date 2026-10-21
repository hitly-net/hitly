import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateHost, parseIPv4, parseIPv6 } from './host-classify'

/** Hostname classification used for production origin trust (lib/host-classify.ts). */

function hostOf(url: string) {
  return new URL(url).hostname
}

describe('address parsing', () => {
  it('parses IPv4 dotted quads strictly', () => {
    assert.deepEqual(parseIPv4('192.0.2.1'), [192, 0, 2, 1])
    assert.equal(parseIPv4('256.0.0.1'), null)
    assert.equal(parseIPv4('1.2.3'), null)
    assert.equal(parseIPv4('a.b.c.d'), null)
  })

  it('parses IPv6 including compression and an embedded IPv4 tail', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1])
    assert.deepEqual(parseIPv6('::'), [0, 0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(parseIPv6('fe80::1%eth0'), [0xfe80, 0, 0, 0, 0, 0, 0, 1])
    assert.deepEqual(parseIPv6('::ffff:192.0.2.1'), [0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201])
    assert.deepEqual(parseIPv6('2001:db8:0:0:0:0:0:1'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
    assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null)
    assert.equal(parseIPv6('1::2::3'), null)
    assert.equal(parseIPv6('example.com'), null)
  })
})

describe('isPrivateHost', () => {
  it('classifies non-public hosts as private (brackets stripped)', () => {
    for (const url of [
      'http://127.0.0.1',
      'http://127.1.2.3',
      'http://0.0.0.0',
      'http://0.1.2.3',
      'http://10.0.0.1',
      'http://172.16.0.1',
      'http://172.31.0.1',
      'http://192.168.0.1',
      'http://100.64.0.1',
      'http://100.127.0.1',
      'http://169.254.0.1',
      'http://[::1]',
      'http://[::]',
      'http://[fe80::abcd]',
      'http://[fc00::1]',
      'http://[fdff::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:8.8.8.8]',
      'http://localhost',
      'http://localhost.',
      'http://LOCALHOST',
      'http://a.b.localhost',
      'http://a.localhost.',
      'http://2130706433',
      'http://0x7f000001',
    ]) {
      assert.equal(isPrivateHost(hostOf(url)), true, `${url} -> ${hostOf(url)}`)
    }
    assert.equal(isPrivateHost('[::1]'), true)
    assert.equal(isPrivateHost('::1'), true)
  })

  it('leaves public hosts alone', () => {
    for (const url of [
      'https://app.example.com',
      'http://8.8.8.8',
      'http://172.15.0.1',
      'http://172.32.0.1',
      'http://100.63.255.255',
      'http://100.128.0.1',
      'http://169.253.0.1',
      'http://11.0.0.1',
      'http://[2001:db8::1]',
      'http://[fe00::1]',
      'http://[::fffe:7f00:1]',
      'https://localhost.example.com',
      'https://notlocalhost',
    ]) {
      assert.equal(isPrivateHost(hostOf(url)), false, `${url} -> ${hostOf(url)}`)
    }
  })
})

describe('isPrivateHost: further non-public ranges', () => {
  const host = (url: string) => isPrivateHost(hostOf(url))

  it('IPv4-mapped ::ffff:0:0/96', () => {
    assert.equal(host('http://[::ffff:127.0.0.1]'), true)
    assert.equal(host('http://[::ffff:cb00:7101]'), true)
  })

  it('IPv4-translated ::ffff:0:0:0/96', () => {
    assert.equal(host('http://[::ffff:0:7f00:1]'), true)
  })

  it('IPv4-compatible ::/96', () => {
    assert.equal(host('http://[::7f00:1]'), true)
    assert.equal(host('http://[::127.0.0.1]'), true)
    assert.equal(host('http://[::cb00:7101]'), true)
  })

  it('6to4 2002::/16 classifies the embedded IPv4 address', () => {
    assert.equal(host('http://[2002:7f00:1::]'), true)
    assert.equal(host('http://[2002:c0a8:101::1]'), true)
    assert.equal(host('http://[2002:a9fe:a9fe::]'), true)
    assert.equal(host('http://[2002:cb00:7101::1]'), false)
  })

  it('NAT64 64:ff9b::/96 classifies the embedded IPv4 address', () => {
    assert.equal(host('http://[64:ff9b::7f00:1]'), true)
    assert.equal(host('http://[64:ff9b::10.0.0.1]'), true)
    assert.equal(host('http://[64:ff9b::cb00:7101]'), false)
  })

  it('local-use NAT64 64:ff9b:1::/48', () => {
    assert.equal(host('http://[64:ff9b:1::7f00:1]'), true)
    assert.equal(host('http://[64:ff9b:1:cb00:71::1]'), true)
  })

  it('site-local fec0::/10', () => {
    assert.equal(host('http://[fec0::1]'), true)
    assert.equal(host('http://[feff::1]'), true)
  })

  it('benchmarking 198.18.0.0/15', () => {
    assert.equal(host('http://198.18.0.1'), true)
    assert.equal(host('http://198.19.255.254'), true)
    assert.equal(host('http://198.20.0.1'), false)
    assert.equal(host('http://198.17.255.255'), false)
  })

  it('IETF protocol assignments 192.0.0.0/24', () => {
    assert.equal(host('http://192.0.0.1'), true)
    assert.equal(host('http://192.0.0.255'), true)
    assert.equal(host('http://192.0.1.1'), false)
  })

  it('reserved 240.0.0.0/4', () => {
    assert.equal(host('http://240.0.0.1'), true)
    assert.equal(host('http://254.255.255.255'), true)
    assert.equal(host('http://239.255.255.255'), false)
  })

  it('broadcast 255.255.255.255', () => {
    assert.equal(host('http://255.255.255.255'), true)
  })

  it('public IPv4 and IPv6 stay public', () => {
    for (const url of ['http://203.0.113.1', 'http://[2001:db8::1]', 'https://app.example.com']) {
      assert.equal(host(url), false, url)
    }
  })
})
