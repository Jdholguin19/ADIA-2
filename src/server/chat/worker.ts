// Adaptador Cloudflare Workers (modelo "assets + main", no Pages clasico).
//
// El deploy de este proyecto en Cloudflare corre `wrangler deploy`, no
// `wrangler pages deploy`: por eso `functions/api/chat.ts` (la convencion de
// Pages Functions) nunca se ejecuta y `/api/chat` caia en el binding de
// assets, que lo trataba como ruta de SPA. Este archivo es el `main` del
// Worker: intercepta /api/chat con el mismo handler.ts de siempre y delega
// todo lo demas al binding ASSETS (estaticos + `not_found_handling` para el
// enrutado del cliente).
import { handleChat, type ChatEnv } from './handler'

interface WorkerEnv extends ChatEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/chat') return handleChat(request, env)
    return env.ASSETS.fetch(request)
  },
}
