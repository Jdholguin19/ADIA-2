import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { ingestFile, type IngestProgress } from '../../lib/ingest/uploader'
import { Empty, Spinner } from '../../components/ui'
import { n0, period } from '../../lib/format'

export function DatasetList() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [prog, setProg] = useState<IngestProgress | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['datasets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('datasets')
        .select('id,name,source_filename,status,n_rows_silver,n_rows_quarantined,created_at,profile')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })

  const upload = useCallback(
    async (file: File) => {
      setErr(null)
      try {
        const id = await ingestFile(file, setProg)
        await qc.invalidateQueries({ queryKey: ['datasets'] })
        setProg(null)
        nav('/d/' + id)
      } catch (e: any) {
        setErr(String(e?.message || e))
        setProg(null)
      }
    },
    [nav, qc],
  )

  async function remove(id: number, name: string) {
    if (!confirm('¿Eliminar "' + name + '" y todos sus datos? No se puede deshacer.')) return
    const { error } = await supabase.rpc('delete_dataset', { p_dataset_id: id })
    if (error) setErr(error.message)
    qc.invalidateQueries({ queryKey: ['datasets'] })
  }

  return (
    <div className="grid gap-5">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault(); setDrag(false)
          const f = e.dataTransfer.files?.[0]
          if (f && !prog) upload(f)
        }}
        onClick={() => !prog && inputRef.current?.click()}
        className="card p-9 text-center cursor-pointer transition-colors"
        style={{ borderStyle: 'dashed', borderColor: drag ? 'var(--s1)' : 'var(--border)' }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
        />
        {prog ? (
          <div className="max-w-md mx-auto">
            <Spinner label={prog.message} />
            <div className="h-1.5 rounded-full mt-4 overflow-hidden" style={{ background: 'var(--grid)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: prog.pct + '%', background: 'var(--s1)' }}
              />
            </div>
            <div className="text-[11.5px] mt-2 tnum" style={{ color: 'var(--muted)' }}>
              {prog.pct}%{prog.resumed ? ' · reanudando carga anterior' : ''}
            </div>
          </div>
        ) : (
          <>
            <div className="text-[14px] font-medium">Arrastra un XLSX o CSV, o haz clic</div>
            <p className="text-[12px] mt-1.5" style={{ color: 'var(--muted)' }}>
              Se perfila solo: detecta tipos, roles de columna, la forma de los datos y las alertas.
            </p>
          </>
        )}
      </div>

      {err && (
        <div className="card p-3 text-[12.5px]" style={{ borderColor: '#d03b3b', color: '#d03b3b' }}>
          {err}
        </div>
      )}

      {isLoading ? (
        <Spinner label="Cargando datasets…" />
      ) : !data?.length ? (
        <Empty>Todavía no has cargado ningún archivo.</Empty>
      ) : (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(310px,1fr))' }}>
          {data.map((d: any) => {
            const p = d.profile || {}
            return (
              <div key={d.id} className="card p-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <button className="text-left font-medium text-[13.5px] hover:underline"
                          onClick={() => nav('/d/' + d.id)}>
                    {d.name}
                  </button>
                  <button className="text-[11px] shrink-0 hover:underline"
                          style={{ color: 'var(--muted)' }}
                          onClick={() => remove(d.id, d.name)}>
                    eliminar
                  </button>
                </div>
                <div className="text-[11.5px] tnum" style={{ color: 'var(--ink2)' }}>
                  {n0(d.n_rows_silver)} filas
                  {d.n_rows_quarantined > 0 && ' · ' + n0(d.n_rows_quarantined) + ' en cuarentena'}
                </div>
                {p.grain === 'panel' && (
                  <div className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
                    Panel · {p.n_periods} periodos · {period(p.last_period)} · ~{n0(p.entities_per_period)} {p.entity_column}
                  </div>
                )}
                <div className="text-[11px] mt-auto pt-1" style={{ color: 'var(--muted)' }}>
                  {d.status === 'ready' ? 'Listo' : d.status} · {d.source_filename}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
