import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { supabase, APP_NAME } from './lib/supabase'
import { Login, useSession } from './features/auth/AuthGate'
import { Spinner } from './components/ui'
import { DatasetList } from './features/datasets/DatasetList'
import { Dashboard } from './features/dashboard/Dashboard'
import { Quality } from './features/quality/Quality'
import { Chat } from './features/chat/Chat'
import { RagSettings } from './features/settings/RagSettings'
import { DataExplorer } from './features/data/DataExplorer'

function useTheme() {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('adia-theme') || 'system')
  useEffect(() => {
    const r = document.documentElement
    if (theme === 'system') r.removeAttribute('data-theme')
    else r.setAttribute('data-theme', theme)
    try { localStorage.setItem('adia-theme', theme) } catch { /* modo privado */ }
  }, [theme])
  return { theme, setTheme }
}

const TABS = [
  { to: '', label: 'Tablero', end: true },
  { to: 'alertas', label: 'Alertas' },
  { to: 'chat', label: 'Copiloto' },
  { to: 'datos', label: 'Datos' },
  { to: 'rag', label: 'Configuración IA' },
]

function DatasetShell({ children }: { children: React.ReactNode }) {
  const { id } = useParams()
  const [name, setName] = useState<string>('')
  useEffect(() => {
    supabase.from('datasets').select('name').eq('id', Number(id)).single()
      .then(({ data }) => setName(data?.name ?? ''))
  }, [id])

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <NavLink to="/" className="text-[12px] hover:underline" style={{ color: 'var(--muted)' }}>
          ← Datasets
        </NavLink>
        <h1 className="text-[15px] font-semibold tracking-tight">{name}</h1>
      </div>
      <nav className="flex gap-1 mb-5 flex-wrap">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              'px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ' +
              (isActive ? 'text-white' : 'hover:opacity-80')
            }
            style={({ isActive }: any) => ({
              background: isActive ? 'var(--s1)' : 'var(--surface)',
              border: '1px solid ' + (isActive ? 'var(--s1)' : 'var(--border)'),
              color: isActive ? '#fff' : 'var(--ink2)',
            })}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {children}
    </>
  )
}

export default function App() {
  const { session, loading } = useSession()
  const { theme, setTheme } = useTheme()

  if (loading) {
    return <div className="min-h-full grid place-items-center"><Spinner label="Cargando…" /></div>
  }
  if (!session) return <Login />

  return (
    <div className="min-h-full">
      <header
        className="sticky top-0 z-20 flex items-center gap-4 px-5 py-2.5"
        style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      >
        <NavLink to="/" className="font-semibold tracking-tight text-[14px]">{APP_NAME}</NavLink>
        <span className="text-[11px] hidden sm:block" style={{ color: 'var(--muted)' }}>
          Análisis de datos con copiloto IA
        </span>
        <div className="ml-auto flex items-center gap-3">
          <select
            className="input w-auto text-[12px] py-1"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            aria-label="Tema"
          >
            <option value="system">Tema del sistema</option>
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
          <span className="text-[11.5px] hidden md:block" style={{ color: 'var(--muted)' }}>
            {session.user.email}
          </span>
          <button className="btn text-[12px] py-1" onClick={() => supabase.auth.signOut()}>
            Salir
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-5">
        <Routes>
          <Route path="/" element={<DatasetList />} />
          <Route path="/d/:id" element={<DatasetShell><Dashboard /></DatasetShell>} />
          <Route path="/d/:id/alertas" element={<DatasetShell><Quality /></DatasetShell>} />
          <Route path="/d/:id/chat" element={<DatasetShell><Chat /></DatasetShell>} />
          <Route path="/d/:id/datos" element={<DatasetShell><DataExplorer /></DatasetShell>} />
          <Route path="/d/:id/rag" element={<DatasetShell><RagSettings /></DatasetShell>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
