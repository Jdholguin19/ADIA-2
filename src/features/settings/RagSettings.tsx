import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { Empty, Modal, Section, SubTabs, Spinner } from '../../components/ui'
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

type Panel = 'modelo' | 'kb' | 'cache'

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode
}) {
  // min-w-0: sin el, un control con ancho intrinseco grande estira su
  // columna del grid y desborda la tarjeta hacia la derecha.
  return (
    <label className="block min-w-0">
      <div className="text-[12px] font-medium">{label}</div>
      {hint && <div className="text-[11px] mb-1.5" style={{ color: 'var(--muted)' }}>{hint}</div>}
      {children}
    </label>
  )
}

function Slider(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" {...props} className="w-full max-w-sm block" />
}

export function RagSettings() {
  const { id } = useParams()
  const dsId = Number(id)
  const qc = useQueryClient()
  const [panel, setPanel] = useState<Panel>('modelo')
  const [cfg, setCfg] = useState<any>(DEF)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [kbOpen, setKbOpen] = useState(false)
  const [kbTitle, setKbTitle] = useState('')
  const [kbBody, setKbBody] = useState('')
  const [kbSql, setKbSql] = useState('')
  const [busy, setBusy] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['rag', dsId],
    queryFn: async () => {
      const [c, kb, cache] = await Promise.all([
        // Solo la config de ESTE dataset o la global. Sin el filtro se
        // cargaba la de otro dataset y al guardar se le reasignaba el
        // dataset_id, secuestrandola en silencio.
        supabase.from('assistant_configs').select('*')
          .or('dataset_id.eq.' + dsId + ',dataset_id.is.null')
          .order('dataset_id', { ascending: false, nullsFirst: false }).limit(1),
        supabase.from('kb_documents').select('*')
          .or('dataset_id.eq.' + dsId + ',dataset_id.is.null')
          .order('created_at', { ascending: false }).limit(50),
        supabase.from('query_cache').select('id,question,status,hit_count,last_used_at,sql_template')
          .eq('dataset_id', dsId).order('hit_count', { ascending: false }).limit(50),
      ])
      return { cfg: c.data?.[0] ?? null, kb: kb.data ?? [], cache: cache.data ?? [] }
    },
  })

  useEffect(() => { if (data?.cfg) setCfg({ ...DEF, ...data.cfg }) }, [data?.cfg])

  async function save() {
    // Lista explicita de columnas editables. Antes se hacia spread de todo
    // cfg, que arrastraba el id devuelto por el SELECT; como id es GENERATED
    // ALWAYS, el PATCH moria con 428C9 ("column id can only be updated to
    // DEFAULT"). Enumerar tambien evita mandar owner_id o created_at, y no
    // se rompe cuando la tabla gane columnas nuevas.
    const row = {
      dataset_id: dsId,
      sql_model: cfg.sql_model,
      fast_model: cfg.fast_model,
      embed_model: cfg.embed_model,
      temperature: cfg.temperature,
      top_k_kb: cfg.top_k_kb,
      kb_min_similarity: cfg.kb_min_similarity,
      cache_enabled: cfg.cache_enabled,
      cache_min_similarity: cfg.cache_min_similarity,
      max_tool_iterations: cfg.max_tool_iterations,
      max_rows: cfg.max_rows,
      allow_freeform_sql: cfg.allow_freeform_sql,
      system_prompt: cfg.system_prompt?.trim() ? cfg.system_prompt : null,
      updated_at: new Date().toISOString(),
    }
    setErr(null)
    const { error } = cfg.id
      ? await supabase.from('assistant_configs').update(row).eq('id', cfg.id)
      : await supabase.from('assistant_configs').insert(row)
    // Un guardado fallido se veia igual que no hacer nada: el error solo
    // salia por consola.
    if (error) { setErr(error.message); return }
    setSaved(true); setTimeout(() => setSaved(false), 2000)
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function addKb() {
    if (!kbTitle.trim() || !kbBody.trim()) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('kb_documents').insert({
      dataset_id: dsId,
      kind: kbSql.trim() ? 'sql_exemplar' : 'glossary',
      title: kbTitle, content: kbBody, sql_text: kbSql.trim() || null,
    })
    setBusy(false)
    // El modal sigue abierto si falla: cerrarlo perderia lo escrito.
    if (error) { setErr(error.message); return }
    setKbTitle(''); setKbBody(''); setKbSql('')
    setKbOpen(false)
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function delKb(kid: number) {
    setErr(null)
    const { error } = await supabase.from('kb_documents').delete().eq('id', kid)
    if (error) { setErr(error.message); return }
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  async function clearCache() {
    if (!confirm('¿Vaciar la caché de preguntas de este dataset?')) return
    setErr(null)
    const { error } = await supabase.from('query_cache').delete().eq('dataset_id', dsId)
    if (error) { setErr(error.message); return }
    qc.invalidateQueries({ queryKey: ['rag', dsId] })
  }

  if (isLoading) return <Spinner label="Cargando configuración…" />

  const hits = (data?.cache ?? []).reduce((s, c: any) => s + (c.hit_count ?? 0), 0)

  return (
    // Ancho de lectura acotado y min-w-0 para que nada empuje la tarjeta
    // fuera de la pantalla. El tablero sí usa todo el ancho; un formulario no.
    <div className="grid gap-4 w-full max-w-4xl mx-auto min-w-0">
      <SubTabs<Panel>
        value={panel}
        onChange={setPanel}
        tabs={[
          { id: 'modelo', label: 'Modelo y recuperación' },
          { id: 'kb', label: 'Base de conocimiento', badge: n0(data?.kb.length ?? 0) },
          { id: 'cache', label: 'Caché de preguntas', badge: n0(data?.cache.length ?? 0) },
        ]}
      />

      {err && !kbOpen && (
        <div className="card p-3 text-[12.5px] flex items-start gap-2"
             style={{ borderColor: '#d03b3b', color: '#d03b3b' }}>
          <span className="min-w-0 flex-1 break-words">No se pudo guardar: {err}</span>
          <button onClick={() => setErr(null)} aria-label="Cerrar aviso"
                  className="shrink-0 leading-none px-1">×</button>
        </div>
      )}

      {panel === 'modelo' && (
        <Section
          title="Modelo y recuperación"
          hint="Afecta a cómo responde el copiloto. Los cambios se aplican en la siguiente pregunta."
          right={
            <button className="btn btn-primary text-[12px] py-1" onClick={save}>
              {saved ? 'Guardado ✓' : 'Guardar'}
            </button>
          }
        >
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
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
            <Field label={'Temperatura: ' + cfg.temperature}
                   hint="0 para cifras. Subirla añade variación, no criterio.">
              <Slider min={0} max={1} step={0.1} value={cfg.temperature}
                      onChange={(e) => setCfg({ ...cfg, temperature: Number(e.target.value) })} />
            </Field>
            <Field label={'Documentos de contexto: ' + cfg.top_k_kb}
                   hint="Cuántas fichas del KB se inyectan">
              <Slider min={0} max={15} value={cfg.top_k_kb}
                      onChange={(e) => setCfg({ ...cfg, top_k_kb: Number(e.target.value) })} />
            </Field>
            <Field label={'Umbral del KB: ' + cfg.kb_min_similarity}
                   hint="Similitud mínima para incluir una ficha">
              <Slider min={0} max={1} step={0.05} value={cfg.kb_min_similarity}
                      onChange={(e) => setCfg({ ...cfg, kb_min_similarity: Number(e.target.value) })} />
            </Field>
            <Field label={'Vueltas de herramienta: ' + cfg.max_tool_iterations}
                   hint="Intentos para corregir una consulta rechazada">
              <Slider min={1} max={8} value={cfg.max_tool_iterations}
                      onChange={(e) => setCfg({ ...cfg, max_tool_iterations: Number(e.target.value) })} />
            </Field>
            <Field label={'Filas máximas: ' + cfg.max_rows} hint="Tope por consulta">
              <Slider min={50} max={5000} step={50} value={cfg.max_rows}
                      onChange={(e) => setCfg({ ...cfg, max_rows: Number(e.target.value) })} />
            </Field>
          </div>

          <div className="grid gap-3 mt-5 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <label className="flex items-start gap-2 text-[12px] cursor-pointer">
              <input type="checkbox" checked={cfg.cache_enabled} className="mt-0.5 shrink-0"
                     onChange={(e) => setCfg({ ...cfg, cache_enabled: e.target.checked })} />
              <span className="min-w-0">
                <strong>Caché semántica</strong>
                <span style={{ color: 'var(--muted)' }}>
                  {' '}— reutiliza la consulta validada de preguntas equivalentes y la vuelve a
                  ejecutar. Nunca devuelve un número guardado.
                </span>
              </span>
            </label>
            {cfg.cache_enabled && (
              <div className="pl-6">
                <Field label={'Umbral de la caché: ' + cfg.cache_min_similarity}
                       hint="Además del coseno, la pregunta debe traer exactamente los mismos literales (mes, año, umbrales). Sin esa segunda puerta, «cuántos conserjes» y «cuántos conserjes en marzo» se confunden.">
                  <Slider min={0.8} max={0.99} step={0.01} value={cfg.cache_min_similarity}
                          onChange={(e) => setCfg({ ...cfg, cache_min_similarity: Number(e.target.value) })} />
                </Field>
              </div>
            )}
            <label className="flex items-start gap-2 text-[12px] cursor-pointer">
              <input type="checkbox" checked={cfg.allow_freeform_sql} className="mt-0.5 shrink-0"
                     onChange={(e) => setCfg({ ...cfg, allow_freeform_sql: e.target.checked })} />
              <span className="min-w-0">
                <strong>SQL libre</strong>
                <span style={{ color: 'var(--muted)' }}>
                  {' '}— permite consultas fuera de las herramientas fijas. Va validado por lint,
                  plan de ejecución y RLS.
                </span>
              </span>
            </label>
          </div>

          <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <Field label="Instrucciones del sistema"
                   hint="Vacío = instrucciones por defecto (incluyen las reglas de no inventar cifras y declarar siempre el periodo).">
              <textarea className="input mt-1" rows={4} value={cfg.system_prompt ?? ''}
                        placeholder="Deja vacío para usar las de fábrica"
                        onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })} />
            </Field>
          </div>
        </Section>
      )}

      {panel === 'kb' && (
        <Section
          title="Base de conocimiento"
          hint="Glosario de negocio y ejemplos pregunta→SQL. Aquí es donde el RAG vectorial sí aporta: significado, no filas."
          right={
            <button className="btn btn-primary text-[12px] py-1" onClick={() => setKbOpen(true)}>
              Añadir ficha
            </button>
          }
        >
          {!data?.kb.length ? (
            <Empty>Sin fichas todavía.</Empty>
          ) : (
            <ul className="grid gap-1.5">
              {data.kb.map((k: any) => (
                <li key={k.id} className="text-[12px] py-2 min-w-0"
                    style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: 'var(--plane)', color: 'var(--muted)' }}>
                      {k.kind === 'sql_exemplar' ? 'ejemplo' : k.kind}
                    </span>
                    <div className="min-w-0 flex-1">
                      {/* "eliminar" junto al titulo: al final de la fila
                          aplastaba el texto en pantallas estrechas. */}
                      <div className="flex items-start gap-2">
                        <div className="font-medium min-w-0 flex-1 break-words">{k.title}</div>
                        <button className="text-[11px] hover:underline shrink-0"
                                style={{ color: 'var(--muted)' }} onClick={() => delKb(k.id)}>
                          eliminar
                        </button>
                      </div>
                      <div className="break-words" style={{ color: 'var(--ink2)' }}>{k.content}</div>
                      {k.sql_text && (
                        <pre className="text-[10.5px] mt-1 p-1.5 rounded overflow-x-auto max-w-full"
                             style={{ background: 'var(--plane)' }}>{k.sql_text}</pre>
                      )}
                      {!k.embedding && (
                        <div className="text-[10.5px] mt-1" style={{ color: 'var(--muted)' }}>
                          sin vector todavía — se generará al indexar
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {panel === 'cache' && (
        <Section
          title="Caché de preguntas"
          hint={n0(data?.cache.length ?? 0) + ' preguntas guardadas · ' + n0(hits) + ' reutilizaciones'}
          right={
            data?.cache.length ? (
              <button className="btn text-[12px] py-1" onClick={clearCache}>Vaciar</button>
            ) : null
          }
        >
          {!data?.cache.length ? (
            <Empty>Todavía no hay preguntas guardadas.</Empty>
          ) : (
            <ul className="grid gap-1">
              {data.cache.map((c: any) => (
                <li key={c.id} className="text-[12px] py-1.5 min-w-0"
                    style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                          style={{
                            background: c.status === 'validated' ? '#0ca30c' : 'var(--plane)',
                            color: c.status === 'validated' ? '#fff' : 'var(--muted)',
                          }}>
                      {c.status === 'validated' ? 'validada' : 'candidata'}
                    </span>
                    <span className="flex-1 min-w-[12rem] truncate">{c.question}</span>
                    <span className="tnum shrink-0 ml-auto" style={{ color: 'var(--muted)' }}>
                      {c.hit_count} usos
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Modal
        open={kbOpen}
        title="Nueva ficha de conocimiento"
        hint="Si añades un SQL de ejemplo, se guarda como ejemplo pregunta→SQL; si no, como glosario."
        onClose={() => setKbOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setKbOpen(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={addKb}
                    disabled={busy || !kbTitle.trim() || !kbBody.trim()}>
              {busy ? 'Guardando…' : 'Añadir'}
            </button>
          </>
        }
      >
        <div className="grid gap-3">
          {err && (
            <div className="text-[12px] px-3 py-2 rounded-lg break-words"
                 style={{ color: '#d03b3b', background: 'color-mix(in srgb, #d03b3b 12%, transparent)' }}>
              {err}
            </div>
          )}
          <Field label="Título" hint="Cómo lo preguntaría alguien — p. ej. «Qué es LOSEP»">
            <input className="input" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} />
          </Field>
          <Field label="Explicación" hint="En lenguaje llano; es lo que se embebe junto al título.">
            <textarea className="input" rows={3} value={kbBody}
                      onChange={(e) => setKbBody(e.target.value)} />
          </Field>
          <Field label="SQL de ejemplo (opcional)"
                 hint="Consulta la tabla del dataset, no una genérica.">
            <textarea className="input font-mono text-[11.5px]" rows={3} value={kbSql}
                      onChange={(e) => setKbSql(e.target.value)} />
          </Field>
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
            La ficha se guarda sin vector: ejecuta <code>npm run kb</code> para indexarla, o se
            indexará en la próxima pasada.
          </p>
        </div>
      </Modal>
    </div>
  )
}
