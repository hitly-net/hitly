import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import * as schema from '@hitly/db/schema'

const url = process.env.DATABASE_URL
const pool = url ? mysql.createPool(url) : null

export const db = pool ? drizzle(pool, { schema, mode: 'default' }) : null
