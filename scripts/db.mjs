// Shared Postgres connection helper for the migration/seed scripts.
// These run on YOUR machine only, never in the browser: they use the DB
// superuser password, which must never reach the frontend bundle.
import pg from 'pg'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..')
config({ path: resolve(ROOT, '.env') })

export function connectionString() {
  const url = process.env.VITE_SUPABASE_URL
  const pw = process.env.SUPABASE_BD_PASSWORD
  if (!url) throw new Error('VITE_SUPABASE_URL missing from .env')
  if (!pw) throw new Error('SUPABASE_BD_PASSWORD missing from .env')
  const ref = new URL(url).hostname.split('.')[0]
  return `postgresql://postgres:${encodeURIComponent(pw)}@db.${ref}.supabase.co:5432/postgres`
}

export async function withClient(fn) {
  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
    statement_timeout: 600_000,
    query_timeout: 600_000,
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
