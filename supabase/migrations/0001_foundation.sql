-- =====================================================================
-- ADIA 0001 - cimientos: extensiones, esquemas, rol de consulta,
--             tablas de metadatos y RLS.
-- =====================================================================

create extension if not exists vector    with schema extensions;
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists unaccent  with schema extensions;

create schema if not exists app;   -- logica de negocio (plpgsql)
create schema if not exists ds;    -- tablas tipadas generadas por dataset

-- ---------------------------------------------------------------------
-- Rol de baja privilegio para el SQL generado por la IA.
-- NO es superusuario y NO puede saltarse RLS.
-- ---------------------------------------------------------------------
do $rl$ begin
  if not exists (select 1 from pg_roles where rolname = 'adia_sql') then
    create role adia_sql nologin noinherit;
  end if;
end $rl$;

grant adia_sql to postgres;                 -- para que SECURITY DEFINER pueda SET ROLE
grant usage on schema ds         to adia_sql;
grant usage on schema extensions to adia_sql;
grant usage on schema auth       to adia_sql;   -- solo para auth.uid(); auth.users NO se concede
grant execute on function auth.uid()  to adia_sql;
grant execute on function auth.role() to adia_sql;

revoke all on schema public from adia_sql;
alter default privileges in schema public revoke execute on functions from adia_sql;
alter default privileges in schema ds grant select on tables to adia_sql;

-- ---------------------------------------------------------------------
-- Perfiles de usuario
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'admin' check (role in ('admin','analyst','viewer')),
  created_at  timestamptz not null default now()
);

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $fn$
begin
  insert into public.profiles(id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------
-- Datasets
-- ---------------------------------------------------------------------
create table public.datasets (
  id                 bigint generated always as identity primary key,
  owner_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name               text not null,
  source_filename    text,
  sheet_name         text,
  content_hash       text,
  status             text not null default 'created'
                     check (status in ('created','ingesting','ingested','building',
                                       'profiling','analyzing','ready','error')),
  phase              text,
  phase_message      text,
  phase_pct          numeric(5,2) not null default 0,
  error              text,
  chunk_size         int  not null default 2000,
  n_rows_expected    bigint,
  n_rows_bronze      bigint not null default 0,
  n_rows_silver      bigint not null default 0,
  n_rows_quarantined bigint not null default 0,
  phys_schema        text,
  phys_table         text,
  profile            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  ready_at           timestamptz,
  constraint datasets_owner_hash_uniq unique (owner_id, content_hash)
);
create index datasets_owner_idx on public.datasets(owner_id, created_at desc);

-- Diccionario de columnas: tipo, rol semantico y estadisticas.
create table public.dataset_columns (
  dataset_id     bigint not null references public.datasets(id) on delete cascade,
  ordinal        int    not null,
  source_name    text   not null,
  column_name    text   not null,       -- identificador saneado
  data_type      text   not null default 'text',
  role           text   not null default 'unknown',
  is_analyzable  boolean not null default true,
  decimal_sep    char(1) not null default '.',
  null_count     bigint,
  distinct_count bigint,
  stats          jsonb  not null default '{}'::jsonb,
  examples       jsonb  not null default '[]'::jsonb,
  derived_rule   text,
  notes          text,
  primary key (dataset_id, ordinal),
  constraint dataset_columns_name_uniq unique (dataset_id, column_name)
);

-- BRONCE: zona de aterrizaje inmutable. Particionada por dataset para que
-- archivar/borrar sea O(1) y las estadisticas sean por dataset.
create table public.dataset_rows (
  dataset_id bigint not null,
  row_idx    bigint not null,
  data       jsonb  not null,
  primary key (dataset_id, row_idx)
) partition by list (dataset_id);

-- Libro mayor de trozos: hace la ingesta idempotente y reanudable.
create table public.ingest_chunks (
  dataset_id bigint not null references public.datasets(id) on delete cascade,
  chunk_idx  int    not null,
  n_rows     int    not null,
  created_at timestamptz not null default now(),
  primary key (dataset_id, chunk_idx)
);

-- Mapa de normalizacion de valores (deriva de codificacion LOSEP/CT <-> 1/2).
create table public.dataset_value_map (
  dataset_id   bigint not null references public.datasets(id) on delete cascade,
  column_name  text   not null,
  raw_value    text   not null,
  mapped_value text   not null,
  confidence   numeric,
  confirmed    boolean not null default false,
  primary key (dataset_id, column_name, raw_value)
);

-- Diccionario de valores: aterriza los literales de la pregunta en los
-- valores que REALMENTE existen ("conserjes" -> "CONSERJE").
create table public.dataset_values (
  id          bigint generated always as identity primary key,
  dataset_id  bigint not null references public.datasets(id) on delete cascade,
  column_name text   not null,
  value       text   not null,
  n           bigint not null default 0,
  embedding   extensions.vector(1536),
  constraint dataset_values_uniq unique (dataset_id, column_name, value)
);
create index dataset_values_trgm_idx on public.dataset_values
  using gin (value extensions.gin_trgm_ops);

create table public.dataset_metrics (
  dataset_id     bigint primary key references public.datasets(id) on delete cascade,
  computed_at    timestamptz not null default now(),
  default_period text,
  metrics        jsonb not null default '{}'::jsonb,
  series         jsonb not null default '{}'::jsonb,
  narrative      text
);

create table public.dataset_alerts (
  id           bigint generated always as identity primary key,
  dataset_id   bigint not null references public.datasets(id) on delete cascade,
  code         text not null,
  severity     text not null check (severity in ('critical','high','medium','low','info')),
  category     text not null check (category in ('data_quality','statistical','business')),
  title        text not null,
  detail       text,
  metric       numeric,
  impact       numeric,
  evidence     jsonb not null default '[]'::jsonb,
  evidence_sql text,
  created_at   timestamptz not null default now()
);
create index dataset_alerts_ds_idx on public.dataset_alerts(dataset_id, severity);

-- Registro de reglas de alerta: los umbrales son datos, no codigo.
create table public.alert_rules (
  code         text primary key,
  title_tpl    text not null,
  detail_tpl   text not null,
  severity     text not null check (severity in ('critical','high','medium','low','info')),
  category     text not null check (category in ('data_quality','statistical','business')),
  applies_when jsonb not null default '{}'::jsonb,
  sql_tpl      text not null,
  params       jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  sort_order   int not null default 100
);

-- ---------------------------------------------------------------------
-- Capa IA
-- ---------------------------------------------------------------------
create table public.assistant_configs (
  id                   bigint generated always as identity primary key,
  owner_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_id           bigint references public.datasets(id) on delete cascade,
  name                 text not null default 'Por defecto',
  is_default           boolean not null default true,
  sql_model            text not null default 'gpt-5.5',
  fast_model           text not null default 'gpt-5.4-mini',
  embed_model          text not null default 'text-embedding-3-small',
  temperature          numeric not null default 0 check (temperature between 0 and 2),
  top_k_kb             int not null default 5  check (top_k_kb between 0 and 25),
  kb_min_similarity    numeric not null default 0.25,
  cache_enabled        boolean not null default true,
  cache_min_similarity numeric not null default 0.93,
  max_tool_iterations  int not null default 4 check (max_tool_iterations between 1 and 8),
  max_rows             int not null default 500,
  allow_freeform_sql   boolean not null default true,
  system_prompt        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.kb_documents (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_id bigint references public.datasets(id) on delete cascade,
  kind       text not null check (kind in ('glossary','schema_card','sql_exemplar','note')),
  title      text not null,
  content    text not null,
  sql_text   text,
  embedding  extensions.vector(1536),
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
create index kb_documents_ds_idx on public.kb_documents(dataset_id, kind);

-- Cache semantica. Guarda una PLANTILLA parametrizada, no una respuesta:
-- reejecutar protege del dato rancio; param_schema, del parametro rancio.
create table public.query_cache (
  id              bigint generated always as identity primary key,
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_id      bigint not null references public.datasets(id) on delete cascade,
  question        text not null,
  question_norm   text not null,
  embedding       extensions.vector(1536) not null,
  sql_template    text not null,
  param_schema    jsonb not null default '{}'::jsonb,
  answer_template text,
  status          text not null default 'candidate'
                  check (status in ('candidate','validated','rejected')),
  hit_count       int not null default 0,
  last_used_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index query_cache_ds_idx on public.query_cache(dataset_id, status);

create table public.chat_sessions (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dataset_id bigint not null references public.datasets(id) on delete cascade,
  title      text,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id            bigint generated always as identity primary key,
  session_id    bigint not null references public.chat_sessions(id) on delete cascade,
  owner_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role          text not null check (role in ('user','assistant','system','tool')),
  content       text,
  sql_text      text,
  result        jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  cache_hit     boolean,
  similarity    numeric,
  usage         jsonb,
  client_msg_id text,
  created_at    timestamptz not null default now()
);
create index chat_messages_session_idx on public.chat_messages(session_id, created_at);
create unique index chat_messages_idem_idx on public.chat_messages(session_id, client_msg_id)
  where client_msg_id is not null;

create table public.query_audit (
  id          bigint generated always as identity primary key,
  owner_id    uuid default auth.uid(),
  dataset_id  bigint,
  question    text,
  sql_text    text,
  row_count   int,
  elapsed_ms  int,
  ok          boolean,
  error       text,
  created_at  timestamptz not null default now()
);
create index query_audit_owner_idx on public.query_audit(owner_id, created_at desc);

-- Limitacion de tasa: no hay backend donde hacerlo, asi que vive en la BD.
create table public.rate_limits (
  user_id      uuid not null,
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (user_id, bucket, window_start)
);

create or replace function app.consume_rate_limit(
  p_user uuid, p_bucket text, p_limit int, p_window_secs int
) returns void language plpgsql security definer
set search_path = public, pg_catalog as $fn$
declare v_win timestamptz; v_n int;
begin
  if p_user is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501'; end if;
  v_win := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);
  insert into public.rate_limits(user_id, bucket, window_start, count)
  values (p_user, p_bucket, v_win, 1)
  on conflict (user_id, bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_n;
  if v_n > p_limit then
    raise exception 'RATE_LIMITED: % consultas por % s', p_limit, p_window_secs
      using errcode = '53400';
  end if;
end $fn$;

-- ---------------------------------------------------------------------
-- RLS
--
-- OJO: cada politica nombra a adia_sql ademas de authenticated. Tras
-- SET LOCAL ROLE adia_sql en exec_analysis_sql, current_user deja de ser
-- authenticated; si la politica no nombra el rol, no aplica ninguna
-- politica permisiva y TODA consulta devuelve cero filas en silencio.
-- auth.uid() no se ve afectado por SET ROLE (lee el GUC del JWT).
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.datasets          enable row level security;
alter table public.dataset_columns   enable row level security;
alter table public.dataset_rows      enable row level security;
alter table public.ingest_chunks     enable row level security;
alter table public.dataset_value_map enable row level security;
alter table public.dataset_values    enable row level security;
alter table public.dataset_metrics   enable row level security;
alter table public.dataset_alerts    enable row level security;
alter table public.alert_rules       enable row level security;
alter table public.assistant_configs enable row level security;
alter table public.kb_documents      enable row level security;
alter table public.query_cache       enable row level security;
alter table public.chat_sessions     enable row level security;
alter table public.chat_messages     enable row level security;
alter table public.query_audit       enable row level security;
alter table public.rate_limits       enable row level security;

create policy profiles_self on public.profiles for all
  to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy datasets_own on public.datasets for all
  to authenticated, adia_sql
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Tablas hijas: se resuelven contra datasets. El EXISTS no referencia otras
-- columnas de la fila externa, asi que el planificador lo evalua una sola vez.
do $pol$
declare t text;
begin
  foreach t in array array['dataset_columns','ingest_chunks','dataset_value_map',
                           'dataset_values','dataset_metrics','dataset_alerts']
  loop
    execute format(
      'create policy %1$s_own on public.%1$I for all '
      '  to authenticated, adia_sql '
      '  using      (exists (select 1 from public.datasets d '
      '                      where d.id = %1$I.dataset_id and d.owner_id = auth.uid())) '
      '  with check (exists (select 1 from public.datasets d '
      '                      where d.id = %1$I.dataset_id and d.owner_id = auth.uid()))', t);
  end loop;
end $pol$;

create policy dataset_rows_own on public.dataset_rows for all
  to authenticated, adia_sql
  using      (exists (select 1 from public.datasets d
                      where d.id = dataset_rows.dataset_id and d.owner_id = auth.uid()))
  with check (exists (select 1 from public.datasets d
                      where d.id = dataset_rows.dataset_id and d.owner_id = auth.uid()));

-- Tablas con owner_id propio
do $pol2$
declare t text;
begin
  foreach t in array array['assistant_configs','kb_documents','query_cache',
                           'chat_sessions','chat_messages','query_audit']
  loop
    execute format(
      'create policy %1$s_own on public.%1$I for all '
      '  to authenticated, adia_sql '
      '  using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $pol2$;

create policy rate_limits_own on public.rate_limits for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- El registro de reglas es global y de solo lectura para los usuarios.
create policy alert_rules_read on public.alert_rules for select
  to authenticated, adia_sql using (true);

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on public.datasets to adia_sql;   -- lo necesitan los EXISTS de las politicas
revoke all on public.rate_limits from anon;
