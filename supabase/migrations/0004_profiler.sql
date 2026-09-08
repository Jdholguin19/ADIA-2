-- =====================================================================
-- ADIA 0004 - perfilador: roles de columna, deteccion de grano,
--             columnas derivadas y diccionario de valores.
-- =====================================================================

create or replace function app.qual(p_dataset_id bigint)
returns text language sql stable security definer
set search_path = public, pg_catalog as $fn$
  select format('%I.%I', phys_schema, phys_table) from public.datasets where id = p_dataset_id;
$fn$;

-- ---------------------------------------------------------------------
-- profile_dataset: estadisticas + rol semantico por columna.
-- ---------------------------------------------------------------------
create or replace function app.profile_dataset(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  c record; v_n bigint; v_stats jsonb; v_role text; v_analyz boolean;
  v_ex jsonb; v_money_re text :=
    '(remunerac|salar|sueldo|ingreso|haber|monto|valor|pago|costo|coste|amount|salary|wage|pay|cost|revenue|precio|total)';
begin
  perform app.set_phase(p_dataset_id, 'profiling', 40, 'Perfilando columnas');
  execute format('select count(*) from %s', v_t) into v_n;

  for c in
    select * from public.dataset_columns where dataset_id = p_dataset_id order by ordinal
  loop
    if c.data_type in ('bigint','numeric') then
      execute format($q$
        select jsonb_build_object(
          'n', %1$s, 'nulls', %1$s - count(%2$I), 'distinct', count(distinct %2$I),
          'min', min(%2$I), 'max', max(%2$I), 'avg', round(avg(%2$I)::numeric, 4),
          'sum', sum(%2$I), 'stddev', round(coalesce(stddev_samp(%2$I),0)::numeric, 4),
          'p05', percentile_cont(0.05) within group (order by %2$I),
          'p25', percentile_cont(0.25) within group (order by %2$I),
          'p50', percentile_cont(0.50) within group (order by %2$I),
          'p75', percentile_cont(0.75) within group (order by %2$I),
          'p90', percentile_cont(0.90) within group (order by %2$I),
          'p95', percentile_cont(0.95) within group (order by %2$I),
          'p99', percentile_cont(0.99) within group (order by %2$I),
          'n_zero', count(*) filter (where %2$I = 0),
          'n_neg',  count(*) filter (where %2$I < 0))
        from %3$s $q$, v_n, c.column_name, v_t) into v_stats;
    else
      execute format($q$
        select jsonb_build_object(
          'n', %1$s, 'nulls', %1$s - count(%2$I), 'distinct', count(distinct %2$I),
          'avg_len', round(coalesce(avg(length(%2$I)),0)::numeric, 1),
          'max_len', coalesce(max(length(%2$I)), 0))
        from %3$s $q$, v_n, c.column_name, v_t) into v_stats;
    end if;

    execute format(
      'select coalesce(jsonb_agg(v), ''[]''::jsonb) from '
      '(select distinct %I::text v from %s where %I is not null limit 8) s',
      c.column_name, v_t, c.column_name) into v_ex;

    ---------------------------------------------------------------------
    -- Asignacion de rol. El orden importa: las reglas mas especificas
    -- van primero.
    ---------------------------------------------------------------------
    v_role := c.role;
    v_analyz := true;

    if (v_stats->>'distinct')::bigint <= 1 then
      v_role := 'constant'; v_analyz := false;

    elsif c.role = 'date_part' or c.data_type = 'date' then
      v_role := coalesce(nullif(c.role, 'unknown'), 'date');

    -- INDICE ORDINAL. Sin esta regla el perfilador elige 'no' como clave
    -- de entidad (dentro de un mes tiene ~4000 valores para ~4000 filas,
    -- identico a una identidad) y todo el headcount sale mal pareciendo
    -- correcto. La firma real es ser un rango contiguo que arranca en 0/1.
    elsif c.data_type = 'bigint'
      and (v_stats->>'min')::numeric in (0, 1)
      and (v_stats->>'distinct')::bigint >= 100
      and ((v_stats->>'max')::numeric - (v_stats->>'min')::numeric + 1)
          = (v_stats->>'distinct')::numeric then
      v_role := 'ordinal_index'; v_analyz := false;

    elsif c.data_type = 'numeric' and (
           c.column_name ~ v_money_re
        or ((v_stats->>'p50')::numeric between 10 and 10000000
            and coalesce((v_stats->>'min')::numeric, 0) >= 0)) then
      v_role := 'money';

    elsif c.data_type = 'bigint' and (v_stats->>'distinct')::bigint > 50 then
      v_role := 'code'; v_analyz := false;   -- identificador, no magnitud

    elsif c.data_type in ('bigint','numeric') then
      v_role := 'metric';

    elsif (v_stats->>'distinct')::bigint <= greatest(50, (v_n * 0.01)::bigint) then
      v_role := 'category';

    elsif c.data_type = 'text'
      and (v_stats->>'distinct')::bigint > greatest(200, (v_n * 0.02)::bigint)
      and (v_stats->>'avg_len')::numeric between 3 and 80 then
      v_role := 'identity';

    elsif c.data_type = 'text' and (v_stats->>'avg_len')::numeric > 80 then
      v_role := 'free_text'; v_analyz := false;

    else
      v_role := 'category';
    end if;

    -- Numerica de cardinalidad ridicula: promediarla produce un numero
    -- sin sentido con aspecto de significativo (14to = {29.5, 30.5}).
    if v_role in ('money','metric') and (v_stats->>'distinct')::bigint <= 3 then
      v_stats := v_stats || jsonb_build_object('low_cardinality_numeric', true);
    end if;

    update public.dataset_columns
       set stats = v_stats, examples = v_ex, role = v_role, is_analyzable = v_analyz,
           null_count = (v_stats->>'nulls')::bigint,
           distinct_count = (v_stats->>'distinct')::bigint
     where dataset_id = p_dataset_id and ordinal = c.ordinal;
  end loop;

  return jsonb_build_object('ok', true, 'n_rows', v_n);
end $fn$;

-- ---------------------------------------------------------------------
-- detect_grain: panel / snapshot / transaccion.
-- Esta funcion es la que decide si "cuantos trabajadores hay" responde
-- 93.540, 5.651 o 3.978.
-- ---------------------------------------------------------------------
create or replace function app.detect_grain(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  v_has_period boolean; v_e text; v_m jsonb; v_best jsonb := null;
begin
  select (profile->>'period_column') is not null into v_has_period
    from public.datasets where id = p_dataset_id;

  if not v_has_period then
    return jsonb_build_object('grain', 'snapshot', 'reason', 'sin_dimension_temporal');
  end if;

  for v_e in
    select column_name from public.dataset_columns
     where dataset_id = p_dataset_id and is_analyzable
       and role in ('identity','category')
       and coalesce(distinct_count, 0) >= 10
     order by distinct_count desc
     limit 5
  loop
    execute format($q$
      with base as (
        select period as p, %1$I::text as e from %2$s
         where %1$I is not null and period is not null),
      pairs as (select p, e, count(*) n from base group by 1,2),
      byent as (select e, count(distinct p) c from base group by 1)
      select jsonb_build_object(
        'entity_column',       %1$L,
        'n_rows',              (select count(*) from base),
        'n_periods',           (select count(distinct p) from base),
        'n_entities',          (select count(distinct e) from base),
        'rows_per_pair',       (select round(avg(n)::numeric, 5) from pairs),
        'dup_pairs',           (select count(*) from pairs where n > 1),
        'periods_per_entity',  (select round(avg(c)::numeric, 3) from byent),
        'entities_per_period', (select round(avg(k)::numeric, 1) from
                                 (select p, count(distinct e) k from base group by 1) z),
        'first_period',        (select min(p)::text from base),
        'last_period',         (select max(p)::text from base))
    $q$, v_e, v_t) into v_m;

    if (v_m->>'rows_per_pair')::numeric <= 1.05
       and (v_m->>'periods_per_entity')::numeric >= 1.5
       and (v_m->>'n_periods')::int >= 2 then
      v_best := v_m || jsonb_build_object('grain', 'panel');
      exit;
    end if;
  end loop;

  if v_best is null then
    return jsonb_build_object('grain', 'transaction', 'period_column', 'period',
      'reason', 'varias filas por entidad y periodo: tratar como registro de eventos');
  end if;

  return v_best || jsonb_build_object('period_column', 'period', 'counting_rule', format(
    'UNA FILA = UN %s EN UN PERIODO. La plantilla es count(distinct %I) CON filtro de periodo. '
    'count(*) cuenta filas-mes (%s en total repartidas en %s periodos), NO personas '
    '(%s distintas en todo el historico, ~%s por periodo).',
    upper(v_best->>'entity_column'), v_best->>'entity_column', v_best->>'n_rows',
    v_best->>'n_periods', v_best->>'n_entities', v_best->>'entities_per_period'));
end $fn$;

-- ---------------------------------------------------------------------
-- detect_derived_columns: reglas de razon y aditivas.
-- Sin esto, "coste total" suma cada columna numerica y reporta una
-- nomina ~26x la real: annual (x12) + 13ro + adicionales ya contados.
-- ---------------------------------------------------------------------
create or replace function app.detect_derived_columns(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  v_cols text[]; a text; b text; c text;
  v_ratio numeric; v_cov numeric; v_viol bigint; v_n bigint;
  v_found jsonb := '[]'::jsonb;
  v_exprs text[]; v_sub text[]; v_res jsonb; i int; j int; k int;
begin
  select array_agg(column_name order by ordinal) into v_cols
    from public.dataset_columns
   where dataset_id = p_dataset_id and data_type in ('numeric','bigint')
     and role in ('money','metric') and is_analyzable;

  if v_cols is null or cardinality(v_cols) < 2 then
    return jsonb_build_object('ok', true, 'rules', v_found);
  end if;

  execute format('select count(*) from %s', v_t) into v_n;

  -- (1) Reglas de razon: a = b * k
  foreach a in array v_cols loop
    foreach b in array v_cols loop
      if a = b then continue; end if;
      execute format(
        'select mode() within group (order by round(%1$I / nullif(%2$I,0), 6)) '
        'from %3$s where %1$I is not null and %2$I is not null and %2$I <> 0',
        a, b, v_t) into v_ratio;
      if v_ratio is null or v_ratio = 0 then continue; end if;

      execute format(
        'select count(*) filter (where abs(%1$I - %2$I * %4$L::numeric) <= 0.02)::numeric '
        '     / nullif(count(*),0) '
        'from %3$s where %1$I is not null and %2$I is not null',
        a, b, v_t, v_ratio) into v_cov;

      if v_cov >= 0.95 then
        execute format(
          'select count(*) from %3$s where %1$I is not null and %2$I is not null '
          '  and abs(%1$I - %2$I * %4$L::numeric) > 0.02',
          a, b, v_t, v_ratio) into v_viol;

        v_found := v_found || jsonb_build_object(
          'target', a, 'kind', 'ratio', 'source', b, 'factor', v_ratio,
          'coverage', round(v_cov, 5), 'violations', v_viol,
          'rule', format('%s = %s * %s', a, b, trim(trailing '.' from trim(trailing '0' from v_ratio::text))));

        -- Solo se marca derivada si la regla se cumple SIEMPRE.
        if v_viol = 0 then
          update public.dataset_columns
             set role = 'derived', is_analyzable = false,
                 derived_rule = format('%s = %s * %s', a, b, v_ratio)
           where dataset_id = p_dataset_id and column_name = a;
        end if;
        exit;
      end if;
    end loop;
  end loop;

  -- (2) Reglas aditivas: c = suma de un subconjunto (tamano 2..4).
  foreach c in array v_cols loop
    v_sub := array(select x from unnest(v_cols) x where x <> c);
    if cardinality(v_sub) < 2 then continue; end if;
    v_exprs := '{}';

    for i in 1 .. cardinality(v_sub) loop
      for j in i + 1 .. cardinality(v_sub) loop
        v_exprs := v_exprs || format(
          'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0))) <= 0.02) as "%2$s+%3$s"',
          c, v_sub[i], v_sub[j]);
        for k in j + 1 .. cardinality(v_sub) loop
          v_exprs := v_exprs || format(
            'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0)+coalesce(%4$I,0))) <= 0.02) as "%2$s+%3$s+%4$s"',
            c, v_sub[i], v_sub[j], v_sub[k]);
        end loop;
      end loop;
    end loop;

    -- Los 4 sumandos se prueban aparte para acotar el ancho de la consulta.
    if cardinality(v_sub) >= 4 then
      v_exprs := v_exprs || format(
        'count(*) filter (where abs(%1$I - (%2$s)) <= 0.02) as "%3$s"',
        c, (select string_agg(format('coalesce(%I,0)', x), '+') from unnest(v_sub) x),
        array_to_string(v_sub, '+'));
    end if;

    if cardinality(v_exprs) = 0 then continue; end if;

    execute format('select to_jsonb(t) from (select count(*) as _n, %s from %s where %I is not null) t',
                   array_to_string(v_exprs, ', '), v_t, c) into v_res;

    declare kk text; vv bigint; tot bigint := (v_res->>'_n')::bigint;
    begin
      for kk, vv in select key, value::text::bigint from jsonb_each(v_res) where key <> '_n' loop
        if tot > 0 and vv::numeric / tot >= 0.99 then
          v_found := v_found || jsonb_build_object(
            'target', c, 'kind', 'additive', 'sources', kk,
            'coverage', round(vv::numeric / tot, 5), 'violations', tot - vv,
            'rule', format('%s = %s', c, kk));
          if tot - vv = 0 then
            update public.dataset_columns
               set role = 'derived', is_analyzable = false,
                   derived_rule = format('%s = %s', c, kk)
             where dataset_id = p_dataset_id and column_name = c;
          end if;
          exit;
        end if;
      end loop;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'rules', v_found);
end $fn$;

-- ---------------------------------------------------------------------
-- build_value_dictionary: los valores que EXISTEN de verdad.
-- El text-to-SQL falla sobre todo por desajuste de literal, no de
-- sintaxis: el modelo escribe 'Conserje' y la tabla dice 'CONSERJE'.
-- ---------------------------------------------------------------------
create or replace function app.build_value_dictionary(p_dataset_id bigint, p_max int default 4000)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '180s' as $fn$
declare v_t text := app.qual(p_dataset_id); c record; v_tot int := 0; v_n int;
begin
  delete from public.dataset_values where dataset_id = p_dataset_id;

  for c in
    select column_name, distinct_count from public.dataset_columns
     where dataset_id = p_dataset_id and is_analyzable
       and role in ('category','code')
       and coalesce(distinct_count, 0) between 1 and 5000
  loop
    execute format($q$
      insert into public.dataset_values(dataset_id, column_name, value, n)
      select %1$s, %2$L, %3$I::text, count(*)
        from %4$s where %3$I is not null
       group by %3$I order by count(*) desc limit %5$s
      on conflict (dataset_id, column_name, value) do update set n = excluded.n
    $q$, p_dataset_id, c.column_name, c.column_name, v_t, p_max);
    get diagnostics v_n = row_count;
    v_tot := v_tot + v_n;
  end loop;

  return jsonb_build_object('ok', true, 'values', v_tot);
end $fn$;
