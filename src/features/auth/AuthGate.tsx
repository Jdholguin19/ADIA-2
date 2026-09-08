import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, APP_NAME } from '../../lib/supabase'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])
  return { session, loading }
}

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setErr(error.message)
    setBusy(false)
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <form onSubmit={submit} className="card p-7 w-full max-w-sm">
        <div className="text-xl font-semibold tracking-tight">{APP_NAME}</div>
        <p className="text-[13px] mt-1 mb-6" style={{ color: 'var(--ink2)' }}>
          Análisis de datos con copiloto IA
        </p>
        <label className="block text-[12px] mb-1" style={{ color: 'var(--ink2)' }}>Correo</label>
        <input className="input mb-3" type="email" value={email} autoComplete="username"
               onChange={(e) => setEmail(e.target.value)} required />
        <label className="block text-[12px] mb-1" style={{ color: 'var(--ink2)' }}>Contraseña</label>
        <input className="input mb-5" type="password" value={password} autoComplete="current-password"
               onChange={(e) => setPassword(e.target.value)} required />
        {err && (
          <div className="text-[12px] mb-4 px-3 py-2 rounded-lg"
               style={{ color: 'var(--critical, #d03b3b)', background: 'color-mix(in srgb, #d03b3b 10%, transparent)' }}>
            {err}
          </div>
        )}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}
