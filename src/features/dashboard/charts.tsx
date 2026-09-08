import type { ReactNode } from 'react'
import { InfoTip } from '../../components/ui'

/** Tokens de grafico leidos del CSS, para que claro/oscuro cambien en un
 *  solo sitio y los colores de serie sean los validados por la paleta. */
export const C = {
  s1: 'var(--s1)',
  s2: 'var(--s2)',
  s3: 'var(--s3)',
  grid: 'var(--grid)',
  axis: 'var(--axis)',
  muted: 'var(--muted)',
  ink: 'var(--ink)',
  ink2: 'var(--ink2)',
  surface: 'var(--surface)',
}

// Ejes y rejilla recesivos: el dato manda, el andamiaje se aparta.
export const axisProps = {
  tick: { fill: 'var(--muted)', fontSize: 10.5 },
  tickLine: false,
  axisLine: { stroke: 'var(--axis)' },
} as const

export const gridProps = {
  stroke: 'var(--grid)',
  strokeDasharray: '0',
  vertical: false,
} as const

/** Tooltip propio: el de Recharts no hereda los tokens de tema. */
export function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="rounded-lg px-2.5 py-2 text-[11.5px] tnum shadow-lg"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--ink)' }}
    >
      {label != null && (
        <div className="font-medium mb-1" style={{ color: 'var(--ink2)' }}>{label}</div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: p.color || p.fill }} />
          <span style={{ color: 'var(--ink2)' }}>{p.name}:</span>
          <span className="font-medium">{fmt ? fmt(p.value, p) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Numero protagonista. Para una sola cifra, una tarjeta se lee mejor que
 *  cualquier grafico. */
export function Stat({ label, value, sub, tone, info }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | null; info?: string
}) {
  return (
    <div className="card p-3.5 min-w-0">
      <div className="text-[11px] uppercase tracking-wide flex items-center gap-1.5"
           style={{ color: 'var(--muted)' }}>
        <span className="min-w-0">{label}</span>
        {info && <InfoTip text={info} label={'Qué significa ' + label} />}
      </div>
      <div className="text-[21px] font-semibold tnum mt-1 leading-tight">{value}</div>
      {sub != null && (
        <div
          className="text-[11.5px] mt-0.5 tnum"
          style={{ color: tone === 'up' ? '#0ca30c' : tone === 'down' ? '#d03b3b' : 'var(--muted)' }}
        >
          {sub}
        </div>
      )}
    </div>
  )
}
