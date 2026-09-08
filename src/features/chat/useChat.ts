import { useCallback, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useFilters } from '../../lib/filters'

export interface Turn {
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

export const STAGE: Record<string, string> = {
  embedding: 'Entendiendo la pregunta…',
  cache: 'Buscando preguntas parecidas…',
  retrieving: 'Recuperando el contexto del dataset…',
  planning: 'Decidiendo cómo consultarlo…',
  sql: 'Consultando la base de datos…',
  answering: 'Redactando la respuesta…',
}

/** Conversación con el copiloto. Compartido por la página completa y el
 *  chat flotante, para que no existan dos implementaciones del mismo
 *  protocolo SSE que puedan divergir. */
export function useChat(dsId: number) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  // Se lee en el momento de preguntar, no al montar: si no, el chat
  // respondería con los filtros que había cuando se abrió.
  const store = useFilters

  const ask = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return
      setBusy(true)
      let at = 0
      setTurns((t) => {
        at = t.length + 1
        return [...t, { role: 'user', text }, { role: 'assistant', text: '', status: 'embedding' }]
      })
      const patch = (p: Partial<Turn>) =>
        setTurns((t) => t.map((x, i) => (i === at ? { ...x, ...p } : x)))

      try {
        const { period, filters, search } = store.getState()
        const { data: s } = await supabase.auth.getSession()
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + (s.session?.access_token ?? ''),
          },
          body: JSON.stringify({
            dataset_id: dsId,
            message: text,
            dashboard: { period, filters, search },
          }),
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
    },
    [busy, dsId, store],
  )

  return { turns, busy, ask, clear: () => setTurns([]) }
}
