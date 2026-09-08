// Ad-hoc query helper:  npm run db:query -- "select 1"
import { withClient } from './db.mjs'
const sql = process.argv.slice(2).join(' ')
if (!sql) { console.error('uso: npm run db:query -- "<sql>"'); process.exit(1) }
await withClient(async (db) => {
  const r = await db.query(sql)
  console.log(JSON.stringify(r.rows, null, 2))
})
