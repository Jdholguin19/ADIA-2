-- =====================================================================
-- ADIA 0003 - capa PLATA: tabla fisica tipada por dataset.
--
-- Por que fisica y no una vista que castea sobre jsonb:
--   (data->>'supplementary_hours')::numeric revienta en cuanto UNA celda
--   contiene '222,91  c) Rem'. Postgres no garantiza que el WHERE se
--   evalue antes del cast del SELECT, asi que una fila corrupta tumba
--   TODA consulta que toque la columna, incluido el dashboard. Casteamos
--   una sola vez, al cargar, y lo que falla se va a cuarentena.
-- =====================================================================

create or replace function app.to_bool_safe(v text)
returns boolean language sql immutable parallel safe
set search_path = pg_catalog as $fn$
  select case lower(btrim(coalesce(v, '')))
           when 'true' then true   when 'false' then false
           when 't'    then true   when 'f'     then false
           when '1'    then true   when '0'     then false
           when 'si'   then true   when 'no'    then false
           when 'yes'  then true   when 'y'     then true
           when 'verdadero' then true when 'falso' then false
           else null end
$fn$;

create or replace function app.to_date_safe(v text)
returns date language plpgsql immutable parallel safe
set search_path = pg_catalog as $fn$
declare t text;
begin
  t := btrim(coalesce(v, ''));
  if t = '' then return null; end if;
  if t ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then return left(t, 10)::date; end if;
  if t ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then return to_date(t, 'DD/MM/YYYY'); end if;
  if t ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' then return to_date(t, 'DD-MM-YYYY'); end if;
  return null;
exception when others then return null;
end $fn$;

create or replace function app.set_phase(
  p_dataset_id bigint, p_phase text, p_pct numeric, p_msg text default null)
returns void language sql security definer
set search_path = public, pg_catalog as $fn$
  update public.datasets
     set phase = p_phase, phase_pct = p_pct, phase_message = coalesce(p_msg, phase_message),
         status = case when p_phase in ('ready','error') then p_phase else status end
   where id = p_dataset_id;
$fn$;

-- Expresion de tipo para el DDL de la columna plata.
create or replace function app.pg_type_for(p_type text)
returns text language sql immutable as $fn$
  select case p_type
           when 'bigint'  then 'bigint'
           when 'numeric' then 'numeric(20,4)'
           when 'boolean' then 'boolean'
           when 'date'    then 'date'
           else 'text' end
$fn$;

-- Expresion de coercion desde el jsonb bronce.
create or replace function app.coerce_expr(p_col text, p_type text, p_sep char)
returns text language sql immutable as $fn$
  select case p_type
    when 'bigint'  then format('app.to_bigint_safe(data->>%L)', p_col)
    when 'numeric' then format('app.to_numeric_safe(data->>%L, %L)', p_col, p_sep)
    when 'boolean' then format('app.to_bool_safe(data->>%L)', p_col)
    when 'date'    then format('app.to_date_safe(data->>%L)', p_col)
    else                format('nullif(btrim(data->>%L), '''')', p_col)
  end
$fn$;

-- ---------------------------------------------------------------------
-- build_silver
-- ---------------------------------------------------------------------
create or replace function app.build_silver(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_owner uuid; v_sch text; v_tbl text; v_qtbl text;
  c record;
  v_defs   text[] := '{}';   -- definiciones de columna
  v_names  text[] := '{}';   -- nombres destino
  v_sel    text[] := '{}';   -- expresiones de coercion
  v_checks text[] := '{}';   -- motivos de cuarentena
  v_norm   text[] := '{}';   -- columnas *_norm de categoria
  v_year text; v_month text; v_datecol text; v_period text := null;
  v_n bigint; v_q bigint; v_sql text;
begin
  select owner_id, phys_schema, phys_table into v_owner, v_sch, v_tbl
    from public.datasets where id = p_dataset_id;
  if v_tbl is null then raise exception 'DATASET_NOT_BUILT' using errcode = 'P0002'; end if;
  v_qtbl := v_tbl || '_q';

  perform app.set_phase(p_dataset_id, 'building', 5, 'Construyendo tabla tipada');

  for c in
    select * from public.dataset_columns where dataset_id = p_dataset_id order by ordinal
  loop
    v_names := v_names || quote_ident(c.column_name);
    v_defs  := v_defs  || format('%I %s', c.column_name, app.pg_type_for(c.data_type));
    v_sel   := v_sel   || app.coerce_expr(c.column_name, c.data_type, c.decimal_sep);

    -- Una fila va a cuarentena si un valor NO vacio no pudo tiparse.
    if c.data_type <> 'text' then
      v_checks := v_checks || format(
        'case when nullif(btrim(data->>%L), '''') is not null and %s is null then %L end',
        c.column_name, app.coerce_expr(c.column_name, c.data_type, c.decimal_sep),
        c.column_name || ':no_es_' || c.data_type);
    end if;

    -- Columna normalizada para categorias (la rellena apply_value_map).
    if c.role = 'category' then
      v_norm := v_norm || c.column_name;
    end if;

    if c.role = 'date_part' then
      if c.column_name ~ '^(year|anio|ano|yr|a_o)$' then v_year := c.column_name;
      elsif c.column_name ~ '^(month|mes|mo)$'      then v_month := c.column_name;
      end if;
    elsif c.data_type = 'date' and v_datecol is null then
      v_datecol := c.column_name;
    end if;
  end loop;

  -- Columna 'period' generada: colapsa (year, month) en un unico valor
  -- indexable sobre el que razonan el linter, el dashboard y el modelo.
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

  execute format('create table %I.%I (_row_idx bigint primary key, %s%s%s)',
    v_sch, v_tbl,
    array_to_string(v_defs, ', '),
    case when cardinality(v_norm) > 0
         then ', ' || (select string_agg(format('%I text', n || '_norm'), ', ')
                       from unnest(v_norm) n)
         else '' end,
    case when v_period is not null then ', ' || v_period else '' end);

  execute format(
    'create table %I.%I (_row_idx bigint primary key, reasons text[] not null, data jsonb not null)',
    v_sch, v_qtbl);

  -- Carga + cuarentena en una sola pasada sobre el bronce.
  v_sql := format($q$
    with src as (
      select row_idx, data,
             array_remove(array[%s], null) as reasons
        from public.dataset_rows where dataset_id = %s
    ), bad as (
      insert into %I.%I (_row_idx, reasons, data)
      select row_idx, reasons, data from src where cardinality(reasons) > 0
      returning 1
    )
    insert into %I.%I (_row_idx, %s)
    select row_idx, %s from src where cardinality(reasons) = 0
  $q$,
    case when cardinality(v_checks) > 0 then array_to_string(v_checks, ', ') else 'null::text' end,
    p_dataset_id, v_sch, v_qtbl, v_sch, v_tbl,
    array_to_string(v_names, ', '), array_to_string(v_sel, ', '));
  execute v_sql;

  -- *_norm arranca igual al valor crudo; apply_value_map lo reescribe.
  if cardinality(v_norm) > 0 then
    execute format('update %I.%I set %s', v_sch, v_tbl,
      (select string_agg(format('%I = %I', n || '_norm', n), ', ') from unnest(v_norm) n));
  end if;

  execute format('select count(*) from %I.%I', v_sch, v_tbl)  into v_n;
  execute format('select count(*) from %I.%I', v_sch, v_qtbl) into v_q;

  -- Indices: periodo, identidad+periodo, categorias, dinero, trigram.
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

  -- RLS. El uuid del dueno se incrusta al generar el DDL: sin subconsulta,
  -- sin dependencia cruzada. Los DOS roles deben nombrarse (ver 0001).
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
           'norm_columns', to_jsonb(v_norm))
   where id = p_dataset_id;

  perform app.set_phase(p_dataset_id, 'building', 35,
    format('%s filas tipadas, %s en cuarentena', v_n, v_q));

  return jsonb_build_object('ok', true, 'rows', v_n, 'quarantined', v_q,
                            'has_period', v_period is not null);
end $fn$;
