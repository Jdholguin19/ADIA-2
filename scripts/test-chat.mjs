// Prueba extremo a extremo del copiloto: login real -> /api/chat -> SSE.
// Recorre exactamente el mismo camino que el navegador.
//   npm run test:chat
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(ROOT, '.env') })

const URL_ = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const EMAIL = process.env.ADIA_ADMIN_EMAIL || 'sistemas@thaliavictoria.com.ec'
const PASSWORD = process.env.ADIA_ADMIN_PASSWORD || 'AdiaDemo2026!'
const APP = process.env.ADIA_APP_URL || 'http://localhost:5173'
const DS = Number(process.argv[2] || 1)

const auth = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: ANON, 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json())

if (!auth.access_token) {
  console.error('No se pudo iniciar sesion:', auth.error_description || auth.msg || JSON.stringify(auth))
  process.exit(1)
}
console.log('Sesion iniciada como ' + EMAIL + '\n')

const PREGUNTAS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      '¿Cuántos trabajadores hay en total?',
      '¿Cuántos conserjes tengo?',
      'Dame la lista de los empleados que ganen más de $5000 al mes',
      '¿Cuántos trabajadores hay en total?', // repetida: debe entrar por cache
      '¿Cuántos conserjes tenía en marzo de 2016?', // parecida pero con OTRO periodo
    ]

async function ask(q) {
  const t0 = Date.now()
  const res = await fetch(APP + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.access_token },
    body: JSON.stringify({ dataset_id: DS, message: q }),
  })
  if (!res.ok) {
    console.log('  HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300))
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', text = '', sql = null, rows = null, count = null, cached = false, sim = null
  let warnings = [], err = null, ms = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n'); buf = parts.pop() || ''
    for (const p of parts) {
      const line = p.replace(/^data:\s*/, '').trim()
      if (!line) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.t === 'delta') text += ev.text
      else if (ev.t === 'sql') { sql = ev.sql; warnings = ev.warnings || [] }
      else if (ev.t === 'result') { rows = ev.rows; count = ev.row_count; ms = ev.elapsed_ms }
      else if (ev.t === 'cache' && ev.hit) { cached = true; sim = ev.similarity }
      else if (ev.t === 'error') err = ev.message
    }
  }
  console.log('P: ' + q)
  if (cached) console.log('   [CACHE] acierto, similitud ' + sim + ' — se reejecuta el SQL')
  if (err) console.log('   ERROR: ' + err)
  if (sql) console.log('   SQL: ' + sql.replace(/\s+/g, ' ').slice(0, 210))
  if (rows) {
    console.log('   ' + count + ' fila(s) en ' + ms + ' ms: ' +
      JSON.stringify(rows.slice(0, 3)).slice(0, 220))
  }
  for (const w of warnings) console.log('   AVISO: ' + String(w).slice(0, 130))
  console.log('   R: ' + text.replace(/\n+/g, ' ').slice(0, 460))
  console.log('   (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)\n')
}

for (const q of PREGUNTAS) await ask(q)
