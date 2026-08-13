import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@hitly/db/schema'

const url = process.env.DATABASE_URL

export const db = url ? drizzle(postgres(url), { schema }) : null
