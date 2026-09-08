-- =====================================================================
-- ADIA 0029 - histograma con filtros estrechos.
-- width_bucket falla con 2201G ("lower bound cannot equal upper bound")
-- cuando el limite inferior iguala al superior, y al filtrar a una sola
-- persona eso ocurre siempre. Se calculan los extremos antes y, si
-- coinciden, se devuelve un unico tramo en vez de reventar el tablero.
-- =====================================================================

create or replace function public.dashboard_slice(
  p_dataset_id bigint,
  p_period     text  default null,           -- 'YYYY-MM-01'; null = periodo por defecto
  p_filters    jsonb default '{}'::jsonb,    -- {"columna": "valor", ...} igualdad exacta
  p_search     text  default null            -- busqueda parcial sobre la columna de identidad
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_catalog
set statement_timeout = '25s' as $fn$
declare
  v_t text; prof jsonb; v_ent text; v_money text; v_hasper boolean;
  v_def text; v_period text; v_prev text;
  v_where text := 'where true'; v_where_all text := 'where true';
  v_kpi jsonb; v_r jsonb; v_groups jsonb; v_hist jsonb; v_series jsonb;
  v_brk jsonb := '{}'::jsonb; v_earners jsonb; v_cat text;
  k text; v text; c record; v_applied jsonb := '[]'::jsonb;
  v_lo numeric; v_hi numeric;
begin
  select profile, format('%I.%I', phys_schema, phys_table) into prof, v_t
    from public.datasets where id = p_dataset_id;
  if v_t is null then return jsonb_build_object('ok', false, 'error', 'DATASET_NO_ENCONTRADO'); end if;

  v_ent    := prof->>'entity_column';
  v_money  := app.primary_money(p_dataset_id);
  v_hasper := (prof->>'period_column') is not null;
  select default_period into v_def from public.dataset_metrics where dataset_id = p_dataset_id;
  v_period := coalesce(p_period, v_def);

  -- Filtros: solo columnas que existan de verdad en este dataset.
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_filters, '{}'::jsonb)) loop
    if v is null or btrim(v) = '' then continue; end if;
    if not exists (select 1 from public.dataset_columns
                    where dataset_id = p_dataset_id and column_name = k) then
      return jsonb_build_object('ok', false, 'error', format('columna no valida: %s', k));
    end if;
    v_where     := v_where     || format(' and %I::text = %L', k, v);
    v_where_all := v_where_all || format(' and %I::text = %L', k, v);
    v_applied   := v_applied   || jsonb_build_object('column', k, 'value', v);
  end loop;

  if p_search is not null and btrim(p_search) <> '' and v_ent is not null then
    v_where     := v_where     || format(' and %I ilike %L', v_ent, '%' || btrim(p_search) || '%');
    v_where_all := v_where_all || format(' and %I ilike %L', v_ent, '%' || btrim(p_search) || '%');
    v_applied   := v_applied   || jsonb_build_object('column', v_ent, 'value', btrim(p_search),
                                                     'op', 'contiene');
  end if;

  -- v_where lleva ademas el periodo; v_where_all recorre toda la serie.
  if v_hasper and v_period is not null then
    v_where := v_where || format(' and period = %L::date', v_period);
    select max(p) into v_prev from (
      select jsonb_array_elements_text(coalesce(prof->'periods', metrics->'periods')) p
        from public.dataset_metrics where dataset_id = p_dataset_id) z
     where p < v_period;
  end if;

  ---------------------------------------------------------------- KPIs
  execute format($q$
    select jsonb_build_object(
      'headcount',  %1$s,
      'rows',       count(*),
      'total_cost', round(coalesce(sum(%2$I),0)::numeric, 2),
      'avg_pay',    round(coalesce(avg(%2$I),0)::numeric, 2),
      'median_pay', round(coalesce(percentile_cont(0.5) within group (order by %2$I),0)::numeric, 2),
      'p10',        round(coalesce(percentile_cont(0.10) within group (order by %2$I),0)::numeric, 2),
      'p90',        round(coalesce(percentile_cont(0.90) within group (order by %2$I),0)::numeric, 2),
      'max_pay',    round(coalesce(max(%2$I),0)::numeric, 2),
      'min_pay',    round(coalesce(min(%2$I),0)::numeric, 2))
    from %3$s %4$s $q$,
    case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
    v_money, v_t, v_where) into v_kpi;

  if v_prev is not null then
    execute format($q$
      select jsonb_build_object('headcount_prev', %1$s,
                                'total_cost_prev', round(coalesce(sum(%2$I),0)::numeric,2))
      from %3$s %4$s and period = %5$L::date $q$,
      case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where_all, v_prev) into v_r;
    v_kpi := v_kpi || v_r;
  end if;

  execute format($q$
    with b as (select %1$I v from %2$s %3$s),
         t as (select count(v) n, sum(v) s from b)
    select jsonb_build_object(
      'top1_share', round(coalesce((select sum(v) from (select v from b where v is not null
                      order by v desc limit greatest(1,(select ceil(n*0.01) from t)::int)) z)
                      / nullif((select s from t),0) * 100, 0)::numeric, 2),
      'top10_share', round(coalesce((select sum(v) from (select v from b where v is not null
                      order by v desc limit greatest(1,(select ceil(n*0.10) from t)::int)) z)
                      / nullif((select s from t),0) * 100, 0)::numeric, 2))
    $q$, v_money, v_t, v_where) into v_r;
  v_kpi := v_kpi || v_r;

  v_kpi := v_kpi || jsonb_build_object(
    'p90_p10', case when (v_kpi->>'p10')::numeric > 0
               then round((v_kpi->>'p90')::numeric / (v_kpi->>'p10')::numeric, 2) end,
    'cost_per_head', case when (v_kpi->>'headcount')::numeric > 0
               then round((v_kpi->>'total_cost')::numeric / (v_kpi->>'headcount')::numeric, 2) end);

  if v_hasper and v_ent is not null and v_prev is not null then
    execute format($q$
      select jsonb_build_object(
        'entrants', (select count(*) from (
            select %1$I from %2$s %3$s and period = %4$L::date
            except select %1$I from %2$s %3$s and period = %5$L::date) a),
        'leavers',  (select count(*) from (
            select %1$I from %2$s %3$s and period = %5$L::date
            except select %1$I from %2$s %3$s and period = %4$L::date) b))
      $q$, v_ent, v_t, v_where_all, v_period, v_prev) into v_r;
    v_kpi := v_kpi || v_r;
  end if;

  ------------------------------------------------------------- series
  if v_hasper then
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'period', p, 'headcount', hc, 'cost', cost, 'avg_pay', ap) order by p), '[]'::jsonb)
      from (select period p, %1$s hc,
                   round(coalesce(sum(%2$I),0)::numeric,2) cost,
                   round(coalesce(avg(%2$I),0)::numeric,2) ap
              from %3$s %4$s and period is not null group by 1) z $q$,
      case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where_all) into v_series;
  else
    v_series := '[]'::jsonb;
  end if;

  --------------------------------------------------- rankings y desgloses
  select column_name into v_cat from public.dataset_columns
   where dataset_id = p_dataset_id and role = 'category' and is_analyzable
   order by distinct_count desc limit 1;

  if v_cat is not null then
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', g, 'headcount', hc, 'cost', cost, 'avg_pay', ap) order by hc desc), '[]'::jsonb)
      from (select coalesce(%1$I::text,'(sin dato)') g, %2$s hc,
                   round(coalesce(sum(%3$I),0)::numeric,2) cost,
                   round(coalesce(avg(%3$I),0)::numeric,2) ap
              from %4$s %5$s group by 1 order by hc desc limit 15) z $q$,
      v_cat, case when v_ent is not null then format('count(distinct %I)', v_ent) else 'count(*)' end,
      v_money, v_t, v_where) into v_groups;
  else
    v_groups := '[]'::jsonb;
  end if;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from
      (select %1$s, round(%2$I::numeric,2) as pago %3$s
         from %4$s %5$s order by %2$I desc nulls last limit 25) z $q$,
    coalesce(quote_ident(v_ent), '_row_idx'), v_money,
    coalesce((select ', ' || string_agg(quote_ident(column_name), ', ')
                from (select column_name from public.dataset_columns
                       where dataset_id = p_dataset_id and role = 'category' and is_analyzable
                       order by distinct_count desc limit 2) s), ''),
    v_t, v_where) into v_earners;

  -- width_bucket lanza 2201G si el limite inferior iguala al superior, y en
  -- cuanto se filtra a un solo valor (buscar una persona concreta) eso pasa
  -- siempre. Se miran los extremos antes y se degrada a un unico tramo.
  execute format('select min(%1$I), max(%1$I) from %2$s %3$s and %1$I > 0',
                 v_money, v_t, v_where) into v_lo, v_hi;

  if v_lo is null or v_hi is null or v_hi <= v_lo then
    execute format($q$
      select case when count(*) = 0 then '[]'::jsonb
                  else jsonb_build_array(jsonb_build_object(
                         'bucket', 1, 'lo', round(min(%1$I)::numeric,2),
                         'hi', round(max(%1$I)::numeric,2), 'n', count(*))) end
      from %2$s %3$s and %1$I is not null and %1$I > 0 $q$,
      v_money, v_t, v_where) into v_hist;
  else
    execute format($q$
      select coalesce(jsonb_agg(jsonb_build_object('bucket', b, 'lo', lo, 'hi', hi, 'n', n) order by b), '[]'::jsonb)
      from (select width_bucket(ln(greatest(%1$I,1)), ln(greatest(%4$L::numeric,1)),
                                ln(greatest(%5$L::numeric,2)), 24) b,
                   round(min(%1$I)::numeric,2) lo, round(max(%1$I)::numeric,2) hi, count(*) n
              from %2$s %3$s and %1$I is not null and %1$I > 0 group by 1) z $q$,
      v_money, v_t, v_where, v_lo, v_hi) into v_hist;
  end if;

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

  return jsonb_build_object(
    'ok', true,
    'period', v_period, 'prev_period', v_prev,
    'entity_column', v_ent, 'primary_money', v_money,
    'applied', v_applied,
    'kpi', v_kpi, 'series', v_series, 'top_groups', v_groups,
    'top_earners', v_earners, 'histogram', v_hist, 'breakdowns', v_brk);
end $fn$;

grant execute on function public.dashboard_slice(bigint,text,jsonb,text) to authenticated;
