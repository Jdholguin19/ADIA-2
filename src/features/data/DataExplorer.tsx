import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { Empty, Spinner } from '../../components/ui'
import { n0, period } from '../../lib/format'

const PAGE = 100

export function DataExplorer() {
  const { id } = useParams()
  const dsId = Number(id)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [per, setPer] = useState('')
  const [quar, setQuar] = useState(false)

  const { data: meta } = useQuery({
    queryKey: ['ds-meta', dsId],
    queryFn: async () => {
      const [d, c] = await Promise.all([
        supabase.from('datasets').select('profile,n_rows_quarantined').eq('id', dsId).single(),
        supabase.from('dataset_columns').select('column_name,role,data_type,derived_rule')
          .eq('dataset_id', dsId).order('ordinal'),
      ])
      return { profile: d.data?.profile as any, quar: d.data?.n_rows_quarantined ?? 0, cols: c.data ?? [] }
    },
  })

  const { data, isFetching } = useQuery({
    queryKey: ['rows', dsId, page, q, per, quar],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dataset_page', {
        p_dataset_id: dsId, p_limit: PAGE, p_offset: page * PAGE,
        p_search: q || null, p_period: per || null, p_quarantine: quar,
      })
      if (error) throw error
      return data as any
    },
  })

  const rows: any[] = data?.rows ?? []
  const total = Number(data?.total ?? 0)
  const cols = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : []
  const periods: string[] = meta?.profile?.periods ?? []
  const roleOf = new Map((meta?.cols ?? []).map((c: any) => [c.column_name, c]))

  return (
    <div className="grid gap-3">
      <div className="card p-3 flex gap-2 flex-wrap items-center">
        <form onSubmit={(e) => { e.preventDefault(); setQ(search); setPage(0) }} className="flex gap-2 flex-1 min-w-[220px]">
          <input className="input" placeholder="Buscar en columnas de texto…"
                 value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn shrink-0">Buscar</button>
        </form>
        {!quar && !!periods.length && (
          <select className="input w-auto" value={per}
                  onChange={(e) => { setPer(e.target.value); setPage(0) }}>
            <option value="">Todos los periodos</option>
            {periods.map((p) => <option key={p} value={p}>{period(p)}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-[12px] cursor-pointer"
               style={{ color: 'var(--ink2)' }}>
          <input type="checkbox" checked={quar}
                 onChange={(e) => { setQuar(e.target.checked); setPage(0) }} />
          Cuarentena ({n0(meta?.quar ?? 0)})
        </label>
      </div>

      {isFetching && <Spinner label="Cargando filas…" />}

      {!isFetching && !rows.length ? (
        <Empty>Sin resultados.</Empty>
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-[11.5px] tnum">
              <thead>
                <tr style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                  {cols.map((c) => {
                    const info: any = roleOf.get(c)
                    return (
                      <th key={c} className="text-left font-medium px-2 py-2 whitespace-nowrap"
                          title={info ? info.role + (info.derived_rule ? ' · ' + info.derived_rule : '') : ''}>
                        {c}
                        {info?.role && (
                          <span className="ml-1 font-normal" style={{ opacity: 0.65 }}>
                            {info.role === 'derived' ? '·derivada'
                              : info.role === 'ordinal_index' ? '·índice'
                              : info.role === 'money' ? '·$' : ''}
                          </span>
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                    {cols.map((c) => {
                      const v = r?.[c]
                      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
                      return (
                        <td key={c} className="px-2 py-1 whitespace-nowrap max-w-[280px] truncate" title={s}>
                          {s || <span style={{ color: 'var(--muted)' }}>—</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3 text-[12px]">
            <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Anterior
            </button>
            <span className="tnum" style={{ color: 'var(--muted)' }}>
              {n0(page * PAGE + 1)}–{n0(Math.min((page + 1) * PAGE, total))} de {n0(total)}
            </span>
            <button className="btn" disabled={(page + 1) * PAGE >= total}
                    onClick={() => setPage((p) => p + 1)}>
              Siguiente →
            </button>
          </div>
        </>
      )}
    </div>
  )
}
