import { supabase } from '../supabase'

export interface IngestProgress {
  phase: 'hashing' | 'parsing' | 'creating' | 'sending' | 'building' | 'ready' | 'error'
  message: string
  pct: number
  rowsSent?: number
  totalRows?: number
  datasetId?: number
  resumed?: boolean
}

const CHUNK = 2000
const CONCURRENCY = 3 // por encima de 3 solo se pelea por el pool, sin ganar caudal

async function sha256(file: File) {
  const buf = await file.arrayBuffer()
  const d = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const es = (n: number) => n.toLocaleString('es-EC')

export async function ingestFile(
  file: File,
  onProgress: (p: IngestProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  onProgress({ phase: 'hashing', message: 'Calculando huella del archivo…', pct: 2 })
  const hash = await sha256(file)

  const worker = new Worker(new URL('../../workers/parse.worker.ts', import.meta.url), {
    type: 'module',
  })
  const waitFor = (type: string) =>
    new Promise<any>((resolve, reject) => {
      const h = (e: MessageEvent) => {
        if (e.data?.type === 'error') {
          worker.removeEventListener('message', h)
          reject(new Error(e.data.message))
        } else if (e.data?.type === type) {
          worker.removeEventListener('message', h)
          resolve(e.data)
        }
      }
      worker.addEventListener('message', h)
    })

  try {
    onProgress({ phase: 'parsing', message: 'Leyendo el archivo…', pct: 5 })
    worker.postMessage({ type: 'parse', file, chunkSize: CHUNK })
    const schema = await waitFor('schema')

    onProgress({
      phase: 'creating',
      message: es(schema.totalRows) + ' filas × ' + schema.columns.length + ' columnas',
      pct: 12,
      totalRows: schema.totalRows,
    })

    const { data: created, error } = await supabase.rpc('create_dataset', {
      p_name: file.name.replace(/\.[^.]+$/, ''),
      p_filename: file.name,
      p_sheet: schema.sheet,
      p_content_hash: hash,
      p_columns: schema.columns,
      p_n_rows: schema.totalRows,
      p_chunk_size: CHUNK,
    })
    if (error) throw new Error(error.message)

    const datasetId = Number(created.dataset_id)
    const done = new Set<number>((created.chunks_done || []).map(Number))
    const total = Math.ceil(schema.totalRows / CHUNK)
    const pending = Array.from({ length: total }, (_, i) => i).filter((i) => !done.has(i))
    let sent = done.size * CHUNK

    if (created.resumed && done.size) {
      onProgress({
        phase: 'sending',
        datasetId,
        resumed: true,
        pct: 15,
        message: 'Reanudando: ' + done.size + ' de ' + total + ' lotes ya estaban cargados',
        rowsSent: sent,
        totalRows: schema.totalRows,
      })
    }

    // Un lote reintentado es un no-op en el servidor (manda el libro mayor de
    // trozos), asi que reintentar nunca duplica filas.
    let cursor = 0
    const runner = async () => {
      while (cursor < pending.length) {
        if (signal?.aborted) throw new Error('Carga cancelada')
        const idx = pending[cursor++]
        worker.postMessage({ type: 'chunk', idx })
        const got = await new Promise<any>((resolve) => {
          const h = (e: MessageEvent) => {
            if (e.data?.type === 'chunk' && e.data.idx === idx) {
              worker.removeEventListener('message', h)
              resolve(e.data)
            }
          }
          worker.addEventListener('message', h)
        })
        const { error: e2 } = await supabase.rpc('ingest_chunk', {
          p_dataset_id: datasetId,
          p_chunk_idx: idx,
          p_rows: got.rows,
        })
        if (e2) throw new Error(e2.message)
        sent = Math.min(sent + got.rows.length, schema.totalRows)
        onProgress({
          phase: 'sending',
          datasetId,
          rowsSent: sent,
          totalRows: schema.totalRows,
          pct: 15 + Math.round((sent / schema.totalRows) * 55),
          message: 'Cargando ' + es(sent) + ' de ' + es(schema.totalRows) + ' filas',
        })
      }
    }
    // El worker sirve un lote cada vez, pero las subidas se solapan.
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, runner),
    )

    worker.postMessage({ type: 'release' })
    await supabase.rpc('finish_ingest', { p_dataset_id: datasetId })

    onProgress({
      phase: 'building',
      datasetId,
      pct: 75,
      message: 'Tipando, perfilando y buscando alertas… (esto tarda un poco)',
    })
    const { error: e3 } = await supabase.rpc('rebuild_dataset', { p_dataset_id: datasetId })
    if (e3) throw new Error(e3.message)

    onProgress({ phase: 'ready', datasetId, pct: 100, message: 'Listo' })
    return datasetId
  } finally {
    worker.terminate()
  }
}
