-- =====================================================================
-- ADIA 0025 - capa IA: contexto, recuperacion vectorial, herramientas y
--             cache semantica.
--
-- Los vectores NO indexan filas de datos. Recuperar 8 fragmentos de 93.484
-- filas no cuenta 4.000 personas. Se indexa SIGNIFICADO:
--   dataset_values  -> los valores que existen de verdad ("conserjes" -> "CONSERJE")
--   kb_documents    -> glosario y ejemplos pregunta->SQL
--   query_cache     -> preguntas ya resueltas
-- Los NUMEROS salen siempre de SQL ejecutado en el momento.
-- =====================================================================

-- HNSW y no IVFFlat: IVFFlat necesita datos representativos al construir sus
-- listas, y query_cache NACE VACIA y crece poco a poco. Sus listas se
-- construirian sobre ruido y el recall se degradaria en silencio. HNSW no
-- entrena y es incremental.
create index if not exists kb_documents_emb_idx on public.kb_documents
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists query_cache_emb_idx on public.query_cache
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists dataset_values_emb_idx on public.dataset_values
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------
-- dataset_context: la ficha COMPLETA del dataset para el prompt.
--
-- No se recupera por similitud: 16 columnas son ~900 tokens y buscar
-- vectorialmente en tu propio esquema solo anade latencia, un umbral que
-- afinar y un modo de fallo nuevo (recuperar 4 de 16 columnas y escribir
-- SQL contra la equivocada). Va entero, siempre.
-- ---------------------------------------------------------------------
create or replace function public.dataset_context(p_dataset_id bigint)
returns text language plpgsql stable security invoker
set search_path = public, pg_catalog as $fn$
declare
  d record; c record; v_out text; v_cols text := ''; v_der text := '';
  v_per text; v_alert text := ''; m jsonb;
begin
  select * into d from public.datasets where id = p_dataset_id;
  if d.id is null then return null; end if;
  select metrics into m from public.dataset_metrics where dataset_id = p_dataset_id;

  for c in select * from public.dataset_columns where dataset_id = p_dataset_id order by ordinal loop
    v_cols := v_cols || format(E'  %s %s  -- rol=%s%s%s%s\n',
      rpad(c.column_name, 26), rpad(c.data_type, 9), c.role,
      case when not c.is_analyzable then ', NO USAR como magnitud ni como identidad' else '' end,
      case when c.distinct_count is not null then format(', %s valores distintos', c.distinct_count) else '' end,
      case when c.examples is not null and jsonb_array_length(c.examples) > 0
           then format(', ej: %s', left(replace(c.examples::text, '"', ''''), 90)) else '' end);
    if c.derived_rule is not null then
      v_der := v_der || format(E'  %s  (redundante: no la sumes junto a sus componentes)\n', c.derived_rule);
    end if;
  end loop;

  if (d.profile->>'period_column') is not null then
    v_per := format(E'\nPERIODOS: %s meses, de %s a %s. Periodo vigente por defecto: %s.\n'
                     'La columna "period" es de tipo date y vale el dia 1 del mes. Filtra con '
                     'period = DATE ''YYYY-MM-01''.\n',
      coalesce(d.profile->>'n_periods','?'), coalesce(d.profile->>'first_period','?'),
      coalesce(d.profile->>'last_period','?'), coalesce(m->>'default_period','?'));
  end if;

  select string_agg(format('  [%s] %s', severity, title), E'\n') into v_alert
    from (select severity, title from public.dataset_alerts
           where dataset_id = p_dataset_id and severity in ('critical','high')
           order by severity limit 8) z;

  v_out := format(E'TABLA: %I.%I  (consultala SIEMPRE por este nombre)\n'
                   'FILAS: %s tipadas, %s apartadas por corrupcion.\n\n'
                   'COLUMNAS\n%s\n',
    d.phys_schema, d.phys_table, d.n_rows_silver, d.n_rows_quarantined, v_cols);

  if v_der <> '' then
    v_out := v_out || E'COLUMNAS DERIVADAS (calculadas a partir de otras)\n' || v_der || E'\n';
  end if;

  if d.profile->>'grain' = 'panel' then
    v_out := v_out || format(E'REGLA DE CONTEO - LEELA ANTES DE ESCRIBIR NADA\n%s\n'
      'Toda cifra de "cuantos" es count(distinct %I) CON filtro de periodo.\n'
      'count(*) responde filas-mes y es casi siempre la respuesta equivocada.\n',
      coalesce(d.profile->>'counting_rule',''), d.profile->>'entity_column');
  end if;

  v_out := v_out || coalesce(v_per, '');
  if m->>'primary_money' is not null then
    v_out := v_out || format(E'\nIMPORTE PRINCIPAL: %s (usalo para coste, sueldo medio y rankings).\n',
                             m->>'primary_money');
  end if;
  if v_alert is not null then
    v_out := v_out || E'\nAVISOS DE CALIDAD VIGENTES\n' || v_alert || E'\n';
  end if;

  return v_out;
end $fn$;

-- ---------------------------------------------------------------------
-- match_values: aterrizar el literal de la pregunta en el valor real.
-- Aqui es donde de verdad falla el texto-a-SQL: el modelo escribe
-- 'Conserje' y la tabla dice 'CONSERJE', o pide "conserjes" sin saber que
-- existen ademas 'CONSERJE 1' y 'CONSERJE VOLANTE'.
-- ---------------------------------------------------------------------
create or replace function public.match_values(
  p_dataset_id bigint, p_query text, p_column text default null, p_limit int default 12)
returns table (column_name text, value text, n bigint, similarity real)
language sql stable security invoker
set search_path = public, extensions, pg_catalog as $fn$
  select v.column_name, v.value, v.n,
         greatest(
           extensions.similarity(extensions.unaccent(lower(v.value)),
                                 extensions.unaccent(lower(p_query))),
           case when extensions.unaccent(lower(v.value))
                     like '%' || extensions.unaccent(lower(p_query)) || '%'
                then 0.75::real else 0::real end
         ) as similarity
    from public.dataset_values v
   where v.dataset_id = p_dataset_id
     and (p_column is null or v.column_name = p_column)
     and (extensions.unaccent(lower(v.value))
            like '%' || extensions.unaccent(lower(p_query)) || '%'
          or extensions.similarity(extensions.unaccent(lower(v.value)),
                                   extensions.unaccent(lower(p_query))) > 0.3)
   order by similarity desc, v.n desc
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$fn$;

-- ---------------------------------------------------------------------
create or replace function public.match_kb(
  p_dataset_id bigint, p_embedding extensions.vector(1536),
  p_limit int default 5, p_min_sim numeric default 0.25)
returns table (id bigint, kind text, title text, content text, sql_text text, similarity numeric)
language sql stable security invoker
set search_path = public, extensions, pg_catalog as $fn$
  select k.id, k.kind, k.title, k.content, k.sql_text,
         round((1 - (k.embedding operator(extensions.<=>) p_embedding))::numeric, 4)
    from public.kb_documents k
   where k.enabled and k.embedding is not null
     and (k.dataset_id = p_dataset_id or k.dataset_id is null)
     and 1 - (k.embedding operator(extensions.<=>) p_embedding) >= p_min_sim
   order by k.embedding operator(extensions.<=>) p_embedding
   limit greatest(1, least(coalesce(p_limit, 5), 25));
$fn$;

-- ---------------------------------------------------------------------
-- match_cached_question
--
-- La similitud coseno SOLA convierte la cache en una fabrica de numeros
-- equivocados: "cuantos conserjes tengo" y "cuantos conserjes tenia en
-- marzo de 2016" se parecen ~0.94. Con umbral 0.93 hay acierto, se
-- reejecuta el SQL cacheado y sale una cifra CORRECTA DEL PERIODO
-- EQUIVOCADO, que nadie detecta. Reejecutar protege del dato rancio, no
-- del parametro rancio.
--
-- Por eso hay una puerta dura no semantica: cada literal de la pregunta
-- entrante (numeros, importes, meses, anios, valores del diccionario) debe
-- poder ligarse a un hueco de la plantilla. Si trae un literal sin hueco,
-- es fallo de cache y se regenera.
-- ---------------------------------------------------------------------
create or replace function public.match_cached_question(
  p_dataset_id bigint, p_embedding extensions.vector(1536),
  p_min_sim numeric default 0.93, p_literals jsonb default '[]'::jsonb)
returns table (id bigint, question text, sql_template text, param_schema jsonb,
               answer_template text, status text, similarity numeric, literal_compatible boolean)
language sql stable security invoker
set search_path = public, extensions, pg_catalog as $fn$
  select c.id, c.question, c.sql_template, c.param_schema, c.answer_template, c.status,
         round((1 - (c.embedding operator(extensions.<=>) p_embedding))::numeric, 4),
         (select coalesce(bool_and(c.param_schema ? (l->>'slot')), true)
            from jsonb_array_elements(coalesce(p_literals, '[]'::jsonb)) l)
         and (select count(*) from jsonb_object_keys(c.param_schema))
             >= jsonb_array_length(coalesce(p_literals, '[]'::jsonb))
    from public.query_cache c
   where c.dataset_id = p_dataset_id
     and c.status in ('validated','candidate')
     and 1 - (c.embedding operator(extensions.<=>) p_embedding) >= p_min_sim
   order by c.embedding operator(extensions.<=>) p_embedding
   limit 5;
$fn$;

-- ---------------------------------------------------------------------
create or replace function public.save_query_cache(
  p_dataset_id bigint, p_question text, p_embedding extensions.vector(1536),
  p_sql_template text, p_param_schema jsonb default '{}'::jsonb,
  p_answer_template text default null)
returns bigint language plpgsql security invoker
set search_path = public, pg_catalog as $fn$
declare v_id bigint;
begin
  insert into public.query_cache(owner_id, dataset_id, question, question_norm, embedding,
                                 sql_template, param_schema, answer_template, status, last_used_at)
  values (auth.uid(), p_dataset_id, p_question,
          lower(btrim(regexp_replace(p_question, '\s+', ' ', 'g'))),
          p_embedding, p_sql_template, coalesce(p_param_schema,'{}'::jsonb),
          p_answer_template, 'candidate', now())
  returning id into v_id;
  return v_id;
end $fn$;

create or replace function public.touch_query_cache(p_id bigint, p_promote boolean default false)
returns void language plpgsql security invoker
set search_path = public, pg_catalog as $fn$
begin
  update public.query_cache
     set hit_count = hit_count + 1, last_used_at = now(),
         status = case when p_promote or hit_count + 1 >= 3 then 'validated' else status end
   where id = p_id;
end $fn$;

-- ---------------------------------------------------------------------
-- Herramientas parametrizadas. El modelo rellena PARAMETROS, no texto SQL:
-- por construccion no hay inyeccion posible y el camino habitual es
-- determinista. El SQL libre queda como red para la cola larga.
-- ---------------------------------------------------------------------
create or replace function public.tool_headcount(
  p_dataset_id bigint, p_period text default null, p_group_by text default null,
  p_filter_column text default null, p_filter_value text default null)
returns jsonb language plpgsql security invoker
set search_path = public, pg_catalog
set statement_timeout = '15s' as $fn$
declare
  prof jsonb; v_t text; v_ent text; v_per text; v_sql text; v_res jsonb; v_def text;
begin
  select profile into prof from public.datasets where id = p_dataset_id;
  if prof is null then return jsonb_build_object('ok', false, 'error', 'DATASET_NO_ENCONTRADO'); end if;
  v_t := app.qual(p_dataset_id);
  v_ent := prof->>'entity_column';
  select default_period into v_def from public.dataset_metrics where dataset_id = p_dataset_id;
  v_per := coalesce(p_period, v_def);

  if p_group_by is not null and not exists (
      select 1 from public.dataset_columns
       where dataset_id = p_dataset_id and column_name = p_group_by and is_analyzable) then
    return jsonb_build_object('ok', false, 'error', format('columna no valida: %s', p_group_by));
  end if;
  if p_filter_column is not null and not exists (
      select 1 from public.dataset_columns
       where dataset_id = p_dataset_id and column_name = p_filter_column) then
    return jsonb_build_object('ok', false, 'error', format('columna no valida: %s', p_filter_column));
  end if;

  v_sql := format('select %s coalesce(%s, 0) as personas from %s where true %s %s %s',
    case when p_group_by is not null then format('%I::text as grupo,', p_group_by) else '' end,
    case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
    v_t,
    case when v_per is not null and (prof->>'period_column') is not null
         then format('and period = %L::date', v_per) else '' end,
    case when p_filter_column is not null
         then format('and %I::text = %L', p_filter_column, p_filter_value) else '' end,
    case when p_group_by is not null
         then format('group by 1 order by 2 desc limit 100') else '' end);

  execute format('select coalesce(jsonb_agg(to_jsonb(z)), ''[]''::jsonb) from (%s) z', v_sql) into v_res;
  return jsonb_build_object('ok', true, 'sql', v_sql, 'period', v_per,
                            'entity_column', v_ent, 'rows', v_res);
end $fn$;

create or replace function public.tool_distinct_values(
  p_dataset_id bigint, p_column text, p_search text default null, p_limit int default 30)
returns jsonb language plpgsql security invoker
set search_path = public, pg_catalog
set statement_timeout = '15s' as $fn$
declare v_res jsonb;
begin
  if not exists (select 1 from public.dataset_columns
                  where dataset_id = p_dataset_id and column_name = p_column) then
    return jsonb_build_object('ok', false, 'error', format('columna no valida: %s', p_column));
  end if;
  select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into v_res from (
    select value, n from public.dataset_values
     where dataset_id = p_dataset_id and column_name = p_column
       and (p_search is null or value ilike '%' || p_search || '%')
     order by n desc limit greatest(1, least(coalesce(p_limit,30), 200))) z;
  return jsonb_build_object('ok', true, 'column', p_column, 'rows', v_res);
end $fn$;

create or replace function public.tool_periods(p_dataset_id bigint)
returns jsonb language sql stable security invoker
set search_path = public, pg_catalog as $fn$
  select jsonb_build_object(
    'ok', true,
    'periods', coalesce(metrics->'periods', '[]'::jsonb),
    'default_period', default_period,
    'latest_is_partial', metrics->'latest_is_partial')
  from public.dataset_metrics where dataset_id = p_dataset_id;
$fn$;

grant execute on function public.dataset_context(bigint)                              to authenticated;
grant execute on function public.match_values(bigint,text,text,int)                   to authenticated;
grant execute on function public.match_kb(bigint,extensions.vector,int,numeric)       to authenticated;
grant execute on function public.match_cached_question(bigint,extensions.vector,numeric,jsonb) to authenticated;
grant execute on function public.save_query_cache(bigint,text,extensions.vector,text,jsonb,text) to authenticated;
grant execute on function public.touch_query_cache(bigint,boolean)                    to authenticated;
grant execute on function public.tool_headcount(bigint,text,text,text,text)           to authenticated;
grant execute on function public.tool_distinct_values(bigint,text,text,int)           to authenticated;
grant execute on function public.tool_periods(bigint)                                 to authenticated;
