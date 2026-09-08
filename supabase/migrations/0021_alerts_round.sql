-- =====================================================================
-- ADIA 0021 - percentile_cont devuelve double precision y en Postgres no
-- existe round(double precision, integer): la alerta de atipicos moria con
-- 42883 al redondear la mediana del grupo. Se castea a numeric.
-- =====================================================================

create or replace function app.run_alerts(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id); v_q text;
  prof jsonb; v_ent text; v_money text; v_hasper boolean; v_def text;
  v_n bigint; v_x numeric; v_ev jsonb; v_sql text; c record; r record; p jsonb;
  v_sch text; v_tbl text;
begin
  select profile, phys_schema, phys_table into prof, v_sch, v_tbl
    from public.datasets where id = p_dataset_id;
  v_q := format('%I.%I', v_sch, v_tbl || '_q');
  v_ent := prof->>'entity_column';
  v_money := app.primary_money(p_dataset_id);
  v_hasper := (prof->>'period_column') is not null;
  select default_period into v_def from public.dataset_metrics where dataset_id = p_dataset_id;

  delete from public.dataset_alerts where dataset_id = p_dataset_id;
  perform app.set_phase(p_dataset_id, 'analyzing', 90, 'Buscando alertas');

  ---------------------------------------------------------------- calidad
  execute format('select count(*) from %s', v_q) into v_n;
  if v_n > 0 then
    execute format('select coalesce(jsonb_agg(to_jsonb(z)),''[]''::jsonb) from '
                   '(select _row_idx, reasons, data from %s limit 20) z', v_q) into v_ev;
    perform app.add_alert(p_dataset_id, 'QUARANTINED_ROWS',
      format('%s filas apartadas por corrupcion estructural', v_n),
      'Cada una tenia varias celdas ilegibles a la vez (extraccion defectuosa del origen). '
      'No se descartaron en silencio: quedan aqui con el motivo por celda.',
      v_n, null, v_ev, format('select * from %s', v_q));
  end if;

  execute format('select count(*) from %s where _issues is not null', v_t) into v_n;
  if v_n > 0 then
    execute format('select coalesce(jsonb_agg(to_jsonb(z)),''[]''::jsonb) from '
                   '(select _row_idx, _issues from %s where _issues is not null limit 20) z', v_t) into v_ev;
    perform app.add_alert(p_dataset_id, 'PARTIAL_CELLS',
      format('%s filas conservadas con alguna celda ilegible', v_n),
      'La fila se mantiene en el analisis y solo esa celda queda nula. Tirar la fila entera '
      'habria borrado personas reales del conteo.',
      v_n, null, v_ev, format('select _row_idx, _issues from %s where _issues is not null', v_t));
  end if;

  if v_ent is not null and v_hasper then
    v_sql := format('select %1$I, period, count(*) n from %2$s where %1$I is not null '
                    'group by 1,2 having count(*) > 1', v_ent, v_t);
    execute format('select count(*), coalesce(jsonb_agg(to_jsonb(z)),''[]''::jsonb) '
                   'from (%s limit 20) z', v_sql) into v_n, v_ev;
    if v_n > 0 then
      execute format('select round(coalesce(sum(%3$I),0)::numeric,2) from %2$s a '
                     'where exists (select 1 from (%1$s) d where d.%4$I = a.%4$I and d.period = a.period)',
                     v_sql, v_t, v_money, v_ent) into v_x;
      perform app.add_alert(p_dataset_id, 'DUPLICATE_GRAIN',
        format('%s claves (%s, periodo) duplicadas', v_n, v_ent),
        'No afectan al conteo de personas (count distinct), pero SI inflan las sumas de dinero.',
        v_n, v_x, v_ev, v_sql);
    end if;
  end if;

  if v_money is not null then
    execute format('select count(*) from %s where %I <= 0', v_t, v_money) into v_n;
    if v_n > 0 then
      execute format('select coalesce(jsonb_agg(to_jsonb(z)),''[]''::jsonb) from '
                     '(select %1$s, %2$I from %3$s where %2$I <= 0 limit 20) z',
                     coalesce(quote_ident(v_ent),'_row_idx'), v_money, v_t) into v_ev;
      perform app.add_alert(p_dataset_id, 'ZERO_OR_NEGATIVE_MONEY',
        format('%s registros con %s <= 0', v_n, v_money),
        'Bajan la media y pueden ser licencias sin sueldo, altas a mitad de mes o errores de carga.',
        v_n, null, v_ev, format('select * from %s where %I <= 0', v_t, v_money));
    end if;
  end if;

  -- Reglas aritmeticas que se cumplen en casi todo el archivo pero no siempre.
  for r in select * from jsonb_array_elements(coalesce(prof->'derived_rules','[]'::jsonb)) e(v) loop
    if (r.v->>'violations')::bigint > 0 and (r.v->>'coverage')::numeric >= 0.95 then
      perform app.add_alert(p_dataset_id, 'DERIVED_INCONSISTENCY',
        format('%s filas incumplen: %s', r.v->>'violations', r.v->>'rule'),
        format('La relacion se cumple en el %s%% del archivo. Las excepciones son errores de '
               'origen o cambios no propagados; no promedies las dos columnas como si fueran independientes.',
               round((r.v->>'coverage')::numeric * 100, 2)),
        (r.v->>'violations')::numeric, null, '[]'::jsonb, null);
    end if;
  end loop;

  -- Deriva de codificacion: el vocabulario de una categoria se sustituye
  -- entero entre dos periodos consecutivos (Jaccard ~ 0).
  if v_hasper then
    for c in select column_name from public.dataset_columns
              where dataset_id = p_dataset_id and role = 'category' and is_analyzable
                and coalesce(distinct_count,0) between 2 and 200
    loop
      execute format($q$
        with vals as (select period p, array_agg(distinct %1$I::text) vs
                        from %2$s where %1$I is not null and period is not null group by 1),
        adj as (select p, vs, lag(p) over (order by p) pp, lag(vs) over (order by p) pvs from vals)
        select coalesce(jsonb_agg(jsonb_build_object(
                 'periodo_corte', p, 'periodo_previo', pp,
                 'desaparecen', (select array_agg(x) from unnest(pvs) x where not x = any(vs)),
                 'aparecen',    (select array_agg(x) from unnest(vs) x where not x = any(pvs)),
                 'jaccard', round(cardinality(array(select unnest(vs) intersect select unnest(pvs)))::numeric
                            / nullif(cardinality(array(select unnest(vs) union select unnest(pvs))),0), 3))),
               '[]'::jsonb)
        from adj where pvs is not null
          and cardinality(array(select unnest(vs) intersect select unnest(pvs)))::numeric
              / nullif(cardinality(array(select unnest(vs) union select unnest(pvs))),0) < 0.2
      $q$, c.column_name, v_t) into v_ev;

      if jsonb_array_length(v_ev) > 0 then
        perform app.add_alert(p_dataset_id, 'CATEGORY_ENCODING_DRIFT',
          format('"%s" cambia de codificacion a mitad de serie', c.column_name),
          format('El vocabulario se sustituye por completo (indice de Jaccard %s). Cualquier '
                 'analisis de esta columna que cruce ese corte es ruido hasta que se confirme la '
                 'equivalencia entre los valores viejos y los nuevos.',
                 v_ev->0->>'jaccard'),
          jsonb_array_length(v_ev), null, v_ev, null);
      end if;
    end loop;
  end if;

  for c in select column_name, null_count, distinct_count, stats,
                  (select count(*) from public.dataset_columns dc2
                    where dc2.dataset_id = p_dataset_id) tot
             from public.dataset_columns
            where dataset_id = p_dataset_id
  loop
    if c.null_count is not null and (c.stats->>'n')::numeric > 0
       and c.null_count::numeric / (c.stats->>'n')::numeric > 0.4 then
      perform app.add_alert(p_dataset_id, 'HIGH_NULL_RATE',
        format('"%s" esta vacia en el %s%% de las filas', c.column_name,
               round(c.null_count::numeric / (c.stats->>'n')::numeric * 100, 1)),
        'Poco fiable para segmentar o filtrar.',
        round(c.null_count::numeric / (c.stats->>'n')::numeric * 100, 2), null, '[]'::jsonb, null);
    end if;
    if c.distinct_count = 1 then
      perform app.add_alert(p_dataset_id, 'CONSTANT_COLUMN',
        format('"%s" tiene un unico valor', c.column_name),
        'No aporta nada como dimension; se muestra como contexto.', 1, null, c.stats, null);
    end if;
  end loop;

  -- Etiquetas casi identicas: variantes raras de un valor mucho mas comun.
  for c in select column_name from public.dataset_columns
            where dataset_id = p_dataset_id and role = 'category' and is_analyzable
  loop
    select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) into v_ev from (
      select a.value rara, a.n n_rara, b.value comun, b.n n_comun,
             round(extensions.similarity(a.value, b.value)::numeric, 3) parecido
        from public.dataset_values a
        join public.dataset_values b
          on b.dataset_id = a.dataset_id and b.column_name = a.column_name
         and b.n >= a.n * 20 and a.value <> b.value
       where a.dataset_id = p_dataset_id and a.column_name = c.column_name
         and extensions.similarity(a.value, b.value) >= 0.8
       order by parecido desc limit 20) z;
    if jsonb_array_length(v_ev) > 0 then
      perform app.add_alert(p_dataset_id, 'NEAR_DUPLICATE_LABELS',
        format('"%s" tiene variantes casi identicas', c.column_name),
        'Dispersan los agregados: contar por igualdad exacta deja fuera a las variantes.',
        jsonb_array_length(v_ev), null, v_ev, null);
    end if;
  end loop;

  execute format('select count(*) from %s where _issues is not null', v_t) into v_n;

  if (prof->>'entity_column') is not null
     and exists (select 1 from public.dataset_columns
                  where dataset_id = p_dataset_id and column_name = prof->>'entity_column'
                    and data_type = 'text') then
    perform app.add_alert(p_dataset_id, 'WEAK_ENTITY_KEY',
      format('La identidad es "%s", un nombre', prof->>'entity_column'),
      'No hay identificador estable en el archivo: los homonimos cuentan de menos y un cambio de '
      'grafia cuenta de mas. Los conteos de personas llevan ese margen.',
      null, null, '[]'::jsonb, null);
  end if;

  if v_hasper then
    execute format($q$
      with p as (select distinct period d from %s where period is not null),
           s as (select d, lag(d) over (order by d) pd from p)
      select coalesce(jsonb_agg(jsonb_build_object('hueco_tras', pd, 'siguiente', d)), '[]'::jsonb)
      from s where pd is not null and d <> (pd + interval '1 month')::date $q$, v_t) into v_ev;
    if jsonb_array_length(v_ev) > 0 then
      perform app.add_alert(p_dataset_id, 'MISSING_PERIOD',
        format('%s hueco(s) en la serie temporal', jsonb_array_length(v_ev)),
        'Las variaciones mensuales que cruzan un hueco no son comparables.',
        jsonb_array_length(v_ev), null, v_ev, null);
    end if;
  end if;

  if coalesce((select (metrics->>'latest_is_partial')::boolean
                 from public.dataset_metrics where dataset_id = p_dataset_id), false) then
    perform app.add_alert(p_dataset_id, 'PARTIAL_LATEST_PERIOD',
      'El ultimo periodo esta incompleto',
      'El tablero retrocede al periodo anterior: tomar un mes a medias como actual fabrica una '
      'caida de plantilla que no ha ocurrido.', null, null, '[]'::jsonb, null);
  end if;

  ------------------------------------------------------- estadisticas
  -- Atipicos CONTRA EL GRUPO DE PARES, con mediana y MAD. Usar la media y
  -- la desviacion tipica no sirve: con una distribucion sesgada a la
  -- derecha, sigma la inflan los propios atipicos que se buscan.
  if v_money is not null and v_ent is not null and v_def is not null then
    select column_name into v_sql from public.dataset_columns
     where dataset_id = p_dataset_id and role = 'category' and is_analyzable
     order by distinct_count desc limit 1;

    if v_sql is not null then
      execute format($q$
        with base as (select %1$I e, %2$I::text g, %3$I v from %4$s
                       where period = %5$L::date and %3$I is not null and %2$I is not null),
        st as (select g, percentile_cont(0.5) within group (order by v) med, count(*) n
                 from base group by g having count(*) >= 20),
        md as (select b.g, percentile_cont(0.5) within group (order by abs(b.v - s.med)) mad
                 from base b join st s on s.g = b.g group by b.g)
        select coalesce(jsonb_agg(to_jsonb(z) order by (z.z_robusto) desc), '[]'::jsonb) from (
          select b.e entidad, b.g grupo, round(b.v,2) valor, round(s.med::numeric,2) mediana_grupo, s.n tam_grupo,
                 round((0.6745 * (b.v - s.med) / nullif(m.mad,0))::numeric, 1) z_robusto
            from base b join st s on s.g = b.g join md m on m.g = b.g
           where m.mad > 0 and abs(0.6745 * (b.v - s.med) / m.mad) > 5
           order by abs(0.6745 * (b.v - s.med) / m.mad) desc limit 20) z
      $q$, v_ent, v_sql, v_money, v_t, v_def) into v_ev;

      if jsonb_array_length(v_ev) > 0 then
        perform app.add_alert(p_dataset_id, 'PAY_OUTLIER_IN_GROUP',
          format('%s atipicos frente a su propio %s', jsonb_array_length(v_ev), v_sql),
          format('Comparados con la mediana de su grupo de pares (no con la media global) usando '
                 'z robusto con MAD. Solo grupos de 20 o mas.'),
          jsonb_array_length(v_ev), null, v_ev, null);
      end if;
    end if;

    -- Saltos de importe por persona, EXCLUYENDO el primer y ultimo mes de
    -- cada una: esos meses van prorrateados y generarian falsos positivos
    -- en masa (bases de $100-140 en este archivo).
    execute format($q$
      with s as (
        select %1$I e, period p, %2$I v,
               lag(%2$I) over (partition by %1$I order by period) pv,
               lag(period) over (partition by %1$I order by period) pp,
               min(period) over (partition by %1$I) fst,
               max(period) over (partition by %1$I) lst
          from %3$s where %2$I is not null and period is not null)
      select coalesce(jsonb_agg(to_jsonb(z) order by abs(z.variacion_pct) desc), '[]'::jsonb) from (
        select e entidad, pp periodo_previo, p periodo, round(pv,2) importe_previo,
               round(v,2) importe, round(((v - pv) / nullif(pv,0) * 100)::numeric, 1) variacion_pct
          from s
         where pv is not null and pv > 0 and p > fst and p < lst and pp > fst
           and abs(v - pv) > 200 and abs((v - pv) / pv) > 0.3
         order by abs((v - pv) / pv) desc limit 20) z
    $q$, v_ent, v_money, v_t) into v_ev;

    if jsonb_array_length(v_ev) > 0 then
      perform app.add_alert(p_dataset_id, 'PERSON_PAY_JUMP',
        format('%s saltos de importe de un mes al siguiente', jsonb_array_length(v_ev)),
        'Variacion superior al 30% y a $200, descartando el primer y ultimo mes de cada persona '
        '(esos van prorrateados y no son comparables).',
        jsonb_array_length(v_ev), null, v_ev, null);
    end if;

    -- Nombres casi identicos cobrando a la vez en el mismo periodo.
    execute format($q$
      select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
        select a.%1$I nombre_a, b.%1$I nombre_b,
               round(extensions.similarity(a.%1$I, b.%1$I)::numeric,3) parecido,
               round(a.%2$I,2) importe_a, round(b.%2$I,2) importe_b
          from %3$s a join %3$s b
            on a.period = b.period and a.%1$I < b.%1$I
           and a.%1$I %% b.%1$I
         where a.period = %4$L::date
           and extensions.similarity(a.%1$I, b.%1$I) >= 0.92
         limit 20) z
    $q$, v_ent, v_money, v_t, v_def) into v_ev;

    if jsonb_array_length(v_ev) > 0 then
      perform app.add_alert(p_dataset_id, 'GHOST_EMPLOYEE_CANDIDATE',
        format('%s pares de nombres casi identicos cobrando en el mismo periodo', jsonb_array_length(v_ev)),
        'Puede ser una errata de carga, dos personas distintas con nombres parecidos, o un registro '
        'duplicado. Merece revision manual.',
        jsonb_array_length(v_ev), null, v_ev, null);
    end if;
  end if;

  select (metrics->'kpi'->>'top1_share')::numeric into v_x
    from public.dataset_metrics where dataset_id = p_dataset_id;
  if v_x is not null and v_x > 10 then
    perform app.add_alert(p_dataset_id, 'PAYROLL_CONCENTRATION',
      format('El 1%% mejor pagado concentra el %s%% del gasto', v_x),
      'Concentracion alta: el coste depende mucho de pocas personas.', v_x, null, '[]'::jsonb, null);
  end if;

  select (metrics->'kpi'->>'p90_p10')::numeric into v_x
    from public.dataset_metrics where dataset_id = p_dataset_id;
  if v_x is not null and v_x > 5 then
    perform app.add_alert(p_dataset_id, 'PAY_DISPERSION',
      format('Dispersion salarial p90/p10 = %s', v_x),
      'El percentil 90 gana mas de 5 veces lo del percentil 10.', v_x, null, '[]'::jsonb, null);
  end if;

  -- Saltos de plantilla frente a la variabilidad historica.
  if v_hasper and v_ent is not null then
    execute format($q$
      with s as (select period p, count(distinct %1$I) hc from %2$s where period is not null group by 1),
           d as (select p, hc, lag(hc) over (order by p) ph from s),
           t as (select stddev_samp(hc - ph) sd from d where ph is not null)
      select coalesce(jsonb_agg(to_jsonb(z) order by abs(z.variacion) desc), '[]'::jsonb) from (
        select p periodo, ph plantilla_previa, hc plantilla, (hc - ph) variacion,
               round(((hc - ph)::numeric / nullif(ph,0) * 100), 2) variacion_pct
          from d, t
         where ph is not null and abs(hc - ph) > greatest(ph * 0.03, 3 * coalesce(t.sd, 0))
         limit 20) z $q$, v_ent, v_t) into v_ev;
    if jsonb_array_length(v_ev) > 0 then
      perform app.add_alert(p_dataset_id, 'HEADCOUNT_JUMP',
        format('%s variaciones bruscas de plantilla', jsonb_array_length(v_ev)),
        'Superan el 3% y tres desviaciones tipicas de la variacion mensual habitual.',
        jsonb_array_length(v_ev), null, v_ev, null);
    end if;
  end if;

  select count(*) into v_n from public.dataset_alerts where dataset_id = p_dataset_id;
  perform app.set_phase(p_dataset_id, 'ready', 100, format('%s alertas', v_n));
  update public.datasets set ready_at = now() where id = p_dataset_id;
  return jsonb_build_object('ok', true, 'alerts', v_n);
end $fn$;
