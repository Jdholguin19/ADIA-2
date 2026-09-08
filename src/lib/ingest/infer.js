// Inferencia de esquema del lado cliente. JS plano a proposito: lo usan
// tanto el Web Worker del navegador como los scripts de node, y duplicar
// esta logica seria la forma mas facil de que servidor y cliente discrepen.

const MONEY_RE =
  /(remunerac|salar|sueldo|ingreso|haber|monto|valor|pago|costo|coste|amount|salary|wage|pay|cost|revenue|precio)/i
const YEAR_RE = /^(year|anio|ano|a_o|yr)$/
const MONTH_RE = /^(month|mes|mo)$/
const DAY_RE = /^(day|dia)$/

const INT_RE = /^-?\d+$/
const DEC_US_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/
const DEC_EU_RE = /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/
const BOOL_RE = /^(true|false|t|f|yes|no|si|s|y|n|verdadero|falso|0|1)$/i
const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}-\d{2}-\d{4})/

export function sanitizeIdent(name, fallback = 'col', taken = new Set()) {
  let s = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!s) s = fallback
  if (/^[0-9]/.test(s)) s = 'c_' + s
  s = s.slice(0, 58)
  let out = s
  let i = 2
  while (taken.has(out)) out = `${s.slice(0, 55)}_${i++}`
  taken.add(out)
  return out
}

/** Elige la fila de cabecera: la primera con mayoria de textos distintos. */
export function detectHeaderRow(rows, limit = 15) {
  for (let r = 0; r < Math.min(limit, rows.length); r++) {
    const cells = (rows[r] || []).filter((c) => c !== null && c !== undefined && String(c).trim() !== '')
    if (cells.length < 2) continue
    const text = cells.filter((c) => typeof c === 'string' && !INT_RE.test(c.trim())).length
    const distinct = new Set(cells.map((c) => String(c).trim().toLowerCase())).size
    if (text / cells.length >= 0.7 && distinct / cells.length >= 0.8) return r
  }
  return 0
}

function classify(values) {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
  if (!nonEmpty.length) return { data_type: 'text', decimal_sep: '.' }

  let numOK = 0, nonInt = 0, decEU = 0, decUS = 0, bool = 0, date = 0
  for (const v of nonEmpty) {
    if (typeof v === 'number') {
      numOK++
      if (!Number.isInteger(v)) nonInt++
      continue
    }
    const s = String(v).trim().replace(/[\s$€]/g, '')
    const isUS = DEC_US_RE.test(s)
    const isEU = DEC_EU_RE.test(s) && /,/.test(s)
    if (isUS) decUS++
    if (isEU) decEU++
    if (isUS || isEU) {
      numOK++
      const norm = isEU && !isUS ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
      if (!INT_RE.test(norm)) nonInt++
    }
    if (BOOL_RE.test(s)) bool++
    if (DATE_RE.test(String(v).trim())) date++
  }
  const n = nonEmpty.length
  const frac = (x) => x / n

  if (frac(date) >= 0.98) return { data_type: 'date', decimal_sep: '.' }
  if (frac(numOK) >= 0.98) {
    const sep = decEU > decUS ? ',' : '.'
    // bigint solo si NO se vio ni un decimal. Un unico valor fraccionario
    // basta para que la columna deba ser numeric: tipar de menos manda
    // filas legitimas a cuarentena.
    return { data_type: nonInt === 0 ? 'bigint' : 'numeric', decimal_sep: sep }
  }
  if (frac(bool) >= 0.98 && new Set(nonEmpty.map((v) => String(v).toLowerCase())).size <= 4)
    return { data_type: 'boolean', decimal_sep: '.' }
  return { data_type: 'text', decimal_sep: '.' }
}

function hintRole(name, type, values) {
  if (type === 'bigint' || type === 'numeric') {
    if (YEAR_RE.test(name)) {
      const nums = values.map(Number).filter(Number.isFinite)
      if (nums.length && nums.every((v) => v >= 1900 && v <= 2100)) return 'date_part'
    }
    if (MONTH_RE.test(name)) {
      const nums = values.map(Number).filter(Number.isFinite)
      if (nums.length && nums.every((v) => v >= 1 && v <= 12)) return 'date_part'
    }
    if (DAY_RE.test(name)) return 'date_part'
    if (MONEY_RE.test(name)) return 'money'
  }
  if (type === 'date') return 'date'
  return 'unknown'
}

/**
 * @param {string[]} headers
 * @param {any[][]} sampleRows filas de muestra (idealmente repartidas por todo el archivo)
 */
export function inferColumns(headers, sampleRows) {
  const taken = new Set()
  return headers.map((h, i) => {
    const column_name = sanitizeIdent(h, `col_${i + 1}`, taken)
    const values = sampleRows.map((r) => r?.[i])
    const { data_type, decimal_sep } = classify(values)
    const role = hintRole(column_name, data_type, values.filter((v) => v != null))
    return {
      ordinal: i,
      source_name: String(h ?? `col_${i + 1}`),
      column_name,
      data_type,
      decimal_sep,
      role,
      is_analyzable: true,
    }
  })
}

/** Indices de muestreo repartidos por todo el archivo, no solo la cabeza. */
export function sampleIndices(total, want = 5000) {
  if (total <= want) return null
  const head = Math.min(1500, Math.floor(want / 3))
  const stride = Math.max(1, Math.floor((total - head) / (want - head)))
  const idx = new Set()
  for (let i = 0; i < head; i++) idx.add(i)
  for (let i = head; i < total; i += stride) idx.add(i)
  return idx
}

/** Cuenta caracteres de reemplazo: sintoma de latin-1 leido como utf-8. */
export function mojibakeRatio(text) {
  if (!text) return 0
  let bad = 0
  for (const ch of text) if (ch === '�') bad++
  return bad / text.length
}
