import { drizzle } from 'drizzle-orm/mysql2'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import mysql from 'mysql2/promise'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.env.DATABASE_URL ?? 'mysql://hitly:hitly@localhost:3306/hitly'

async function waitForDatabase(retries = 30) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const connection = await mysql.createConnection(url)
      await connection.ping()
      return connection
    } catch (error) {
      if (attempt === retries) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('MariaDB did not become ready')
}

const connection = await waitForDatabase()
const db = drizzle(connection)
const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')

await migrate(db, { migrationsFolder })
await connection.end()
console.log('Hitly migrations applied')
