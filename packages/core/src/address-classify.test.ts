import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyAddress } from './address-classify.ts'

describe('shared address classifier', () => {
  const cases: Array<[string, string, ReturnType<typeof classifyAddress>]> = [
    ['benchmarking 198.18.0.0/15', '198.18.0.1', 'private'],
    ['benchmarking 198.18.0.0/15 (upper half)', '198.19.255.254', 'private'],
    ['IETF protocol assignments 192.0.0.0/24', '192.0.0.1', 'private'],
    ['reserved 240.0.0.0/4', '240.0.0.1', 'private'],
    ['reserved 240.0.0.0/4 (top)', '254.255.255.255', 'private'],
    ['limited broadcast', '255.255.255.255', 'multicast'],
    ['IPv4 multicast 224.0.0.0/4', '224.0.0.1', 'multicast'],
    ['IPv4 multicast 224.0.0.0/4 (top)', '239.255.255.255', 'multicast'],
    ['IPv6 multicast ff00::/8', 'ff02::1', 'multicast'],
    ['site-local fec0::/10', 'fec0::1', 'private'],
    ['site-local fec0::/10 (top)', 'feff::1', 'private'],
    ['IPv4-translated ::ffff:0:0:0/96', '::ffff:0:808:808', 'private'],
    ['local-use NAT64 64:ff9b:1::/48', '64:ff9b:1::808:808', 'private'],
    ['IPv4-compatible ::/96 with a global IPv4', '::8.8.8.8', 'private'],
    ['IPv4-mapped ::ffff:0:0/96 with a global IPv4', '::ffff:8.8.8.8', 'private'],
    ['IPv4-mapped multicast', '::ffff:224.0.0.1', 'multicast'],
    ['6to4 with private IPv4', '2002:c0a8:101::1', 'private'],
    ['6to4 with multicast IPv4', '2002:e000:1::', 'multicast'],
    ['NAT64 /96 with loopback IPv4', '64:ff9b::7f00:1', 'private'],
    ['NAT64 /96 with benchmarking IPv4', '64:ff9b::c612:1', 'private'],
    ['public IPv4', '8.8.8.8', 'public'],
    ['public IPv4 next to benchmarking', '198.20.0.1', 'public'],
    ['public IPv6', '2606:4700:4700::1111', 'public'],
    ['6to4 with a global IPv4', '2002:808:808::', 'public'],
    ['NAT64 /96 with a global IPv4', '64:ff9b::808:808', 'public'],
    ['NAT64 /96 with a global IPv4 (dotted tail)', '64:ff9b::1.1.1.1', 'public'],
    ['bracketed IPv6', '[2606:4700:4700::1111]', 'public'],
    ['not an IP literal', 'example.com', null],
  ]
  for (const [label, address, expected] of cases) {
    it(`${label}: ${address} -> ${expected}`, () => assert.equal(classifyAddress(address), expected))
  }
})
