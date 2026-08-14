import { db } from './db'

export function requireDb() {
  if (!db) {
    throw new Error('DATABASE_URL is not set')
  }
  return db
}
