-- =====================================================================
-- ADIA 0020 - el orquestador guarda las reglas derivadas en el perfil
-- (las necesita la alerta DERIVED_INCONSISTENCY) y encadena tablero y
-- alertas, de modo que rebuild_dataset deja el dataset listo de una vez.
-- =====================================================================

create or replace function public.rebuild_dataset(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '290s' as $fn$
declare v_owner uuid; v_out jsonb := '{}'::jsonb; v_grain jsonb; v_der jsonb;
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

  v_der := app.detect_derived_columns(p_dataset_id);
  update public.datasets
     set profile = profile || jsonb_build_object('derived_rules', v_der->'rules')
   where id = p_dataset_id;
  v_out := v_out || jsonb_build_object('derived', v_der);

  v_out := v_out || jsonb_build_object('values',    app.build_value_dictionary(p_dataset_id));
  v_out := v_out || jsonb_build_object('dashboard', app.build_dashboard(p_dataset_id));
  v_out := v_out || jsonb_build_object('alerts',    app.run_alerts(p_dataset_id));
  return v_out;
end $fn$;

revoke all on function public.rebuild_dataset(bigint) from public;
grant execute on function public.rebuild_dataset(bigint) to authenticated;
