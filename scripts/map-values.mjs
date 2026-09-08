// Confirma equivalencias de valores para una columna con deriva de
// codificacion, y las aplica.
//
//   npm run map -- 1 labor_regime '{"1":"LOSEP","2":"CT","3":"LOEI"}'
//
// El valor CRUDO no se toca: el mapa rellena la columna <col>_norm, asi que
// siempre se puede auditar que decia el archivo y rehacer el mapeo.
import { withClient } from './db.mjs'

const DS = Number(process.argv[2] || 1)
const COL = process.argv[3]
const MAP = process.argv[4]

if (!COL || !MAP) {
  console.error('uso: npm run map -- <dataset_id> <columna> \'{"crudo":"etiqueta",...}\'')
  process.exit(1)
}

await withClient(async (db) => {
  const uid = (await db.query('select owner_id from datasets where id=$1', [DS])).rows[0]?.owner_id
  if (!uid) { console.error('No existe el dataset ' + DS); process.exit(1) }
  await db.query(`select set_config('request.jwt.claims',$1,false)`,
    [JSON.stringify({ sub: uid, role: 'authenticated' })])

  const before = (await db.query(
    `select coalesce(value,'(nulo)') v, n from dataset_values
      where dataset_id=$1 and column_name=$2 order by n desc`, [DS, COL])).rows
  console.log('antes :', before.map((r) => r.v + ' (' + r.n + ')').join(' · ') || '(sin valores)')

  const r = (await db.query('select public.set_value_map($1,$2,$3::jsonb,true) r', [DS, COL, MAP])).rows[0].r
  if (!r.ok) { console.error('ERROR:', r.error); process.exit(1) }

  const after = (await db.query(
    `select coalesce(value,'(nulo)') v, n from dataset_values
      where dataset_id=$1 and column_name=$2 order by n desc`, [DS, COL])).rows
  console.log('despues:', after.map((r) => r.v + ' (' + r.n + ')').join(' · '))

  // El tablero precalculado guarda etiquetas: hay que rehacerlo.
  await db.query('select app.build_dashboard($1)', [DS])
  console.log(r.pairs + ' equivalencias confirmadas · tablero recalculado')
})
