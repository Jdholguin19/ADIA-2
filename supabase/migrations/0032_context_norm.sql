-- =====================================================================
-- ADIA 0032 - el contexto del modelo incluye las columnas normalizadas.
-- Sin esto el copiloto sigue escribiendo labor_regime = '1' y se deja
-- fuera la mitad de la serie, que en el archivo dice 'LOSEP'.
-- =====================================================================

create or replace function public.dataset_context(p_dataset_id bigint)
returns text language plpgsql stable security invoker
set search_path = public, pg_catalog as $fn$
declare
  d record; c record; v_out text; v_cols text := ''; v_der text := '';
  v_per text; v_alert text := ''; m jsonb; v_norm text := ''; v_map text;
begin
  select * into d from public.datasets where id = p_dataset_id;
  if d.id is null then return null; end if;
  select metrics into m from public.dataset_metrics where dataset_id = p_dataset_id;

  for c in select * from public.dataset_columns where dataset_id = p_dataset_id order by ordinal loop
    v_cols := v_cols || format(E'  %s %s  -- rol=%s%s%s%s\n',
      rpad(c.column_name, 26), rpad(c.data_type, 9), c.role,
      case when not c.is_analyzable then ', NO USAR como magnitud ni como identidad' else '' end,
      case when c.distinct_count is not null then format(', %s valores distintos', c.distinct_count) else '' end,
      case when c.examples is not null and jsonb_array_length(c.examples) > 0
           then format(', ej: %s', left(replace(c.examples::text, '"', ''''), 90)) else '' end);
    if c.derived_rule is not null then
      v_der := v_der || format(E'  %s  (redundante: no la sumes junto a sus componentes)\n', c.derived_rule);
    end if;

    -- Columnas normalizadas: si existen, son las que hay que usar. Sin este
    -- aviso el modelo escribe labor_regime = '1' y se deja fuera la mitad de
    -- la serie, que en el archivo original dice 'LOSEP'.
    if app.norm_col(p_dataset_id, c.column_name) <> c.column_name then
      select string_agg(format('%s -> %s', raw_value, mapped_value), ', ' order by raw_value)
        into v_map
        from public.dataset_value_map
       where dataset_id = p_dataset_id and column_name = c.column_name and confirmed;
      v_norm := v_norm || format(
        E'  %I_norm  <- usa ESTA para agrupar y filtrar %I\n',
        c.column_name, c.column_name);
      if v_map is not null then
        v_norm := v_norm || format(E'      equivalencias confirmadas: %s\n', v_map);
      end if;
    end if;
  end loop;

  if (d.profile->>'period_column') is not null then
    v_per := format(E'\nPERIODOS: %s meses, de %s a %s. Periodo vigente por defecto: %s.\n'
                     'La columna "period" es de tipo date y vale el dia 1 del mes. Filtra con '
                     'period = DATE ''YYYY-MM-01''.\n',
      coalesce(d.profile->>'n_periods','?'), coalesce(d.profile->>'first_period','?'),
      coalesce(d.profile->>'last_period','?'), coalesce(m->>'default_period','?'));
  end if;

  select string_agg(format('  [%s] %s', severity, title), E'\n') into v_alert
    from (select severity, title from public.dataset_alerts
           where dataset_id = p_dataset_id and severity in ('critical','high')
           order by severity limit 8) z;

  v_out := format(E'TABLA: %I.%I  (consultala SIEMPRE por este nombre)\n'
                   'FILAS: %s tipadas, %s apartadas por corrupcion.\n\n'
                   'COLUMNAS\n%s\n',
    d.phys_schema, d.phys_table, d.n_rows_silver, d.n_rows_quarantined, v_cols);

  if v_der <> '' then
    v_out := v_out || E'COLUMNAS DERIVADAS (calculadas a partir de otras)\n' || v_der || E'\n';
  end if;

  if d.profile->>'grain' = 'panel' then
    v_out := v_out || format(E'REGLA DE CONTEO - LEELA ANTES DE ESCRIBIR NADA\n%s\n'
      'Toda cifra de "cuantos" es count(distinct %I) CON filtro de periodo.\n'
      'count(*) responde filas-mes y es casi siempre la respuesta equivocada.\n',
      coalesce(d.profile->>'counting_rule',''), d.profile->>'entity_column');
  end if;

  if v_norm <> '' then
    v_out := v_out ||
      E'COLUMNAS NORMALIZADAS\n' ||
      E'El archivo cambia de codificacion a mitad de la serie. La columna cruda conserva\n' ||
      E'lo que decia el origen; la columna _norm trae el valor canonico ya unificado.\n' ||
      E'Agrupa y filtra SIEMPRE por la _norm, o partiras la serie en dos.\n' || v_norm || E'\n';
  end if;

  v_out := v_out || coalesce(v_per, '');
  if m->>'primary_money' is not null then
    v_out := v_out || format(E'\nIMPORTE PRINCIPAL: %s (usalo para coste, sueldo medio y rankings).\n',
                             m->>'primary_money');
  end if;
  if v_alert is not null then
    v_out := v_out || E'\nAVISOS DE CALIDAD VIGENTES\n' || v_alert || E'\n';
  end if;

  return v_out;
end $fn$;

grant execute on function public.dataset_context(bigint) to authenticated;
