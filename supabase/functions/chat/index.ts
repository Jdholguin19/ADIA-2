// Adaptador Deno para Supabase Edge Functions.
// Toda la logica vive en el manejador compartido; esto solo traduce el
// entorno. Despliegue:  supabase functions deploy chat --no-verify-jwt
//   (la verificacion la hace la propia RLS con el JWT del usuario)
// Secreto:  supabase secrets set OPENAI_API_KEY=sk-...
import { handleChat } from '../_shared/handler.ts'

Deno.serve((req: Request) =>
  handleChat(req, {
    OPENAI_API_KEY: Deno.env.get('OPENAI_API_KEY')!,
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
  }),
)
