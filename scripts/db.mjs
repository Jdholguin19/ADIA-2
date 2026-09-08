// Conexion a Postgres compartida por los scripts de migracion y siembra.
// Solo corren en TU maquina, nunca en el navegador: usan la contrasena de
// superusuario, que jamas debe llegar al bundle del frontend.
import pg from 'pg'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..')
config({ path: resolve(ROOT, '.env') })

// Regiones del pooler a probar como respaldo. Se puede fijar una con
// SUPABASE_POOLER_HOST para saltarse el sondeo.
const POOLER_REGIONS = ['us-east-1', 'us-east-2', 'sa-east-1', 'us-west-1', 'eu-central-1']

function parts() {
  const url = process.env.VITE_SUPABASE_URL
  const pw = process.env.SUPABASE_BD_PASSWORD
  if (!url) throw new Error('Falta VITE_SUPABASE_URL en .env')
  if (!pw) throw new Error('Falta SUPABASE_BD_PASSWORD en .env')
  return { ref: new URL(url).hostname.split('.')[0], pw: encodeURIComponent(pw) }
}

/**
 * Candidatos de conexion, en orden de preferencia.
 *
 * db.<ref>.supabase.co solo resuelve por IPv6. Cuando la maquina se queda
 * sin ruta IPv6, TODOS los scripts mueren con ENOTFOUND aunque nslookup
 * resuelva bien, porque getaddrinfo no devuelve nada usable. El pooler va
 * por IPv4 y sirve de respaldo; ojo, alli el usuario es postgres.<ref>, no
 * postgres.
 */
export function candidates() {
  const { ref, pw } = parts()
  const out = [{
    label: 'directo (IPv6)',
    cs: `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`,
  }]
  const fixed = process.env.SUPABASE_POOLER_HOST
  const hosts = fixed ? [fixed] : POOLER_REGIONS.map((r) => `aws-0-${r}.pooler.supabase.com`)
  for (const h of hosts) {
    out.push({ label: `pooler ${h}`, cs: `postgresql://postgres.${ref}:${pw}@${h}:5432/postgres` })
  }
  return out
}

export function connectionString() {
  return candidates()[0].cs
}

// Solo se avisa del respaldo una vez por proceso, no en cada consulta.
let avisado = false

async function connect() {
  const errs = []
  for (const { label, cs } of candidates()) {
    const client = new pg.Client({
      connectionString: cs,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 600_000,
      query_timeout: 600_000,
      connectionTimeoutMillis: 8000,
    })
    try {
      await client.connect()
      if (label !== 'directo (IPv6)' && !avisado) {
        avisado = true
        console.error(`[db] host directo inalcanzable; usando ${label}`)
      }
      return client
    } catch (e) {
      errs.push(`${label}: ${e.message}`)
      try { await client.end() } catch { /* ya estaba caido */ }
      // Un fallo de credenciales no se arregla cambiando de host.
      if (/password|authentication|role .* does not exist/i.test(e.message)) break
    }
  }
  throw new Error('No se pudo conectar a Postgres.\n  ' + errs.join('\n  '))
}

export async function withClient(fn) {
  const client = await connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
