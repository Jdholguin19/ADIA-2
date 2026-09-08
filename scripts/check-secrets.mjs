// Comprueba que ningun secreto acabo en dist/. Pensado para CI y para
// ejecutarse antes de cada despliegue: basta anadir un VITE_ por descuido
// para publicar una clave.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
config({ path: resolve(ROOT, '.env') })
const DIST = resolve(ROOT, 'dist')

const patterns = [
  ['clave de OpenAI', /sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}/],
  ['token de Supabase', /sbp_[a-f0-9]{40,}/],
]
// La contrasena se busca como texto literal, no como regex: escaparla a mano
// es justo el tipo de detalle que rompe el guardian que deberia protegerte.
const PW = process.env.SUPABASE_BD_PASSWORD || null

function walk(dir) {
  const out = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let bad = 0
try {
  for (const f of walk(DIST)) {
    if (!/\.(js|css|html|json|webmanifest|map)$/.test(f)) continue
    const t = readFileSync(f, 'utf8')
    for (const [name, re] of patterns) {
      if (re.test(t)) { console.error('FUGA: ' + name + ' en ' + f.slice(ROOT.length + 1)); bad++ }
    }
    if (PW && PW.length > 6 && t.includes(PW)) {
      console.error('FUGA: contrasena de la BD en ' + f.slice(ROOT.length + 1)); bad++
    }
  }
} catch {
  console.error('No hay dist/. Ejecuta npm run build primero.')
  process.exit(1)
}
if (bad) { console.error('\n' + bad + ' secreto(s) en el bundle. NO desplegar.'); process.exit(1) }
console.log('OK: ningun secreto en dist/')
