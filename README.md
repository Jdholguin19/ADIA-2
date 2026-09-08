# ADIA — Analizador de datos con copiloto IA

Cargas un XLSX o un CSV y obtienes un tablero ejecutivo (indicadores + alertas) y un
chatbot que responde preguntas sobre esos datos.

**Stack:** React 18 + Vite 6 + Tailwind 4 (PWA) hablando directo a Supabase.
Sin backend propio: la lógica vive en funciones plpgsql y la seguridad en RLS.
La IA (OpenAI) se alcanza por una función Edge, nunca desde el navegador.

---

## La decisión que define el proyecto

Un RAG clásico —trocear filas, generar embeddings, recuperar top-k— **no puede**
contestar «¿cuántos trabajadores hay?». Recuperar 8 fragmentos de 93.484 filas no
cuenta 4.000 personas: produce una respuesta con aire de verdad y un número
inventado. Para un tablero de gerencia eso es peor que no tener chatbot.

ADIA es, por tanto, **un agente texto-a-SQL con el prompt aumentado por
recuperación**, no un RAG sobre filas:

- **Los vectores indexan significado**: los valores que existen de verdad, el
  glosario de negocio y las preguntas ya resueltas.
- **Los números salen siempre de SQL** ejecutado en el momento contra Postgres.
- **La caché semántica** reutiliza la *consulta validada* y la vuelve a ejecutar;
  jamás sirve una cifra guardada.

### El riesgo número uno, y cómo se neutraliza

Con un panel mensual, «¿cuántos trabajadores hay?» tiene tres respuestas que
parecen todas correctas:

| Consulta | Resultado | ¿Sirve? |
|---|---|---|
| `count(*)` | 93.484 | No: son filas-mes |
| `count(distinct names)` | 5.647 | No: todo el que pasó alguna vez en 23 meses |
| `count(distinct names)` **con periodo** | **3.978** | Sí |

El perfilador detecta la forma de panel y escribe una **regla de conteo** que va a
tres sitios a la vez: al prompt del modelo, al *linter* de SQL (que rechaza
`count(*)` sin filtro de periodo, explicando por qué) y al propio tablero, pegada
al número. Gerencia ve la definición junto a la cifra.

---

## Puesta en marcha

```bash
npm install
cp .env.example .env          # rellena tus credenciales
npm run migrate               # crea el esquema en Supabase
npm run load -- tu-archivo.xlsx   # opcional: siembra datos y crea el usuario admin
npm run kb                    # opcional: glosario y ejemplos pregunta→SQL
npm run dev                   # http://localhost:5173
```

En desarrollo, `/api/chat` corre **dentro del dev server de Vite** usando el mismo
`handler.ts` que se despliega luego. La `OPENAI_API_KEY` se queda en el proceso de
node: la app funciona de punta a punta en local sin desplegar nada.

### Variables de entorno

Todo lo que empieza por `VITE_` **se incrusta en el bundle y se publica**. La clave
de OpenAI y la contraseña de la base de datos no lo llevan, y `npm run check:secrets`
lo verifica sobre `dist/` antes de cada despliegue.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | App + endpoint de chat en local |
| `npm run migrate` | Aplica `supabase/migrations/*.sql` (con libro de versiones) |
| `npm run load -- <archivo>` | Carga un archivo por el mismo camino que el navegador |
| `npm run kb` | Siembra glosario y ejemplos, y genera sus vectores |
| `npm run test:sandbox` | 27 pruebas: 12 ataques + guarda de grano + cifras + RLS |
| `npm run test:chat` | Prueba extremo a extremo del copiloto |
| `npm run check:secrets` | Falla si algún secreto acabó en `dist/` |
| `npm run verify` | build + secretos + caja de arena |

---

## Cómo está construido

### Ingesta: bronce → plata

1. **Bronce** (`dataset_rows`, jsonb particionado por dataset): el archivo tal cual,
   inmutable. Permite reperfilar sin volver a subir.
2. **Plata** (`ds.t_<id>`, tabla física tipada): lo que consulta todo el mundo.

El casteo ocurre **una sola vez, al cargar**, nunca al leer. Con una vista que
casteara sobre jsonb, una única celda con `'222,91  c) Rem'` haría fallar *toda*
consulta que tocara esa columna —incluido el tablero—, porque Postgres no garantiza
que el `WHERE` se evalúe antes del cast del `SELECT`.

Una fila con **una** celda ilegible se conserva con esa celda nula y el fallo
anotado en `_issues`. Solo va a cuarentena la fila con corrupción **estructural**
(dos o más celdas rotas). En el archivo de prueba la separación es limpia: 31 filas
con un fallo (empleados reales) frente a 56 con cinco (extracción PDF defectuosa).
Tirar la fila entera habría borrado 5 personas de la plantilla de noviembre.

### El perfilador

Deduce por columna el tipo real y su **rol semántico**: identidad, categoría,
dinero, parte de fecha, métrica, código, índice ordinal, constante o derivada.
Tres reglas que se ganan el sitio:

- **Índice ordinal.** La columna `no` va de 1 a ~4.000 *dentro de cada mes*, así que
  parece una identidad perfecta. Si el perfilador la eligiera como clave de entidad,
  la plantilla pasaría a ser el número de filas y todo lo demás saldría mal
  pareciendo bien. Se detecta por ser un rango contiguo que arranca en 0 o 1.
- **Código frente a dinero.** `budget_item` vale `1110.001`: tiene decimales, pero
  son niveles de un código contable, no céntimos. Ninguna heurística numérica los
  distingue de un importe; el nombre sí.
- **Columnas derivadas.** Detecta reglas de razón y aditivas. En este archivo:
  `13ro = mensual/12` y `adicionales = 13ro+14to+horas+subrogaciones`, ambas exactas.
  Sin esto, «coste total» sumaría cada columna numérica y reportaría una nómina
  del orden de 26 veces la real.

### La caja de arena SQL

`exec_analysis_sql` es **SECURITY INVOKER**: la consulta corre con los privilegios
del propio usuario y la **RLS** es la frontera de seguridad.

> El diseño original bajaba privilegios con `SET LOCAL ROLE` dentro de una función
> `SECURITY DEFINER`. Eso es **imposible** en PostgreSQL: el GUC `role` lleva
> `GUC_NOT_WHILE_SEC_REST` y cualquier `SET ROLE` ahí dentro falla con
> `42501 cannot set parameter "role" within security-definer function`.
> Comprobado contra este Postgres 17.6. La versión con INVOKER es además más
> segura: el usuario no gana nada que no tuviera ya vía PostgREST.

Capas, en orden: autorización → límite de tasa → *lint* estático (gramática, lista
blanca de relaciones y funciones, **guarda de grano**) → parámetros ligados como
literales → `LIMIT` forzado → **`EXPLAIN (FORMAT JSON)`**, que valida el *plan* y no
el texto (un regex se puede burlar; un plan no puede mentir sobre lo que va a leer)
→ ejecución → auditoría.

Los errores se **devuelven**, no se lanzan: el modelo los lee y corrige la consulta
en la vuelta siguiente. De esa reparación sale buena parte de la precisión real.

### La caché semántica y su puerta dura

«¿cuántos conserjes tengo?» y «¿cuántos conserjes tenía en marzo de 2016?» se
parecen ~0,94 en coseno. Con umbral 0,93 hay acierto, se reejecuta el SQL guardado
y sale una cifra **correcta del periodo equivocado**, que nadie detecta.

Reejecutar protege del dato rancio, no del parámetro rancio. Por eso, además del
coseno, la pregunta entrante debe traer **exactamente los mismos literales** (mes,
año, umbrales, textos entrecomillados). Comprobado: la repetición literal acierta
en 0,8 s frente a 4,1 s, y la variante de marzo falla la caché y devuelve 82 en vez
de 78.

---

## Desplegar

### Base de datos

`npm run migrate` con `SUPABASE_BD_PASSWORD` en `.env`.

### Función Edge del chat

Necesita un token de https://supabase.com/dashboard/account/tokens en `.env` como
`SUPABASE_ACCESS_TOKEN`:

```bash
npx supabase link --project-ref <ref>
npx supabase secrets set OPENAI_API_KEY=sk-...
npx supabase functions deploy chat --no-verify-jwt
```

Luego apunta el front a la función con `VITE_CHAT_ENDPOINT`.

*Alternativa sin token:* el mismo handler ya está adaptado como Pages Function en
`functions/api/chat.ts`. Se despliega con el propio frontend y la clave vive como
secreto de Cloudflare.

### Frontend en Cloudflare Pages

Build `npm run build`, salida `dist`, `NODE_VERSION=20`. `_redirects` y `_headers`
salen ya en `dist`. Define las `VITE_*` como variables de build.

---

## Estado verificado

Contrastado contra un perfilado independiente del archivo hecho en Python:

| Comprobación | Valor |
|---|---|
| Plantilla en 2016-11 | 3.978 |
| Nómina base 2016-11 | $3.609.277,41 |
| Conserjes | 76 exactos / 78 agrupando variantes |
| Sueldos > $5.000 | 1 — el alcalde, $5.263,53 |
| Mediana histórica | $666,75 |
| Cuarentena / celdas sueltas | 56 / 31 |
| Duplicados (persona, periodo) | 3, con impacto de $5.315,26 |
| Caja de arena | 27/27 pruebas |
| Alertas | 15 (2 críticas, 6 altas, 6 medias, 1 info) |

## Limitaciones conocidas

- **`names` es una clave de entidad débil.** No hay identificador estable en el
  archivo: los homónimos cuentan de menos y un cambio de grafía cuenta de más. La
  app lo dice en vez de fingir precisión.
- **`labor_regime` y `hierarchical_grade` cambian de codificación** en 2015-06.
  Cualquier análisis de esas columnas que cruce ese corte es ruido hasta que se
  confirme la equivalencia; la alerta crítica lo señala con la evidencia.
- **La confirmación de equivalencias todavía no tiene interfaz.** El motor detecta
  la deriva y propone el corte; falta la pantalla para que un humano confirme el
  mapeo y rellene las columnas `_norm`.
- **El chat no persiste el historial** entre recargas (las tablas existen; falta
  conectarlas).
- El copiloto responde sobre **un dataset a la vez**.
