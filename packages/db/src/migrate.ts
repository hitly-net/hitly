import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL ?? 'postgres://hitly:hitly@localhost:5432/hitly'

async function waitForDatabase(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query('SELECT 1')
      return client
    } catch (error) {
      await client.end().catch(() => undefined)
      if (attempt === retries) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('Postgres did not become ready')
}

const client = await waitForDatabase()
const db = drizzle(client)
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')

await migrate(db, { migrationsFolder })
await client.end()
console.log('Hitly migrations applied')
