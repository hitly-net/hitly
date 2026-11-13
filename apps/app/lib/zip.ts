/**
 * Minimal ZIP writer (no dependency). Produces a valid ZIP archive from a
 * list of entries using deflate (raw) with a stored fallback when deflate
 * does not help. Sufficient for the small JSON export bundles; not a
 * general-purpose archive library.
 */

import { deflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; data: Uint8Array }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(date.getUTCFullYear(), 1980)
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1)
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, date: day }
}

/**
 * Build a ZIP archive (Buffer) from entries. Names must be forward-slash
 * paths without a leading '/'. Duplicate names are written as-is (the
 * extractor keeps the last); callers control the entry list.
 */
export function createZip(entries: ZipEntry[], modified = new Date()): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const { time, date } = dosDateTime(modified)

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data)
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header magic
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18) // compressed size
    local.writeUInt32LE(raw.length, 22) // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    parts.push(local, nameBuf, body)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0) // central directory magic
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0x0800, 8) // flags: UTF-8 names
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(time, 12)
    dir.writeUInt16LE(date, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42) // local header offset

    central.push(Buffer.concat([dir, nameBuf]))
    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end-of-central-directory magic
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, centralBuf, eocd])
}
