-- =====================================================================
-- ADIA 0012 - dos fallos reales descubiertos por la bateria adversaria.
--
-- 1) text[] || 'literal' es AMBIGUO en Postgres: existen anyarray||anyelement
--    y anyarray||anyarray, y con un literal sin tipo gana el segundo, que
--    intenta parsear la cadena como array y lanza
--      22P02 malformed array literal
--    Efecto: el lint moria por excepcion en vez de rechazar con motivo, y
--    los ataques "se bloqueaban" por accidente, no por analisis. Cada
--    literal lleva ahora ::text explicito.
--
-- 2) authenticated no tenia USAGE sobre el esquema ds, asi que toda consulta
--    legitima moria con "permission denied for schema ds". Las tablas si
--    tenian GRANT SELECT; faltaba el permiso sobre el esquema.
-- =====================================================================

grant usage on schema ds to authenticated;
alter default privileges in schema ds grant select on tables to authenticated;

create or replace function app.lint_sql(p_dataset_id bigint, p_sql text)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_catalog as $fn$
declare
  raw text := btrim(coalesce(p_sql, ''));
  s text; errs text[] := '{}'; warns text[] := '{}';
  prof jsonb; v_sch text; v_tbl text;
  v_grain text; v_ent text; v_per text[]; v_rel text[]; m text[];
  allowed_fn text[] := array[
    'count','sum','avg','min','max','round','coalesce','nullif','abs','greatest','least',
    'percentile_cont','percentile_disc','mode','stddev','stddev_samp','stddev_pop','variance',
    'var_samp','corr','covar_pop','lower','upper','initcap','trim','btrim','ltrim','rtrim',
    'left','right','substr','substring','length','char_length','replace','split_part','concat',
    'concat_ws','position','strpos','translate','to_char','to_date','to_number','date_trunc',
    'extract','date_part','make_date','make_interval','age','now','row_number','rank',
    'dense_rank','percent_rank','cume_dist','lag','lead','ntile','first_value','last_value',
    'nth_value','array_agg','string_agg','jsonb_agg','json_agg','jsonb_build_object','unnest',
    'generate_series','floor','ceil','ceiling','mod','div','sqrt','power','exp','ln','log',
    'sign','trunc','similarity','unaccent','regexp_replace','regexp_match','regexp_matches',
    'starts_with','cast','bool_and','bool_or','every','filter','over','partition','coalesce'];
  sql_kw text[] := array[
    'select','where','and','or','not','in','on','by','as','union','intersect','except','all',
    'distinct','over','partition','filter','order','group','having','when','then','else','end',
    'from','join','using','with','case','asc','desc','limit','offset','is','null','between',
    'like','ilike','exists','any','some','interval','date','numeric','text','int','integer',
    'bigint','boolean','decimal','within','nulls','first','last','recursive','lateral','cross',
    'inner','left','right','full','outer','only','fetch','next','rows','row','value'];
begin
  select d.phys_schema, d.phys_table, d.profile into v_sch, v_tbl, prof
    from public.datasets d where d.id = p_dataset_id;
  if v_tbl is null then
    return jsonb_build_object('ok', false, 'errors', to_jsonb(array['dataset_no_construido']),
                              'warnings', '[]'::jsonb);
  end if;

  v_grain := prof->>'grain';
  v_ent   := prof->>'entity_column';
  v_per   := array_remove(array[prof->>'period_column', prof->>'year_column',
                                prof->>'month_column'], null);
  v_rel   := array[lower(v_sch || '.' || v_tbl), lower(v_tbl),
                   lower(v_sch || '.' || v_tbl || '_q'), lower(v_tbl || '_q')];

  -- Normalizar: fuera literales, fuera comentarios, minusculas, espacios.
  s := regexp_replace(raw, '''([^'']|'''')*''', ' ''L'' ', 'g');
  s := regexp_replace(s,   '--[^' || chr(10) || ']*', ' ', 'g');
  s := regexp_replace(s,   '/\*.*?\*/', ' ', 'gs');
  s := lower(regexp_replace(s, '\s+', ' ', 'g'));

  if length(raw) > 8000 then errs := errs || 'consulta_demasiado_larga'::text; end if;
  if s !~ '^\s*(with|select)\y' then errs := errs || 'debe_empezar_por_select_o_with'::text; end if;
  if s ~ ';\s*\S'               then errs := errs || 'varias_sentencias'::text; end if;
  if s ~ '\y(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|analyze|reindex|refresh|call|do|set|reset|listen|notify|lock|prepare|execute|declare|fetch|move|comment|import|begin|commit|rollback|savepoint|returning|into)\y'
    then errs := errs || 'palabra_clave_prohibida'::text; end if;
  if s ~ '\ypg_[a-z0-9_]+' or s ~ '\y(information_schema|pg_catalog|auth|storage|vault|net|extensions|cron|graphql|public)\.'
    then errs := errs || 'esquema_o_catalogo_prohibido'::text; end if;
  if s ~ '\y(dblink|lo_import|lo_export|pg_read_file|pg_ls_dir|pg_sleep|query_to_xml|http|xmlelement)\y'
    then errs := errs || 'funcion_prohibida'::text; end if;

  -- Lista blanca de relaciones: solo la tabla de ESTE dataset.
  for m in select regexp_matches(s, '\y(?:from|join)\s+([a-z_][a-z0-9_$.]*)', 'g') loop
    if not (m[1] = any(v_rel)) then
      errs := errs || format('relacion_no_permitida:%s (usa %s.%s)', m[1], v_sch, v_tbl);
    end if;
  end loop;

  -- Lista blanca de funciones.
  for m in select regexp_matches(s, '([a-z_][a-z0-9_]*)\s*\(', 'g') loop
    if not (m[1] = any(allowed_fn)) and not (m[1] = any(sql_kw)) then
      errs := errs || format('funcion_no_permitida:%s', m[1]);
    end if;
  end loop;

  -------------------------------------------------------------------
  -- GUARDA DE GRANO.
  -- El mensaje esta escrito PARA EL MODELO: cuando el lint falla, este
  -- texto vuelve como resultado de la herramienta y el modelo se corrige
  -- solo en la siguiente vuelta.
  -------------------------------------------------------------------
  if v_grain = 'panel' and v_ent is not null then
    if s ~ '\ycount\s*\(\s*(\*|1)\s*\)'
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      errs := errs || format(
        'conteo_de_filas_en_panel: este dataset tiene una fila por (%s, periodo). '
        'count(*) cuenta filas-mes, no personas. Usa count(distinct %s) y filtra por %s.',
        v_ent, v_ent, array_to_string(v_per, ' o '));
    end if;

    if s ~ ('\ycount\s*\(\s*distinct\s+"?' || v_ent || '"?\s*\)')
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'distinct_sin_periodo: devuelve todo el que aparecio alguna vez (%s en el historico), '
        'no la plantilla actual (~%s por periodo). Filtra por periodo salvo que sea intencionado.',
        coalesce(prof->>'n_entities','?'), coalesce(prof->>'entities_per_period','?'));
    end if;

    if s ~ '\ysum\s*\('
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'suma_sin_periodo: suma los %s periodos del historico. Confirma que es lo que quieres.',
        coalesce(prof->>'n_periods','?'));
    end if;

    if s !~ '\y(count|sum|avg|min|max)\s*\(' and s !~ '\ygroup by\y'
       and s ~ ('\y' || v_ent || '\y')
       and not exists (select 1 from unnest(v_per) c where s ~ ('\y' || c || '\y')) then
      warns := warns || format(
        'listado_puede_duplicar: sin filtro de periodo cada %s aparece hasta %s veces.',
        v_ent, coalesce(prof->>'n_periods','?'));
    end if;
  end if;

  if s !~ '\ylimit\y' and s !~ '\y(count|sum|avg)\s*\(' and s !~ '\ygroup by\y' then
    warns := warns || 'sin_limit: se aplico un LIMIT automatico.'::text;
  end if;

  return jsonb_build_object('ok', cardinality(errs) = 0,
                            'errors', to_jsonb(errs), 'warnings', to_jsonb(warns));
end $fn$;

