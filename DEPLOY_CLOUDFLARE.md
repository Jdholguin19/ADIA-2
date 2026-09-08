# Desplegar ADIA en Cloudflare Pages — paso a paso

Este documento asume que ya tienes un proyecto Supabase funcionando (migrado y,
si quieres, con datos cargados). Cloudflare solo sirve el frontend estático y la
función `/api/chat`; la base de datos y la lógica de negocio siguen viviendo en
Supabase, tal como describe `CLAUDE.md`.

Estado actual de este repo detectado al escribir esta guía: **no tiene commits
todavía** (`git log` está vacío) y no hay remoto configurado. El primer bloque
cubre eso.

---

## 0. Antes de nada: revisa lo que vas a publicar

- [ ] **Contraseña por defecto en el código.** [scripts/load-file.mjs:22](scripts/load-file.mjs#L22)
  trae un *fallback* hardcodeado (`ADIA_ADMIN_PASSWORD || 'AdiaDemo2026!'`). Si el
  repo de GitHub va a ser público, cambia esa línea o al menos asegúrate de
  definir siempre `ADIA_ADMIN_PASSWORD` en tu `.env` para no depender del
  valor por defecto. Si el repo es privado no es urgente, pero conviene saberlo
  antes de darle acceso a alguien más.
- [ ] Confirma que `.env` **no** está en el commit: `.gitignore` ya lo excluye
  (línea 4), solo verifica con `git status` antes de hacer `git add`.
- [ ] El archivo `salaries-municipality-guayaquil.xlsx` (8 MB) también está
  ignorado por el patrón `*.xlsx` — no se subirá por accidente.

---

## 1. Subir el proyecto a GitHub (no hay commits aún)

```bash
git add .
git status                     # revisa que NO aparezca .env ni *.xlsx
git commit -m "Initial commit"
```

Crea un repositorio vacío en GitHub (sin README/licencia, para no pisar el
tuyo) y conéctalo:

```bash
git remote add origin https://github.com/<tu-usuario>/<tu-repo>.git
git branch -M main
git push -u origin main
```

Cloudflare Pages se conecta a este repo, así que necesitas que exista en
GitHub (o GitLab) antes del paso 4.

---

## 2. Verifica que el build pasa en local

Cloudflare va a ejecutar `npm run build`; corrobora que funciona antes de
depender de los logs remotos para depurarlo:

```bash
npm install
npm run build            # tsc -b && vite build → genera dist/
npm run check:secrets    # falla si OPENAI_API_KEY o la contraseña de BD llegaron a dist/
```

Si tienes la base de datos accesible desde tu máquina, corre también
`npm run test:routes` y `npm run test:sandbox` (este último pega contra el
Supabase real, así que solo si el dataset ya está cargado). Todo junto es
`npm run verify`.

---

## 3. Confirma que el CSP apunta a tu proyecto Supabase

[public/_headers](public/_headers) trae la política de seguridad de contenido
con el dominio de Supabase **hardcodeado**:

```
connect-src 'self' https://atwkpmapaxtihrqfgfth.supabase.co wss://atwkpmapaxtihrqfgfth.supabase.co;
```

- [ ] Compara ese ref (`atwkpmapaxtihrqfgfth`) contra tu `VITE_SUPABASE_URL`
  en `.env`. Si es un proyecto Supabase distinto, edita ambas líneas en
  `public/_headers` — si no coincide, el navegador bloqueará las llamadas a
  Supabase con un error de CSP y la app se verá "rota" sin ningún error obvio
  en la consola de red.

Este archivo se copia tal cual a `dist/` porque vive en `public/`, así que el
cambio solo hace falta hacerlo aquí, no en ningún paso de build de Cloudflare.

---

## 4. Crear el proyecto en Cloudflare Pages

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers &
   Pages** → **Create application** → pestaña **Pages** → **Connect to Git**.
2. Autoriza el acceso a GitHub y elige el repositorio que acabas de subir.
3. Configuración de build:

   | Campo | Valor |
   |---|---|
   | Framework preset | `Vite` (o `None`, es equivalente) |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | `/` (raíz del repo) |

4. En **Environment variables** (todavía en esta misma pantalla de setup)
   añade las variables de build — estas son públicas, terminan en el bundle
   del navegador, así que deben tener el prefijo `VITE_`:

   | Nombre | Valor |
   |---|---|
   | `VITE_SUPABASE_URL` | el mismo valor que tienes en `.env` |
   | `VITE_SUPABASE_ANON_KEY` | el mismo valor que tienes en `.env` |
   | `VITE_APP_NOMBRE` | `ADIA` (o el nombre que uses) |
   | `NODE_VERSION` | `20` |

5. Dale a **Save and Deploy**. El primer build tarda unos minutos; síguelo en
   la pestaña de logs del deployment.

---

## 5. Configurar el secreto de OpenAI para `/api/chat`

El repo ya trae el adaptador de Cloudflare Pages Functions en
[functions/api/chat.ts](functions/api/chat.ts), que reexporta el mismo
`handler.ts` que corre en local — **no hace falta desplegar la Edge Function
de Supabase** para tener el chat funcionando; con Pages Functions basta,
porque `useChat.ts` siempre llama a la ruta relativa `/api/chat` del mismo
origen.

Este secreto **no** lleva prefijo `VITE_` — nunca debe llegar al bundle del
navegador — así que se configura aparte de las variables de build:

1. En el proyecto de Pages recién creado: **Settings** → **Environment
   variables** → sección de variables de **Production** (y repite en
   **Preview** si vas a usar esas URLs de vista previa).
2. Añade `OPENAI_API_KEY` marcada como **Secret** (no como texto plano) con tu
   clave `sk-...`.
3. Vuelve a desplegar (**Deployments** → **Retry deployment**, o simplemente
   haz un nuevo commit) para que la función recoja el secreto — los Pages
   Functions leen `env` en tiempo de ejecución, así que un secreto añadido
   después del primer build también sirve sin rebuildear el frontend, pero
   conviene forzar un redeploy la primera vez para confirmarlo.

Alternativa por CLI, si prefieres no usar el dashboard:

```bash
npx wrangler pages secret put OPENAI_API_KEY --project-name <nombre-del-proyecto>
```

---

## 6. Verificar el deploy

Con la URL que te da Cloudflare (`https://<proyecto>.pages.dev`):

- [ ] Carga la app y confirma que el login funciona (usuario sembrado por
  `npm run load`).
- [ ] Abre el tablero de un dataset y confirma que los KPIs cargan (esto
  valida que `VITE_SUPABASE_URL`/`ANON_KEY` y el CSP están bien).
- [ ] Haz una pregunta en el chat y confirma que responde con streaming
  (esto valida `OPENAI_API_KEY` como secreto de Pages Functions).
- [ ] Revisa la pestaña **Network** del navegador: no debe haber ninguna
  llamada directa a `api.openai.com` desde el cliente — el CSP de
  `public/_headers` la bloquea a propósito; toda IA pasa por `/api/chat`.

Si el chat da 500: revisa **Deployments → Functions → Real-time Logs** en el
dashboard de Pages para ver el error real (`env.OPENAI_API_KEY` ausente es la
causa más común la primera vez).

---

## 7. Despliegues siguientes

Con la integración de Git ya conectada, cada `git push` a `main` dispara un
build y deploy de producción automático; cada push a otra rama o PR genera un
deploy de *preview* con su propia URL.

Antes de cada push que toque código, corre `npm run verify` en local — es
justo lo que hace `check:secrets`: evitar que una variable sin querer
prefijada con `VITE_` filtre una clave al bundle público.

Deploy manual sin esperar al push (útil para probar el output de `dist/`
directamente):

```bash
npm run build
npx wrangler pages deploy dist --project-name <nombre-del-proyecto>
```

---

## 8. Dominio propio (opcional)

**Workers & Pages** → tu proyecto → **Custom domains** → **Set up a custom
domain**. Si el dominio ya está en Cloudflare, el certificado y el DNS se
configuran solos; si no, te da el registro CNAME/TXT que hay que crear en tu
proveedor de DNS actual.

---

## Notas que no dependen de Cloudflare

Estos pasos son de Supabase, no del hosting del frontend, pero suelen
olvidarse al desplegar por primera vez a un entorno nuevo:

- `npm run migrate` — aplica el esquema (`supabase/migrations/*.sql`) contra
  el proyecto Supabase de producción. Necesita `SUPABASE_BD_PASSWORD` en el
  `.env` de la máquina desde la que lo corras (no en Cloudflare).
- `npm run kb` — siembra glosario y ejemplos pregunta→SQL y genera sus
  embeddings. Sin esto el copiloto arranca sin contexto de negocio.
- Si vas a desplegar la Edge Function de Supabase en vez de (o además de) la
  Pages Function — por ejemplo para tener el chat disponible incluso fuera de
  Cloudflare —, la sección "Desplegar → Función Edge del chat" del
  [README.md](README.md#desplegar) tiene esos comandos. Recuerda: después de
  tocar `src/server/chat/handler.ts` hay que sincronizar la copia con
  `cp src/server/chat/handler.ts supabase/functions/_shared/handler.ts` antes
  de desplegar cualquiera de las dos rutas.
