import { randomBytes } from 'node:crypto'

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || 'workspace'
}
