// Manejador del chat. Web APIs puras (fetch, Request, Response, streams) y
// cero dependencias, para que el MISMO fichero corra en Deno (Supabase Edge
// Function), en Workers (Cloudflare Pages Function) y en el dev server de
// Vite. La OPENAI_API_KEY se lee de env y NUNCA sale hacia el navegador.
//
// Arquitectura: NO es un RAG sobre filas. Es un agente texto-a-SQL con el
// prompt aumentado por recuperacion. Los vectores indexan significado
// (valores reales, glosario, preguntas anteriores); los NUMEROS salen
// siempre de SQL ejecutado en el momento contra Postgres.

export interface ChatEnv {
  OPENAI_API_KEY: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
}

export interface ChatRequest {
  dataset_id: number
  session_id?: number | null
  message: string
  client_msg_id?: string
  stream?: boolean
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

/* ------------------------------------------------------------------ */
/* Literales: la puerta dura de la cache semantica                     */
/* ------------------------------------------------------------------ */

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

/**
 * Extrae los literales que fijan el ALCANCE de una pregunta.
 *
 * Sin esto, la cache semantica es una fabrica de numeros equivocados:
 * "cuantos conserjes tengo" y "cuantos conserjes tenia en marzo de 2016"
 * se parecen ~0.94 en coseno. Con umbral 0.93 hay acierto, se reejecuta el
 * SQL guardado y sale una cifra CORRECTA DEL PERIODO EQUIVOCADO, que nadie
 * detecta. Reejecutar protege del dato rancio, no del parametro rancio.
 */
export function extractLiterals(q: string): string[] {
  const s = ' ' + q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' '
  const out = new Set<string>()

  for (const m of s.matchAll(/\b(19|20)\d{2}\b/g)) out.add(`year:${m[0]}`)
  for (const [name, n] of Object.entries(MESES)) {
    if (new RegExp(`\\b${name}\\b`).test(s)) out.add(`month:${n}`)
  }
  // Importes y cantidades: se normaliza para que "5000", "5.000" y "$5,000"
  // cuenten como el mismo literal.
  for (const m of s.matchAll(/\$?\s?\b\d[\d.,]*\b/g)) {
    const raw = m[0].replace(/[\s$]/g, '')
    if (/^(19|20)\d{2}$/.test(raw)) continue
    const norm = raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')
    const num = Number(norm)
    if (Number.isFinite(num)) out.add(`num:${num}`)
  }
  for (const m of s.matchAll(/["'“”']([^"'“”']{2,60})["'“”']/g)) out.add(`txt:${m[1].trim()}`)
  for (const w of ['mayor', 'menor', 'mas de', 'menos de', 'entre', 'promedio', 'total',
                   'top', 'ultimo', 'primer', 'historico', 'todos los periodos']) {
    if (s.includes(' ' + w)) out.add(`op:${w}`)
  }
  return [...out].sort()
}

const sameLiterals = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/* ------------------------------------------------------------------ */
/* Supabase RPC con el JWT del usuario (la RLS le acompana)            */
/* ------------------------------------------------------------------ */

async function rpc<T = unknown>(env: ChatEnv, jwt: string, fn: string, args: unknown): Promise<T> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`rpc ${fn}: ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : (null as T)
}

async function embed(env: ChatEnv, model: string, input: string): Promise<number[]> {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, input }),
  })
  const j = await r.json()
  if (j.error) throw new Error(`embeddings: ${j.error.message}`)
  return j.data[0].embedding
}


/**
 * Llamada a OpenAI que se cura sola.
 *
 * Los modelos de razonamiento rechazan parametros que otros aceptan (p. ej.
 * gpt-5.5 solo admite temperature=1). En vez de mantener una tabla por
 * modelo que envejece con cada lanzamiento, se lee el error, se quita el
 * parametro que sobra y se reintenta.
 */
async function openai(env: ChatEnv, payload: Record<string, any>, tries = 3): Promise<any> {
  let body = { ...payload }
  for (let i = 0; i < tries; i++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    })
    if (body.stream && r.ok) return r
    const j = await r.json()
    if (!j.error) return j
    const m = /Unsupported (?:value|parameter): '([a-z_]+)'/i.exec(j.error.message || '')
    if (m && m[1] in body) { delete body[m[1]]; continue }
    throw new Error(`openai: ${j.error.message}`)
  }
  throw new Error('openai: no se pudo completar la peticion')
}

/* ------------------------------------------------------------------ */
/* Herramientas                                                        */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_sql',
      description:
        'Ejecuta UNA consulta SELECT de solo lectura sobre la tabla del dataset y devuelve las filas. ' +
        'Es la unica forma de obtener cifras. Si la consulta se rechaza, el motivo explica como corregirla.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Una sola sentencia SELECT (o WITH ... SELECT).' },
        },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_values',
      description:
        'Busca como se escriben REALMENTE los valores de una columna. Usala SIEMPRE antes de filtrar ' +
        'por un texto que venga de la pregunta: la tabla puede decir "CONSERJE" y existir ademas ' +
        '"CONSERJE 1" y "CONSERJE VOLANTE".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto a buscar, tal cual lo dijo el usuario.' },
          column: { type: 'string', description: 'Columna donde buscar (opcional).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_periods',
      description: 'Lista los periodos disponibles y cual es el vigente por defecto.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_alerts',
      description: 'Devuelve las alertas de calidad y riesgo detectadas en el dataset.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

const SYSTEM_BASE = `Eres ADIA, analista de datos. Respondes en espanol, con precision y sin adornos.

REGLAS QUE NO PUEDES ROMPER
1. NUNCA calcules ni estimes una cifra tu mismo. Todo numero de tu respuesta tiene que
   venir de un resultado de herramienta. Si una consulta no devolvio filas, dilo; no deduzcas.
2. DI SIEMPRE a que periodo corresponden las cifras. En un panel mensual, un numero sin
   periodo no significa nada.
3. Antes de filtrar por un texto que venga de la pregunta, usa lookup_values para ver como
   se escribe de verdad, y agrupa las variantes si procede (dilo cuando lo hagas).
4. Si run_sql rechaza tu consulta, LEE el motivo y corrigela: suele decirte exactamente que
   falta. Tienes varios intentos.
5. Se breve. Da la cifra, su alcance y como maximo una o dos observaciones utiles.
   Si una advertencia del resultado afecta a la lectura del numero, mencionala.`

/* ------------------------------------------------------------------ */

function sse(obj: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`)
}

export async function handleChat(req: Request, env: ChatEnv): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS })

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) {
    return new Response(JSON.stringify({ error: 'Falta la sesion' }), {
      status: 401, headers: { ...CORS, 'content-type': 'application/json' },
    })
  }

  let body: ChatRequest
  try { body = await req.json() } catch {
    return new Response(JSON.stringify({ error: 'JSON invalido' }), {
      status: 400, headers: { ...CORS, 'content-type': 'application/json' },
    })
  }
  if (!body?.dataset_id || !body?.message?.trim()) {
    return new Response(JSON.stringify({ error: 'Faltan dataset_id o message' }), {
      status: 400, headers: { ...CORS, 'content-type': 'application/json' },
    })
  }

  const stream = new TransformStream()
  const w = stream.writable.getWriter()
  const send = (o: unknown) => w.write(sse(o)).catch(() => {})

  ;(async () => {
    const t0 = Date.now()
    try {
      // -------- configuracion --------
      const cfgRows = await fetch(
        `${env.SUPABASE_URL}/rest/v1/assistant_configs?select=*&order=dataset_id.desc.nullslast&limit=1`,
        { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } },
      ).then((r) => r.json())
      const cfg = (Array.isArray(cfgRows) && cfgRows[0]) || {}
      const sqlModel = cfg.sql_model || 'gpt-5.4-mini'
      const embModel = cfg.embed_model || 'text-embedding-3-small'
      const maxIter = cfg.max_tool_iterations ?? 4
      const maxRows = cfg.max_rows ?? 500
      const cacheOn = cfg.cache_enabled ?? true
      const cacheMin = Number(cfg.cache_min_similarity ?? 0.93)
      const kbK = cfg.top_k_kb ?? 5
      const kbMin = Number(cfg.kb_min_similarity ?? 0.25)
      const temperature = Number(cfg.temperature ?? 0)

      const literals = extractLiterals(body.message)

      send({ t: 'status', stage: 'embedding' })
      const emb = await embed(env, embModel, body.message)

      // -------- cache semantica --------
      let cacheHit: any = null
      if (cacheOn) {
        send({ t: 'status', stage: 'cache' })
        const cands: any[] = await rpc(env, jwt, 'match_cached_question', {
          p_dataset_id: body.dataset_id, p_embedding: emb as any,
          p_min_sim: cacheMin, p_literals: [],
        })
        // La puerta dura: mismos literales exactamente. Si la pregunta trae
        // un mes, un anio o un umbral distinto, es OTRA pregunta aunque el
        // coseno diga 0.95.
        cacheHit = (cands || []).find((c) =>
          sameLiterals(literals, (c.param_schema?.literals as string[]) || [])) || null
      }

      if (cacheHit) {
        send({ t: 'cache', hit: true, similarity: Number(cacheHit.similarity),
               cached_question: cacheHit.question })
        send({ t: 'status', stage: 'sql' })
        const res: any = await rpc(env, jwt, 'exec_analysis_sql', {
          p_dataset_id: body.dataset_id, p_sql: cacheHit.sql_template,
          p_params: {}, p_max_rows: maxRows, p_question: body.message,
        })
        if (res?.ok) {
          // Se reejecuta el SQL, nunca se sirve un numero guardado.
          send({ t: 'sql', sql: cacheHit.sql_template, source: 'cache',
                 warnings: res.warnings || [] })
          send({ t: 'result', rows: res.rows, row_count: res.row_count,
                 truncated: res.truncated, elapsed_ms: res.elapsed_ms })
          await rpc(env, jwt, 'touch_query_cache', { p_id: cacheHit.id, p_promote: false })
          const txt = cacheHit.answer_template ||
            'Reutilizo la consulta ya validada para esta pregunta y la vuelvo a ejecutar sobre los datos actuales.'
          send({ t: 'delta', text: txt })
          send({ t: 'done', cached: true, latency_ms: Date.now() - t0 })
          await w.close(); return
        }
        // Si la consulta cacheada ya no vale, se sigue por el camino normal.
        cacheHit = null
      }
      if (cacheOn) send({ t: 'cache', hit: false })

      // -------- contexto + recuperacion --------
      send({ t: 'status', stage: 'retrieving' })
      const ctx: string = await rpc(env, jwt, 'dataset_context', { p_dataset_id: body.dataset_id })
      let kb: any[] = []
      try {
        kb = await rpc(env, jwt, 'match_kb', {
          p_dataset_id: body.dataset_id, p_embedding: emb as any,
          p_limit: kbK, p_min_sim: kbMin,
        })
      } catch { kb = [] }

      const kbBlock = (kb || []).length
        ? '\n\nCONOCIMIENTO RELEVANTE\n' + kb.map((k) =>
            `- ${k.title}: ${k.content}${k.sql_text ? `\n  SQL: ${k.sql_text}` : ''}`).join('\n')
        : ''

      const messages: any[] = [
        { role: 'system', content: `${cfg.system_prompt || SYSTEM_BASE}\n\n${ctx}${kbBlock}` },
        { role: 'user', content: body.message },
      ]

      // -------- bucle de herramientas --------
      let lastSql: string | null = null
      let lastWarnings: string[] = []
      let usedTool = false

      // Guardar la consulta validada. Se define aqui porque hay DOS salidas
      // del bucle (el modelo responde sin pedir mas herramientas, o se agotan
      // las vueltas) y la primera es, con diferencia, la mas frecuente: si
      // solo se guardase en la segunda, la cache no se llenaria nunca.
      const saveCache = async (answer: string) => {
        if (!usedTool || !lastSql) return
        try {
          await rpc(env, jwt, 'save_query_cache', {
            p_dataset_id: body.dataset_id,
            p_question: body.message,
            p_embedding: emb as any,
            p_sql_template: lastSql,
            p_param_schema: { literals },
            p_answer_template: answer.slice(0, 2000) || null,
          })
        } catch { /* la cache es un extra: nunca debe tumbar la respuesta */ }
      }

      send({ t: 'status', stage: 'planning' })
      for (let i = 0; i < maxIter; i++) {
        const j = await openai(env, { model: sqlModel, messages, tools: TOOLS, temperature })
        const msg = j.choices[0].message
        messages.push(msg)

        if (!msg.tool_calls?.length) {
          if (msg.content) send({ t: 'delta', text: msg.content })
          await saveCache(msg.content ?? '')
          send({ t: 'done', cached: false, latency_ms: Date.now() - t0 })
          await w.close(); return
        }

        usedTool = true
        for (const call of msg.tool_calls) {
          const name = call.function.name
          let args: any = {}
          try { args = JSON.parse(call.function.arguments || '{}') } catch {}
          let out: any

          if (name === 'run_sql') {
            send({ t: 'status', stage: 'sql', detail: args.sql })
            out = await rpc(env, jwt, 'exec_analysis_sql', {
              p_dataset_id: body.dataset_id, p_sql: args.sql, p_params: {},
              p_max_rows: maxRows, p_question: body.message,
            })
            if (out?.ok) {
              lastSql = args.sql
              lastWarnings = out.warnings || []
              send({ t: 'sql', sql: args.sql, source: 'generated', warnings: lastWarnings })
              send({ t: 'result', rows: out.rows, row_count: out.row_count,
                     truncated: out.truncated, elapsed_ms: out.elapsed_ms })
            } else {
              // El error vuelve al modelo como resultado de herramienta: de
              // esta reparacion sale la mayor parte de la precision real.
              send({ t: 'status', stage: 'sql', detail: 'consulta rechazada, corrigiendo' })
            }
          } else if (name === 'lookup_values') {
            out = await rpc(env, jwt, 'match_values', {
              p_dataset_id: body.dataset_id, p_query: args.query,
              p_column: args.column ?? null, p_limit: 12,
            })
          } else if (name === 'list_periods') {
            out = await rpc(env, jwt, 'tool_periods', { p_dataset_id: body.dataset_id })
          } else if (name === 'get_alerts') {
            out = await fetch(
              `${env.SUPABASE_URL}/rest/v1/dataset_alerts?dataset_id=eq.${body.dataset_id}` +
              `&select=severity,code,title,detail,metric,impact&order=severity`,
              { headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}` } },
            ).then((x) => x.json())
          } else {
            out = { ok: false, error: `herramienta desconocida: ${name}` }
          }

          messages.push({
            role: 'tool', tool_call_id: call.id, name,
            content: JSON.stringify(out).slice(0, 60000),
          })
        }
      }

      // Se agotaron las vueltas: se fuerza una respuesta en texto, en
      // streaming real, con tool_choice none.
      send({ t: 'status', stage: 'answering' })
      const fin: Response = await openai(env, {
        model: sqlModel, messages, tool_choice: 'none', temperature, stream: true,
      })
      const reader = fin.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let full = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() || ''
        for (const p of parts) {
          const line = p.replace(/^data:\s*/, '').trim()
          if (!line || line === '[DONE]') continue
          try {
            const d = JSON.parse(line)
            const t = d.choices?.[0]?.delta?.content
            if (t) { full += t; send({ t: 'delta', text: t }) }
          } catch {}
        }
      }

      await saveCache(full)
      send({ t: 'done', cached: false, latency_ms: Date.now() - t0 })
      await w.close()
    } catch (e: any) {
      send({ t: 'error', code: 'CHAT_ERROR', message: String(e?.message || e).slice(0, 400) })
      await w.close().catch(() => {})
    }
  })()

  return new Response(stream.readable, {
    headers: {
      ...CORS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
}
