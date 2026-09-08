-- =====================================================================
-- ADIA 0013 - dejar de tirar empleados reales por UNA celda mala.
--
-- La politica anterior mandaba a cuarentena la fila entera en cuanto un
-- valor no casteaba. En el archivo de nomina eso salia asi:
--
--   56 filas con 5 celdas rotas  -> corrupcion real de la extraccion PDF
--   31 filas con 1 celda rota    -> empleados de verdad cuyo unico defecto
--                                   es un 13ro ilegible... una columna que
--                                   el propio perfilador detecta como
--                                   100% derivada de monthly_remuneration
--
-- Consecuencia: 5 de esas 31 caian en 2016-11 y la plantilla salia 3.973
-- en vez de 3.978. Coherente por dentro, pero mal para gerencia: son
-- personas que existen (con sueldo 0, seguramente sin sueldo ese mes).
--
-- Nueva politica: se castea lo que se puede, se anula lo que no, se anota
-- el fallo por celda en _issues, y solo va a cuarentena la fila con
-- corrupcion ESTRUCTURAL (>= 2 celdas rotas). La separacion en estos datos
-- es limpia: 1 fallo o 5, sin termino medio.
-- =====================================================================

create or replace function app.build_silver(
  p_dataset_id bigint, p_max_bad_cells int default 2)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_owner uuid; v_sch text; v_tbl text; v_qtbl text;
  c record;
  v_defs   text[] := '{}';
  v_names  text[] := '{}';
  v_sel    text[] := '{}';
  v_checks text[] := '{}';
  v_norm   text[] := '{}';
  v_year text; v_month text; v_datecol text; v_period text := null;
  v_n bigint; v_q bigint; v_iss bigint; v_sql text;
begin
  select owner_id, phys_schema, phys_table into v_owner, v_sch, v_tbl
    from public.datasets where id = p_dataset_id;
  if v_tbl is null then raise exception 'DATASET_NO_CONSTRUIDO' using errcode = 'P0002'; end if;
  v_qtbl := v_tbl || '_q';

  perform app.set_phase(p_dataset_id, 'building', 5, 'Construyendo tabla tipada');

  for c in
    select * from public.dataset_columns where dataset_id = p_dataset_id order by ordinal
  loop
    v_names := v_names || quote_ident(c.column_name);
    v_defs  := v_defs  || format('%I %s', c.column_name, app.pg_type_for(c.data_type));
    v_sel   := v_sel   || app.coerce_expr(c.column_name, c.data_type, c.decimal_sep);

    if c.data_type <> 'text' then
      v_checks := v_checks || format(
        'case when nullif(btrim(data->>%L), '''') is not null and %s is null then %L end',
        c.column_name, app.coerce_expr(c.column_name, c.data_type, c.decimal_sep),
        c.column_name || ':no_es_' || c.data_type);
    end if;

    if c.role = 'category' then v_norm := v_norm || c.column_name; end if;

    if c.role = 'date_part' then
      if c.column_name ~ '^(year|anio|ano|yr|a_o)$' then v_year := c.column_name;
      elsif c.column_name ~ '^(month|mes|mo)$'      then v_month := c.column_name;
      end if;
    elsif c.data_type = 'date' and v_datecol is null then
      v_datecol := c.column_name;
    end if;
  end loop;

  if v_year is not null and v_month is not null then
    v_period := format(
      'period date generated always as (case when %1$I between 1900 and 2100 '
      'and %2$I between 1 and 12 then make_date(%1$I::int, %2$I::int, 1) end) stored',
      v_year, v_month);
  elsif v_datecol is not null then
    v_period := format(
      'period date generated always as (date_trunc(''month'', %1$I::timestamp)::date) stored',
      v_datecol);
  end if;

  execute format('drop table if exists %I.%I cascade', v_sch, v_tbl);
  execute format('drop table if exists %I.%I cascade', v_sch, v_qtbl);

  -- _issues guarda los fallos por celda de las filas que SI se conservan.
  execute format('create table %I.%I (_row_idx bigint primary key, _issues text[], %s%s%s)',
    v_sch, v_tbl,
    array_to_string(v_defs, ', '),
    case when cardinality(v_norm) > 0
         then ', ' || (select string_agg(format('%I text', n || '_norm'), ', ') from unnest(v_norm) n)
         else '' end,
    case when v_period is not null then ', ' || v_period else '' end);

  execute format(
    'create table %I.%I (_row_idx bigint primary key, reasons text[] not null, data jsonb not null)',
    v_sch, v_qtbl);

  v_sql := format($q$
    with src as (
      select row_idx, data, array_remove(array[%s], null) as reasons
        from public.dataset_rows where dataset_id = %s
    ), bad as (
      insert into %I.%I (_row_idx, reasons, data)
      select row_idx, reasons, data from src where cardinality(reasons) >= %s
      returning 1
    )
    insert into %I.%I (_row_idx, _issues, %s)
    select row_idx, nullif(reasons, '{}'::text[]), %s
      from src where cardinality(reasons) < %s
  $q$,
    case when cardinality(v_checks) > 0 then array_to_string(v_checks, ', ') else 'null::text' end,
    p_dataset_id, v_sch, v_qtbl, p_max_bad_cells, v_sch, v_tbl,
    array_to_string(v_names, ', '), array_to_string(v_sel, ', '), p_max_bad_cells);
  execute v_sql;

  if cardinality(v_norm) > 0 then
    execute format('update %I.%I set %s', v_sch, v_tbl,
      (select string_agg(format('%I = %I', n || '_norm', n), ', ') from unnest(v_norm) n));
  end if;

  execute format('select count(*) from %I.%I', v_sch, v_tbl)  into v_n;
  execute format('select count(*) from %I.%I', v_sch, v_qtbl) into v_q;
  execute format('select count(*) from %I.%I where _issues is not null', v_sch, v_tbl) into v_iss;

  if v_period is not null then
    execute format('create index %I on %I.%I (period)', v_tbl || '_period_idx', v_sch, v_tbl);
  end if;
  for c in
    select column_name, role from public.dataset_columns
     where dataset_id = p_dataset_id and is_analyzable
       and role in ('identity','category','money')
  loop
    if v_period is not null then
      execute format('create index %I on %I.%I (%I, period)',
        left(v_tbl || '_' || c.column_name || '_p_idx', 63), v_sch, v_tbl, c.column_name);
    else
      execute format('create index %I on %I.%I (%I)',
        left(v_tbl || '_' || c.column_name || '_idx', 63), v_sch, v_tbl, c.column_name);
    end if;
    if c.role = 'category' then
      execute format('create index %I on %I.%I using gin (%I extensions.gin_trgm_ops)',
        left(v_tbl || '_' || c.column_name || '_trgm', 63), v_sch, v_tbl, c.column_name);
    end if;
  end loop;

  execute format('alter table %I.%I enable row level security', v_sch, v_tbl);
  execute format('alter table %I.%I enable row level security', v_sch, v_qtbl);
  execute format(
    'create policy sel_own on %I.%I for select to authenticated, adia_sql using (auth.uid() = %L::uuid)',
    v_sch, v_tbl, v_owner);
  execute format(
    'create policy sel_own on %I.%I for select to authenticated, adia_sql using (auth.uid() = %L::uuid)',
    v_sch, v_qtbl, v_owner);
  execute format('grant select on %I.%I to authenticated, adia_sql', v_sch, v_tbl);
  execute format('grant select on %I.%I to authenticated, adia_sql', v_sch, v_qtbl);

  execute format('analyze %I.%I', v_sch, v_tbl);

  update public.datasets
     set n_rows_silver = v_n, n_rows_quarantined = v_q,
         profile = profile || jsonb_build_object(
           'period_column', case when v_period is not null then 'period' else null end,
           'year_column', v_year, 'month_column', v_month,
           'norm_columns', to_jsonb(v_norm),
           'rows_with_issues', v_iss)
   where id = p_dataset_id;

  perform app.set_phase(p_dataset_id, 'building', 35,
    format('%s filas tipadas (%s con alguna celda ilegible), %s en cuarentena', v_n, v_iss, v_q));

  return jsonb_build_object('ok', true, 'rows', v_n, 'quarantined', v_q,
                            'rows_with_issues', v_iss, 'has_period', v_period is not null);
end $fn$;

-- ---------------------------------------------------------------------
-- Orquestador: un solo punto de entrada para reconstruir todo el analisis.
-- ---------------------------------------------------------------------
create or replace function public.rebuild_dataset(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '290s' as $fn$
declare v_owner uuid; v_out jsonb := '{}'::jsonb; v_grain jsonb;
begin
  select owner_id into v_owner from public.datasets where id = p_dataset_id;
  if v_owner is null then raise exception 'DATASET_NO_ENCONTRADO' using errcode = 'P0002'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'PROHIBIDO' using errcode = '42501'; end if;

  v_out := v_out || jsonb_build_object('types',   app.validate_types(p_dataset_id));
  v_out := v_out || jsonb_build_object('silver',  app.build_silver(p_dataset_id));
  v_out := v_out || jsonb_build_object('profile', app.profile_dataset(p_dataset_id));

  v_grain := app.detect_grain(p_dataset_id);
  update public.datasets set profile = profile || v_grain where id = p_dataset_id;
  v_out := v_out || jsonb_build_object('grain', v_grain);

  v_out := v_out || jsonb_build_object('derived', app.detect_derived_columns(p_dataset_id));
  v_out := v_out || jsonb_build_object('values',  app.build_value_dictionary(p_dataset_id));

  perform app.set_phase(p_dataset_id, 'analyzing', 80, 'Analisis base completo');
  return v_out;
end $fn$;

revoke all on function public.rebuild_dataset(bigint) from public;
grant execute on function public.rebuild_dataset(bigint) to authenticated;
