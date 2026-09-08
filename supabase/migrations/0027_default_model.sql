-- =====================================================================
-- ADIA 0027 - modelo por defecto gpt-5.4-mini en vez de gpt-5.5.
-- Para escribir SQL sobre un esquema ya descrito en el prompt, mini da la
-- misma precision con bastante menos latencia y coste, y admite
-- temperature=0, que es lo que se quiere cuando se producen cifras
-- (gpt-5.5 solo acepta el valor por defecto).
-- =====================================================================
alter table public.assistant_configs alter column sql_model set default 'gpt-5.4-mini';
update public.assistant_configs set sql_model = 'gpt-5.4-mini' where sql_model = 'gpt-5.5';
