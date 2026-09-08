// Applies supabase/migrations/*.sql in filename order, tracked in a ledger table.
// Each file runs inside one transaction: a failing migration leaves no partial state.
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withClient, ROOT } from './db.mjs'

const DIR = resolve(ROOT, 'supabase/migrations')
const statusOnly = process.argv.includes('--status')

await withClient(async (db) => {
  await db.query(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    )`)

  const applied = new Map(
    (await db.query('select version, applied_at from public.schema_migrations')).rows
      .map((r) => [r.version, r.applied_at]),
  )
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()

  if (statusOnly) {
    for (const f of files) {
      const at = applied.get(f)
      console.log(`${at ? 'x' : ' '} ${f}${at ? `  (${at.toISOString()})` : ''}`)
    }
    return
  }

  const pending = files.filter((f) => !applied.has(f))
  if (!pending.length) return console.log('Sin migraciones pendientes.')

  for (const file of pending) {
    const sql = await readFile(resolve(DIR, file), 'utf8')
    const t0 = Date.now()
    process.stdout.write(`-> ${file} ... `)
    try {
      await db.query('begin')
      await db.query(sql)
      await db.query(
        'insert into public.schema_migrations(version, duration_ms) values ($1,$2)',
        [file, Date.now() - t0],
      )
      await db.query('commit')
      console.log(`ok (${Date.now() - t0} ms)`)
    } catch (err) {
      await db.query('rollback')
      console.log('FALLO')
      console.error(`\n${file}: ${err.message}`)
      if (err.position && err.length === undefined) {
        const pos = Number(err.position)
        console.error('  ...' + sql.slice(Math.max(0, pos - 220), pos + 220).replace(/\n/g, '\n  '))
      }
      process.exit(1)
    }
  }
  console.log(`\n${pending.length} migracion(es) aplicadas.`)
})
