# Vectores en Postgres: cómo funciona la parte «IA» de ADIA

Documento de referencia sobre embeddings, `pgvector`, índices vectoriales y HNSW,
explicado sobre la instalación real de este proyecto. Todos los números que aparecen
salen de consultar la base tal como está hoy, no de la documentación general.

- **pgvector** 0.8.2 sobre PostgreSQL 17.6 (Supabase)
- **Modelo de embeddings**: `text-embedding-3-small` de OpenAI, 1.536 dimensiones
- **Índices**: 3 índices HNSW con distancia coseno

---

## 1. El problema que resuelven los vectores

Una base de datos sabe buscar por igualdad (`labor_regime = 'LOSEP'`) y por texto
contenido (`ilike '%conserje%'`). Lo que no sabe hacer sola es buscar por **parecido de
significado**: que «cuántos empleados tengo» y «número total de trabajadores» se
reconozcan como la misma pregunta, aunque no compartan ni una palabra.

Los embeddings convierten ese problema en uno que la base sí sabe resolver:
**distancia entre puntos**.

---

## 2. Qué es un embedding

Un embedding es una lista larga de números que representa un texto, construida de modo
que **textos con significados parecidos quedan cerca** en ese espacio.

Este es un embedding real de este proyecto — la ficha de glosario «LOSEP»:

```
[-0.015853882, -0.00356102, 0.023712158, -0.0135650635, 0.008666992, 0.06994629, ... ]
   ↑ componente 1    ↑ componente 2                                    ↑ y así hasta 1.536
```

Ninguna componente significa nada por separado. No hay una que sea «lo laboral» y otra
que sea «lo público». El significado está repartido en el conjunto, y solo emerge al
**comparar dos vectores entre sí**.

La comprobación de que esto funciona: si medimos el parecido de todas las fichas del
glosario contra la de «LOSEP», el orden que sale es este.

| Similitud | Ficha                               |
| --------: | ----------------------------------- |
|    1,0000 | LOSEP*(consigo misma)*            |
|    0,6617 | LOEI                                |
|    0,5856 | CT (Código del Trabajo)            |
|    0,5257 | Grado en el régimen docente (LOEI) |
|    0,4810 | Sueldo medio por régimen laboral   |
|    0,4735 | Grado jerárquico                   |
|    0,4450 | Régimen 4                          |

Nadie le dijo al sistema que LOSEP, CT y LOEI son los tres regímenes laborales. Salen
juntos porque sus descripciones ocupan zonas cercanas del espacio.

---

## 3. Las dimensiones

**1.536 dimensiones** significa que cada texto se representa con 1.536 números. No es un
parámetro que elijamos nosotros: lo fija el modelo. `text-embedding-3-small` produce
vectores de 1.536 componentes, siempre, mida el texto tres palabras o tres párrafos.

Esa es una propiedad clave: **la longitud del vector no depende de la longitud del
texto**. Por eso se pueden comparar una pregunta corta y una ficha larga.

### Por qué no usamos el modelo grande

`text-embedding-3-large` produce vectores de **3.072** dimensiones. Suena mejor, pero:

> `pgvector` **no puede indexar vectores de más de 2.000 dimensiones**. Es un límite
> duro del tipo `vector`, no una preferencia.

Con 3.072 habría que pasar a `halfvec` (media precisión), duplicando la complejidad para
una ganancia no medible en textos cortos como los nuestros: títulos de glosario y
preguntas de una línea. Si algún día hiciera falta el modelo grande, la salida elegante
es pedirle 1.024 dimensiones mediante su parámetro `dimensions` —esos modelos permiten
truncar el vector sin reentrenar— en vez de arrastrar 3.072.

### Cuánto ocupa

```sql
select pg_column_size(embedding), vector_dims(embedding) from kb_documents limit 1;
-- 6148 bytes, 1536 dims
```

1.536 componentes × 4 bytes (`float4`) = 6.144 bytes, más 4 de cabecera. **Unos 6 KB por
vector.** Con 35 vectores es irrelevante; con un millón serían 6 GB, y ahí la decisión de
dimensiones deja de ser académica.

---

## 4. Normalización: por qué la norma vale 1

Los embeddings de OpenAI vienen **normalizados**: su longitud (norma euclídea) es 1.

```sql
select round(sqrt(sum(x*x))::numeric, 6) as norma, count(*) as componentes
  from kb_documents k, unnest(k.embedding::real[]) x
 where k.id = (select min(id) from kb_documents);
-- norma = 0.999678   componentes = 1536
```

Ese 0,999678 en vez de 1,000000 es redondeo de coma flotante, no un error.

Que estén normalizados tiene una consecuencia práctica: **todos los vectores viven en la
superficie de una esfera**. Solo importa la *dirección*, no la longitud. Por eso la
distancia coseno es la métrica natural aquí, y por eso coseno y producto escalar
ordenan igual — con vectores de norma 1 son equivalentes.

---

## 5. Distancia coseno y los operadores de pgvector

La **similitud coseno** mide el ángulo entre dos vectores:

- `1` — misma dirección: significados equivalentes
- `0` — perpendiculares: sin relación
- `-1` — opuestos

`pgvector` trabaja con **distancias** (menor = más parecido), no con similitudes, porque
así `ORDER BY` ordena de mejor a peor de forma natural:

| Operador | Distancia                 | Cuándo                                                           |
| -------- | ------------------------- | ----------------------------------------------------------------- |
| `<=>`  | Coseno                    | **La que usa ADIA.** Correcta para embeddings normalizados. |
| `<->`  | Euclídea (L2)            | Cuando la magnitud del vector significa algo.                     |
| `<#>`  | Producto escalar negativo | Equivalente al coseno si están normalizados; algo más rápida.  |

La conversión entre ambas es directa:

```sql
1 - (embedding <=> $1)   -- distancia coseno  →  similitud coseno
```

Ese patrón aparece literalmente en `match_kb` y `match_cached_question`.

---

## 6. Cómo se crearon los de ADIA

Los genera `scripts/seed-kb.mjs` con una llamada HTTP a OpenAI:

```js
const r = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
  body: JSON.stringify({ model: 'text-embedding-3-small', input: batch }),
})
// j.data[i].embedding  ->  array de 1.536 numeros
```

Y se guardan como un valor más de la fila:

```sql
insert into public.kb_documents (..., embedding)
values (..., $7::extensions.vector)
```

### Qué texto se embebe, y qué no

Esta es la decisión de diseño que más afecta a la calidad, y es fácil equivocarse.

```js
// Se embebe titulo + contenido, NO el SQL de ejemplo.
const vecs = await embedAll(rows.map((r) => r.title + '. ' + r.content))
```

El motivo: lo que se compara contra estos vectores es **la pregunta del usuario**. Un
texto en español se parece a otro texto en español. Si metiéramos el SQL dentro del
vector, todos los ejemplos se parecerían mucho *entre sí* —comparten `select`, `from`,
`count`— y se alejarían de la pregunta, que es justo lo contrario de lo que se busca. El
SQL viaja en la fila como dato, y llega al modelo cuando la ficha se recupera; pero no
participa en la búsqueda.

### Cuándo se regeneran

Los embeddings son **específicos del modelo**: un vector de `3-small` no es comparable
con uno de `3-large`, ni siquiera con uno de `ada-002`. Cambiar de modelo invalida todo
lo guardado. Por eso el selector de modelo de embeddings en la pantalla de configuración
avisa de ello, y por eso `npm run kb` borra y regenera en bloque en vez de ir añadiendo.

---

## 7. `pgvector`: el tipo y el almacenamiento

`pgvector` añade a Postgres un tipo de dato y sus operadores. Nada más, y eso es lo
elegante: los vectores son **columnas normales**.

```sql
create extension if not exists vector with schema extensions;

create table public.kb_documents (
  id         bigint generated always as identity primary key,
  dataset_id bigint references public.datasets(id) on delete cascade,
  title      text not null,
  content    text not null,
  embedding  extensions.vector(1536),     -- ← una columna más
  ...
);
```

Que sea una columna normal implica que **la RLS se aplica igual** que a cualquier otra
columna, que participa en transacciones y que se respalda con el resto de la base. No hay
una segunda base de datos vectorial que mantener sincronizada, que es de dónde vienen la
mayoría de los problemas en arquitecturas RAG.

El `(1536)` es obligatorio si quieres indexar: el índice necesita saber la dimensión.

---

## 8. Por qué hace falta un índice

Sin índice, esta consulta funciona perfectamente:

```sql
select title, 1 - (embedding <=> $1) as sim
  from kb_documents
 order by embedding <=> $1
 limit 5;
```

…pero calcula la distancia contra **todas** las filas y luego ordena. Es una búsqueda
exacta —encuentra siempre los k mejores— y su coste crece linealmente. Con 18 fichas
tarda un par de milisegundos. Con 5 millones, no.

El índice cambia el trato: deja de garantizar el resultado exacto y pasa a devolver
**casi siempre casi los mejores**, muchísimo más rápido. Eso se llama búsqueda
aproximada (**ANN**, *approximate nearest neighbour*), y la métrica que mide cuánto se
pierde es el **recall**: de los 10 vecinos realmente más cercanos, cuántos aparecen en el
resultado. Un recall de 0,98 significa que uno de cada cincuenta se escapa.

Para recuperar glosario y preguntas parecidas, ese trato es claramente bueno: que se
escape la quinta ficha más parecida no cambia la respuesta.

---

## 9. HNSW

**Hierarchical Navigable Small World.** Es el índice que usa ADIA en sus tres tablas.

### La idea

Imagina que buscas una casa en un país desconocido y solo puedes preguntar a la gente:
«¿quién de tus conocidos vive más cerca de esta dirección?». Si empiezas preguntando a
alguien al azar, tardarás muchísimo. Si empiezas por alguien que conoce gente de todo el
país, te acerca a la región correcta en un salto; luego alguien de esa región te acerca a
la ciudad; luego al barrio.

HNSW construye exactamente eso: **un grafo de vecinos en varias capas**.

```
capa 2    ●──────────────────●              pocos nodos, saltos largos
                             │
capa 1    ●────────●─────────●────────●     más nodos, saltos medios
          │        │         │        │
capa 0    ●──●──●──●──●───●──●──●──●──●     TODOS los nodos, saltos cortos
                         ↑
                    aquí está el resultado
```

La búsqueda entra por la capa de arriba, avanza al vecino más cercano al objetivo
mientras pueda mejorar, y cuando se atasca baja una capa y repite. Es la misma idea que
una *skip list*, llevada a un espacio de 1.536 dimensiones.

En vez de mirar un millón de puntos, mira unas decenas.

### Los parámetros

Nuestros índices, tal como están creados:

```sql
create index kb_documents_emb_idx on public.kb_documents
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

| Parámetro          | Nuestro valor | Qué controla                                                                                                                                                    |
| ------------------- | ------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m`               |            16 | Cuántos vecinos guarda cada nodo. Más alto = grafo mejor conectado, mejor recall, índice más grande. Se fija al crear y no se puede cambiar sin reconstruir. |
| `ef_construction` |            64 | Cuántos candidatos se consideran al insertar cada nodo. Más alto = índice de mejor calidad, más lento de construir.                                          |
| `ef_search`       |            40 | Cuántos candidatos se exploran**al buscar**. Es el único que se ajusta por consulta. Más alto = mejor recall, más lento.                               |

`vector_cosine_ops` no es decoración: le dice al índice **con qué distancia** se
construyó. Un índice creado con `vector_cosine_ops` no sirve para consultas con `<->`.
Si la clase de operador no coincide con el operador de la consulta, Postgres ignora el
índice en silencio y hace escaneo completo — el resultado sigue siendo correcto, pero
lento, y no hay ningún error que lo delate.

`ef_search` se fija en las funciones de búsqueda:

```sql
create or replace function public.match_kb(...)
language sql stable security invoker
set hnsw.ef_search = 40 as $fn$ ... $fn$;
```

### El índice puede pesar más que los datos

Un dato real de esta instalación, que sorprende la primera vez:

| Tabla            | Datos |     Índice HNSW |
| ---------------- | ----: | ---------------: |
| `kb_documents` | 16 kB | **280 kB** |
| `query_cache`  | 16 kB | **160 kB** |

El índice ocupa **17 veces** más que la tabla. Es normal: HNSW guarda el grafo de
vecindad —hasta `m` enlaces por nodo y por capa— además de una copia de los propios
vectores. Con volúmenes grandes conviene contar con que el índice vectorial es un
consumidor de memoria de primer orden, no un extra.

---

## 10. IVFFlat, y por qué aquí no

La alternativa que trae `pgvector` es **IVFFlat** (*inverted file with flat compression*).
Funciona por agrupación: divide el espacio en `lists` regiones, calcula el centro de cada
una, y al buscar solo mira las regiones más prometedoras (`probes`).

```
        región A          región B
      ●  ●   ●          ●   ●  ●
        ● ⊕ ●              ⊕  ●          ⊕ = centro de la region
      ●   ●             ●  ●   ●
```

Es más pequeño y más rápido de construir que HNSW. Pero tiene un requisito que aquí lo
descarta:

> **IVFFlat necesita datos representativos en el momento de crear el índice**, porque los
> centros de las regiones se calculan a partir de lo que hay.

`query_cache` **nace vacía** y crece pregunta a pregunta. Sus regiones se construirían
sobre nada, y a medida que se llenara, el recall se degradaría **en silencio** —sin
error, sin aviso— hasta que alguien recordara reconstruir el índice. HNSW no entrena: se
mantiene incrementalmente y funciona bien desde la primera fila.

|                          | HNSW   | IVFFlat                |
| ------------------------ | ------ | ---------------------- |
| Necesita datos previos   | No     | **Sí**          |
| Recall a igual velocidad | Mejor  | Peor                   |
| Tamaño del índice      | Grande | Pequeño               |
| Coste de inserción      | Mayor  | Menor                  |
| Se degrada al crecer     | No     | Sí, hasta reconstruir |

Para tablas que crecen continuamente y se escriben poco —exactamente nuestro caso— HNSW
es la elección correcta aunque ocupe más.

---

## 11. La trampa del filtrado

Este es el fallo con el que se tropieza todo el mundo al menos una vez:

```sql
select * from query_cache
 where dataset_id = 1                    -- ← filtro
 order by embedding <=> $1
 limit 5;
```

Parece «los 5 más parecidos del dataset 1». En realidad, el índice HNSW recorre el grafo
**sin saber nada del filtro**, produce sus candidatos, y el `WHERE` los descarta después.
Si los vectores del dataset 1 son una fracción pequeña de la tabla, puedes recibir **menos
de 5 resultados, o ninguno**, aunque existan de sobra.

Dos mitigaciones:

1. `pgvector` 0.8 —el que tenemos— añade `hnsw.iterative_scan`, que reintenta y amplía
   la búsqueda hasta reunir los `k` pedidos.
2. Por debajo de unos miles de vectores, el escaneo secuencial tarda 10–20 ms de todas
   formas. En nuestra escala actual (18 y 17 filas) **el índice todavía no aporta nada**:
   está puesto para cuando la caché crezca.

Merece la pena decirlo claro: hoy los índices HNSW de este proyecto son prevención, no
optimización.

---

## 12. Dónde ADIA usa vectores, y dónde deliberadamente no

Esta parte importa tanto como la anterior, porque la tentación es vectorizarlo todo.

### Sí usa vectores

| Tabla            | Filas | Con vector | Para qué                                                            |
| ---------------- | ----: | ---------: | -------------------------------------------------------------------- |
| `kb_documents` |    18 |         18 | Recuperar glosario y ejemplos pregunta→SQL parecidos a la pregunta. |
| `query_cache`  |    17 |         17 | Reconocer que una pregunta ya se resolvió antes.                    |

### No usa vectores, y es a propósito

**El diccionario de valores** (`dataset_values`, 1.344 filas) tiene columna `embedding` e
índice HNSW, pero **está vacía**: la búsqueda se hace por **trigramas** (`pg_trgm`), no
por embeddings.

```sql
-- match_values: similitud de trigramas + coincidencia por substring
greatest(
  similarity(unaccent(lower(v.value)), unaccent(lower(p_query))),
  case when unaccent(lower(v.value)) like '%' || unaccent(lower(p_query)) || '%'
       then 0.75 else 0 end
)
```

No es un descuido: es la herramienta correcta. El problema que resuelve esa búsqueda es
**ortográfico, no semántico** — el usuario escribe «conserjes» y la tabla dice
`CONSERJE`, `CONSERJE 1`, `CONSERJE VOLANTE`. Los trigramas comparan cómo se *escribe*
una palabra, que es exactamente la pregunta. Un embedding compararía qué *significa*, y
acercaría «conserje» a «limpieza» o «portero» — valores que no existen en la tabla y que
producirían un `WHERE` que no devuelve nada.

> Regla general: **vectores para significado, trigramas para ortografía.** Confundirlas
> es una fuente clásica de resultados vacíos en text-to-SQL.

**El diccionario de columnas** tampoco se vectoriza: se mete entero en el prompt. Son 16
columnas, unos 900 tokens. Buscar por similitud en tu propio esquema añade latencia, un
umbral que afinar y un modo de fallo nuevo —recuperar 4 columnas de 16 y escribir la
consulta contra la equivocada.

---

## 13. Por qué la similitud sola no basta

Lo más importante de todo el documento, y no es un tema de vectores sino de lo que se
hace con ellos.

Estas dos preguntas tienen una similitud coseno de aproximadamente **0,94**:

```
"¿cuántos conserjes tengo?"                  → 78   (noviembre 2016)
"¿cuántos conserjes tenía en marzo de 2016?" → 82   (marzo 2016)
```

Con el umbral de caché en 0,93, eso es un **acierto**. El sistema reejecutaría el SQL
guardado y devolvería 78 para la segunda pregunta: una cifra *correcta*, del periodo
*equivocado*, que nadie detectaría jamás.

Los embeddings capturan de qué **trata** un texto, no los **parámetros exactos** que lo
acotan. Un mes, un umbral de dólares o un filtro activo cambian por completo la respuesta
y apenas mueven el vector.

Por eso la caché de ADIA tiene una segunda puerta que **no es semántica**: extrae los
literales de la pregunta —años, meses, importes, textos entrecomillados y los filtros
activos del tablero— y solo acepta el acierto si coinciden **exactamente**.

> Reejecutar el SQL protege del **dato** rancio. La puerta de literales protege del
> **parámetro** rancio. Hacen falta las dos.

---

## 14. Glosario

| Término                      | Qué es                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Embedding**           | Lista de números que representa un texto, construida para que el parecido de significado sea proximidad geométrica. |
| **Dimensiones**         | Cuántos números tiene el vector. Lo fija el modelo. Aquí, 1.536.                                                   |
| **Normalizado**         | Vector de longitud 1. Solo importa su dirección. Los de OpenAI lo vienen.                                            |
| **Distancia coseno**    | Ángulo entre dos vectores.`0` = idénticos en dirección, `1` = perpendiculares. En SQL, `<=>`.                |
| **ANN**                 | Búsqueda aproximada del vecino más cercano. Cambia exactitud garantizada por velocidad.                             |
| **Recall**              | Qué fracción de los verdaderos k mejores devuelve la búsqueda aproximada.                                          |
| **HNSW**                | Índice de grafo por capas. No necesita entrenamiento, buen recall, ocupa bastante.                                   |
| **IVFFlat**             | Índice por regiones. Necesita datos representativos al crearse.                                                      |
| **`m`**               | Vecinos por nodo en HNSW. Se fija al crear el índice.                                                                |
| **`ef_construction`** | Candidatos considerados al insertar. Calidad del índice.                                                             |
| **`ef_search`**       | Candidatos explorados al buscar. Ajustable por consulta.                                                              |
| **Clase de operador**   | `vector_cosine_ops` y compañía. Debe coincidir con el operador de la consulta o el índice se ignora sin avisar.  |
| **Trigrama**            | Trozo de tres caracteres. Base de la búsqueda por parecido*ortográfico* (`pg_trgm`).                            |
| **Post-filtrado**       | El`WHERE` se aplica *después* del índice vectorial, y puede dejar menos resultados de los pedidos.              |

---

## 15. Consultas útiles

```sql
-- Dimensiones y tamaño de un vector
select vector_dims(embedding), pg_column_size(embedding) from kb_documents limit 1;

-- Comprobar que estan normalizados (deberia dar ~1.0)
select round(sqrt(sum(x*x))::numeric, 6)
  from kb_documents k, unnest(k.embedding::real[]) x
 where k.id = (select min(id) from kb_documents);

-- Que hay cerca de una ficha concreta
with a as (select embedding e from kb_documents where title = 'LOSEP' limit 1)
select k.title, round((1 - (k.embedding <=> a.e))::numeric, 4) as similitud
  from kb_documents k, a
 order by k.embedding <=> a.e
 limit 8;

-- Tamano de los indices vectoriales
select ic.relname as indice, pg_size_pretty(pg_relation_size(ic.oid)) as tamano
  from pg_class c
  join pg_index i on i.indrelid = c.oid
  join pg_class ic on ic.oid = i.indexrelid
 where ic.relname like '%emb_idx';

-- ¿Se esta usando el indice? Busca "Index Scan using ..._emb_idx"
explain analyze
select id from kb_documents order by embedding <=> (select embedding from kb_documents limit 1) limit 5;
```

---

## Referencias

- `supabase/migrations/0025_ai.sql` — creación de los índices y funciones de búsqueda
- `scripts/seed-kb.mjs` — generación de los embeddings
- `src/server/chat/handler.ts` — `extractLiterals()` y la puerta de la caché
- [pgvector](https://github.com/pgvector/pgvector) · [OpenAI embeddings](https://platform.openai.com/docs/guides/embeddings) · [Malkov &amp; Yashunin, *HNSW* (2016)](https://arxiv.org/abs/1603.09320)
