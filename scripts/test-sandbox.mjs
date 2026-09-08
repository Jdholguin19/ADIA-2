// Bateria adversaria contra exec_analysis_sql + comprobacion de que los
// numeros que saldrian por el chat coinciden con la verdad del archivo.
//   npm run test:sandbox
import { withClient } from './db.mjs'

const DS = Number(process.argv[2] || 1)
let pass = 0, fail = 0
const ok = (n, c, d = '') => { console.log(`  OK   ${n}${d ? '  ' + d : ''}`); pass++ }
const no = (n, d) => { console.log(`  FALLA ${n}\n        ${d}`); fail++ }

await withClient(async (db) => {
  const uid = (await db.query('select owner_id from datasets where id=$1', [DS])).rows[0].owner_id
  const T = (await db.query('select phys_schema||$2||phys_table t from datasets where id=$1', [DS, '.'])).rows[0].t
  const asUser = async (sub) => {
    await db.query(`select set_config('request.jwt.claims',$1,false)`,
      [JSON.stringify({ sub, role: 'authenticated' })])
    await db.query('set role authenticated')
  }
  await asUser(uid)

  const run = async (sql) =>
    (await db.query('select public.exec_analysis_sql($1,$2,$3::jsonb,$4) r', [DS, sql, '{}', 500])).rows[0].r

  // ---------- 1. Debe RECHAZAR ----------
  console.log('\n== Intentos que deben ser rechazados ==')
  const attacks = [
    ['escritura directa',      `insert into ${T} (_row_idx) values (1)`],
    ['update',                 `update ${T} set names='x'`],
    ['drop',                   `drop table ${T}`],
    ['dos sentencias',         `select 1; drop table ${T}`],
    ['leer auth.users',        `select * from auth.users`],
    ['leer otra tabla propia', `select * from public.datasets`],
    ['otro dataset',           `select * from ds.t_000999`],
    ['lectura de fichero',     `select pg_read_file('/etc/passwd')`],
    ['pg_sleep',               `select pg_sleep(30)`],
    ['catalogo',               `select * from pg_catalog.pg_tables`],
    ['CTE escritora',          `with x as (delete from ${T} returning 1) select * from x`],
    ['funcion no permitida',   `select dblink('','')`],
  ]
  for (const [name, sql] of attacks) {
    const r = await run(sql)
    if (r.ok === false) ok(name, null, `-> ${r.error}`)
    else no(name, `NO fue rechazado: devolvio ${r.row_count} filas`)
  }

  // ---------- 2. Guarda de grano ----------
  console.log('\n== Guarda de grano (el riesgo #1 del proyecto) ==')
  const cs = await run(`select count(*) from ${T}`)
  if (cs.ok === false && JSON.stringify(cs.lint).includes('conteo_de_filas_en_panel'))
    ok('count(*) sin periodo se rechaza con explicacion para el modelo')
  else no('count(*) sin periodo', `deberia rechazarse; dio ${JSON.stringify(cs).slice(0, 200)}`)

  const dw = await run(`select count(distinct names) from ${T}`)
  if (dw.ok && JSON.stringify(dw.warnings).includes('distinct_sin_periodo'))
    ok('distinct sin periodo pasa pero AVISA', null, `= ${dw.rows[0].count} (historico)`)
  else no('aviso distinct sin periodo', JSON.stringify(dw).slice(0, 200))

  // ---------- 3. Numeros reales ----------
  console.log('\n== Los numeros que vera gerencia ==')
  const checks = [
    ['plantilla 2016-11',
     `select count(distinct names) n from ${T} where period = date '2016-11-01'`,
     (r) => Number(r.rows[0].n)],
    ['nomina base 2016-11',
     `select round(sum(monthly_remuneration),2) v from ${T} where period = date '2016-11-01'`,
     (r) => Number(r.rows[0].v)],
    ['conserjes exactos 2016-11',
     `select count(distinct names) n from ${T} where period = date '2016-11-01' and institutional_position = 'CONSERJE'`,
     (r) => Number(r.rows[0].n)],
    ['conserjes agrupando variantes 2016-11',
     `select count(distinct names) n from ${T} where period = date '2016-11-01' and institutional_position like 'CONSERJE%'`,
     (r) => Number(r.rows[0].n)],
    ['sueldo mediano historico',
     `select percentile_cont(0.5) within group (order by monthly_remuneration) v from ${T}`,
     (r) => Number(r.rows[0].v)],
    ['periodos',
     `select count(distinct period) n from ${T}`, (r) => Number(r.rows[0].n)],
  ]
  const got = {}
  for (const [name, sql, pick] of checks) {
    const r = await run(sql)
    if (!r.ok) { no(name, JSON.stringify(r).slice(0, 250)); continue }
    got[name] = pick(r)
    ok(name, null, `= ${got[name]}`)
  }

  const expect = {
    'plantilla 2016-11': 3978,
    'conserjes exactos 2016-11': 76,
    'conserjes agrupando variantes 2016-11': 78,
    'sueldo mediano historico': 666.75,
    'periodos': 23,
  }
  console.log('\n== Contraste con el perfilado independiente en Python ==')
  for (const [k, v] of Object.entries(expect)) {
    if (!(k in got)) continue
    if (Math.abs(got[k] - v) < 0.01) ok(`${k} coincide (${v})`)
    else no(k, `esperado ${v}, obtenido ${got[k]}`)
  }

  const over = await run(
    `select names, institutional_position, monthly_remuneration from ${T}
      where period = date '2016-11-01' and monthly_remuneration > 5000
      order by monthly_remuneration desc`)
  if (over.ok) {
    ok(`sueldos > $5000 en 2016-11 = ${over.row_count}`, null,
       over.rows.map((r) => `${r.names} (${r.institutional_position}) $${r.monthly_remuneration}`).join('; '))
  } else no('sueldos > 5000', JSON.stringify(over).slice(0, 200))

  // ---------- 4. RLS ----------
  console.log('\n== Aislamiento por RLS ==')
  await db.query('reset role')
  await asUser('00000000-0000-0000-0000-0000000000ff')
  const other = await run(`select count(distinct names) from ${T} where period = date '2016-11-01'`)
  await db.query('reset role')
  if (other.ok === false && /NO_ENCONTRADO|FORBIDDEN|42501/.test(JSON.stringify(other)))
    ok('otro usuario no puede consultar el dataset', null, `-> ${other.message || other.error}`)
  else no('aislamiento RLS', JSON.stringify(other).slice(0, 200))

  console.log(`\n${pass} correctas, ${fail} fallidas`)
  if (fail) process.exitCode = 1
})
