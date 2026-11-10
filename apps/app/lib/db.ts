import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '@hitly/db/schema'
import { createAppPool } from './db-pool'

const url = process.env.DATABASE_URL
export const pool = url ? createAppPool(url) : null

export const db = pool ? drizzle(pool, { schema }) : null
