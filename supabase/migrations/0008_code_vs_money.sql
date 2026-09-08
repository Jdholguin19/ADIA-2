-- =====================================================================
-- ADIA 0008 - budget_item seguia clasificandose como dinero.
--
-- Sus valores (1110.001 .. 3230003) tienen parte decimal en el 38% de las
-- filas, asi que la regla "dinero = numero con centimos" lo aceptaba. Pero
-- esos decimales son niveles de un codigo contable, no centimos: ninguna
-- heuristica sobre los numeros puede separarlos de un importe. El nombre
-- si puede, de modo que el patron de codigo pasa a evaluarse ANTES que la
-- regla de dinero por rango (y despues que la de dinero por nombre, para
-- que un "costo_cuenta" siga siendo dinero).
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

    -- El nombre manda sobre la forma. budget_item vale 1110.001: TIENE
    -- decimales, pero son niveles de un codigo contable, no centimos, asi
    -- que ninguna heuristica numerica puede distinguirlo de un importe.
    elsif c.data_type in ('numeric','bigint') and c.column_name ~ v_money_re then
      v_role := 'money';

    elsif c.column_name ~ v_code_re then
      v_role := 'code'; v_analyz := false;

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

