import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { Empty, Severity, Spinner } from '../../components/ui'
import { money, n0 } from '../../lib/format'

const ORDER = ['critical', 'high', 'medium', 'low', 'info']

function EvidenceTable({ rows }: { rows: any[] }) {
  if (!rows?.length) return null
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))]
  return (
    <div className="overflow-x-auto mt-2.5 rounded-lg" style={{ border: '1px solid var(--border)' }}>
      <table className="w-full text-[11.5px] tnum">
        <thead>
          <tr style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
            {cols.map((c) => (
              <th key={c} className="text-left font-medium px-2 py-1.5 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              {cols.map((c) => {
                const v = r?.[c]
                const s = v == null ? '—'
                  : typeof v === 'object' ? JSON.stringify(v)
                  : String(v)
                return (
                  <td key={c} className="px-2 py-1 max-w-[280px] truncate" title={s}>{s}</td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Quality() {
  const { id } = useParams()
  const dsId = Number(id)
  const [open, setOpen] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', dsId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dataset_alerts')
        .select('*')
        .eq('dataset_id', dsId)
      if (error) throw error
      return (data ?? []).sort(
        (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.code.localeCompare(b.code),
      )
    },
  })

  if (isLoading) return <Spinner label="Cargando alertas…" />
  if (!data?.length) return <Empty>Sin alertas: el archivo está limpio.</Empty>

  const counts = ORDER.map((s) => [s, data.filter((a: any) => a.severity === s).length] as const)
    .filter(([, n]) => n > 0)

  return (
    <div className="grid gap-3">
      <div className="flex gap-2 flex-wrap items-center text-[12px]">
        <span style={{ color: 'var(--muted)' }}>{data.length} alertas:</span>
        {counts.map(([s, n]) => (
          <span key={s} className="flex items-center gap-1.5">
            <Severity level={s} /><span className="tnum">{n}</span>
          </span>
        ))}
      </div>

      {data.map((a: any) => {
        const isOpen = open === a.id
        const hasEv = Array.isArray(a.evidence) && a.evidence.length > 0
        return (
          <div key={a.id} className="card p-4">
            <div className="flex items-start gap-2.5">
              <Severity level={a.severity} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-[13px]">{a.title}</div>
                <p className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--ink2)' }}>
                  {a.detail}
                </p>
                {a.impact != null && (
                  <p className="text-[12px] mt-1.5 font-medium">
                    Impacto en dinero: {money(a.impact)}
                  </p>
                )}
                <div className="flex gap-3 items-center mt-2">
                  <code className="text-[10.5px] px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                    {a.code}
                  </code>
                  {a.metric != null && (
                    <span className="text-[11px] tnum" style={{ color: 'var(--muted)' }}>
                      métrica: {n0(a.metric)}
                    </span>
                  )}
                  {hasEv && (
                    <button className="text-[11.5px] hover:underline" style={{ color: 'var(--s1)' }}
                            onClick={() => setOpen(isOpen ? null : a.id)}>
                      {isOpen ? 'ocultar evidencia' : 'ver ' + a.evidence.length + ' filas de evidencia'}
                    </button>
                  )}
                </div>
                {isOpen && hasEv && <EvidenceTable rows={a.evidence} />}
                {isOpen && a.evidence_sql && (
                  <pre className="text-[10.5px] mt-2 p-2 rounded-lg overflow-x-auto"
                       style={{ background: 'var(--plane)', color: 'var(--ink2)' }}>
                    {a.evidence_sql}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
