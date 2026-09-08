# Desplegar ADIA en Cloudflare — paso a paso

Este documento asume que ya tienes un proyecto Supabase funcionando (migrado y,
si quieres, con datos cargados). Cloudflare solo sirve el frontend estático y la
función `/api/chat`; la base de datos y la lógica de negocio siguen viviendo en
Supabase, tal como describe `CLAUDE.md`.

**Importante — esto NO es Cloudflare Pages clásico.** El proyecto ya está
conectado (repo `Jdholguin19/ADIA-2`) y el dashboard de Cloudflare lo desplegó
usando `wrangler deploy` (el modelo unificado **Workers + assets**), no
`wrangler pages deploy`. Esto importa porque cambia dónde vive cada
configuración — lo explica el paso 5. `wrangler.jsonc` y
[src/server/chat/worker.ts](src/server/chat/worker.ts) ya están en el repo
para que esto funcione de forma reproducible en cada build, en vez de
depender de lo que Cloudflare auto-genera.

---

## 0. Antes de nada: revisa lo que vas a publicar

- [ ] **Contraseña por defecto en el código.** [scripts/load-file.mjs:22](scripts/load-file.mjs#L22)
  trae un *fallback* hardcodeado (`ADIA_ADMIN_PASSWORD || 'AdiaDemo2026!'`). Si el
  repo de GitHub va a ser público, cambia esa línea o al menos asegúrate de
  definir siempre `ADIA_ADMIN_PASSWORD` en tu `.env` para no depender del
  valor por defecto.
- [ ] Confirma que `.env` **no** está en el commit: `.gitignore` ya lo excluye,
  solo verifica con `git status` antes de hacer `git add`.

---

## 1. Repo en GitHub

Ya conectado: `origin` apunta a `https://github.com/Jdholguin19/ADIA-2.git` y
Cloudflare construye desde ahí en cada push a la rama que hayas configurado
como productiva en el dashboard. Antes de cada push que toque código, corre:

```bash
npm run build && npm run check:secrets
```

para no depender de los logs remotos si algo sale mal.

---

## 2. Confirma que el CSP apunta a tu proyecto Supabase

[public/_headers](public/_headers) trae la política de seguridad de contenido
con el dominio de Supabase **hardcodeado**:

```
connect-src 'self' https://atwkpmapaxtihrqfgfth.supabase.co wss://atwkpmapaxtihrqfgfth.supabase.co;
```

- [ ] Compara ese ref (`atwkpmapaxtihrqfgfth`) contra tu `VITE_SUPABASE_URL`
  en `.env`. Si es un proyecto Supabase distinto, edita ambas apariciones en
  `public/_headers` — si no coincide, el navegador bloqueará las llamadas a
  Supabase con un error de CSP y la app se verá "rota" sin ningún error obvio
  en la consola de red.

Este archivo se copia tal cual a `dist/` porque vive en `public/`.

---

## 3. Build settings en el dashboard de Cloudflare

**Workers & Pages** → el proyecto `adia` → **Settings** → **Build**:

| Campo | Valor |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

Variables de **build** (públicas, terminan en el bundle del navegador — deben
llevar prefijo `VITE_`), en **Settings → Variables and Secrets** o en la
pantalla de build:

| Nombre | Valor |
|---|---|
| `VITE_SUPABASE_URL` | el mismo valor que tienes en `.env` |
| `VITE_SUPABASE_ANON_KEY` | el mismo valor que tienes en `.env` |
| `VITE_APP_NOMBRE` | `ADIA` (o el nombre que uses) |
| `NODE_VERSION` | `20` |

---

## 4. El secreto de OpenAI — y dos variables más que se olvidan fácil

`src/server/chat/worker.ts` es el `main` del Worker: intercepta `/api/chat`
con el mismo `handler.ts` de siempre y delega todo lo demás al binding de
assets. Para que ese handler funcione necesita **tres** variables de entorno
en tiempo de ejecución — no solo la clave de OpenAI:

| Nombre | Tipo | Valor |
|---|---|---|
| `OPENAI_API_KEY` | **Secret** | tu clave `sk-...` |
| `SUPABASE_URL` | Variable de texto | el mismo valor que `VITE_SUPABASE_URL` (sin el prefijo `VITE_`) |
| `SUPABASE_ANON_KEY` | Variable de texto | el mismo valor que `VITE_SUPABASE_ANON_KEY` (sin el prefijo `VITE_`) |

Las dos últimas no son secretas — son las mismas que ya viajan al navegador
con el prefijo `VITE_` — pero el Worker no lee esas, necesita su propia copia
sin prefijo porque `VITE_*` solo existe en tiempo de build del frontend.
**Si solo configuras `OPENAI_API_KEY`, el chat responde 500** porque
`handler.ts` no puede armar el cliente de Supabase.

Dónde ponerlas: en el proyecto `adia` (aparece como Worker en el dashboard,
no como "Pages") → **Settings** → **Variables and Secrets** → **Add** una por
una, marcando `OPENAI_API_KEY` como **Secret** y las otras dos como texto
plano. Vuelve a desplegar después (**Deployments** → **Retry deployment**, o
un nuevo push) para que el Worker las recoja.

Por CLI, si prefieres no usar el dashboard:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

(`wrangler secret put` sirve tanto para secretos como para variables simples;
si quieres que `SUPABASE_URL`/`SUPABASE_ANON_KEY` queden como texto plano
visible en el dashboard en vez de ocultas, defínelas ahí en vez de por CLI.)

---

## 5. Por qué existe `wrangler.jsonc` — no lo borres

Sin un `wrangler.jsonc` comprometido en el repo, Cloudflare **auto-genera uno
efímero en cada build** que solo declara `assets` (sin `main`). Eso pasó en
el primer deploy real de este proyecto: el build terminó en verde, pero
`/api/chat` devolvía la SPA (`index.html`) en vez de ejecutar el chat, porque
sin `main` no hay Worker script — `functions/api/chat.ts` (la convención de
Cloudflare **Pages** Functions) nunca se ejecuta bajo `wrangler deploy`. El
log del build lo advertía al final:

```
Detected wrangler autoconfig generated changes to your project.
Please run 'npx wrangler setup' in your repo and commit the changes.
```

Ese autoconfig nunca se comprometía — cada build lo reinventaba desde cero.
El `wrangler.jsonc` que ya está en el repo fija `main: src/server/chat/worker.ts`
y `assets.not_found_handling: single-page-application` (el reemplazo, a nivel
de plataforma, del viejo `/*  /index.html  200` de `_redirects` — ese archivo
ahora está vacío de reglas a propósito, ver el comentario dentro de
[public/_redirects](public/_redirects)).

**`keep_vars: true` también está ahí a propósito.** Por defecto, `wrangler
deploy` borra cualquier variable de texto plano puesta a mano en el dashboard
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`) en **cada** deploy, porque trata el
archivo de config como fuente de verdad y sincroniza a lo que ese archivo
declara — nada, en nuestro caso, ya que no hay bloque `vars`. Los *secrets*
(`OPENAI_API_KEY`, `SUPABASE_BD_PASSWORD`) no se ven afectados; solo las
variables planas. Sin `keep_vars: true`, cada push nuevo revive el error
`"Invalid URL: undefined/rest/v1/..."` aunque las variables sigan visibles en
el dashboard — porque el deploy las borra y las vuelve a mostrar vacías/las
quita silenciosamente, no porque tú hayas hecho algo mal.

---

## 6. Verificar el deploy

Con la URL que te da Cloudflare (`https://adia.<tu-cuenta>.workers.dev`, o tu
dominio propio si ya lo configuraste):

- [ ] Carga la app y confirma que el login funciona.
- [ ] Abre el tablero de un dataset y confirma que los KPIs cargan (valida
  `VITE_SUPABASE_URL`/`ANON_KEY` y el CSP).
- [ ] Haz una pregunta en el chat y confirma que responde con streaming
  (valida las tres variables del paso 4).
- [ ] Prueba rápida por terminal, sin abrir el navegador — un `GET` a
  `/api/chat` debe dar `404`/`405` (lo maneja el handler), **nunca** un
  `307` a `/spa` o un `200` con HTML: eso significaría que el Worker no está
  interceptando la ruta y volvió a caer en el binding de assets.

  ```bash
  curl -i https://adia.<tu-cuenta>.workers.dev/api/chat
  ```
- [ ] Pestaña **Network** del navegador: no debe haber ninguna llamada
  directa a `api.openai.com` desde el cliente — el CSP la bloquea a
  propósito; toda IA pasa por `/api/chat`.

Si el chat da 500: **Deployments → Logs** (o `npx wrangler tail`) en el
dashboard para ver el error real — falta alguna de las tres variables del
paso 4 es la causa más común.

---

## 7. Despliegues siguientes

Cada `git push` a la rama productiva dispara build + deploy automático.

Deploy manual sin esperar al push:

```bash
npm run deploy          # npm run build && wrangler deploy
```

---

## 8. Dominio propio (opcional)

**Workers & Pages** → tu proyecto → **Custom domains** → **Set up a custom
domain**. Si el dominio ya está en Cloudflare, el certificado y el DNS se
configuran solos.

---

## Notas que no dependen de Cloudflare

- `npm run migrate` — aplica el esquema contra Supabase de producción.
  Necesita `SUPABASE_BD_PASSWORD` en el `.env` local, no en Cloudflare.
- `npm run kb` — siembra glosario y ejemplos pregunta→SQL. Sin esto el
  copiloto arranca sin contexto de negocio.
- Si en vez de (o además de) `worker.ts` quieres la Edge Function de
  Supabase, la sección "Desplegar → Función Edge del chat" del
  [README.md](README.md#desplegar) tiene esos comandos. Después de tocar
  `src/server/chat/handler.ts`, sincroniza la copia Deno con
  `cp src/server/chat/handler.ts supabase/functions/_shared/handler.ts` —
  `worker.ts` y `functions/api/chat.ts` importan el original directamente, así
  que esos dos nunca se desincronizan.
