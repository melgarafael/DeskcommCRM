-- selfhost-prelude.sql — stubs de compatibilidade para rodar o baseline num
-- POSTGRES PURO (sem Supabase): roles anon/authenticated/service_role, schemas
-- auth/extensions/storage com stubs mínimos, e as extensões que o dump supõe
-- (uuid-ossp, pgcrypto, vector, citext, pg_trgm).
--
-- QUANDO USAR: só no caminho "Postgres próprio" do self-host. Com um projeto
-- Supabase (o caminho recomendado do README), NADA disto é necessário — o
-- Supabase já fornece tudo nativo (e com Auth/Storage REAIS, não stubs).
-- LIMITE HONESTO: auth.users/storage aqui são STUBS — login e upload de mídia
-- do app exigem Supabase real; o worker/agente funcionam integralmente.
--
-- Fonte: o mesmo prelude do gate de CI (scripts/test-db.sh) — se editar um,
-- edite o outro. O invariante `selfhost-prelude-aplica-o-baseline` aplica este
-- arquivo + o baseline num banco vazio e reprova quando eles se separam.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create schema if not exists extensions;

-- O baseline referencia extensions.uuid_generate_v4/gen_random_bytes e os tipos
-- public.vector/public.citext + gin_trgm_ops, mas não cria as extensões (pg_dump).
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;

-- Stubs de storage (o apêndice do baseline cria buckets + policies em storage.objects).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.users (FKs do baseline apontam pra cá).
--
-- `raw_user_meta_data` é o nome real da coluna no GoTrue; o baseline a lê
-- (fn_conversation_assign, backfill de conversations.assigned_to_user_name).
-- O `alter` alcança quem aplicou uma versão anterior deste prelude.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}'::jsonb;

-- Contrato Supabase usado pelo suporte: sessão é do Auth, nunca do produto.
create table if not exists auth.sessions (
 id uuid primary key, user_id uuid not null references auth.users(id),
 aal text, not_after timestamptz
);
create table if not exists auth.mfa_factors (
 id uuid primary key, user_id uuid not null references auth.users(id), status text, factor_type text default 'totp'
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb;
$$;

-- Stub de auth.uid() — mesmo corpo do Supabase (o `nullif` protege o CAST:
-- GUC já tocado na sessão vale '' e não NULL).
create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $fn$;

grant usage on schema auth, extensions, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
