// Carga un XLSX/CSV en Supabase recorriendo EXACTAMENTE el mismo camino que
// el navegador (create_dataset -> ingest_chunk -> build_step), pero desde
// node. Sirve para sembrar datos y como prueba end-to-end del pipeline.
//
//   npm run load -- salaries-municipality-guayaquil.xlsx
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { withClient, ROOT } from './db.mjs'
import { inferColumns, detectHeaderRow, sampleIndices } from '../src/lib/ingest/infer.js'

const file = process.argv[2]
if (!file) {
  console.error('uso: npm run load -- <archivo.xlsx|csv>')
  process.exit(1)
}
const path = resolve(ROOT, file)
const CHUNK = 2000

const EMAIL = process.env.ADIA_ADMIN_EMAIL || 'sistemas@thaliavictoria.com.ec'
const PASSWORD = process.env.ADIA_ADMIN_PASSWORD || 'AdiaDemo2026!'

async function ensureUser(db) {
  const found = await db.query('select id from auth.users where email = $1', [EMAIL])
  if (found.rows.length) return found.rows[0].id

  // OJO con las columnas de token: GoTrue esta escrito en Go y no puede
  // escanear NULL en un string no anulable. Si se dejan nulas, el login
  // falla con un 500 opaco ("Database error querying schema") aunque la
  // fila parezca perfecta. Tienen que ser cadena vacia.
  const { rows } = await db.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
             'authenticated', 'authenticated', $1,
             extensions.crypt($2, extensions.gen_salt('bf')), now(),
             '{"provider":"email","providers":["email"]}', '{}', now(), now(),
             '', '', '', '', '', '', '', '')
     returning id`,
    [EMAIL, PASSWORD],
  )
  const id = rows[0].id
  // GoTrue moderno espera ademas una fila en auth.identities.
  await db.query(
    `insert into auth.identities
       (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text),
             'email', now(), now(), now())
     on conflict do nothing`,
    [id, EMAIL],
  )
  console.log(`Usuario creado: ${EMAIL} / ${PASSWORD}`)
  return id
}

function readTable(buf, name) {
  if (/\.csv$/i.test(name)) {
    const wb = XLSX.read(buf.toString('utf8'), { type: 'string', raw: true, dense: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return { sheet: wb.SheetNames[0], rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) }
  }
  const wb = XLSX.read(buf, {
    type: 'buffer', dense: true, raw: true, cellDates: false, cellStyles: false, cellHTML: false,
  })
  const sheet = wb.SheetNames[0]
  const ws = wb.Sheets[sheet]
  return { sheet, rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) }
}

const t0 = Date.now()
const buf = await readFile(path)
const content_hash = createHash('sha256').update(buf).digest('hex')
console.log(`Leyendo ${basename(path)} (${(buf.length / 1e6).toFixed(1)} MB)...`)

const { sheet, rows: raw } = readTable(buf, path)
const hdrRow = detectHeaderRow(raw)
const headers = raw[hdrRow].map((h) => (h == null ? '' : String(h)))
const body = raw.slice(hdrRow + 1).filter((r) => r && r.some((c) => c !== null && c !== ''))
console.log(`Hoja "${sheet}": ${body.length} filas x ${headers.length} columnas (cabecera en fila ${hdrRow + 1})`)

// Muestreo repartido por todo el archivo, no solo la cabeza: si solo miraras
// las primeras filas te perderias la deriva de tipos del final.
const idx = sampleIndices(body.length, 5000)
const sample = idx ? [...idx].map((i) => body[i]).filter(Boolean) : body
const columns = inferColumns(headers, sample)
console.log('Tipos inferidos:', columns.map((c) => `${c.column_name}:${c.data_type}${c.role !== 'unknown' ? '/' + c.role : ''}`).join(' '))

await withClient(async (db) => {
  const uid = await ensureUser(db)
  // Nos hacemos pasar por el usuario: auth.uid() resuelve y la RLS aplica
  // igual que aplicaria desde el navegador.
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated', email: EMAIL }),
  ])
  await db.query(`select set_config('role', 'authenticated', false)`)

  const created = await db.query(
    'select public.create_dataset($1,$2,$3,$4,$5::jsonb,$6,$7) as r',
    [basename(path).replace(/\.[^.]+$/, ''), basename(path), sheet, content_hash,
     JSON.stringify(columns), body.length, CHUNK],
  )
  const info = created.rows[0].r
  const datasetId = Number(info.dataset_id)
  const done = new Set((info.chunks_done || []).map(Number))
  console.log(`Dataset #${datasetId}${info.resumed ? ` (reanudado, ${done.size} trozos ya cargados)` : ''}`)

  const total = Math.ceil(body.length / CHUNK)
  let sent = 0
  for (let ci = 0; ci < total; ci++) {
    if (done.has(ci)) continue
    const slice = body.slice(ci * CHUNK, (ci + 1) * CHUNK)
    const payload = slice.map((r) => {
      const o = {}
      for (let i = 0; i < columns.length; i++) {
        const v = r[i]
        o[columns[i].column_name] = v === null || v === undefined ? null : String(v)
      }
      return o
    })
    await db.query('select public.ingest_chunk($1,$2,$3::jsonb)', [datasetId, ci, JSON.stringify(payload)])
    sent += slice.length
    if (ci % 10 === 0 || ci === total - 1)
      process.stdout.write(`\r  cargando ${sent}/${body.length} filas (${Math.round((100 * (ci + 1)) / total)}%)   `)
  }
  console.log()
  console.log(JSON.stringify((await db.query('select public.finish_ingest($1) as r', [datasetId])).rows[0].r))

  // Pipeline analitico
  for (const step of [
    ['app.validate_types', 'validando tipos'],
    ['app.build_silver', 'tipando'],
    ['app.profile_dataset', 'perfilando'],
    ['app.build_value_dictionary', 'diccionario de valores'],
  ]) {
    const s = Date.now()
    const r = await db.query(`select ${step[0]}($1) as r`, [datasetId])
    console.log(`${step[1]}: ${JSON.stringify(r.rows[0].r)}  (${Date.now() - s} ms)`)
  }

  const grain = (await db.query('select app.detect_grain($1) as r', [datasetId])).rows[0].r
  console.log('\nGRANO:', JSON.stringify(grain, null, 2))
  await db.query(
    `update public.datasets set profile = profile || $2::jsonb where id = $1`,
    [datasetId, JSON.stringify(grain)],
  )

  const derived = (await db.query('select app.detect_derived_columns($1) as r', [datasetId])).rows[0].r
  console.log('\nDERIVADAS:', JSON.stringify(derived.rules, null, 2))

  console.log(`\nListo en ${((Date.now() - t0) / 1000).toFixed(1)} s. dataset_id=${datasetId}`)
})
