-- =====================================================================
-- ADIA 0002 - ingesta: creacion de dataset, particion bronce y carga
--             por trozos idempotente/reanudable.
-- =====================================================================

-- Saneado de identificadores: acentos fuera, snake_case, sin colisiones.
create or replace function app.sanitize_ident(p_name text, p_fallback text default 'col')
returns text language plpgsql immutable
set search_path = extensions, pg_catalog as $fn$
declare s text;
begin
  s := lower(coalesce(p_name, ''));
  s := extensions.unaccent(s);
  s := regexp_replace(s, '[^a-z0-9]+', '_', 'g');
  s := regexp_replace(s, '_+', '_', 'g');
  s := btrim(s, '_');
  if s = '' then s := p_fallback; end if;
  if s ~ '^[0-9]' then s := 'c_' || s; end if;
  return left(s, 58);
end $fn$;

-- Conversion numerica tolerante: NUNCA lanza excepcion, devuelve null.
-- Es lo que permite que las 87 filas corruptas se aparten en vez de
-- tumbar cada agregado que toque la columna.
create or replace function app.to_numeric_safe(v text, dec_sep char default '.')
returns numeric language plpgsql immutable parallel safe
set search_path = pg_catalog as $fn$
declare t text;
begin
  if v is null then return null; end if;
  t := btrim(regexp_replace(v, '[[:space:]$€USD]', '', 'g'));
  if t = '' then return null; end if;
  if dec_sep = ',' then t := replace(replace(t, '.', ''), ',', '.');
  else                  t := replace(t, ',', ''); end if;
  -- Filtro rapido: evita el coste de una excepcion en el caso corrupto.
  if t !~ '^-?\(?[0-9]+(\.[0-9]+)?\)?$' then return null; end if;
  if t ~ '^\(.*\)$' then t := '-' || btrim(t, '()'); end if;
  return t::numeric;
exception when others then return null;
end $fn$;

create or replace function app.to_bigint_safe(v text)
returns bigint language plpgsql immutable parallel safe
set search_path = pg_catalog as $fn$
declare n numeric;
begin
  n := app.to_numeric_safe(v);
  if n is null then return null; end if;
  if n <> trunc(n) then return null; end if;
  if n > 9223372036854775807 or n < -9223372036854775808 then return null; end if;
  return n::bigint;
exception when others then return null;
end $fn$;

-- ---------------------------------------------------------------------
-- create_dataset: crea (o reanuda) un dataset y su particion bronce.
-- ---------------------------------------------------------------------
create or replace function public.create_dataset(
  p_name         text,
  p_filename     text,
  p_sheet        text,
  p_content_hash text,
  p_columns      jsonb,
  p_n_rows       bigint,
  p_chunk_size   int default 2000
) returns jsonb
language plpgsql security definer
set search_path = public, pg_catalog as $fn$
declare
  v_uid uuid := auth.uid();
  v_id bigint; v_existing bigint; v_status text; v_done jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;

  -- Mismo archivo + mismo dueno => reanudar en vez de duplicar.
  select id, status into v_existing, v_status
    from public.datasets
   where owner_id = v_uid and content_hash = p_content_hash;

  if v_existing is not null then
    select coalesce(jsonb_agg(chunk_idx order by chunk_idx), '[]'::jsonb) into v_done
      from public.ingest_chunks where dataset_id = v_existing;
    return jsonb_build_object('dataset_id', v_existing, 'resumed', true,
                              'status', v_status, 'chunks_done', v_done);
  end if;

  insert into public.datasets(owner_id, name, source_filename, sheet_name, content_hash,
                              status, phase, chunk_size, n_rows_expected)
  values (v_uid, p_name, p_filename, p_sheet, p_content_hash,
          'ingesting', 'ingesting', p_chunk_size, p_n_rows)
  returning id into v_id;

  update public.datasets
     set phys_schema = 'ds', phys_table = format('t_%s', lpad(v_id::text, 6, '0'))
   where id = v_id;

  execute format(
    'create table if not exists public.dataset_rows_%s partition of public.dataset_rows for values in (%s)',
    v_id, v_id);

  insert into public.dataset_columns(dataset_id, ordinal, source_name, column_name,
                                     data_type, role, decimal_sep, is_analyzable)
  select v_id,
         (c->>'ordinal')::int,
         c->>'source_name',
         c->>'column_name',
         coalesce(c->>'data_type', 'text'),
         coalesce(c->>'role', 'unknown'),
         coalesce(c->>'decimal_sep', '.'),
         coalesce((c->>'is_analyzable')::boolean, true)
    from jsonb_array_elements(p_columns) c;

  return jsonb_build_object('dataset_id', v_id, 'resumed', false,
                            'status', 'ingesting', 'chunks_done', '[]'::jsonb);
end $fn$;

-- ---------------------------------------------------------------------
-- ingest_chunk: el libro mayor manda. Un trozo reintentado es un no-op,
-- asi que una reconexion nunca duplica filas.
-- ---------------------------------------------------------------------
create or replace function public.ingest_chunk(
  p_dataset_id bigint, p_chunk_idx int, p_rows jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '45s' as $fn$
declare v_owner uuid; v_base bigint; v_n int; v_size int;
begin
  select owner_id, chunk_size into v_owner, v_size
    from public.datasets where id = p_dataset_id;
  if v_owner is null then raise exception 'DATASET_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  insert into public.ingest_chunks(dataset_id, chunk_idx, n_rows)
  values (p_dataset_id, p_chunk_idx, jsonb_array_length(p_rows))
  on conflict (dataset_id, chunk_idx) do nothing;

  if not found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'n', 0);
  end if;

  v_base := p_chunk_idx::bigint * v_size;

  insert into public.dataset_rows(dataset_id, row_idx, data)
  select p_dataset_id, v_base + (ord - 1), elem
    from jsonb_array_elements(p_rows) with ordinality as t(elem, ord)
  on conflict (dataset_id, row_idx) do nothing;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'duplicate', false, 'n', v_n);
end $fn$;

-- ---------------------------------------------------------------------
create or replace function public.finish_ingest(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '55s' as $fn$
declare v_owner uuid; v_n bigint;
begin
  select owner_id into v_owner from public.datasets where id = p_dataset_id;
  if v_owner is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  select count(*) into v_n from public.dataset_rows where dataset_id = p_dataset_id;
  update public.datasets
     set n_rows_bronze = v_n, status = 'ingested', phase = 'ingested', phase_pct = 100
   where id = p_dataset_id;

  return jsonb_build_object('ok', true, 'n_rows_bronze', v_n);
end $fn$;

-- ---------------------------------------------------------------------
create or replace function public.delete_dataset(p_dataset_id bigint)
returns void language plpgsql security definer
set search_path = public, pg_catalog as $fn$
declare v_owner uuid; v_sch text; v_tbl text;
begin
  select owner_id, phys_schema, phys_table into v_owner, v_sch, v_tbl
    from public.datasets where id = p_dataset_id;
  if v_owner is null then return; end if;
  if v_owner is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  if v_tbl is not null then
    execute format('drop table if exists %I.%I cascade', v_sch, v_tbl);
    execute format('drop table if exists %I.%I cascade', v_sch, v_tbl || '_q');
  end if;
  execute format('drop table if exists public.dataset_rows_%s', p_dataset_id);
  delete from public.datasets where id = p_dataset_id;
end $fn$;

revoke all on function public.create_dataset(text,text,text,text,jsonb,bigint,int) from public;
revoke all on function public.ingest_chunk(bigint,int,jsonb)                        from public;
revoke all on function public.finish_ingest(bigint)                                 from public;
revoke all on function public.delete_dataset(bigint)                                from public;
grant execute on function public.create_dataset(text,text,text,text,jsonb,bigint,int) to authenticated;
grant execute on function public.ingest_chunk(bigint,int,jsonb)                        to authenticated;
grant execute on function public.finish_ingest(bigint)                                 to authenticated;
grant execute on function public.delete_dataset(bigint)                                to authenticated;
