/**
 * Tiny PNG helper: encode RGBA pixel data as a 24-bit RGB PNG with no alpha
 * channel (colour type 2), which is what the App Store requires for the
 * 1024px iOS icon. Kept dependency-free so icon generation is reproducible
 * with only @resvg/resvg-js + Node stdlib.
 */
import { deflateSync } from 'node:zlib'

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer[] {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, Buffer.from(data)])))
  return [len, typeBuf, Buffer.from(data), crc]
}

/**
 * Throws if any pixel is actually translucent rather than silently dropping
 * the alpha channel.
 */
export function encodeRgbPng(rgba: Uint8Array, width: number, height: number): Buffer {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) throw new Error('refusing to drop alpha: image contains translucent pixels')
  }
  const raw = Buffer.alloc(height * (1 + width * 3))
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      raw[o++] = rgba[s]
      raw[o++] = rgba[s + 1]
      raw[o++] = rgba[s + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB, no alpha
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', deflateSync(raw, { level: 9 })),
    ...chunk('IEND', new Uint8Array(0)),
  ]
  return Buffer.concat(parts)
}
