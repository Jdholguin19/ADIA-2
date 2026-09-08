import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { supabase } from '../../lib/supabase'
import { Empty, Section, Spinner } from '../../components/ui'
import { money, n0, pct, period as fmtPeriod, delta } from '../../lib/format'
import { useFilters } from '../../lib/filters'
import { C, Stat, Tip, axisProps, gridProps } from './charts'

/** Que significa cada indicador. Un numero sin definicion es justo lo que
 *  hace que alguien lo cite mal en una reunion. */
const EXPLICA: Record<string, string> = {
  headcount:
    'Personas distintas en el periodo seleccionado. No es el número de filas: el archivo trae una fila por persona y mes, así que contar filas daría los "persona-mes", no la plantilla.',
  cost:
    'Suma del importe principal del mes para las filas del periodo y filtros activos. Es el coste base; los ingresos adicionales se reportan aparte para no contarlos dos veces.',
  median:
    'La MEDIANA parte a la plantilla en dos: la mitad cobra menos que esa cifra y la mitad más. ' +
    'La MEDIA es la suma repartida entre todos, así que unos pocos sueldos muy altos tiran de ella hacia arriba. ' +
    'Cuando la media queda por encima de la mediana, significa que la mayoría cobra menos que el promedio, ' +
    'y entonces la mediana describe mejor "lo que gana la gente".',
  costPerHead: 'Nómina del periodo dividida entre las personas distintas de ese mismo periodo.',
  top1:
    'Porcentaje del gasto total que concentra el 1% mejor pagado. Cuanto más alto, más depende el coste de unas pocas personas.',
  flow:
    'Altas = personas presentes este periodo que no estaban en el anterior. Bajas = al revés. No distingue contrataciones de correcciones de datos.',
  max: 'Importe más alto del periodo y filtros activos.',
}

const PAGE_HINT: Record<string, string> = {}

export function Dashboard() {
  const { id } = useParams()
  const dsId = Number(id)
  const [tab, setTab] = useState<'chart' | 'table'>('chart')
  const { period, filters, search, setDataset, setPeriod, setFilter, setSearch, reset } = useFilters()
  const [searchBox, setSearchBox] = useState(search)

  useEffect(() => { setDataset(dsId) }, [dsId, setDataset])

  // Debounce: sin el, cada tecla lanzaria una consulta al servidor.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchBox), 400)
    return () => clearTimeout(t)
  }, [searchBox, setSearch])

  const meta = useQuery({
    queryKey: ['ds-meta', dsId],
    queryFn: async () => {
      const [m, o] = await Promise.all([
        supabase.from('dataset_metrics').select('metrics,default_period').eq('dataset_id', dsId).maybeSingle(),
        supabase.rpc('dataset_filter_options', { p_dataset_id: dsId, p_limit: 60 }),
      ])
      if (m.error) throw m.error
      return { metrics: m.data?.metrics as any, options: (o.data as any[]) ?? [] }
    },
  })

  const slice = useQuery({
    queryKey: ['slice', dsId, period, filters, search],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('dashboard_slice', {
        p_dataset_id: dsId,
        p_period: period,
        p_filters: filters,
        p_search: search || null,
      })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error ?? 'Error al calcular el tablero')
      return data as any
    },
    enabled: !!meta.data,
    placeholderData: (prev) => prev,
  })

  const M = meta.data?.metrics
  const S = slice.data
  const k = S?.kpi ?? {}
  const periods: string[] = M?.periods ?? []
  const entityLabel = S?.entity_column ?? M?.entity_column ?? 'registros'
  // El grafico habla de PERSONAS, no del nombre tecnico de la columna.
  // Antes el tooltip decia "names: 2.243", que no significa nada para nadie.
  const serieLabel = 'Personas'

  const trend = useMemo(
    () => (S?.series ?? []).map((s: any) => ({
      p: fmtPeriod(s.period), headcount: Number(s.headcount),
      cost: Number(s.cost), avg: Number(s.avg_pay),
    })),
    [S],
  )
  const groups = useMemo(
    () => (S?.top_groups ?? []).slice(0, 12).map((g: any) => ({
      ...g, headcount: Number(g.headcount), avg_pay: Number(g.avg_pay),
    })),
    [S],
  )
  const hist = useMemo(
    () => (S?.histogram ?? []).map((h: any) => ({
      ...h, label: '$' + n0(h.lo) + '–' + n0(h.hi), n: Number(h.n),
    })),
    [S],
  )

  if (meta.isLoading) return <Spinner label="Cargando indicadores…" />
  if (meta.error) return <Empty>{String((meta.error as any).message)}</Empty>
  if (!M) return <Empty>Este dataset todavía no tiene análisis.</Empty>

  const activeCount = Object.keys(filters).length + (search ? 1 : 0) + (period ? 1 : 0)
  // Cuanto se separa la media de la mediana: es lo que revela si unos pocos
  // sueldos altos estan tirando del promedio.
  const gapMedia = delta(k.avg_pay, k.median_pay)
  const hcDelta = delta(k.headcount, k.headcount_prev)
  const costDelta = delta(k.total_cost, k.total_cost_prev)
  const shown = S?.period ?? M.default_period

  return (
    <div className="grid gap-4">
      {M.grain === 'panel' && (
        <div className="card p-3 text-[12px] leading-relaxed"
             style={{ borderLeft: '3px solid var(--s1)' }}>
          <span className="font-semibold">Cómo se cuenta: </span>
          <span style={{ color: 'var(--ink2)' }}>
            una fila = un/a {entityLabel} en un mes. El indicador cuenta{' '}
            <strong>{entityLabel} distintos dentro del periodo y los filtros activos</strong>, no filas.
          </span>
        </div>
      )}

      {/* -------------------------------- filtros -------------------------------- */}
      <div className="card p-3 grid gap-2.5">
        <div className="flex gap-2 flex-wrap items-end">
          <label className="grid gap-1">
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>Periodo</span>
            <select className="input w-auto" value={period ?? ''}
                    onChange={(e) => setPeriod(e.target.value || null)}>
              <option value="">{fmtPeriod(M.default_period)} (vigente)</option>
              {periods.map((p) => <option key={p} value={p}>{fmtPeriod(p)}</option>)}
            </select>
          </label>

          {(meta.data?.options ?? []).map((o: any) => (
            <label key={o.column} className="grid gap-1 min-w-0">
              <span className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
                {o.column}
              </span>
              <select className="input w-auto max-w-[15rem]" value={filters[o.column] ?? ''}
                      onChange={(e) => setFilter(o.column, e.target.value)}>
                <option value="">Todos ({n0(o.distinct)})</option>
                {(o.values ?? []).map((v: any) => (
                  <option key={v.value} value={v.value}>{v.value} ({n0(v.n)})</option>
                ))}
              </select>
            </label>
          ))}

          <label className="grid gap-1 flex-1 min-w-[12rem]">
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              Buscar en {entityLabel}
            </span>
            <input className="input" value={searchBox} placeholder="parte de un nombre…"
                   onChange={(e) => setSearchBox(e.target.value)} />
          </label>

          {activeCount > 0 && (
            <button className="btn text-[12px]" onClick={() => { reset(); setSearchBox('') }}>
              Limpiar ({activeCount})
            </button>
          )}
        </div>

        <div className="text-[11.5px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--muted)' }}>
          <span>Mostrando <strong style={{ color: 'var(--ink)' }}>{fmtPeriod(shown)}</strong></span>
          {S?.prev_period && <span>· compara con {fmtPeriod(S.prev_period)}</span>}
          {(S?.applied ?? []).map((a: any, i: number) => (
            <span key={i} className="px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--plane)', color: 'var(--ink2)' }}>
              {a.column} {a.op ?? '='} {a.value}
            </span>
          ))}
          {slice.isFetching && <span>· actualizando…</span>}
        </div>
      </div>

      {slice.error && (
        <div className="card p-3 text-[12.5px]" style={{ borderColor: '#d03b3b', color: '#d03b3b' }}>
          {String((slice.error as any).message)}
        </div>
      )}

      {Number(k.rows ?? 0) === 0 ? (
        <Empty>Ningún registro coincide con estos filtros.</Empty>
      ) : (
        <>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(178px,1fr))' }}>
            <Stat
              label={M.grain === 'panel' ? 'Plantilla' : 'Registros'}
              value={n0(k.headcount)}
              info={EXPLICA.headcount}
              tone={hcDelta == null ? null : hcDelta >= 0 ? 'up' : 'down'}
              sub={hcDelta == null ? null : (hcDelta >= 0 ? '+' : '') + hcDelta.toFixed(2) + '% vs periodo previo'}
            />
            <Stat
              label="Nómina del periodo" value={money(k.total_cost, true)} info={EXPLICA.cost}
              tone={costDelta == null ? null : costDelta >= 0 ? 'down' : 'up'}
              sub={costDelta == null ? null : (costDelta >= 0 ? '+' : '') + costDelta.toFixed(2) + '% vs periodo previo'}
            />
            <Stat
              label="Mediana" value={money(k.median_pay)} info={EXPLICA.median}
              sub={
                gapMedia == null
                  ? 'media ' + money(k.avg_pay)
                  : 'media ' + money(k.avg_pay) + ' · ' +
                    (gapMedia > 0
                      ? 'un ' + gapMedia.toFixed(0) + '% más alta, la estiran los sueldos altos'
                      : 'por debajo de la mediana')
              }
            />
            <Stat label="Coste por persona" value={money(k.cost_per_head)} info={EXPLICA.costPerHead} />
            <Stat label="Concentración top 1%" value={pct(k.top1_share)} info={EXPLICA.top1}
                  sub={'top 10%: ' + pct(k.top10_share)} />
            {k.entrants != null && (
              <Stat label="Altas / bajas" value={n0(k.entrants) + ' / ' + n0(k.leavers)}
                    info={EXPLICA.flow} sub="respecto al periodo previo" />
            )}
            <Stat label="Importe máximo" value={money(k.max_pay)} info={EXPLICA.max}
                  sub={Number(k.min_pay) <= 0 ? 'mínimo $0' : 'mínimo ' + money(k.min_pay)} />
          </div>

          {trend.length > 1 && (
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
              <Section title="Plantilla por periodo"
                       hint={n0(trend.length) + ' periodos · respeta los filtros, no el periodo'}>
                <ResponsiveContainer width="100%" height={210}>
                  <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="p" {...axisProps} interval="preserveStartEnd" minTickGap={26} />
                    <YAxis {...axisProps} width={52} domain={['dataMin - 40', 'dataMax + 40']} />
                    <Tooltip content={<Tip fmt={(v: number) => n0(v)} />} cursor={{ stroke: 'var(--axis)' }} />
                    <Line type="monotone" dataKey="headcount" name={serieLabel} stroke={C.s1}
                          strokeWidth={2} dot={false}
                          activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--surface)' }} />
                  </LineChart>
                </ResponsiveContainer>
              </Section>

              <Section title="Nómina por periodo" hint="Importe principal del mes">
                <ResponsiveContainer width="100%" height={210}>
                  <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: -4 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="p" {...axisProps} interval="preserveStartEnd" minTickGap={26} />
                    <YAxis {...axisProps} width={62}
                           tickFormatter={(v) => '$' + (v / 1e6).toFixed(2) + 'M'}
                           domain={['auto', 'auto']} />
                    <Tooltip content={<Tip fmt={(v: number) => money(v)} />} cursor={{ stroke: 'var(--axis)' }} />
                    <Line type="monotone" dataKey="cost" name="Nómina" stroke={C.s2}
                          strokeWidth={2} dot={false}
                          activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--surface)' }} />
                  </LineChart>
                </ResponsiveContainer>
              </Section>
            </div>
          )}

          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
            {!!groups.length && (
              <Section
                title="Mayores grupos"
                hint={'Por número de ' + entityLabel + ' en ' + fmtPeriod(shown)}
                right={
                  <div className="flex gap-1">
                    {(['chart', 'table'] as const).map((t) => (
                      <button key={t} onClick={() => setTab(t)}
                              className="text-[11px] px-2 py-0.5 rounded"
                              style={{
                                background: tab === t ? 'var(--s1)' : 'transparent',
                                color: tab === t ? '#fff' : 'var(--muted)',
                                border: '1px solid ' + (tab === t ? 'var(--s1)' : 'var(--border)'),
                              }}>
                        {t === 'chart' ? 'Gráfico' : 'Tabla'}
                      </button>
                    ))}
                  </div>
                }
              >
                {tab === 'chart' ? (
                  <ResponsiveContainer width="100%" height={Math.max(220, groups.length * 22)}>
                    <BarChart data={groups} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 4 }}>
                      <CartesianGrid {...gridProps} horizontal={false} vertical />
                      <XAxis type="number" {...axisProps} />
                      <YAxis type="category" dataKey="label" {...axisProps} width={172}
                             tick={{ fill: 'var(--ink2)', fontSize: 10.5 }} />
                      <Tooltip content={<Tip fmt={(v: number) => n0(v)} />} cursor={{ fill: 'var(--grid)' }} />
                      <Bar dataKey="headcount" name={serieLabel} fill={C.s1}
                           radius={[0, 4, 4, 0]} barSize={13} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px] tnum">
                      <thead>
                        <tr style={{ color: 'var(--muted)' }}>
                          <th className="text-left font-medium pb-1.5">Grupo</th>
                          <th className="text-right font-medium pb-1.5">Personas</th>
                          <th className="text-right font-medium pb-1.5">Medio</th>
                          <th className="text-right font-medium pb-1.5">Coste</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((g: any, i: number) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                            <td className="py-1 pr-2">{g.label}</td>
                            <td className="text-right">{n0(g.headcount)}</td>
                            <td className="text-right">{money(g.avg_pay)}</td>
                            <td className="text-right">{money(g.cost, true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            )}

            {!!hist.length && (
              <Section title="Distribución salarial"
                       hint="Tramos en escala logarítmica: con mediana baja y cola larga, un eje lineal no se lee">
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={hist} margin={{ top: 6, right: 8, bottom: 0, left: -14 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="label" {...axisProps} interval="preserveStartEnd" minTickGap={14}
                           tick={{ fill: 'var(--muted)', fontSize: 9.5 }} />
                    <YAxis {...axisProps} width={46} />
                    <Tooltip content={<Tip fmt={(v: number) => n0(v) + ' personas'} />}
                             cursor={{ fill: 'var(--grid)' }} />
                    <Bar dataKey="n" name={serieLabel} fill={C.s1} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Section>
            )}
          </div>

          {Object.entries(S?.breakdowns ?? {}).map(([col, rows]: any) => {
            const rs = (rows as any[]).map((r) => ({ ...r, headcount: Number(r.headcount) }))
            if (rs.length < 2) return null
            return (
              <Section key={col} title={'Desglose por ' + col}
                       hint={PAGE_HINT[col] ?? ('En ' + fmtPeriod(shown))}>
                <ResponsiveContainer width="100%" height={Math.max(140, rs.length * 26)}>
                  <BarChart data={rs} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 4 }}>
                    <CartesianGrid {...gridProps} horizontal={false} vertical />
                    <XAxis type="number" {...axisProps} />
                    <YAxis type="category" dataKey="label" {...axisProps} width={150}
                           tick={{ fill: 'var(--ink2)', fontSize: 10.5 }} />
                    <Tooltip content={<Tip fmt={(v: number) => n0(v)} />} cursor={{ fill: 'var(--grid)' }} />
                    <Bar dataKey="headcount" name={serieLabel} fill={C.s3} radius={[0, 4, 4, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </Section>
            )
          })}

          {!!S?.top_earners?.length && (
            <Section title="Mayores importes" hint={'En ' + fmtPeriod(shown)}>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] tnum">
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      {Object.keys(S.top_earners[0]).map((h) => (
                        <th key={h} className={'font-medium pb-1.5 ' + (h === 'pago' ? 'text-right' : 'text-left')}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {S.top_earners.slice(0, 15).map((r: any, i: number) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        {Object.entries(r).map(([kk, v]: any) => (
                          <td key={kk} className={'py-1 pr-3 ' + (kk === 'pago' ? 'text-right font-medium' : '')}>
                            {kk === 'pago' ? money(v) : String(v ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
