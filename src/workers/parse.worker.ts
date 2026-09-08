/// <reference lib="webworker" />
// Parseo en un Web Worker: 93.000 filas x 16 columnas congelarian la UI
// varios segundos si se hiciera en el hilo principal.
//
// El worker se QUEDA las filas parseadas y las entrega por lotes cuando el
// hilo principal las pide (protocolo con acuse). Asi no hay dos copias del
// archivo en memoria y la reanudacion es gratis: basta pedir los lotes que
// falten.
import { inferColumns, detectHeaderRow, sampleIndices, mojibakeRatio } from '../lib/ingest/infer.js'

type Row = unknown[]
let body: Row[] = []
let columns: any[] = []
let chunkSize = 2000

async function parse(file: File) {
  const isCsv = /\.csv$/i.test(file.name)
  let rows: Row[] = []
  let sheet = ''
  let encodingNote: string | null = null

  if (isCsv) {
    const buf = await file.arrayBuffer()
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf)
    // Latin-1 leido como utf-8 deja caracteres de reemplazo. Si hay
    // bastantes, se reintenta con windows-1252 en vez de arrastrar mojibake.
    if (mojibakeRatio(text) > 0.001) {
      text = new TextDecoder('windows-1252').decode(buf)
      encodingNote = 'Se detectó texto en windows-1252 y se releyó con esa codificación.'
    }
    const Papa = (await import('papaparse')).default
    const res = Papa.parse<Row>(text, { skipEmptyLines: 'greedy' })
    rows = res.data as Row[]
    sheet = 'csv'
  } else {
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    // dense + raw + sin estilos: mantiene el heap del worker acotado.
    const wb = XLSX.read(buf, {
      type: 'array', dense: true, raw: true, cellDates: false, cellStyles: false, cellHTML: false,
    })
    sheet = wb.SheetNames[0]
    rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet], { header: 1, raw: true, defval: null })
  }

  const hdr = detectHeaderRow(rows)
  const headers = (rows[hdr] || []).map((h) => (h == null ? '' : String(h)))
  body = rows.slice(hdr + 1).filter((r) => r && r.some((c) => c !== null && c !== ''))
  rows.length = 0

  // Muestra repartida por TODO el archivo: mirar solo la cabeza deja pasar
  // la deriva de tipos del final.
  const idx = sampleIndices(body.length, 5000)
  const sample = idx ? [...idx].map((i) => body[i]).filter(Boolean) : body
  columns = inferColumns(headers, sample)

  return { sheet, headerRow: hdr, totalRows: body.length, columns, encodingNote }
}

function chunkAt(i: number) {
  const slice = body.slice(i * chunkSize, (i + 1) * chunkSize)
  return slice.map((r) => {
    const o: Record<string, string | null> = {}
    for (let c = 0; c < columns.length; c++) {
      const v = r[c]
      o[columns[c].column_name] = v === null || v === undefined ? null : String(v)
    }
    return o
  })
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data
  try {
    if (msg.type === 'parse') {
      chunkSize = msg.chunkSize ?? 2000
      const meta = await parse(msg.file)
      ;(self as any).postMessage({ type: 'schema', ...meta })
    } else if (msg.type === 'chunk') {
      ;(self as any).postMessage({ type: 'chunk', idx: msg.idx, rows: chunkAt(msg.idx) })
    } else if (msg.type === 'release') {
      body = []
    }
  } catch (err: any) {
    ;(self as any).postMessage({ type: 'error', message: String(err?.message || err) })
  }
}
