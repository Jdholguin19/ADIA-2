import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}


/**
 * Explicacion de una metrica. Se muestra al pasar el raton Y al enfocar con
 * teclado: un tooltip que solo responde a :hover deja fuera a quien navega
 * con tabulador y a cualquiera en tactil.
 */
export function InfoTip({ text, label = 'Que significa' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="w-3.5 h-3.5 rounded-full text-[9px] leading-none flex items-center justify-center cursor-help"
        style={{ border: '1px solid var(--axis)', color: 'var(--muted)' }}
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 bottom-full z-40 mb-1.5 w-60 -translate-x-1/2 rounded-lg p-2 text-[11px] font-normal normal-case leading-snug shadow-lg pointer-events-none"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            color: 'var(--ink2)',
            letterSpacing: 'normal',
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}

/** Barra de sub-pestañas. Solo se renderiza el panel activo, que es lo que
 *  evita que un formulario y varias listas se peleen por el mismo ancho. */
export function SubTabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: string; badge?: ReactNode }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div role="tablist" className="flex gap-1 flex-wrap">
      {tabs.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors flex items-center gap-1.5"
            style={{
              background: active ? 'var(--s1)' : 'var(--surface)',
              border: '1px solid ' + (active ? 'var(--s1)' : 'var(--border)'),
              color: active ? '#fff' : 'var(--ink2)',
            }}
          >
            {t.label}
            {t.badge != null && (
              <span className="text-[10.5px] tnum px-1.5 rounded"
                    style={{
                      background: active ? 'rgba(255,255,255,.22)' : 'var(--plane)',
                      color: active ? '#fff' : 'var(--muted)',
                    }}>
                {t.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Diálogo modal. Cierra con Escape y al pulsar fuera, bloquea el scroll del
 * fondo y devuelve el foco al elemento que lo abrió: sin eso, quien navega
 * con teclado acaba perdido al final del documento.
 */
export function Modal({ open, title, hint, onClose, children, footer }: {
  open: boolean
  title: string
  hint?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      restoreTo.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,.55)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title}
           className="card w-full max-w-xl my-auto">
        <header className="flex items-start justify-between gap-3 p-4"
                style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">{title}</h2>
            {hint && <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{hint}</p>}
          </div>
          <button onClick={onClose} aria-label="Cerrar"
                  className="text-[16px] leading-none px-1 shrink-0"
                  style={{ color: 'var(--muted)' }}>×</button>
        </header>
        <div className="p-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 p-4"
                  style={{ borderTop: '1px solid var(--border)' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export function Section({ title, hint, right, children }: {
  title: string; hint?: string; right?: ReactNode; children: ReactNode
}) {
  return (
    // min-w-0: los elementos de un grid llevan min-width:auto, asi que un
    // hijo ancho (un <pre> con SQL largo) ensancha la seccion, luego el
    // <body>, y el mx-auto del <main> acaba empujando la pagina fuera de
    // la pantalla. Es la causa habitual del scroll horizontal fantasma.
    <section className="card p-4 min-w-0">
      {/* flex-wrap: sin el, en estrecho el boton de la derecha estruja el
          titulo y su explicacion hasta partirlos letra a letra. */}
      <header className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
        <div className="min-w-0">
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
