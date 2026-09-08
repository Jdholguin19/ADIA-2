-- =====================================================================
-- ADIA 0023 - la evidencia de una alerta debe ser SIEMPRE un array.
-- CONSTANT_COLUMN pasaba el objeto de estadisticas tal cual, y cualquier
-- consumidor que hiciera jsonb_array_length reventaba con 22023. Se
-- normaliza en add_alert en vez de confiar en cada llamada.
-- =====================================================================

create or replace function app.add_alert(
  p_dataset_id bigint, p_code text, p_title text, p_detail text,
  p_metric numeric default null, p_impact numeric default null,
  p_evidence jsonb default '[]'::jsonb, p_sql text default null)
returns void language plpgsql security definer
set search_path = public, pg_catalog as $fn$
declare r record; v_ev jsonb;
begin
  select * into r from public.alert_rules where code = p_code;
  if r.code is null or not r.enabled then return; end if;

  v_ev := coalesce(p_evidence, '[]'::jsonb);
  if jsonb_typeof(v_ev) <> 'array' then v_ev := jsonb_build_array(v_ev); end if;

  insert into public.dataset_alerts(dataset_id, code, severity, category, title, detail,
                                    metric, impact, evidence, evidence_sql)
  values (p_dataset_id, p_code, r.severity, r.category, p_title, p_detail,
          p_metric, p_impact, v_ev, p_sql);
end $fn$;

update public.dataset_alerts set evidence = jsonb_build_array(evidence)
 where jsonb_typeof(evidence) <> 'array';
