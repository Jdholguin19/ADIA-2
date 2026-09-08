// Ejecuta el manejador del chat dentro del dev server de Vite.
//
// Asi la app funciona de punta a punta en local SIN desplegar nada: la
// OPENAI_API_KEY se queda en el proceso de node (jamas en el bundle) y el
// front habla con /api/chat igual que hablara en produccion. El mismo
// handler.ts se despliega despues como Edge Function sin tocar una linea.
import type { Plugin, Connect } from 'vite'
import { Readable } from 'node:stream'

export function chatDevPlugin(): Plugin {
  return {
    name: 'adia-chat-dev',
    configureServer(server) {
      const mw: Connect.NextHandleFunction = async (req, res, next) => {
        if (!req.url?.startsWith('/api/chat')) return next()
        try {
          const { handleChat } = await server.ssrLoadModule('/src/server/chat/handler.ts')

          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method,
            headers: req.headers as any,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          })

          const env = {
            OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
            SUPABASE_URL: process.env.VITE_SUPABASE_URL!,
            SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY!,
          }
          if (!env.OPENAI_API_KEY) {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'Falta OPENAI_API_KEY en .env' }))
            return
          }

          const response: Response = await handleChat(request, env)
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v))
          if (response.body) Readable.fromWeb(response.body as any).pipe(res)
          else res.end()
        } catch (e: any) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      }
      server.middlewares.use(mw)
    },
  }
}
