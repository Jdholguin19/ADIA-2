-- =====================================================================
-- ADIA 0010 - restauracion exacta del rol tras la caja de arena.
--
-- exec_analysis_sql hacia RESET ROLE, que vuelve al rol de SESION. Bajo
-- PostgREST el rol de sesion es 'authenticator' y el rol efectivo lo pone
-- un SET LOCAL ROLE 'authenticated': tras un RESET, el resto de la
-- transaccion correria como authenticator. Se guarda el rol previo y se
-- restaura tal cual.
-- =====================================================================

create or replace function app.restore_role(p_prev text)
returns void language plpgsql as $fn$
begin
  if p_prev is null or p_prev = '' or lower(p_prev) = 'none' then
    reset role;
  else
    execute format('set local role %I', p_prev);
  end if;
exception when others then
  reset role;
end $fn$;

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
  -- Rol vigente ANTES de soltar privilegios. RESET ROLE volveria al rol de
  -- sesion, que bajo PostgREST es 'authenticator', no 'authenticated': las
  -- sentencias siguientes de la misma transaccion correrian con el rol
  -- equivocado. Se restaura exactamente lo que habia.
  v_prev text := current_setting('role', true);
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

  perform app.restore_role(v_prev);
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
  perform app.restore_role(v_prev);
  insert into public.query_audit(owner_id, dataset_id, question, sql_text, ok, error)
  values (auth.uid(), p_dataset_id, p_question, p_sql, false, left(sqlerrm, 500));
  -- Se devuelve el error en vez de lanzarlo: asi el modelo puede leerlo y
  -- reparar la consulta en la siguiente vuelta, que es de donde sale la
  -- mayor parte de la precision extremo a extremo.
  return jsonb_build_object('ok', false, 'error', sqlstate, 'message', left(sqlerrm, 500));
end $fn$;

revoke all on function public.exec_analysis_sql(bigint,text,jsonb,int,text) from public;
grant execute on function public.exec_analysis_sql(bigint,text,jsonb,int,text) to authenticated;
