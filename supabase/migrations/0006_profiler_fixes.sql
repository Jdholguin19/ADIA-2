-- =====================================================================
-- ADIA 0006 - correcciones del perfilador
--
-- 1) "dinero" por rango numerico marcaba budget_item (1310005 = codigo de
--    partida presupuestaria) como importe, y el dashboard habria mostrado
--    una columna de $3,2M sin significado. El dinero casi siempre tiene
--    centimos: se exige parte decimal, y los nombres tipo codigo se
--    fuerzan a 'code'.
-- 2) Las reglas aditivas se etiquetaban concatenando nombres de columna,
--    que Postgres trunca a 63 caracteres: la regla salia ilegible. Ahora
--    se usan alias sinteticos y se elige la de MAYOR cobertura, no la
--    primera que pase el umbral.
-- 3) Una columna solo puede declararse derivada de otra ANTERIOR en el
--    archivo. Sin esta guarda, si annual = monthly*12 se cumpliese exacto
--    en ambos sentidos, monthly_remuneration podria marcarse como derivada
--    y el dataset se quedaria sin columna de dinero primaria.
-- =====================================================================

create or replace function app.profile_dataset(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  c record; v_n bigint; v_stats jsonb; v_role text; v_analyz boolean;
  v_ex jsonb; v_dec numeric;
  v_money_re text :=
    '(remunerac|salar|sueldo|ingreso|haber|monto|valor|pago|costo|coste|amount|salary|wage|pay|cost|revenue|precio|importe|nomina)';
  v_code_re text :=
    '(item|code|codigo|cuenta|partida|account|_id$|^id$|nro|num_|numero|folio|ruc|cedula|dni|matricula|placa|serie)';
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
          'n_neg',  count(*) filter (where %2$I < 0),
          'frac_decimal', round((count(*) filter (where %2$I is not null and %2$I <> trunc(%2$I)))::numeric
                                / nullif(count(%2$I),0), 4))
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

    v_role := c.role;
    v_analyz := true;
    v_dec := coalesce((v_stats->>'frac_decimal')::numeric, 0);

    if (v_stats->>'distinct')::bigint <= 1 then
      v_role := 'constant'; v_analyz := false;

    elsif c.role = 'date_part' or c.data_type = 'date' then
      v_role := coalesce(nullif(c.role, 'unknown'), 'date');

    -- INDICE ORDINAL: rango contiguo que arranca en 0/1. Sin esta regla el
    -- perfilador elegiria 'no' como clave de entidad (dentro de un mes tiene
    -- ~4000 valores para ~4000 filas, identico a una identidad) y todo el
    -- headcount saldria mal pareciendo correcto.
    elsif c.data_type = 'bigint'
      and (v_stats->>'min')::numeric in (0, 1)
      and (v_stats->>'distinct')::bigint >= 100
      and ((v_stats->>'max')::numeric - (v_stats->>'min')::numeric + 1)
          = (v_stats->>'distinct')::numeric then
      v_role := 'ordinal_index'; v_analyz := false;

    -- Nombre de codigo => identificador, nunca magnitud.
    elsif c.column_name ~ v_code_re and v_dec = 0 then
      v_role := 'code'; v_analyz := false;

    elsif c.data_type in ('numeric','bigint') and c.column_name ~ v_money_re then
      v_role := 'money';

    -- Dinero por forma: rango plausible, no negativo y CON centimos.
    -- La exigencia de decimales es lo que separa un importe de un codigo.
    elsif c.data_type = 'numeric'
      and v_dec >= 0.2
      and (v_stats->>'max')::numeric between 10 and 100000000
      and coalesce((v_stats->>'min')::numeric, 0) >= 0 then
      v_role := 'money';

    elsif c.data_type = 'bigint' and (v_stats->>'distinct')::bigint > 50 then
      v_role := 'code'; v_analyz := false;

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

    -- Numerica de cardinalidad ridicula: promediarla da un numero sin
    -- sentido con aspecto de significativo (14to = {29.5, 30.5}).
    if v_role in ('money','metric') and (v_stats->>'distinct')::bigint <= 3 then
      v_stats := v_stats || jsonb_build_object('low_cardinality_numeric', true);
    end if;

    update public.dataset_columns
       set stats = v_stats, examples = v_ex, role = v_role, is_analyzable = v_analyz,
           null_count = (v_stats->>'nulls')::bigint,
           distinct_count = (v_stats->>'distinct')::bigint,
           derived_rule = null
     where dataset_id = p_dataset_id and ordinal = c.ordinal;
  end loop;

  return jsonb_build_object('ok', true, 'n_rows', v_n);
end $fn$;

-- ---------------------------------------------------------------------
create or replace function app.detect_derived_columns(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  v_cols text[]; v_ord jsonb := '{}'::jsonb;
  a text; b text; c text;
  v_ratio numeric; v_cov numeric; v_viol bigint;
  v_found jsonb := '[]'::jsonb;
  v_exprs text[]; v_labels text[]; v_sub text[]; v_res jsonb;
  i int; j int; k int; v_tot bigint;
  v_best_cov numeric; v_best_lbl text; v_best_viol bigint; kk text; vv bigint;
begin
  select array_agg(column_name order by ordinal),
         jsonb_object_agg(column_name, ordinal)
    into v_cols, v_ord
    from public.dataset_columns
   where dataset_id = p_dataset_id and data_type in ('numeric','bigint')
     and role in ('money','metric') and is_analyzable;

  if v_cols is null or cardinality(v_cols) < 2 then
    return jsonb_build_object('ok', true, 'rules', v_found);
  end if;

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
      if v_cov is null or v_cov < 0.95 then continue; end if;

      execute format(
        'select count(*) from %3$s where %1$I is not null and %2$I is not null '
        '  and abs(%1$I - %2$I * %4$L::numeric) > 0.02',
        a, b, v_t, v_ratio) into v_viol;

      v_found := v_found || jsonb_build_object(
        'target', a, 'kind', 'ratio', 'source', b, 'factor', v_ratio,
        'coverage', round(v_cov, 5), 'violations', v_viol,
        'rule', format('%s = %s * %s', a, b,
                       trim(trailing '.' from trim(trailing '0' from v_ratio::text))));

      -- Derivada solo si la regla es EXACTA y la fuente es anterior en el
      -- archivo: la convencion universal es listar primero la cifra base.
      if v_viol = 0 and (v_ord->>a)::int > (v_ord->>b)::int then
        update public.dataset_columns
           set role = 'derived', is_analyzable = false,
               derived_rule = format('%s = %s * %s', a, b, v_ratio)
         where dataset_id = p_dataset_id and column_name = a;
        exit;
      end if;
    end loop;
  end loop;

  -- (2) Reglas aditivas: c = suma de un subconjunto (2..4 sumandos).
  foreach c in array v_cols loop
    if exists (select 1 from public.dataset_columns
                where dataset_id = p_dataset_id and column_name = c and role = 'derived') then
      continue;
    end if;

    v_sub := array(select x from unnest(v_cols) x where x <> c);
    if cardinality(v_sub) < 2 then continue; end if;
    v_exprs := '{}'; v_labels := '{}';

    for i in 1 .. cardinality(v_sub) loop
      for j in i + 1 .. cardinality(v_sub) loop
        -- Alias sintetico: concatenar nombres reales desborda el limite de
        -- 63 caracteres de identificador y trunca la regla.
        v_labels := v_labels || (v_sub[i] || ' + ' || v_sub[j]);
        v_exprs := v_exprs || format(
          'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0))) <= 0.02) as k%4$s',
          c, v_sub[i], v_sub[j], cardinality(v_labels) - 1);
        for k in j + 1 .. cardinality(v_sub) loop
          v_labels := v_labels || (v_sub[i] || ' + ' || v_sub[j] || ' + ' || v_sub[k]);
          v_exprs := v_exprs || format(
            'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0)+coalesce(%4$I,0))) <= 0.02) as k%5$s',
            c, v_sub[i], v_sub[j], v_sub[k], cardinality(v_labels) - 1);
        end loop;
      end loop;
    end loop;

    if cardinality(v_sub) between 4 and 12 then
      v_labels := v_labels || array_to_string(v_sub, ' + ');
      v_exprs := v_exprs || format(
        'count(*) filter (where abs(%1$I - (%2$s)) <= 0.02) as k%3$s',
        c, (select string_agg(format('coalesce(%I,0)', x), '+') from unnest(v_sub) x),
        cardinality(v_labels) - 1);
    end if;

    if cardinality(v_exprs) = 0 then continue; end if;

    execute format('select to_jsonb(t) from (select count(*) as n_, %s from %s where %I is not null) t',
                   array_to_string(v_exprs, ', '), v_t, c) into v_res;
    v_tot := (v_res->>'n_')::bigint;
    if v_tot is null or v_tot = 0 then continue; end if;

    -- Quedarse con la MEJOR cobertura, no con la primera que pase.
    v_best_cov := 0; v_best_lbl := null; v_best_viol := null;
    for kk, vv in select key, value::text::bigint from jsonb_each(v_res) where key <> 'n_' loop
      if vv::numeric / v_tot > v_best_cov then
        v_best_cov := vv::numeric / v_tot;
        v_best_lbl := v_labels[(substring(kk from 2))::int + 1];
        v_best_viol := v_tot - vv;
      end if;
    end loop;

    if v_best_cov >= 0.99 then
      v_found := v_found || jsonb_build_object(
        'target', c, 'kind', 'additive', 'sources', v_best_lbl,
        'coverage', round(v_best_cov, 5), 'violations', v_best_viol,
        'rule', format('%s = %s', c, v_best_lbl));
      if v_best_viol = 0 then
        update public.dataset_columns
           set role = 'derived', is_analyzable = false,
               derived_rule = format('%s = %s', c, v_best_lbl)
         where dataset_id = p_dataset_id and column_name = c;
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'rules', v_found);
end $fn$;
