// Siembra la base de conocimiento y genera sus vectores.
//   npm run kb -- [dataset_id]
//
// Aqui es donde el RAG vectorial SI aporta: significado de negocio y
// ejemplos pregunta->SQL. Las cifras nunca salen de estos documentos.
import { withClient } from './db.mjs'

const DS = Number(process.argv[2] || 1)
const KEY = process.env.OPENAI_API_KEY
if (!KEY) { console.error('Falta OPENAI_API_KEY en .env'); process.exit(1) }

const GLOSARIO = [
  ['LOSEP', 'Ley Organica del Servicio Publico: regimen laboral del personal administrativo de carrera del sector publico ecuatoriano. En este archivo aparece como texto "LOSEP" hasta 2015-05 y como codigo 1 a partir de 2015-06.'],
  ['CT (Codigo del Trabajo)', 'Regimen laboral de obreros y trabajadores bajo el Codigo del Trabajo, distinto de LOSEP. Aparece como "CT" hasta 2015-05 y como codigo 2 desde 2015-06.'],
  ['LOEI', 'Ley Organica de Educacion Intercultural: regimen del personal docente. Aparece como "LOEI" hasta 2015-05 y como codigo 3 desde 2015-06. Concentra profesores y personal de escuelas municipales.'],
  ['Regimen 4', 'Codigo que aparece solo desde 2016-05, sobre todo en jornaleros y obreros. El archivo NO trae su etiqueta, asi que no se le asigna un nombre inventado: se reporta como "Regimen 4 (sin etiquetar en origen)".'],
  ['Grado jerarquico', 'Peldano de la escala salarial (columna hierarchical_grade). El ARCHIVO NO TRAE NINGUNA LEYENDA que explique los codigos; lo que sigue se deduce de los propios datos y de la normativa publica. El numero es un peldano: dentro de un mismo regimen el sueldo sube de forma monotona con el (en LOSEP, grado 6 ~$646 y grado 19 ~$3.100) y es casi fijo dentro de cada grado. La escala DEPENDE DEL REGIMEN: el grado 12 en LOSEP ronda $1.022 y en CT $734, asi que comparar grados entre regimenes no significa nada. La letra final modifica el importe dentro del mismo numero (19 H = $4.508 frente a 19 sin letra = $3.113). El formato venia sucio ("10 B" y "10B", "8 -" y "8-"): ya esta unificado en hierarchical_grade_norm, 97 variantes reducidas a 43.'],
  ['Grado en el regimen docente (LOEI)', 'En las filas de regimen LOEI la letra corresponde al escalafon del Magisterio Nacional, que tiene 10 categorias de la J (quien empieza) a la A (mas de 24 anos y maestria). En este archivo los importes son fijos por categoria y coinciden con la escala nacional del Ministerio del Trabajo: H=$733, G=$817, F=$901, D=$1.086, C=$1.212, y suben en el orden J->A, como marca la norma. Para los regimenes LOSEP y CT la letra tambien cambia el importe, pero su significado NO esta determinado: no lo dice el archivo ni se puede deducir sin la escala interna del municipio.'],
  ['Media y mediana', 'La media es la suma dividida entre el numero de personas: unos pocos sueldos altos la empujan hacia arriba. La mediana es el valor que deja a la mitad de la plantilla por debajo y a la otra mitad por encima, asi que no se mueve por los extremos. En este archivo la media ronda $907 y la mediana $689: esa diferencia dice que la mayoria cobra bastante menos que el promedio, y por eso para hablar de "lo que gana la gente" es mejor la mediana.'],
  ['Decimotercera remuneracion', 'Beneficio equivalente a un doceavo de la remuneracion mensual. En este archivo es exactamente monthly_remuneration / 12 en el 100% de las filas: es una columna derivada y no debe sumarse junto a la remuneracion.'],
  ['Decimocuarta remuneracion', 'Beneficio fijo ligado al salario basico unificado. Aqui solo toma dos valores (29,5 y 30,5), asi que promediarla no significa nada.'],
  ['Ingresos adicionales totales', 'total_additional_income es exactamente la suma de decimotercera + decimocuarta + horas suplementarias + subrogaciones. Es derivada: sumarla junto a sus componentes cuenta el dinero dos veces.'],
  ['Plantilla (headcount)', 'Numero de personas distintas en un periodo. NO es el numero de filas: el archivo trae una fila por persona y mes, de modo que count(*) responde filas-mes.'],
  ['Nomina mensual', 'Suma de monthly_remuneration en un periodo concreto. Es el coste base del mes; los ingresos adicionales se reportan aparte para no duplicar.'],
]

const EJEMPLOS = [
  ['Cuantos trabajadores hay',
   'Personas distintas en el periodo vigente. Nunca count(*), que contaria filas-mes.',
   "select count(distinct names) as trabajadores from {T} where period = date '2016-11-01'"],
  ['Cuantos hay de un cargo concreto',
   'Filtrar por el cargo agrupando sus variantes de escritura. Consulta antes lookup_values: existen CONSERJE, CONSERJE 1 y CONSERJE VOLANTE.',
   "select count(distinct names) as n from {T} where period = date '2016-11-01' and institutional_position like 'CONSERJE%'"],
  ['Empleados que ganan mas de un umbral',
   'Lista nominal en un periodo. Sin filtro de periodo, la misma persona sale repetida hasta 23 veces.',
   "select names, institutional_position, monthly_remuneration from {T} where period = date '2016-11-01' and monthly_remuneration > 5000 order by monthly_remuneration desc"],
  ['Evolucion de la nomina mes a mes',
   'Serie temporal del coste y de la plantilla por periodo.',
   'select period, count(distinct names) as plantilla, round(sum(monthly_remuneration),2) as nomina from {T} group by period order by period'],
  ['Cargos con mayor dispersion salarial',
   'Ratio entre percentil 90 y percentil 10 dentro de cada cargo, solo en grupos con suficientes casos.',
   "select institutional_position, count(*) n, round(percentile_cont(0.9) within group (order by monthly_remuneration)::numeric,2) p90, round(percentile_cont(0.1) within group (order by monthly_remuneration)::numeric,2) p10 from {T} where period = date '2016-11-01' group by 1 having count(*) >= 20 order by p90 / nullif(p10,0) desc limit 15"],
  ['Sueldo medio por regimen laboral',
   'Agrupacion por regimen. Ojo: la codificacion cambia en 2015-06, asi que cruzar ese corte mezcla vocabularios distintos.',
   "select labor_regime, count(distinct names) personas, round(avg(monthly_remuneration),2) medio from {T} where period = date '2016-11-01' group by 1 order by personas desc"],
]

async function embedAll(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64)
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: batch }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message)
    for (const d of j.data) out.push(d.embedding)
  }
  return out
}

await withClient(async (db) => {
  const ds = (await db.query(
    'select owner_id, phys_schema, phys_table from public.datasets where id=$1', [DS])).rows[0]
  if (!ds) { console.error('No existe el dataset ' + DS); process.exit(1) }
  const T = ds.phys_schema + '.' + ds.phys_table

  await db.query(`select set_config('request.jwt.claims',$1,false)`,
    [JSON.stringify({ sub: ds.owner_id, role: 'authenticated' })])

  // Configuracion por defecto del asistente
  await db.query(
    `insert into public.assistant_configs (owner_id, dataset_id, name)
     select $1::uuid, $2::bigint, 'Por defecto'
      where not exists (select 1 from public.assistant_configs
                         where owner_id = $1::uuid and dataset_id = $2::bigint)`,
    [ds.owner_id, DS])

  await db.query('delete from public.kb_documents where dataset_id = $1', [DS])

  const rows = [
    ...GLOSARIO.map(([title, content]) => ({ kind: 'glossary', title, content, sql_text: null })),
    ...EJEMPLOS.map(([title, content, sql]) => ({
      kind: 'sql_exemplar', title, content, sql_text: sql.replaceAll('{T}', T),
    })),
  ]

  // Se embebe titulo + contenido: es lo que se parece a la PREGUNTA del
  // usuario. Meter el SQL en el vector acerca los ejemplos entre si y los
  // aleja de la pregunta, que es justo lo contrario de lo que se busca.
  const vecs = await embedAll(rows.map((r) => r.title + '. ' + r.content))

  for (let i = 0; i < rows.length; i++) {
    await db.query(
      `insert into public.kb_documents (owner_id, dataset_id, kind, title, content, sql_text, embedding)
       values ($1::uuid, $2::bigint, $3, $4, $5, $6, $7::extensions.vector)`,
      [ds.owner_id, DS, rows[i].kind, rows[i].title, rows[i].content, rows[i].sql_text,
       JSON.stringify(vecs[i])])
  }

  console.log(rows.length + ' documentos indexados (' + GLOSARIO.length + ' de glosario, ' +
              EJEMPLOS.length + ' ejemplos pregunta->SQL)')
})
