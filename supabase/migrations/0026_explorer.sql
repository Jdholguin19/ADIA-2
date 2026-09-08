-- =====================================================================
-- ADIA 0026 - explorador de filas.
--
-- La tabla plata vive en el esquema ds, que PostgREST no expone (solo
-- publica public), asi que el navegador no puede consultarla directamente.
-- Se ofrece por RPC, con paginacion y busqueda, sin abrir el esquema.
-- =====================================================================

create or replace function public.dataset_page(
  p_dataset_id bigint,
  p_limit      int  default 100,
  p_offset     bigint default 0,
  p_search     text default null,
  p_period     text default null,
  p_quarantine boolean default false
) returns jsonb
language plpgsql security invoker
set search_path = public, pg_catalog
set statement_timeout = '20s' as $fn$
declare
  v_sch text; v_tbl text; v_t text; v_where text := 'where true';
  v_rows jsonb; v_total bigint; v_cols text[]; v_hasper boolean;
begin
  select phys_schema, phys_table, (profile->>'period_column') is not null
    into v_sch, v_tbl, v_hasper
    from public.datasets where id = p_dataset_id;
  if v_tbl is null then
    return jsonb_build_object('ok', false, 'error', 'DATASET_NO_ENCONTRADO');
  end if;

  if p_quarantine then
    v_t := format('%I.%I', v_sch, v_tbl || '_q');
    if p_search is not null and btrim(p_search) <> '' then
      v_where := v_where || format(' and data::text ilike %L', '%' || p_search || '%');
    end if;
  else
    v_t := format('%I.%I', v_sch, v_tbl);
    if p_period is not null and v_hasper then
      v_where := v_where || format(' and period = %L::date', p_period);
    end if;
    if p_search is not null and btrim(p_search) <> '' then
      -- Solo columnas de texto analizables: buscar sobre toda la fila
      -- obligaria a castear numeros y fechas en cada comparacion.
      select array_agg(quote_ident(column_name)) into v_cols
        from public.dataset_columns
       where dataset_id = p_dataset_id and data_type = 'text' and is_analyzable;
      if v_cols is not null then
        v_where := v_where || format(' and (%s)',
          (select string_agg(format('%s ilike %L', c, '%' || p_search || '%'), ' or ')
             from unnest(v_cols) c));
      end if;
    end if;
  end if;

  execute format('select count(*) from %s %s', v_t, v_where) into v_total;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(z)), ''[]''::jsonb) from '
    '(select * from %s %s order by _row_idx limit %s offset %s) z',
    v_t, v_where, greatest(1, least(coalesce(p_limit, 100), 500)), greatest(0, coalesce(p_offset, 0)))
  into v_rows;

  return jsonb_build_object('ok', true, 'total', v_total, 'rows', v_rows);
end $fn$;

grant execute on function public.dataset_page(bigint,int,bigint,text,text,boolean) to authenticated;
