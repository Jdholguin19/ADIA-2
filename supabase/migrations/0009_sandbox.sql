-- =====================================================================
-- ADIA 0009 - caja de arena SQL para las consultas que escribe la IA.
--
-- Defensa en capas:
--   1. Autorizacion ANTES de tocar nada (SECURITY DEFINER se salta RLS).
--   2. Limite de tasa por usuario.
--   3. Lint estatico: gramatica, lista blanca de relaciones y funciones,
--      y GUARDA DE GRANO (la regla que impide responder 93.540 cuando
--      preguntan cuantos empleados hay).
--   4. Parametros ligados como literales entrecomillados.
--   5. LIMIT forzado.
--   6. SET LOCAL ROLE adia_sql: se sueltan privilegios.
--   7. EXPLAIN: valida el PLAN, no el texto. Un regex se puede burlar;
--      un plan no puede mentir sobre lo que va a leer.
--   8. Ejecucion, y RESET ROLE tambien en el manejador de excepciones
--      (SET LOCAL ROLE sobrevive hasta el fin de la TRANSACCION).
-- =====================================================================

create or replace function app.bind_params(p_sql text, p_params jsonb)
returns text language plpgsql immutable as $fn$
declare k text; v jsonb; s text := p_sql;
begin
  if p_params is null or p_params = '{}'::jsonb then return s; end if;
  for k, v in select key, value from jsonb_each(p_params) loop
    if k !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'BAD_PARAM_NAME: %', k using errcode = '22023';
    end if;
    -- quote_nullable escapa el valor: se convierte en literal de texto y
    -- la inyeccion a traves de parametros es estructuralmente imposible.
    s := replace(s, ':' || k,
                 case when jsonb_typeof(v) = 'null' then 'null'
                      else quote_nullable(v #>> '{}') end);
  end loop;
  return s;
end $fn$;

-- ---------------------------------------------------------------------
create or replace function app.assert_plan_safe(
  p_dataset_id bigint, p_plan jsonb, p_max_cost float8 default 2e7)
returns void language plpgsql stable security definer
set search_path = public, pg_catalog as $fn$
declare v_sch text; v_tbl text; v_cost float8; v_bad text;
begin
  select phys_schema, phys_table into v_sch, v_tbl
    from public.datasets where id = p_dataset_id;

  v_cost := (p_plan->0->'Plan'->>'Total Cost')::float8;
  if v_cost is not null and v_cost > p_max_cost then
    raise exception 'QUERY_TOO_EXPENSIVE: coste estimado %, maximo %', round(v_cost), p_max_cost
      using errcode = '53400';
  end if;

  with recursive walk(node) as (
      select p_plan
    union all
      select c.child from walk w,
             lateral (
               select value as child from jsonb_each(w.node)          where jsonb_typeof(w.node) = 'object'
               union all
               select value        from jsonb_array_elements(w.node)  where jsonb_typeof(w.node) = 'array'
             ) c
      where jsonb_typeof(w.node) in ('object','array')
  )
  select string_agg(distinct msg, '; ') into v_bad from (
    select case
      when node->>'Node Type' in ('ModifyTable','LockRows')
        then 'nodo de escritura: ' || (node->>'Node Type')
      when node ? 'Relation Name'
       and not (coalesce(node->>'Schema', v_sch) = v_sch
                and node->>'Relation Name' in (v_tbl, v_tbl || '_q'))
        then 'relacion no permitida: ' || coalesce(node->>'Schema','?') || '.' || (node->>'Relation Name')
      end as msg
    from walk where jsonb_typeof(node) = 'object'
  ) z where msg is not null;

  if v_bad is not null then
    raise exception 'PLAN_REJECTED: %', v_bad using errcode = '42501';
  end if;
end $fn$;

-- ---------------------------------------------------------------------
-- lint_sql
-- ---------------------------------------------------------------------
create or replace function app.lint_sql(p_dataset_id bigint, p_sql text)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog as $fn$
declare
  raw text := btrim(coalesce(p_sql, ''));
  s text; errs text[] := '{}'; warns text[] := '{}';
  prof jsonb; v_sch text; v_tbl text;
  v_grain text; v_ent text; v_per text[]; v_rel text[]; m text[];
  allowed_fn text[] := array[
    'count','sum','avg','min','max','round','coalesce','nullif','abs','greatest','least',
    'percentile_cont','percentile_disc','mode','stddev','stddev_samp','stddev_pop','variance',
    'var_samp','corr','covar_pop','lower','upper','initcap','trim','btrim','ltrim','rtrim',
    'left','right','substr','substring','length','char_length','replace','split_part','concat',
    'concat_ws','position','strpos','translate','to_char','to_date','to_number','date_trunc',
    'extract','date_part','make_date','make_interval','age','now','row_number','rank',
    'dense_rank','percent_rank','cume_dist','lag','lead','ntile','first_value','last_value',
    'nth_value','array_agg','string_agg','jsonb_agg','json_agg','jsonb_build_object','unnest',
    'generate_series','floor','ceil','ceiling','mod','div','sqrt','power','exp','ln','log',
    'sign','trunc','similarity','unaccent','regexp_replace','regexp_match','regexp_matches',
    'starts_with','cast','bool_and','bool_or','every','filter','over','partition','coalesce'];
  sql_kw text[] := array[
    'select','where','and','or','not','in','on','by','as','union','intersect','except','all',
    'distinct','over','partition','filter','order','group','having','when','then','else','end',
    'from','join','using','with','case','asc','desc','limit','offset','is','null','between',
    'like','ilike','exists','any','some','interval','date','numeric','text','int','integer',
    'bigint','boolean','decimal','within','nulls','first','last','recursive','lateral','cross',
    'inner','left','right','full','outer','only','fetch','next','rows','row','value'];
begin
  select d.phys_schema, d.phys_table, d.profile into v_sch, v_tbl, prof
    from public.datasets d where d.id = p_dataset_id;
  if v_tbl is null then
    return jsonb_build_object('ok', false, 'errors', to_jsonb(array['dataset_no_construido']),
                              'warnings', '[]'::jsonb);
  end if;

  v_grain := prof->>'grain';
  v_ent   := prof->>'entity_column';
  v_per   := array_remove(array[prof->>'period_column', prof->>'year_column',
                                prof->>'month_column'], null);
  v_rel   := array[lower(v_sch || '.' || v_tbl), lower(v_tbl),
                   lower(v_sch || '.' || v_tbl || '_q'), lower(v_tbl || '_q')];

  -- Normalizar: fuera literales, fuera comentarios, minusculas, espacios.
  s := regexp_replace(raw, '''([^'']|'''')*''', ' ''L'' ', 'g');
  s := regexp_replace(s,   '--[^' || chr(10) || ']*', ' ', 'g');
  s := regexp_replace(s,   '/\*.*?\*/', ' ', 'gs');
  s := lower(regexp_replace(s, '\s+', ' ', 'g'));

  if length(raw) > 8000 then errs := errs || 'consulta_demasiado_larga'; end if;
  if s !~ '^\s*(with|select)\y' then errs := errs || 'debe_empezar_por_select_o_with'; end if;
  if s ~ ';\s*\S'               then errs := errs || 'varias_sentencias'; end if;
  if s ~ '\y(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|reindex|refresh|call|do|set|reset|listen|notify|lock|prepare|execute|declare|fetch|move|comment|import|begin|commit|rollback|savepoint|returning|into)\y'
    then errs := errs || 'palabra_clave_prohibida'; end if;
  if s ~ '\ypg_[a-z0-9_]+' or s ~ '\y(information_schema|pg_catalog|auth|storage|vault|net|extensions|cron|graphql|public)\.'
    then errs := errs || 'esquema_o_catalogo_prohibido'; end if;
  if s ~ '\y(dblink|lo_import|lo_export|pg_read_file|pg_ls_dir|pg_sleep|query_to_xml|http|xmlelement)\y'
    then errs := errs || 'funcion_prohibida'; end if;

  -- Lista blanca de relaciones: solo la tabla de ESTE dataset.
  for m in select regexp_matches(s, '\y(?:from|join)\s+([a-z_][a-z0-9_$.]*)', 'g') loop
    if not (m[1] = any(v_rel)) then
      errs := errs || format('relacion_no_permitida:%s (usa %s.%s)', m[1], v_sch, v_tbl);
    end if;
  end loop;

  -- Lista blanca de funciones.
  for m in select regexp_matches(s, '([a-z_][a-z0-9_]*)\s*\(', 'g') loop
    if not (m[1] = any(allowed_fn)) and not (m[1] = any(sql_kw)) then
      errs := errs || format('funcion_no_permitida:%s', m[1]);
    end if;
  end loop;

  -------------------------------------------------------------------
  -- GUARDA DE GRANO.
  -- El mensaje esta escrito PARA EL MODELO: cuando el lint falla, este
  -- texto vuelve como resultado de la herramienta y el modelo se corrige
  -- solo en la siguiente vuelta.
  -------------------------------------------------------------------
  if v_grain = 'panel' and v_ent is not null then
    if s ~ '\ycount\s*\(\s*(\*|1)\s*\)'
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      errs := errs || format(
        'conteo_de_filas_en_panel: este dataset tiene una fila por (%s, periodo). '
        'count(*) cuenta filas-mes, no personas. Usa count(distinct %s) y filtra por %s.',
        v_ent, v_ent, array_to_string(v_per, ' o '));
    end if;

    if s ~ ('\ycount\s*\(\s*distinct\s+"?' || v_ent || '"?\s*\)')
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'distinct_sin_periodo: devuelve todo el que aparecio alguna vez (%s en el historico), '
        'no la plantilla actual (~%s por periodo). Filtra por periodo salvo que sea intencionado.',
        coalesce(prof->>'n_entities','?'), coalesce(prof->>'entities_per_period','?'));
    end if;

    if s ~ '\ysum\s*\('
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'suma_sin_periodo: suma los %s periodos del historico. Confirma que es lo que quieres.',
        coalesce(prof->>'n_periods','?'));
    end if;

    if s !~ '\y(count|sum|avg|min|max)\s*\(' and s !~ '\ygroup by\y'
       and s ~ ('\y' || v_ent || '\y')
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'listado_puede_duplicar: sin filtro de periodo cada %s aparece hasta %s veces.',
        v_ent, coalesce(prof->>'n_periods','?'));
    end if;
  end if;

  if s !~ '\ylimit\y' and s !~ '\y(count|sum|avg)\s*\(' and s !~ '\ygroup by\y' then
    warns := warns || 'sin_limit: se aplico un LIMIT automatico.';
  end if;

  return jsonb_build_object('ok', cardinality(errs) = 0,
                            'errors', to_jsonb(errs), 'warnings', to_jsonb(warns));
end $fn$;

-- ---------------------------------------------------------------------
-- exec_analysis_sql
-- ---------------------------------------------------------------------
create or replace function public.exec_analysis_sql(
  p_dataset_id bigint,
  p_sql        text,
  p_params     jsonb default '{}'::jsonb,
  p_max_rows   int   default 500,
  p_question   text  default null
) returns jsonb
language plpgsql security definer
set search_path = ds, public, pg_catalog
set statement_timeout = '8s'
set lock_timeout = '2s'
set work_mem = '32MB' as $fn$
declare
  v_owner uuid; v_sch text; v_tbl text;
  v_lint jsonb; v_plan jsonb; v_rows jsonb; v_sql text;
  v_cap int := least(greatest(coalesce(p_max_rows, 500), 1), 5000);
  v_t0 timestamptz := clock_timestamp(); v_ms int;
begin
  -- (1) Autorizacion a mano: SECURITY DEFINER se salta la RLS aqui.
  select d.owner_id, d.phys_schema, d.phys_table
    into v_owner, v_sch, v_tbl
    from public.datasets d where d.id = p_dataset_id;
  if v_owner is null then raise exception 'DATASET_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  perform app.consume_rate_limit(auth.uid(), 'sql', 120, 60);

  -- (3) Lint
  v_lint := app.lint_sql(p_dataset_id, p_sql);
  if coalesce((v_lint->>'ok')::boolean, false) is not true then
    insert into public.query_audit(owner_id, dataset_id, question, sql_text, ok, error)
    values (auth.uid(), p_dataset_id, p_question, p_sql, false, v_lint->>'errors');
    return jsonb_build_object('ok', false, 'error', 'SQL_RECHAZADO', 'lint', v_lint);
  end if;

  -- (4)(5) Parametros + tope de filas
  v_sql := app.bind_params(p_sql, p_params);
  v_sql := format('select * from (%s) as _adia_q limit %s', v_sql, v_cap);

  -- (6) Soltar privilegios
  set local role adia_sql;

  -- (7) EXPLAIN planifica pero no ejecuta.
  execute format('explain (format json, costs true, verbose false) %s', v_sql) into v_plan;
  perform app.assert_plan_safe(p_dataset_id, v_plan, 2e7::float8);

  -- (8) Ejecutar
  execute format('select coalesce(jsonb_agg(to_jsonb(_x)), ''[]''::jsonb) from (%s) _x', v_sql)
    into v_rows;

  reset role;
  v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;

  insert into public.query_audit(owner_id, dataset_id, question, sql_text, row_count, elapsed_ms, ok)
  values (auth.uid(), p_dataset_id, p_question, v_sql, jsonb_array_length(v_rows), v_ms, true);

  return jsonb_build_object(
    'ok', true, 'sql', v_sql, 'rows', v_rows,
    'row_count', jsonb_array_length(v_rows),
    'truncated', jsonb_array_length(v_rows) >= v_cap,
    'elapsed_ms', v_ms,
    'est_cost', (v_plan->0->'Plan'->>'Total Cost')::float8,
    'warnings', coalesce(v_lint->'warnings', '[]'::jsonb));

exception when others then
  -- OBLIGATORIO: SET LOCAL ROLE dura hasta el fin de la transaccion.
  reset role;
  insert into public.query_audit(owner_id, dataset_id, question, sql_text, ok, error)
  values (auth.uid(), p_dataset_id, p_question, p_sql, false, left(sqlerrm, 500));
  -- Se devuelve el error en vez de lanzarlo: asi el modelo puede leerlo y
  -- reparar la consulta en la siguiente vuelta, que es de donde sale la
  -- mayor parte de la precision extremo a extremo.
  return jsonb_build_object('ok', false, 'error', sqlstate, 'message', left(sqlerrm, 500));
end $fn$;

revoke all on function public.exec_analysis_sql(bigint,text,jsonb,int,text) from public;
grant execute on function public.exec_analysis_sql(bigint,text,jsonb,int,text) to authenticated;
