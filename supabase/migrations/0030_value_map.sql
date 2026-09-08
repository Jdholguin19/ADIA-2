-- =====================================================================
-- ADIA 0030 - equivalencias de valores confirmadas.
--
-- build_silver ya creaba una columna <col>_norm por cada categoria, copia
-- del valor crudo, esperando exactamente esto. Aqui se cierra el circuito:
-- una persona confirma que 1=LOSEP, 2=CT, 3=LOEI y el mapa se aplica.
--
-- El valor CRUDO nunca se toca: _norm es una columna aparte, de modo que
-- siempre se puede auditar que decia el archivo y deshacer el mapeo.
-- Un valor sin equivalencia confirmada se queda como esta (el codigo 4 de
-- este dataset, por ejemplo, que el archivo no etiqueta).
-- =====================================================================

-- Columna fisica a usar para agrupar/filtrar: la normalizada si existe.
create or replace function app.norm_col(p_dataset_id bigint, p_col text)
returns text language plpgsql stable security definer
set search_path = public, pg_catalog as $fn$
declare v_sch text; v_tbl text;
begin
  select phys_schema, phys_table into v_sch, v_tbl from public.datasets where id = p_dataset_id;
  if v_tbl is null or p_col is null then return p_col; end if;
  if exists (select 1 from information_schema.columns
              where table_schema = v_sch and table_name = v_tbl
                and column_name = p_col || '_norm') then
    return p_col || '_norm';
  end if;
  return p_col;
end $fn$;

-- ---------------------------------------------------------------------
create or replace function app.apply_value_map(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '120s' as $fn$
declare v_t text := app.qual(p_dataset_id); c record; v_n bigint; v_total bigint := 0;
begin
  for c in
    select distinct column_name from public.dataset_value_map
     where dataset_id = p_dataset_id and confirmed
  loop
    if app.norm_col(p_dataset_id, c.column_name) = c.column_name then continue; end if;

    -- Se parte SIEMPRE del valor crudo, no del _norm actual: asi reaplicar
    -- el mapa es idempotente y corregir una equivalencia mal puesta no
    -- arrastra el error anterior.
    execute format($q$
      update %1$s t
         set %2$I = coalesce(m.mapped_value, t.%3$I::text)
        from public.dataset_value_map m
       where m.dataset_id = %4$s and m.column_name = %5$L and m.confirmed
         and m.raw_value = t.%3$I::text
    $q$, v_t, c.column_name || '_norm', c.column_name, p_dataset_id, c.column_name);
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;

  return jsonb_build_object('ok', true, 'rows_mapped', v_total);
end $fn$;

-- ---------------------------------------------------------------------
-- RPC para confirmar equivalencias. Existe para que una futura pantalla la
-- llame; de momento la usa un script.
-- ---------------------------------------------------------------------
create or replace function public.set_value_map(
  p_dataset_id bigint, p_column text, p_mapping jsonb, p_confirmed boolean default true)
returns jsonb language plpgsql security invoker
set search_path = public, pg_catalog
set statement_timeout = '180s' as $fn$
declare k text; v text; v_n int := 0;
begin
  -- Al ser invoker, esta lectura ya pasa por RLS.
  if not exists (select 1 from public.datasets where id = p_dataset_id) then
    return jsonb_build_object('ok', false, 'error', 'DATASET_NO_ENCONTRADO');
  end if;
  if not exists (select 1 from public.dataset_columns
                  where dataset_id = p_dataset_id and column_name = p_column) then
    return jsonb_build_object('ok', false, 'error', format('columna no valida: %s', p_column));
  end if;

  for k, v in select key, value #>> '{}' from jsonb_each(p_mapping) loop
    insert into public.dataset_value_map(dataset_id, column_name, raw_value, mapped_value, confirmed)
    values (p_dataset_id, p_column, k, v, p_confirmed)
    on conflict (dataset_id, column_name, raw_value)
      do update set mapped_value = excluded.mapped_value, confirmed = excluded.confirmed;
    v_n := v_n + 1;
  end loop;

  perform app.apply_value_map(p_dataset_id);
  perform app.build_value_dictionary(p_dataset_id);
  return jsonb_build_object('ok', true, 'pairs', v_n);
end $fn$;

grant execute on function public.set_value_map(bigint,text,jsonb,boolean) to authenticated;

-- ---------------------------------------------------------------------
-- El diccionario de valores pasa a leer la columna normalizada: asi los
-- desplegables de filtro muestran LOSEP y no 1.
-- ---------------------------------------------------------------------
create or replace function app.build_value_dictionary(p_dataset_id bigint, p_max int default 4000)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '180s' as $fn$
declare v_t text := app.qual(p_dataset_id); c record; v_tot int := 0; v_n int; v_col text;
begin
  delete from public.dataset_values where dataset_id = p_dataset_id;

  for c in
    select column_name, distinct_count from public.dataset_columns
     where dataset_id = p_dataset_id and is_analyzable
       and role in ('category','code')
       and coalesce(distinct_count, 0) between 1 and 5000
  loop
    v_col := app.norm_col(p_dataset_id, c.column_name);
    execute format($q$
      insert into public.dataset_values(dataset_id, column_name, value, n)
      select %1$s, %2$L, %3$I::text, count(*)
        from %4$s where %3$I is not null
       group by %3$I order by count(*) desc limit %5$s
      on conflict (dataset_id, column_name, value) do update set n = excluded.n
    $q$, p_dataset_id, c.column_name, v_col, v_t, p_max);
    get diagnostics v_n = row_count;
    v_tot := v_tot + v_n;
  end loop;

  return jsonb_build_object('ok', true, 'values', v_tot);
end $fn$;
