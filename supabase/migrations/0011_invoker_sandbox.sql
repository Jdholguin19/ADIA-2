-- =====================================================================
-- ADIA 0011 - la caja de arena pasa a SECURITY INVOKER.
--
-- POR QUE. El diseno original bajaba privilegios con
--   SET LOCAL ROLE adia_sql
-- dentro de una funcion SECURITY DEFINER. Eso es IMPOSIBLE en PostgreSQL:
-- el GUC "role" lleva la marca GUC_NOT_WHILE_SEC_REST y, estando dentro de
-- un cambio local de usuario (que es justo lo que hace SECURITY DEFINER),
-- cualquier SET ROLE falla con
--   42501 cannot set parameter "role" within security-definer function
-- Comprobado contra este mismo Postgres 17.6, no deducido.
--
-- QUE SE HACE EN SU LUGAR, que ademas es mas seguro:
-- la funcion se ejecuta como SECURITY INVOKER, es decir con los privilegios
-- del propio usuario. No hay elevacion que revertir ni rol que restaurar, y
-- la frontera de seguridad real pasa a ser la RLS, que es donde debia estar.
-- El usuario no gana NADA que no tuviera ya: authenticated puede lanzar
-- lecturas filtradas via PostgREST desde el navegador de todos modos.
--
-- Reparto de responsabilidades:
--   RLS          -> frontera de seguridad (que filas se pueden ver)
--   lint + plan  -> encauzan al modelo y frenan consultas caras o absurdas
--   auth.users   -> sin GRANT a authenticated: ilegible, con o sin lint
-- =====================================================================

drop function if exists app.restore_role(text);

create or replace function public.exec_analysis_sql(
  p_dataset_id bigint,
  p_sql        text,
  p_params     jsonb default '{}'::jsonb,
  p_max_rows   int   default 500,
  p_question   text  default null
) returns jsonb
language plpgsql security invoker
set search_path = ds, public, pg_catalog
set statement_timeout = '8s'
set lock_timeout = '2s'
set work_mem = '32MB' as $fn$
declare
  v_sch text; v_tbl text;
  v_lint jsonb; v_plan jsonb; v_rows jsonb; v_sql text;
  v_cap int := least(greatest(coalesce(p_max_rows, 500), 1), 5000);
  v_t0 timestamptz := clock_timestamp(); v_ms int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'NO_AUTENTICADO');
  end if;

  -- Al ser SECURITY INVOKER, esta lectura ya pasa por RLS: si no devuelve
  -- fila, o el dataset no existe o no es de este usuario. No hace falta
  -- comparar owner_id a mano.
  select d.phys_schema, d.phys_table into v_sch, v_tbl
    from public.datasets d where d.id = p_dataset_id;
  if v_tbl is null then
    return jsonb_build_object('ok', false, 'error', 'DATASET_NO_ENCONTRADO');
  end if;

  perform app.consume_rate_limit(auth.uid(), 'sql', 120, 60);

  v_lint := app.lint_sql(p_dataset_id, p_sql);
  if coalesce((v_lint->>'ok')::boolean, false) is not true then
    insert into public.query_audit(owner_id, dataset_id, question, sql_text, ok, error)
    values (auth.uid(), p_dataset_id, p_question, p_sql, false, v_lint->>'errors');
    return jsonb_build_object('ok', false, 'error', 'SQL_RECHAZADO', 'lint', v_lint);
  end if;

  v_sql := app.bind_params(p_sql, p_params);
  v_sql := format('select * from (%s) as _adia_q limit %s', v_sql, v_cap);

  -- EXPLAIN planifica pero no ejecuta: expone cada relacion que se tocaria
  -- y delata un nodo de escritura. Un regex se puede burlar; un plan no
  -- puede mentir sobre lo que va a leer.
  execute format('explain (format json, costs true, verbose false) %s', v_sql) into v_plan;
  perform app.assert_plan_safe(p_dataset_id, v_plan, 2e7::float8);

  execute format('select coalesce(jsonb_agg(to_jsonb(_x)), ''[]''::jsonb) from (%s) _x', v_sql)
    into v_rows;

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
  -- El error se DEVUELVE, no se lanza: lanzarlo abortaria la transaccion y
  -- PostgREST daria un 400 opaco. Devolviendolo, el modelo lee el mensaje y
  -- repara la consulta en la vuelta siguiente, que es de donde sale la mayor
  -- parte de la precision extremo a extremo.
  return jsonb_build_object('ok', false, 'error', sqlstate, 'message', left(sqlerrm, 500));
end $fn$;

revoke all on function public.exec_analysis_sql(bigint,text,jsonb,int,text) from public;
grant execute on function public.exec_analysis_sql(bigint,text,jsonb,int,text) to authenticated;

-- assert_plan_safe leia datasets como DEFINER; como invoker le basta la RLS.
create or replace function app.assert_plan_safe(
  p_dataset_id bigint, p_plan jsonb, p_max_cost float8 default 2e7)
returns void language plpgsql stable security invoker
set search_path = public, pg_catalog as $fn$
declare v_sch text; v_tbl text; v_cost float8; v_bad text;
begin
  select phys_schema, phys_table into v_sch, v_tbl
    from public.datasets where id = p_dataset_id;
  if v_tbl is null then raise exception 'DATASET_NO_ENCONTRADO' using errcode = '42501'; end if;

  v_cost := (p_plan->0->'Plan'->>'Total Cost')::float8;
  if v_cost is not null and v_cost > p_max_cost then
    raise exception 'CONSULTA_DEMASIADO_CARA: coste estimado %, maximo %', round(v_cost), p_max_cost
      using errcode = '53400';
  end if;

  with recursive walk(node) as (
      select p_plan
    union all
      select c.child from walk w,
             lateral (
               select value as child from jsonb_each(w.node)         where jsonb_typeof(w.node) = 'object'
               union all
               select value        from jsonb_array_elements(w.node) where jsonb_typeof(w.node) = 'array'
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
    raise exception 'PLAN_RECHAZADO: %', v_bad using errcode = '42501';
  end if;
end $fn$;
