const nf0 = new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 })
const nf2 = new Intl.NumberFormat('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const n0 = (v: unknown) => (v == null || v === '' ? '—' : nf0.format(Number(v)))
export const n2 = (v: unknown) => (v == null || v === '' ? '—' : nf2.format(Number(v)))

/** Importes compactos para tarjetas: $3,61 M se lee mejor que $3.609.277,41 */
export function money(v: unknown, compact = false) {
  if (v == null || v === '') return '—'
  const x = Number(v)
  if (compact && Math.abs(x) >= 1_000_000) return `$${nf2.format(x / 1_000_000)} M`
  if (compact && Math.abs(x) >= 10_000) return `$${nf0.format(x)}`
  return `$${nf2.format(x)}`
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** '2016-11-01' -> 'nov 2016'. Se corta la cadena a proposito: construir un
 *  Date desplaza el mes segun la zona horaria del navegador. */
export function period(p?: string | null) {
  if (!p) return '—'
  const [y, m] = p.split('-')
  const i = Number(m) - 1
  return `${MESES[i] ?? m} ${y}`
}

export function pct(v: unknown, digits = 1) {
  if (v == null || v === '') return '—'
  return `${Number(v).toFixed(digits)}%`
}

export function delta(cur: unknown, prev: unknown) {
  const a = Number(cur), b = Number(prev)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null
  return ((a - b) / b) * 100
}
