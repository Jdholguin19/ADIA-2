-- =====================================================================
-- ADIA 0005 - validacion de tipos contra TODAS las filas del bronce.
--
-- El cliente infiere tipos sobre una muestra, y una muestra siempre puede
-- mentir: en el archivo de nomina, 382 de 93.540 filas traen decimales en
-- charges_and_subrogations, asi que la muestra dice "bigint" y esas 382
-- filas legitimas acabarian en cuarentena.
--
-- Regla: pocos fallos = defecto de datos (cuarentena); muchos fallos =
-- tipo equivocado (se ensancha). Y un valor numerico con parte decimal en
-- una columna bigint SIEMPRE ensancha, sea uno o sean mil: eso no es una
-- fila mala, es un tipo estrecho.
-- =====================================================================

create or replace function app.validate_types(p_dataset_id bigint, p_tolerance numeric default 0.005)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog
set statement_timeout = '280s' as $fn$
declare
  c record; v_type text; v_ne bigint; v_fail bigint; v_frac bigint;
  v_changes jsonb := '[]'::jsonb; v_guard int;
begin
  for c in
    select * from public.dataset_columns
     where dataset_id = p_dataset_id and data_type <> 'text'
     order by ordinal
  loop
    v_type := c.data_type;

    -- (1) bigint con decimales reales -> numeric, sin importar cuantos.
    if v_type = 'bigint' then
      execute format($q$
        select count(*) from public.dataset_rows
         where dataset_id = %1$s
           and nullif(btrim(data->>%2$L), '') is not null
           and app.to_numeric_safe(data->>%2$L, %3$L) is not null
           and app.to_numeric_safe(data->>%2$L, %3$L)
               <> trunc(app.to_numeric_safe(data->>%2$L, %3$L))
      $q$, p_dataset_id, c.column_name, c.decimal_sep) into v_frac;
      if v_frac > 0 then v_type := 'numeric'; end if;
    end if;

    -- (2) Ensanchar mientras los fallos de coercion superen la tolerancia.
    v_guard := 0;
    loop
      v_guard := v_guard + 1;
      exit when v_type = 'text' or v_guard > 4;

      execute format($q$
        select count(*) filter (where raw is not null),
               count(*) filter (where raw is not null and %4$s is null)
          from (select nullif(btrim(data->>%2$L), '') as raw, data
                  from public.dataset_rows where dataset_id = %1$s) t
      $q$, p_dataset_id, c.column_name, c.decimal_sep,
           app.coerce_expr(c.column_name, v_type, c.decimal_sep))
      into v_ne, v_fail;

      exit when v_ne = 0 or v_fail::numeric / v_ne <= p_tolerance;

      v_type := case v_type
                  when 'bigint'  then 'numeric'
                  when 'numeric' then 'text'
                  when 'date'    then 'text'
                  when 'boolean' then 'text'
                  else 'text' end;
    end loop;

    if v_type <> c.data_type then
      v_changes := v_changes || jsonb_build_object(
        'column', c.column_name, 'from', c.data_type, 'to', v_type,
        'fractional_values', coalesce(v_frac, 0), 'coercion_failures', coalesce(v_fail, 0));
      update public.dataset_columns
         set data_type = v_type,
             notes = format('tipo ensanchado de %s a %s tras validar todas las filas',
                            c.data_type, v_type)
       where dataset_id = p_dataset_id and ordinal = c.ordinal;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'changes', v_changes);
end $fn$;
