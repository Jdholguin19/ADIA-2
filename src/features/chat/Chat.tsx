import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Spinner } from '../../components/ui'
import { n0 } from '../../lib/format'
import { describeFilters, useFilters } from '../../lib/filters'
import { STAGE, useChat } from './useChat'

// Página completa del copiloto. Ya no tiene pestaña —el acceso habitual es
// el chat flotante— pero la ruta /d/:id/chat sigue viva para cuando hace
// falta espacio: respuestas con tablas largas se leen mejor aquí.
// Comparte el hook useChat con el widget: una sola implementación del
// protocolo SSE.

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
    <div className="overflow-x-auto rounded-lg mt-1.5 max-w-full"
         style={{ border: '1px solid var(--border)' }}>
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
  const { turns, busy, ask } = useChat(dsId)
  const [q, setQ] = useState('')
  const [openSql, setOpenSql] = useState<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const chips = describeFilters(useFilters())

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns])

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
              <button key={s} className="btn text-[11.5px] py-1"
                      onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {!!chips.length && (
        <div className="text-[11.5px] flex gap-1.5 flex-wrap items-center"
             style={{ color: 'var(--muted)' }}>
          <span>Las preguntas heredan los filtros del tablero:</span>
          {chips.map((c, i) => (
            <span key={i} className="px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--plane)', color: 'var(--ink2)' }}>{c}</span>
          ))}
        </div>
      )}

      {turns.map((t, i) =>
        t.role === 'user' ? (
          <div key={i} className="flex justify-end">
            <div className="rounded-xl px-3.5 py-2 text-[13px] max-w-[80%] break-words"
                 style={{ background: 'var(--s1)', color: '#fff' }}>
              {t.text}
            </div>
          </div>
        ) : (
          <div key={i} className="card p-4 min-w-0">
            {t.cached && (
              <div className="text-[11px] mb-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded"
                   style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                Pregunta ya conocida (similitud {t.similarity?.toFixed(2)}) · se reejecutó la consulta,
                no se reutilizó el número
              </div>
            )}
            {t.status && <Spinner label={STAGE[t.status] ?? t.status} />}
            {t.error && <div className="text-[12.5px]" style={{ color: '#d03b3b' }}>{t.error}</div>}
            {t.text && (
              <div className="text-[13px] whitespace-pre-wrap leading-relaxed break-words">{t.text}</div>
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
              <div className="mt-3 min-w-0">
                <div className="flex items-center gap-2 text-[11px] flex-wrap"
                     style={{ color: 'var(--muted)' }}>
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
                  <pre className="text-[10.5px] mt-1.5 p-2 rounded-lg overflow-x-auto max-w-full"
                       style={{ background: 'var(--plane)', color: 'var(--ink2)' }}>{t.sql}</pre>
                )}
                <ResultTable rows={t.rows} />
              </div>
            )}
          </div>
        ),
      )}
      <div ref={endRef} />

      <form className="flex gap-2 sticky bottom-3"
            onSubmit={(e) => { e.preventDefault(); ask(q); setQ('') }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="¿Cuántos conserjes tengo?" disabled={busy} />
        <button className="btn btn-primary shrink-0" disabled={busy || !q.trim()}>
          {busy ? '…' : 'Preguntar'}
        </button>
      </form>
    </div>
  )
}
