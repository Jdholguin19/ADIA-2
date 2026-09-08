import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { Spinner } from '../../components/ui'
import { n0 } from '../../lib/format'

interface Turn {
  role: 'user' | 'assistant'
  text: string
  sql?: string
  rows?: any[]
  rowCount?: number
  truncated?: boolean
  elapsed?: number
  warnings?: string[]
  cached?: boolean
  similarity?: number
  status?: string
  error?: string
}

const STAGE: Record<string, string> = {
  embedding: 'Entendiendo la pregunta…',
  cache: 'Buscando preguntas parecidas…',
  retrieving: 'Recuperando el contexto del dataset…',
  planning: 'Decidiendo cómo consultarlo…',
  sql: 'Consultando la base de datos…',
  answering: 'Redactando la respuesta…',
}

const SUGERENCIAS = [
  '¿Cuántos trabajadores hay en total?',
  '¿Cuántos conserjes tengo?',
  'Dame la lista de empleados que ganen más de $5000 al mes',
  '¿Cómo ha evolucionado la nómina mes a mes?',
  '¿Qué cargos tienen mayor dispersión salarial?',
]

function ResultTable({ rows }: { rows: any[] }) {
  if (!rows?.length) {
    return <div className="text-[11.5px] mt-1" style={{ color: 'var(--muted)' }}>Sin filas.</div>
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))]
  return (
    <div className="overflow-x-auto rounded-lg mt-1.5" style={{ border: '1px solid var(--border)' }}>
      <table className="w-full text-[11.5px] tnum">
        <thead>
          <tr style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
            {cols.map((c) => (
              <th key={c} className="text-left font-medium px-2 py-1.5 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 whitespace-nowrap">
                  {r?.[c] == null ? '—' : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Chat() {
  const { id } = useParams()
  const dsId = Number(id)
  const [turns, setTurns] = useState<Turn[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [openSql, setOpenSql] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns])

  async function ask(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setQ('')
    setTurns((t) => [...t, { role: 'user', text }, { role: 'assistant', text: '', status: 'embedding' }])
    const at = turns.length + 1
    const patch = (p: Partial<Turn>) =>
      setTurns((t) => t.map((x, i) => (i === at ? { ...x, ...p } : x)))

    try {
      const { data: s } = await supabase.auth.getSession()
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + (s.session?.access_token ?? ''),
        },
        body: JSON.stringify({ dataset_id: dsId, message: text }),
      })
      if (!res.ok || !res.body) {
        const t = await res.text()
        patch({ status: undefined, error: 'El servicio de chat respondió ' + res.status + '. ' + t.slice(0, 300) })
        setBusy(false)
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const p of parts) {
          const line = p.replace(/^data:\s*/, '').trim()
          if (!line) continue
          let ev: any
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.t === 'status') patch({ status: ev.stage })
          else if (ev.t === 'cache' && ev.hit) patch({ cached: true, similarity: ev.similarity })
          else if (ev.t === 'sql') patch({ sql: ev.sql, warnings: ev.warnings ?? [] })
          else if (ev.t === 'result') {
            patch({ rows: ev.rows, rowCount: ev.row_count, truncated: ev.truncated, elapsed: ev.elapsed_ms })
          } else if (ev.t === 'delta') {
            setTurns((t) => t.map((x, i) => (i === at ? { ...x, text: x.text + ev.text, status: undefined } : x)))
          } else if (ev.t === 'error') patch({ status: undefined, error: ev.message })
          else if (ev.t === 'done') patch({ status: undefined })
        }
      }
    } catch (e: any) {
      patch({ status: undefined, error: String(e?.message || e) })
    }
    setBusy(false)
  }

  return (
    <div className="grid gap-3">
      {!turns.length && (
        <div className="card p-5">
          <div className="text-[13px] font-medium mb-1">Pregúntale a tus datos</div>
          <p className="text-[12px] mb-4" style={{ color: 'var(--ink2)' }}>
            Cada cifra sale de una consulta SQL real ejecutada en el momento, y puedes ver la
            consulta debajo de cada respuesta.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SUGERENCIAS.map((s) => (
              <button key={s} className="btn text-[11.5px] py-1" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {turns.map((t, i) =>
        t.role === 'user' ? (
          <div key={i} className="flex justify-end">
            <div className="rounded-xl px-3.5 py-2 text-[13px] max-w-[80%]"
                 style={{ background: 'var(--s1)', color: '#fff' }}>
              {t.text}
            </div>
          </div>
        ) : (
          <div key={i} className="card p-4">
            {t.cached && (
              <div className="text-[11px] mb-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded"
                   style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                Pregunta ya conocida (similitud {t.similarity?.toFixed(2)}) · se reejecutó la consulta,
                no se reutilizó el número
              </div>
            )}
            {t.status && <Spinner label={STAGE[t.status] ?? t.status} />}
            {t.error && (
              <div className="text-[12.5px]" style={{ color: '#d03b3b' }}>{t.error}</div>
            )}
            {t.text && (
              <div className="text-[13px] whitespace-pre-wrap leading-relaxed">{t.text}</div>
            )}

            {!!t.warnings?.length && (
              <ul className="mt-2.5 grid gap-1">
                {t.warnings.map((w, j) => (
                  <li key={j} className="text-[11.5px] px-2 py-1 rounded"
                      style={{ background: 'color-mix(in srgb, #fab219 14%, transparent)', color: 'var(--ink2)' }}>
                    {w}
                  </li>
                ))}
              </ul>
            )}

            {t.rows && (
              <div className="mt-3">
                <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                  <span>{n0(t.rowCount)} fila(s){t.truncated ? ' (recortado)' : ''}</span>
                  {t.elapsed != null && <span>· {t.elapsed} ms</span>}
                  {t.sql && (
                    <button className="hover:underline" style={{ color: 'var(--s1)' }}
                            onClick={() => setOpenSql(openSql === i ? null : i)}>
                      {openSql === i ? 'ocultar SQL' : 'ver SQL'}
                    </button>
                  )}
                </div>
                {openSql === i && t.sql && (
                  <pre className="text-[10.5px] mt-1.5 p-2 rounded-lg overflow-x-auto"
                       style={{ background: 'var(--plane)', color: 'var(--ink2)' }}>
                    {t.sql}
                  </pre>
                )}
                <ResultTable rows={t.rows} />
              </div>
            )}
          </div>
        ),
      )}
      <div ref={endRef} />

      <form className="flex gap-2 sticky bottom-3" onSubmit={(e) => { e.preventDefault(); ask(q) }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="¿Cuántos conserjes tengo?" disabled={busy} />
        <button className="btn btn-primary shrink-0" disabled={busy || !q.trim()}>
          {busy ? '…' : 'Preguntar'}
        </button>
      </form>
    </div>
  )
}
