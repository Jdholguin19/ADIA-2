-- =====================================================================
-- ADIA 0016 - build_dashboard emitia dos WHERE seguidos.
-- El filtro de periodo ya venia como "where period = ...", y las consultas
-- de concentracion e histograma anadian su propio "where ... is not null",
-- produciendo "where period = X where col is not null" (42601). Se usa un
-- conector calculado ('where' si no hay filtro previo, 'and' si lo hay).
-- =====================================================================

create or replace function app.build_dashboard(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  prof jsonb; v_ent text; v_money text; v_grain text; v_hasper boolean;
  v_periods jsonb; v_def text; v_prev text; v_yoy text;
  v_median_rows numeric; v_last_rows bigint; v_partial boolean := false;
  v_kpi jsonb := '{}'::jsonb; v_series jsonb; v_top_pos jsonb; v_top_earn jsonb;
  v_hist jsonb; v_brk jsonb := '{}'::jsonb; v_r jsonb; c record;
  v_where text; v_where_prev text;
  v_and text;   -- 'where' o 'and', segun si ya hay filtro de periodo
begin
  select profile into prof from public.datasets where id = p_dataset_id;
  v_grain  := coalesce(prof->>'grain', 'snapshot');
  v_ent    := prof->>'entity_column';
  v_money  := app.primary_money(p_dataset_id);
  v_hasper := (prof->>'period_column') is not null;

  perform app.set_phase(p_dataset_id, 'analyzing', 85, 'Calculando indicadores');

  if v_hasper then
    execute format('select coalesce(jsonb_agg(p order by p), ''[]''::jsonb) from '
                   '(select distinct period p from %s where period is not null) z', v_t)
      into v_periods;

    -- Periodo parcial: si el ultimo mes viene incompleto y se toma por
    -- defecto, se fabrica una caida de plantilla que no existe y saltan
    -- todas las alertas de variacion mensual.
    execute format(
      'select percentile_cont(0.5) within group (order by n), '
      '       max(n) filter (where p = (select max(period) from %1$s)) '
      'from (select period p, count(*) n from %1$s where period is not null group by 1) z', v_t)
      into v_median_rows, v_last_rows;

    v_partial := v_median_rows is not null and v_last_rows < v_median_rows * 0.8;
    v_def  := (v_periods->>(jsonb_array_length(v_periods) - 1));
    if v_partial and jsonb_array_length(v_periods) >= 2 then
      v_def := (v_periods->>(jsonb_array_length(v_periods) - 2));
    end if;
    v_prev := case when jsonb_array_length(v_periods) >= 2
                   then (v_periods->>(array_position(
                          array(select jsonb_array_elements_text(v_periods)), v_def) - 2)) end;
    v_yoy  := case when jsonb_array_length(v_periods) >= 13
                   then (v_periods->>(array_position(
                          array(select jsonb_array_elements_text(v_periods)), v_def) - 14)) end;

    v_where      := format('where period = %L::date', v_def);
    v_where_prev := case when v_prev is not null then format('where period = %L::date', v_prev) end;
  else
    v_periods := '[]'::jsonb; v_where := ''; v_where_prev := null;
  end if;
  v_and := case when coalesce(v_where, '') = '' then 'where' else 'and' end;

  ---------------------------------------------------------------------
  -- KPIs del periodo vigente
  ---------------------------------------------------------------------
  execute format($q$
    select jsonb_build_object(
      'headcount',    %1$s,
      'rows',         count(*),
      'total_cost',   round(coalesce(sum(%2$I),0)::numeric, 2),
      'avg_pay',      round(coalesce(avg(%2$I),0)::numeric, 2),
      'median_pay',   round(coalesce(percentile_cont(0.5) within group (order by %2$I),0)::numeric, 2),
      'p10',          round(coalesce(percentile_cont(0.10) within group (order by %2$I),0)::numeric, 2),
      'p90',          round(coalesce(percentile_cont(0.90) within group (order by %2$I),0)::numeric, 2),
      'max_pay',      round(coalesce(max(%2$I),0)::numeric, 2),
      'min_pay',      round(coalesce(min(%2$I),0)::numeric, 2))
    from %3$s %4$s $q$,
    case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
    v_money, v_t, v_where) into v_kpi;

  if v_where_prev is not null then
    execute format($q$
      select jsonb_build_object('headcount_prev', %1$s,
                                'total_cost_prev', round(coalesce(sum(%2$I),0)::numeric,2))
      from %3$s %4$s $q$,
      case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where_prev) into v_r;
    v_kpi := v_kpi || v_r;
  end if;

  -- Concentracion y equidad
  execute format($q$
    with b as (select %1$I v from %2$s %3$s),
         t as (select count(v) n, sum(v) s from b)
    select jsonb_build_object(
      'top1_share', round(coalesce((select sum(v) from (select v from b where v is not null order by v desc
                      limit greatest(1, (select ceil(n*0.01) from t)::int)) z)
                      / nullif((select s from t),0) * 100, 0)::numeric, 2),
      'top10_share', round(coalesce((select sum(v) from (select v from b where v is not null order by v desc
                      limit greatest(1, (select ceil(n*0.10) from t)::int)) z)
                      / nullif((select s from t),0) * 100, 0)::numeric, 2))
    $q$, v_money, v_t, v_where) into v_r;
  v_kpi := v_kpi || v_r;

  v_kpi := v_kpi || jsonb_build_object(
    'p90_p10', case when (v_kpi->>'p10')::numeric > 0
               then round((v_kpi->>'p90')::numeric / (v_kpi->>'p10')::numeric, 2) end,
    'cost_per_head', case when (v_kpi->>'headcount')::numeric > 0
               then round((v_kpi->>'total_cost')::numeric / (v_kpi->>'headcount')::numeric, 2) end);

  -- Altas y bajas
  if v_hasper and v_ent is not null and v_prev is not null then
    execute format($q$
      select jsonb_build_object(
        'entrants', (select count(*) from (
            select %1$I from %2$s where period = %3$L::date
            except select %1$I from %2$s where period = %4$L::date) a),
        'leavers',  (select count(*) from (
            select %1$I from %2$s where period = %4$L::date
            except select %1$I from %2$s where period = %3$L::date) b))
      $q$, v_ent, v_t, v_def, v_prev) into v_r;
    v_kpi := v_kpi || v_r;
  end if;

  ---------------------------------------------------------------------
  -- Series temporales
  ---------------------------------------------------------------------
  if v_hasper then
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'period', p, 'headcount', hc, 'cost', cost, 'avg_pay', ap) order by p), '[]'::jsonb)
      from (select period p, %1$s hc,
                   round(coalesce(sum(%2$I),0)::numeric,2) cost,
                   round(coalesce(avg(%2$I),0)::numeric,2) ap
              from %3$s where period is not null group by 1) z $q$,
      case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t) into v_series;
  else
    v_series := '[]'::jsonb;
  end if;

  ---------------------------------------------------------------------
  -- Rankings y distribucion
  ---------------------------------------------------------------------
  select column_name into v_r from public.dataset_columns
   where dataset_id = p_dataset_id and role = 'category' and is_analyzable
   order by distinct_count desc limit 1;

  if v_r is not null then
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', g, 'headcount', hc, 'cost', cost, 'avg_pay', ap) order by hc desc), '[]'::jsonb)
      from (select %1$I::text g, %2$s hc,
                   round(coalesce(sum(%3$I),0)::numeric,2) cost,
                   round(coalesce(avg(%3$I),0)::numeric,2) ap
              from %4$s %5$s group by 1 order by hc desc limit 15) z $q$,
      v_r::text, case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where) into v_top_pos;
  else
    v_top_pos := '[]'::jsonb;
  end if;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from
      (select %1$s, round(%2$I::numeric,2) as pago %3$s
         from %4$s %5$s order by %2$I desc nulls last limit 25) z $q$,
    coalesce(quote_ident(v_ent), '_row_idx'),
    v_money,
    coalesce((select ', ' || string_agg(format('%I', column_name), ', ')
                from public.dataset_columns
               where dataset_id = p_dataset_id and role = 'category' and is_analyzable
               order by distinct_count desc limit 2), ''),
    v_t, v_where) into v_top_earn;

  -- Histograma en escala log: con mediana 667 y maximo 5.538 un eje lineal
  -- amontona todo a la izquierda y no se lee.
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('bucket', b, 'lo', lo, 'hi', hi, 'n', n) order by b), '[]'::jsonb)
    from (select width_bucket(ln(greatest(%1$I,1)),
                   ln(greatest((select min(%1$I) from %2$s %3$s %4$s %1$I > 0),1)),
                   ln(greatest((select max(%1$I) from %2$s %3$s),2)), 24) b,
                 round(min(%1$I)::numeric,2) lo, round(max(%1$I)::numeric,2) hi, count(*) n
            from %2$s %3$s %4$s %1$I is not null and %1$I > 0 group by 1) z $q$,
    v_money, v_t, v_where, v_and) into v_hist;

  for c in
    select column_name from public.dataset_columns
     where dataset_id = p_dataset_id and role = 'category' and is_analyzable
       and coalesce(distinct_count, 0) between 2 and 60
  loop
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object('label', g, 'headcount', hc, 'cost', cost) order by hc desc), '[]'::jsonb)
      from (select coalesce(%1$I::text,'(sin dato)') g, %2$s hc,
                   round(coalesce(sum(%3$I),0)::numeric,2) cost
              from %4$s %5$s group by 1) z $q$,
      c.column_name,
      case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where) into v_r;
    v_brk := v_brk || jsonb_build_object(c.column_name, v_r);
  end loop;

  insert into public.dataset_metrics(dataset_id, default_period, metrics, series, computed_at)
  values (p_dataset_id, v_def,
    jsonb_build_object(
      'grain', v_grain, 'entity_column', v_ent, 'primary_money', v_money,
      'period_column', prof->>'period_column',
      'periods', v_periods, 'default_period', v_def, 'prev_period', v_prev, 'yoy_period', v_yoy,
      'latest_is_partial', v_partial,
      'counting_rule', prof->>'counting_rule',
      'kpi', v_kpi, 'top_groups', v_top_pos, 'top_earners', v_top_earn,
      'histogram', v_hist, 'breakdowns', v_brk),
    v_series, now())
  on conflict (dataset_id) do update
    set default_period = excluded.default_period, metrics = excluded.metrics,
        series = excluded.series, computed_at = excluded.computed_at, narrative = null;

  update public.datasets set profile = profile || jsonb_build_object('primary_money', v_money)
   where id = p_dataset_id;

  return jsonb_build_object('ok', true, 'default_period', v_def, 'primary_money', v_money,
                            'latest_is_partial', v_partial);
end $fn$;

revoke all on function app.build_dashboard(bigint) from public;
