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
      'http://[fec0::1]',
      'http://[::fffe:7f00:1]',
      'https://localhost.example.com',
      'https://notlocalhost',
    ]) {
      assert.equal(isPrivateHost(hostOf(url)), false, `${url} -> ${hostOf(url)}`)
    }
  })
})
