import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '@hitly/db/schema'

const url = process.env.DATABASE_URL
export const pool = url ? new pg.Pool({ connectionString: url }) : null

export const db = pool ? drizzle(pool, { schema }) : null
