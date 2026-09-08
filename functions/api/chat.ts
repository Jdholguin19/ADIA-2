// Adaptador Cloudflare Pages Functions.
// Alternativa si no se despliega la Edge Function de Supabase: la clave
// vive como secreto de Pages y se despliega con el propio frontend.
import { handleChat, type ChatEnv } from '../../src/server/chat/handler'

export const onRequest: PagesFunction<ChatEnv> = (ctx) => handleChat(ctx.request, ctx.env)
