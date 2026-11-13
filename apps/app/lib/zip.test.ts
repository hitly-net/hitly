import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { crc32, createZip, type ZipEntry } from './zip'

/**
 * Unit tests for the minimal ZIP writer. The archive is parsed back by hand
 * (local headers + central directory) and every entry is inflated and
 * CRC-checked, so a broken header field, CRC, size or offset turns this RED.
 */

function parseZip(zip: Buffer): Map<string, Buffer> {
  const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocdOffset > 0, 'end-of-central-directory signature present')
  const total = zip.readUInt16LE(eocdOffset + 10)
  const centralSize = zip.readUInt32LE(eocdOffset + 12)
  const centralOffset = zip.readUInt32LE(eocdOffset + 16)

  const entries = new Map<string, Buffer>()
  let p = centralOffset
  for (let i = 0; i < total; i += 1) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50, `central entry ${i} magic`)
    const method = zip.readUInt16LE(p + 10)
    const crc = zip.readUInt32LE(p + 16)
    const compressedSize = zip.readUInt32LE(p + 20)
    const uncompressedSize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    // Local header must agree with the central directory.
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, `${name} local magic`)
    const localNameLen = zip.readUInt16LE(localOffset + 26)
    const dataStart = localOffset + 30 + localNameLen
    const body = zip.subarray(dataStart, dataStart + compressedSize)
    const raw = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    assert.equal(raw.length, uncompressedSize, `${name} uncompressed size`)
    assert.equal(crc32(raw), crc, `${name} crc`)
    entries.set(name, raw)
    p += 46 + nameLen
  }
  assert.ok(centralOffset + centralSize <= zip.length)
  return entries
}

describe('zip writer', () => {
  it('writes a valid archive with deflate entries round-tripping byte-exact', () => {
    const entries: ZipEntry[] = [
      { name: 'profile.json', data: new TextEncoder().encode(JSON.stringify({ name: 'Ada', note: 'a'.repeat(500) })) },
      { name: 'manifest.json', data: new TextEncoder().encode('{"kind":"hitly-data-export","version":1}') },
    ]
    const parsed = parseZip(createZip(entries))
    assert.deepEqual([...parsed.keys()], ['profile.json', 'manifest.json'])
    assert.equal(parsed.get('profile.json')?.toString('utf8'), Buffer.from(entries[0].data).toString('utf8'))
    assert.equal(parsed.get('manifest.json')?.toString('utf8'), Buffer.from(entries[1].data).toString('utf8'))
  })

  it('handles empty files and UTF-8 names', () => {
    const entries: ZipEntry[] = [
      { name: 'empty.json', data: new TextEncoder().encode('') },
      { name: 'ünïcode.json', data: new TextEncoder().encode('ünïcode') },
    ]
    const parsed = parseZip(createZip(entries))
    assert.equal(parsed.get('empty.json')?.length, 0)
    assert.equal(parsed.get('ünïcode.json')?.toString('utf8'), 'ünïcode')
  })

  it('falls back to stored entries when deflate would grow the data', () => {
    const random = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7919) & 0xff))
    const parsed = parseZip(createZip([{ name: 'rand.bin', data: new Uint8Array(random) }]))
    assert.deepEqual([...(parsed.get('rand.bin') ?? Buffer.alloc(0))], [...random])
  })

  it('produces an empty but valid archive for no entries', () => {
    const zip = createZip([])
    assert.equal(zip.length, 22)
    assert.equal(zip.readUInt32LE(0), 0x06054b50)
  })
})
