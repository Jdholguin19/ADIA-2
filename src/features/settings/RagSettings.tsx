import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { Empty, Section, Spinner } from '../../components/ui'
import { n0 } from '../../lib/format'

const MODELOS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4.1', 'gpt-4.1-mini']
const EMBEDS = ['text-embedding-3-small']

const DEF = {
  sql_model: 'gpt-5.4-mini',
  fast_model: 'gpt-5.4-mini',
  embed_model: 'text-embedding-3-small',
  temperature: 0,
  top_k_kb: 5,
  kb_min_similarity: 0.25,
  cache_enabled: true,
  cache_min_similarity: 0.93,
  max_tool_iterations: 4,
  max_rows: 500,
  allow_freeform_sql: true,
  system_prompt: '',
}

function Field({ label, hint, children }: any) {
  return (
    <label className="block">
      <div className="text-[12px] font-medium">{label}</div>
      {hint && <div className="text-[11px] mb-1.5" style={{ color: 'var(--muted)' }}>{hint}</div>}
      {children}
    </label>
  )
}

export function RagSettings() {
  const { id } = useParams()
  const dsId = Number(id)
  const qc = useQueryClient()
  const [cfg, setCfg] = useState<any>(DEF)
  const [saved, setSaved] = useState(false)
  const [kbTitle, setKbTitle] = useState('')
  const [kbBody, setKbBody] = useState('')
  const [kbSql, setKbSql] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['rag', dsId],
    queryFn: async () => {
      const [c, kb, cache] = await Promise.all([
        supabase.from('assistant_configs').select('*')
          .order('dataset_id', { ascending: false, nullsFirst: false }).limit(1),
        supabase.from('kb_documents').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('query_cache').select('id,question,status,hit_count,last_used_at,sql_template')
          .eq('dataset_id', dsId).order('hit_count', { ascending: false }).limit(50),
      ])
      return { cfg: c.data?.[0] ?? null, kb: kb.data ?? [], cache: cache.data ?? [] }
    },
  })

  useEffect(() => { if (data?.cfg) setCfg({ ...DEF, ...data.cfg }) }, [data?.cfg])

  async function save() {
    const row = { ...cfg, dataset_id: dsId, updated_at: new Date().toISOString() }
    delete row.created_at
    const { error } = cfg.id
      ? await supabase.from('assistant_configs').update(row).eq('id', cfg.id)
      : await supabase.from('assistant_configs').insert(row)
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function addKb() {
    if (!kbTitle.trim() || !kbBody.trim()) return
    await supabase.from('kb_documents').insert({
      dataset_id: dsId,
      kind: kbSql.trim() ? 'sql_exemplar' : 'glossary',
      title: kbTitle, content: kbBody, sql_text: kbSql.trim() || null,
    })
    setKbTitle(''); setKbBody(''); setKbSql('')
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function delKb(kid: number) {
    await supabase.from('kb_documents').delete().eq('id', kid)
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function clearCache() {
    if (!confirm('¿Vaciar la caché de preguntas de este dataset?')) return
    await supabase.from('query_cache').delete().eq('dataset_id', dsId)
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  if (isLoading) return <Spinner label="Cargando configuración…" />

  const hits = (data?.cache ?? []).reduce((s, c: any) => s + (c.hit_count ?? 0), 0)

  return (
    <div className="grid gap-4">
      <Section
        title="Modelo y recuperación"
        hint="Afecta a cómo responde el copiloto. Los cambios se aplican en la siguiente pregunta."
        right={
          <button className="btn btn-primary text-[12px] py-1" onClick={save}>
            {saved ? 'Guardado ✓' : 'Guardar'}
          </button>
        }
      >
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
          <Field label="Modelo principal" hint="Escribe el SQL y redacta la respuesta">
            <select className="input" value={cfg.sql_model}
                    onChange={(e) => setCfg({ ...cfg, sql_model: e.target.value })}>
              {MODELOS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Modelo de embeddings" hint="1536 dimensiones; cambiarlo invalida la caché">
            <select className="input" value={cfg.embed_model}
                    onChange={(e) => setCfg({ ...cfg, embed_model: e.target.value })}>
              {EMBEDS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
          <Field label={'Temperatura: ' + cfg.temperature} hint="0 para cifras. Subirla añade variación, no criterio.">
            <input type="range" min={0} max={1} step={0.1} className="w-full" value={cfg.temperature}
                   onChange={(e) => setCfg({ ...cfg, temperature: Number(e.target.value) })} />
          </Field>
          <Field label={'Documentos de contexto: ' + cfg.top_k_kb} hint="Cuántas fichas del KB se inyectan">
            <input type="range" min={0} max={15} className="w-full" value={cfg.top_k_kb}
                   onChange={(e) => setCfg({ ...cfg, top_k_kb: Number(e.target.value) })} />
          </Field>
          <Field label={'Umbral del KB: ' + cfg.kb_min_similarity} hint="Similitud mínima para incluir una ficha">
            <input type="range" min={0} max={1} step={0.05} className="w-full" value={cfg.kb_min_similarity}
                   onChange={(e) => setCfg({ ...cfg, kb_min_similarity: Number(e.target.value) })} />
          </Field>
          <Field label={'Vueltas de herramienta: ' + cfg.max_tool_iterations}
                 hint="Intentos para corregir una consulta rechazada">
            <input type="range" min={1} max={8} className="w-full" value={cfg.max_tool_iterations}
                   onChange={(e) => setCfg({ ...cfg, max_tool_iterations: Number(e.target.value) })} />
          </Field>
          <Field label={'Filas máximas: ' + cfg.max_rows} hint="Tope por consulta">
            <input type="range" min={50} max={5000} step={50} className="w-full" value={cfg.max_rows}
                   onChange={(e) => setCfg({ ...cfg, max_rows: Number(e.target.value) })} />
          </Field>
        </div>

        <div className="grid gap-2 mt-4">
          <label className="flex items-start gap-2 text-[12px] cursor-pointer">
            <input type="checkbox" checked={cfg.cache_enabled} className="mt-0.5"
                   onChange={(e) => setCfg({ ...cfg, cache_enabled: e.target.checked })} />
            <span>
              <strong>Caché semántica</strong>
              <span style={{ color: 'var(--muted)' }}>
                {' '}— reutiliza la consulta validada de preguntas equivalentes y la vuelve a
                ejecutar. Nunca devuelve un número guardado.
              </span>
            </span>
          </label>
          {cfg.cache_enabled && (
            <Field label={'Umbral de la caché: ' + cfg.cache_min_similarity}
                   hint="Además del coseno, la pregunta debe traer exactamente los mismos literales (mes, año, umbrales). Sin esa segunda puerta, «cuántos conserjes» y «cuántos conserjes en marzo» se confunden.">
              <input type="range" min={0.8} max={0.99} step={0.01} className="w-full"
                     value={cfg.cache_min_similarity}
                     onChange={(e) => setCfg({ ...cfg, cache_min_similarity: Number(e.target.value) })} />
            </Field>
          )}
          <label className="flex items-start gap-2 text-[12px] cursor-pointer">
            <input type="checkbox" checked={cfg.allow_freeform_sql} className="mt-0.5"
                   onChange={(e) => setCfg({ ...cfg, allow_freeform_sql: e.target.checked })} />
            <span>
              <strong>SQL libre</strong>
              <span style={{ color: 'var(--muted)' }}>
                {' '}— permite consultas fuera de las herramientas fijas. Va validado por lint,
                plan de ejecución y RLS.
              </span>
            </span>
          </label>
        </div>

        <Field label="Instrucciones del sistema"
               hint="Vacío = instrucciones por defecto (incluyen las reglas de no inventar cifras y declarar siempre el periodo).">
          <textarea className="input mt-1" rows={4} value={cfg.system_prompt ?? ''}
                    placeholder="Deja vacío para usar las de fábrica"
                    onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })} />
        </Field>
      </Section>

      <Section title="Base de conocimiento"
               hint="Glosario de negocio y ejemplos pregunta→SQL. Aquí es donde el RAG vectorial sí aporta: significado, no filas.">
        <div className="grid gap-2 mb-4">
          <input className="input" placeholder="Título — p. ej. «Qué es LOSEP»"
                 value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} />
          <textarea className="input" rows={2} placeholder="Explicación en lenguaje llano"
                    value={kbBody} onChange={(e) => setKbBody(e.target.value)} />
          <textarea className="input font-mono text-[11.5px]" rows={2}
                    placeholder="SQL de ejemplo (opcional) — lo convierte en ejemplo pregunta→SQL"
                    value={kbSql} onChange={(e) => setKbSql(e.target.value)} />
          <button className="btn justify-self-start" onClick={addKb}
                  disabled={!kbTitle.trim() || !kbBody.trim()}>
            Añadir
          </button>
        </div>
        {!data?.kb.length ? (
          <Empty>Sin fichas todavía.</Empty>
        ) : (
          <ul className="grid gap-1.5">
            {data.kb.map((k: any) => (
              <li key={k.id} className="flex items-start gap-2 text-[12px] py-1.5"
                  style={{ borderTop: '1px solid var(--border)' }}>
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                  {k.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{k.title}</div>
                  <div style={{ color: 'var(--ink2)' }}>{k.content}</div>
                  {k.sql_text && (
                    <pre className="text-[10.5px] mt-1 p-1.5 rounded overflow-x-auto"
                         style={{ background: 'var(--plane)' }}>{k.sql_text}</pre>
                  )}
                  {!k.embedding && (
                    <div className="text-[10.5px] mt-1" style={{ color: 'var(--muted)' }}>
                      sin vector todavía — se generará al indexar
                    </div>
                  )}
                </div>
                <button className="text-[11px] hover:underline shrink-0"
                        style={{ color: 'var(--muted)' }} onClick={() => delKb(k.id)}>
                  eliminar
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Caché de preguntas"
               hint={n0(data?.cache.length ?? 0) + ' preguntas guardadas · ' + n0(hits) + ' reutilizaciones'}
               right={
                 data?.cache.length ? (
                   <button className="btn text-[12px] py-1" onClick={clearCache}>Vaciar</button>
                 ) : null
               }>
        {!data?.cache.length ? (
          <Empty>Todavía no hay preguntas guardadas.</Empty>
        ) : (
          <ul className="grid gap-1">
            {data.cache.map((c: any) => (
              <li key={c.id} className="text-[12px] py-1.5" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          background: c.status === 'validated' ? '#0ca30c' : 'var(--plane)',
                          color: c.status === 'validated' ? '#fff' : 'var(--muted)',
                        }}>
                    {c.status === 'validated' ? 'validada' : 'candidata'}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{c.question}</span>
                  <span className="tnum shrink-0" style={{ color: 'var(--muted)' }}>
                    {c.hit_count} usos
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
