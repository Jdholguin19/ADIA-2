-- =====================================================================
-- ADIA 0024 - no reportar dos veces la misma relacion aritmetica.
-- El detector recorria los pares ordenados en ambos sentidos y emitia
-- "annual = monthly * 12" y "monthly = annual * 0.083333" como si fueran
-- hallazgos distintos. Se conserva solo la direccion en la que la columna
-- derivada aparece DESPUES de la base en el archivo.
-- =====================================================================

create or replace function app.detect_derived_columns(p_dataset_id bigint)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  v_t text := app.qual(p_dataset_id);
  v_cols text[]; v_ord jsonb := '{}'::jsonb;
  a text; b text; c text;
  v_ratio numeric; v_cov numeric; v_viol bigint;
  v_found jsonb := '[]'::jsonb;
  v_exprs text[]; v_labels text[]; v_sub text[]; v_res jsonb;
  i int; j int; k int; m int; v_tot bigint;
  v_best_cov numeric; v_best_lbl text; v_best_viol bigint; kk text; vv bigint;
begin
  select array_agg(column_name order by ordinal),
         jsonb_object_agg(column_name, ordinal)
    into v_cols, v_ord
    from public.dataset_columns
   where dataset_id = p_dataset_id and data_type in ('numeric','bigint')
     and role in ('money','metric') and is_analyzable;

  if v_cols is null or cardinality(v_cols) < 2 then
    return jsonb_build_object('ok', true, 'rules', v_found);
  end if;

  -- (1) Reglas de razon: a = b * k
  foreach a in array v_cols loop
    foreach b in array v_cols loop
      if a = b then continue; end if;
      -- Solo la direccion "cifra derivada = cifra base * k". Sin esto se
      -- reporta dos veces la MISMA relacion (annual = monthly*12 y
      -- monthly = annual*0.083333), y gerencia ve dos alertas donde hay una.
      if (v_ord->>a)::int < (v_ord->>b)::int then continue; end if;

      execute format(
        'select mode() within group (order by round(%1$I / nullif(%2$I,0), 6)) '
        'from %3$s where %1$I is not null and %2$I is not null and %2$I <> 0',
        a, b, v_t) into v_ratio;
      if v_ratio is null or v_ratio = 0 then continue; end if;

      execute format(
        'select count(*) filter (where abs(%1$I - %2$I * %4$L::numeric) <= 0.02)::numeric '
        '     / nullif(count(*),0) '
        'from %3$s where %1$I is not null and %2$I is not null',
        a, b, v_t, v_ratio) into v_cov;
      if v_cov is null or v_cov < 0.95 then continue; end if;

      execute format(
        'select count(*) from %3$s where %1$I is not null and %2$I is not null '
        '  and abs(%1$I - %2$I * %4$L::numeric) > 0.02',
        a, b, v_t, v_ratio) into v_viol;

      v_found := v_found || jsonb_build_object(
        'target', a, 'kind', 'ratio', 'source', b, 'factor', v_ratio,
        'coverage', round(v_cov, 5), 'violations', v_viol,
        'rule', format('%s = %s * %s', a, b,
                       trim(trailing '.' from trim(trailing '0' from v_ratio::text))));

      -- Derivada solo si la regla es EXACTA y la fuente es anterior en el
      -- archivo: la convencion universal es listar primero la cifra base.
      if v_viol = 0 and (v_ord->>a)::int > (v_ord->>b)::int then
        update public.dataset_columns
           set role = 'derived', is_analyzable = false,
               derived_rule = format('%s = %s * %s', a, b, v_ratio)
         where dataset_id = p_dataset_id and column_name = a;
        exit;
      end if;
    end loop;
  end loop;

  -- (2) Reglas aditivas: c = suma de un subconjunto (2..4 sumandos).
  foreach c in array v_cols loop
    if exists (select 1 from public.dataset_columns
                where dataset_id = p_dataset_id and column_name = c and role = 'derived') then
      continue;
    end if;

    v_sub := array(select x from unnest(v_cols) x where x <> c);
    if cardinality(v_sub) < 2 then continue; end if;
    v_exprs := '{}'; v_labels := '{}';

    for i in 1 .. cardinality(v_sub) loop
      for j in i + 1 .. cardinality(v_sub) loop
        -- Alias sintetico: concatenar nombres reales desborda el limite de
        -- 63 caracteres de identificador y trunca la regla.
        v_labels := v_labels || (v_sub[i] || ' + ' || v_sub[j]);
        v_exprs := v_exprs || format(
          'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0))) <= 0.02) as k%4$s',
          c, v_sub[i], v_sub[j], cardinality(v_labels) - 1);
        for k in j + 1 .. cardinality(v_sub) loop
          v_labels := v_labels || (v_sub[i] || ' + ' || v_sub[j] || ' + ' || v_sub[k]);
          v_exprs := v_exprs || format(
            'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0)+coalesce(%4$I,0))) <= 0.02) as k%5$s',
            c, v_sub[i], v_sub[j], v_sub[k], cardinality(v_labels) - 1);
          -- Subconjuntos de 4: sin este bucle la regla real del archivo de
          -- nomina (total_additional = 13ro+14to+horas+subrogaciones) nunca
          -- se prueba y gana una regla de 3 sumandos peor.
          if cardinality(v_sub) <= 12 then
            for m in k + 1 .. cardinality(v_sub) loop
              v_labels := v_labels || (v_sub[i] || ' + ' || v_sub[j] || ' + ' || v_sub[k] || ' + ' || v_sub[m]);
              v_exprs := v_exprs || format(
                'count(*) filter (where abs(%1$I - (coalesce(%2$I,0)+coalesce(%3$I,0)+coalesce(%4$I,0)+coalesce(%5$I,0))) <= 0.02) as k%6$s',
                c, v_sub[i], v_sub[j], v_sub[k], v_sub[m], cardinality(v_labels) - 1);
            end loop;
          end if;
        end loop;
      end loop;
    end loop;

    if cardinality(v_sub) between 4 and 12 then
      v_labels := v_labels || array_to_string(v_sub, ' + ');
      v_exprs := v_exprs || format(
        'count(*) filter (where abs(%1$I - (%2$s)) <= 0.02) as k%3$s',
        c, (select string_agg(format('coalesce(%I,0)', x), '+') from unnest(v_sub) x),
        cardinality(v_labels) - 1);
    end if;

    if cardinality(v_exprs) = 0 then continue; end if;

    execute format('select to_jsonb(t) from (select count(*) as n_, %s from %s where %I is not null) t',
                   array_to_string(v_exprs, ', '), v_t, c) into v_res;
    v_tot := (v_res->>'n_')::bigint;
    if v_tot is null or v_tot = 0 then continue; end if;

    -- Quedarse con la MEJOR cobertura, no con la primera que pase.
    v_best_cov := 0; v_best_lbl := null; v_best_viol := null;
    for kk, vv in select key, value::text::bigint from jsonb_each(v_res) where key <> 'n_' loop
      if vv::numeric / v_tot > v_best_cov then
        v_best_cov := vv::numeric / v_tot;
        v_best_lbl := v_labels[(substring(kk from 2))::int + 1];
        v_best_viol := v_tot - vv;
      end if;
    end loop;

    if v_best_cov >= 0.99 then
      v_found := v_found || jsonb_build_object(
        'target', c, 'kind', 'additive', 'sources', v_best_lbl,
        'coverage', round(v_best_cov, 5), 'violations', v_best_viol,
        'rule', format('%s = %s', c, v_best_lbl));
      if v_best_viol = 0 then
        update public.dataset_columns
           set role = 'derived', is_analyzable = false,
               derived_rule = format('%s = %s', c, v_best_lbl)
         where dataset_id = p_dataset_id and column_name = c;
      end if;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'rules', v_found);
end $fn$;
