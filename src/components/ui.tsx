import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function Section({ title, hint, right, children }: {
  title: string; hint?: string; right?: ReactNode; children: ReactNode
}) {
  return (
    <section className="card p-4">
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {hint && <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--ink2)' }}>
      <span className="inline-block w-3.5 h-3.5 rounded-full animate-spin"
            style={{ border: '2px solid var(--axis)', borderTopColor: 'var(--s1)' }} />
      {label}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-[13px] py-8 text-center" style={{ color: 'var(--muted)' }}>{children}</div>
}

const SEV: Record<string, { bg: string; fg: string; label: string }> = {
  critical: { bg: '#d03b3b', fg: '#fff', label: 'Crítica' },
  high:     { bg: '#ec835a', fg: '#2a1206', label: 'Alta' },
  medium:   { bg: '#fab219', fg: '#2a1f02', label: 'Media' },
  low:      { bg: '#0ca30c', fg: '#fff', label: 'Baja' },
  info:     { bg: '#898781', fg: '#fff', label: 'Info' },
}

/** Severidad SIEMPRE con texto, nunca solo color: un color de estado no
 *  puede cargar el significado por si mismo. */
export function Severity({ level }: { level: string }) {
  const s = SEV[level] ?? SEV.info
  return (
    <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0"
          style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  )
}
