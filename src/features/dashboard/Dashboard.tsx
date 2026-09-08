import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { supabase } from '../../lib/supabase'
import { Empty, Section, Severity, Spinner } from '../../components/ui'
import { money, n0, n2, pct, period, delta } from '../../lib/format'
import { C, Stat, Tip, axisProps, gridProps } from './charts'

export function Dashboard() {
  const { id } = useParams()
  const dsId = Number(id)
  const [tab, setTab] = useState<'chart' | 'table'>('chart')

  const { data, isLoading, error } = useQuery({
    queryKey: ['metrics', dsId],
    queryFn: async () => {
      const [m, a, d] = await Promise.all([
        supabase.from('dataset_metrics').select('*').eq('dataset_id', dsId).maybeSingle(),
        supabase.from('dataset_alerts').select('severity,code,title')
          .eq('dataset_id', dsId).in('severity', ['critical', 'high']).limit(5),
        supabase.from('datasets').select('profile,n_rows_silver,n_rows_quarantined')
          .eq('id', dsId).single(),
      ])
      if (m.error) throw m.error
      return { metrics: m.data, alerts: a.data ?? [], ds: d.data }
    },
  })

  const M = data?.metrics?.metrics as any
  const series = (data?.metrics?.series as any[]) ?? []
  const k = M?.kpi ?? {}

  const hist = useMemo(
    () => (M?.histogram ?? []).map((h: any) => ({
      ...h, label: '$' + n0(h.lo) + '–' + n0(h.hi), n: Number(h.n),
    })),
    [M],
  )
  const groups = useMemo(
    () => (M?.top_groups ?? []).slice(0, 12).map((g: any) => ({
      ...g, headcount: Number(g.headcount), avg_pay: Number(g.avg_pay),
    })),
    [M],
  )
  const trend = useMemo(
    () => series.map((s) => ({
      p: period(s.period), headcount: Number(s.headcount),
      cost: Number(s.cost), avg: Number(s.avg_pay),
    })),
    [series],
  )

  if (isLoading) return <Spinner label="Cargando indicadores…" />
  if (error) return <Empty>{String((error as any).message)}</Empty>
  if (!M) {
    return <Empty>Este dataset todavía no tiene análisis. Vuelve a construirlo desde la lista.</Empty>
  }

  const hcDelta = delta(k.headcount, k.headcount_prev)
  const costDelta = delta(k.total_cost, k.total_cost_prev)
  const entityLabel = M.entity_column ?? 'registros'

  return (
    <div className="grid gap-4">
      {/* La regla de conteo va PEGADA a las cifras: un numero de plantilla sin
          su definicion es justo lo que hace que gerencia cite el dato mal. */}
      {M.grain === 'panel' && (
        <div className="card p-3 text-[12px] leading-relaxed"
             style={{ borderLeft: '3px solid var(--s1)' }}>
          <span className="font-semibold">Cómo se cuenta: </span>
          <span style={{ color: 'var(--ink2)' }}>
            {n0(data?.ds?.n_rows_silver)} filas = {n0(M.periods?.length)} periodos ×
            ~{n0(k.headcount)} {entityLabel}. El indicador cuenta{' '}
            <strong>{entityLabel} distintos dentro del periodo seleccionado</strong>, no filas.
          </span>
        </div>
      )}

      {M.latest_is_partial && (
        <div className="card p-3 text-[12px]" style={{ borderLeft: '3px solid #fab219' }}>
          <strong>Último periodo incompleto.</strong>{' '}
          <span style={{ color: 'var(--ink2)' }}>
            El tablero retrocede a {period(M.default_period)} para no mostrar una caída que no ha ocurrido.
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Periodo</span>
        <strong className="text-[13px]">{period(M.default_period)}</strong>
        {M.prev_period && (
          <span className="text-[11.5px]" style={{ color: 'var(--muted)' }}>
            (compara con {period(M.prev_period)})
          </span>
        )}
      </div>

      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))' }}>
        <Stat
          label={M.grain === 'panel' ? 'Plantilla' : 'Registros'}
          value={n0(k.headcount)}
          tone={hcDelta == null ? null : hcDelta >= 0 ? 'up' : 'down'}
          sub={hcDelta == null ? null : (hcDelta >= 0 ? '+' : '') + hcDelta.toFixed(2) + '% vs mes previo'}
        />
        <Stat
          label="Nómina del mes"
          value={money(k.total_cost, true)}
          tone={costDelta == null ? null : costDelta >= 0 ? 'down' : 'up'}
          sub={costDelta == null ? null : (costDelta >= 0 ? '+' : '') + costDelta.toFixed(2) + '% vs mes previo'}
        />
        <Stat label="Mediana" value={money(k.median_pay)}
              sub={'media ' + money(k.avg_pay) + ' · la media va por encima'} />
        <Stat label="Coste por persona" value={money(k.cost_per_head)} />
        <Stat label="Dispersión p90/p10" value={n2(k.p90_p10) + '×'}
              sub={money(k.p10) + ' → ' + money(k.p90)} />
        <Stat label="Concentración top 1%" value={pct(k.top1_share)}
              sub={'top 10%: ' + pct(k.top10_share)} />
        {k.entrants != null && (
          <Stat label="Altas / bajas" value={n0(k.entrants) + ' / ' + n0(k.leavers)}
                sub="respecto al mes previo" />
        )}
        <Stat label="Sueldo máximo" value={money(k.max_pay)}
              sub={Number(k.min_pay) <= 0 ? 'mínimo $0 — revisa alertas' : 'mínimo ' + money(k.min_pay)} />
      </div>

      {!!data?.alerts.length && (
        <Section title="Alertas destacadas" right={
          <Link to={'../alertas'} className="text-[11.5px] hover:underline" style={{ color: 'var(--s1)' }}>
            ver todas →
          </Link>
        }>
          <ul className="grid gap-1.5">
            {data.alerts.map((a: any, i: number) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px]">
                <Severity level={a.severity} />
                <span>{a.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Plantilla y coste van en graficos SEPARADOS: dos escalas distintas en
          un mismo eje doble es el error de grafico mas comun y hace ver
          correlaciones que no existen. */}
      {trend.length > 1 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
          <Section title={'Plantilla por periodo'} hint={n0(trend.length) + ' periodos'}>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="p" {...axisProps} interval="preserveStartEnd" minTickGap={26} />
                <YAxis {...axisProps} width={52} domain={['dataMin - 120', 'dataMax + 120']} />
                <Tooltip content={<Tip fmt={(v: number) => n0(v)} />} cursor={{ stroke: 'var(--axis)' }} />
                <Line type="monotone" dataKey="headcount" name="Plantilla" stroke={C.s1}
                      strokeWidth={2} dot={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--surface)' }} />
              </LineChart>
            </ResponsiveContainer>
          </Section>

          <Section title="Nómina por periodo" hint="Importe principal del mes">
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: -4 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="p" {...axisProps} interval="preserveStartEnd" minTickGap={26} />
                <YAxis {...axisProps} width={62} tickFormatter={(v) => '$' + (v / 1e6).toFixed(2) + 'M'}
                       domain={['dataMin - 100000', 'dataMax + 100000']} />
                <Tooltip content={<Tip fmt={(v: number) => money(v)} />} cursor={{ stroke: 'var(--axis)' }} />
                <Line type="monotone" dataKey="cost" name="Nómina" stroke={C.s2}
                      strokeWidth={2} dot={false} activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--surface)' }} />
              </LineChart>
            </ResponsiveContainer>
          </Section>
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        {!!groups.length && (
          <Section
            title="Mayores grupos"
            hint={'Por número de ' + entityLabel + ' en ' + period(M.default_period)}
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
                  <Bar dataKey="headcount" name={entityLabel} fill={C.s1}
                       radius={[0, 4, 4, 0]} barSize={13} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] tnum">
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th className="text-left font-medium pb-1.5">Grupo</th>
                      <th className="text-right font-medium pb-1.5">N.º</th>
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
                <Bar dataKey="n" name="Personas" fill={C.s1} radius={[4, 4, 0, 0]}>
                  {hist.map((_: any, i: number) => <Cell key={i} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Section>
        )}
      </div>

      {Object.entries(M.breakdowns ?? {}).map(([col, rows]: any) => {
        const rs = (rows as any[]).map((r) => ({ ...r, headcount: Number(r.headcount) }))
        if (rs.length < 2) return null
        return (
          <Section key={col} title={'Desglose por ' + col}
                   hint={'En ' + period(M.default_period)}>
            <ResponsiveContainer width="100%" height={Math.max(140, rs.length * 26)}>
              <BarChart data={rs} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 4 }}>
                <CartesianGrid {...gridProps} horizontal={false} vertical />
                <XAxis type="number" {...axisProps} />
                <YAxis type="category" dataKey="label" {...axisProps} width={150}
                       tick={{ fill: 'var(--ink2)', fontSize: 10.5 }} />
                <Tooltip content={<Tip fmt={(v: number) => n0(v)} />} cursor={{ fill: 'var(--grid)' }} />
                <Bar dataKey="headcount" name={entityLabel} fill={C.s3} radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        )
      })}

      {!!M.top_earners?.length && (
        <Section title="Mayores importes" hint={'En ' + period(M.default_period)}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tnum">
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  {Object.keys(M.top_earners[0]).map((h) => (
                    <th key={h} className={'font-medium pb-1.5 ' + (h === 'pago' ? 'text-right' : 'text-left')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {M.top_earners.slice(0, 15).map((r: any, i: number) => (
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
    </div>
  )
}
