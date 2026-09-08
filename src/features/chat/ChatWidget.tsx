import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Spinner } from '../../components/ui'
import { n0 } from '../../lib/format'
import { useFilters, describeFilters } from '../../lib/filters'
import { STAGE, useChat, type Turn } from './useChat'

const SUGERENCIAS = [
  '¿Cuántos trabajadores hay?',
  '¿Cuántos conserjes tengo?',
  'Empleados que ganen más de $5000',
  '¿Cómo ha evolucionado la nómina?',
]

function ResultTable({ rows }: { rows: any[] }) {
  if (!rows?.length) {
    return <div className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>Sin filas.</div>
  }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))]
  return (
    <div className="overflow-x-auto rounded-lg mt-1.5 max-w-full"
         style={{ border: '1px solid var(--border)' }}>
      <table className="w-full text-[11px] tnum">
        <thead>
          <tr style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
            {cols.map((c) => (
              <th key={c} className="text-left font-medium px-1.5 py-1 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 25).map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              {cols.map((c) => (
                <td key={c} className="px-1.5 py-1 whitespace-nowrap">
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

function Bubble({ t, i, openSql, setOpenSql }: {
  t: Turn; i: number; openSql: number | null; setOpenSql: (n: number | null) => void
}) {
  if (t.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="rounded-xl rounded-br-sm px-3 py-1.5 text-[12.5px] max-w-[85%] break-words"
             style={{ background: 'var(--s1)', color: '#fff' }}>
          {t.text}
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-xl rounded-bl-sm px-3 py-2 text-[12.5px] max-w-[92%] min-w-0"
         style={{ background: 'var(--plane)', border: '1px solid var(--border)' }}>
      {t.cached && (
        <div className="text-[10px] mb-1" style={{ color: 'var(--muted)' }}>
          Pregunta ya conocida · se reejecutó la consulta
        </div>
      )}
      {t.status && <Spinner label={STAGE[t.status] ?? t.status} />}
      {t.error && <div style={{ color: '#d03b3b' }}>{t.error}</div>}
      {t.text && <div className="whitespace-pre-wrap leading-relaxed break-words">{t.text}</div>}

      {!!t.warnings?.length && (
        <ul className="mt-2 grid gap-1">
          {t.warnings.map((w, j) => (
            <li key={j} className="text-[10.5px] px-1.5 py-1 rounded"
                style={{ background: 'color-mix(in srgb, #fab219 16%, transparent)', color: 'var(--ink2)' }}>
              {w}
            </li>
          ))}
        </ul>
      )}

      {t.rows && (
        <div className="mt-2 min-w-0">
          <div className="flex items-center gap-2 text-[10.5px] flex-wrap"
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
            <pre className="text-[10px] mt-1 p-1.5 rounded overflow-x-auto max-w-full"
                 style={{ background: 'var(--surface)', color: 'var(--ink2)' }}>{t.sql}</pre>
          )}
          <ResultTable rows={t.rows} />
        </div>
      )}
    </div>
  )
}

/** ADIA IA: asistente flotante, disponible desde cualquier pestaña y
 *  consciente de los filtros que se están viendo en el tablero. */
export function ChatWidget() {
  const { id } = useParams()
  const dsId = Number(id)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [openSql, setOpenSql] = useState<number | null>(null)
  const { turns, busy, ask, clear } = useChat(dsId)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const state = useFilters()
  const chips = describeFilters(state)

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [turns, open])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!Number.isFinite(dsId)) return null

  function send(text: string) {
    ask(text)
    setQ('')
  }

  return (
    <>
      {open && (
        <div
          className="fixed z-40 flex flex-col card overflow-hidden
                     inset-x-3 bottom-20 top-16
                     sm:inset-x-auto sm:top-auto sm:right-5 sm:bottom-20 sm:w-[27rem] sm:h-[34rem]"
          role="dialog" aria-label="ADIA IA"
        >
          <header className="flex items-center gap-2 px-3.5 py-2.5 shrink-0"
                  style={{ background: 'var(--s1)', color: '#fff' }}>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold leading-tight">ADIA IA</div>
              <div className="text-[10.5px] opacity-90 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{ background: '#7ef0a8' }} />
                Tu asistente de datos
              </div>
            </div>
            {!!turns.length && (
              <button onClick={clear} className="text-[11px] opacity-90 hover:opacity-100 px-1">
                limpiar
              </button>
            )}
            <button onClick={() => setOpen(false)} aria-label="Cerrar ADIA IA"
                    className="text-[18px] leading-none px-1 opacity-90 hover:opacity-100">×</button>
          </header>

          {/* El chat hereda los filtros del tablero: si estas mirando
              CONSERJE en marzo, la pregunta se responde sobre eso. */}
          {!!chips.length && (
            <div className="px-3 py-1.5 text-[10.5px] flex gap-1 flex-wrap shrink-0"
                 style={{ background: 'var(--plane)', borderBottom: '1px solid var(--border)',
                          color: 'var(--muted)' }}>
              <span>Filtrando por:</span>
              {chips.map((c, i) => (
                <span key={i} className="px-1.5 rounded"
                      style={{ background: 'var(--surface)', color: 'var(--ink2)' }}>{c}</span>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-3 grid gap-2 content-start min-w-0">
            {!turns.length && (
              <>
                <div className="rounded-xl rounded-bl-sm px-3 py-2 text-[12.5px] leading-relaxed"
                     style={{ background: 'var(--plane)', border: '1px solid var(--border)' }}>
                  ¡Hola! Soy <strong>ADIA</strong> 👋<br />
                  Pregúntame lo que quieras sobre estos datos: cuánta gente hay, cuánto se paga,
                  quién gana más, cómo ha cambiado el mes pasado… Te respondo al momento y con
                  cifras reales.
                  <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
                    ¿Por dónde empiezo?
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {SUGERENCIAS.map((s) => (
                    <button key={s} className="btn text-[11px] py-1" onClick={() => send(s)}>{s}</button>
                  ))}
                </div>
              </>
            )}
            {turns.map((t, i) => (
              <Bubble key={i} t={t} i={i} openSql={openSql} setOpenSql={setOpenSql} />
            ))}
            <div ref={endRef} />
          </div>

          <form className="flex gap-2 p-2.5 shrink-0"
                style={{ borderTop: '1px solid var(--border)' }}
                onSubmit={(e) => { e.preventDefault(); send(q) }}>
            <input ref={inputRef} className="input" value={q} disabled={busy}
                   placeholder="Escribe tu pregunta…"
                   onChange={(e) => setQ(e.target.value)} />
            <button className="btn btn-primary shrink-0" disabled={busy || !q.trim()}
                    aria-label="Enviar">
              {busy ? '…' : '↑'}
            </button>
          </form>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Cerrar ADIA IA' : 'Abrir ADIA IA'}
        className="fixed right-5 bottom-5 z-40 rounded-full shadow-lg flex items-center justify-center text-[20px] transition-transform hover:scale-105"
        style={{ background: open ? 'var(--surface)' : 'var(--s1)',
                 color: open ? 'var(--ink2)' : '#fff',
                 border: '1px solid ' + (open ? 'var(--border)' : 'var(--s1)'),
                 width: '3.25rem', height: '3.25rem' }}
      >
        {open ? '×' : '💬'}
      </button>
    </>
  )
}
