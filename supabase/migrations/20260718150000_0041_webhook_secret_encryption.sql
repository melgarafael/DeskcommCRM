-- 0041: cifragem at-rest dos secrets de webhooks (spec 2026-07-17 §10 — retrofit)
-- webhook_sources.secret (text) -> secret_encrypted (bytea via fn_encrypt_oauth)
-- automation_rules.actions[].config.secret -> config.secret_enc (hex do bytea)
--
-- A cifra usa a MESMA infra do Nuvemshop/WAHA: pgp_sym_encrypt com a chave na
-- GUC `app.nuvemshop_oauth_key` (ALTER DATABASE ... SET). Clones sem a chave:
-- os secrets plaintext existentes NÃO são recuperáveis com segurança — são
-- descartados com WARNING (feature recém-lançada; re-configurar leva segundos
-- na UI e é melhor que manter plaintext, que é o objeto deste retrofit).
-- Idempotente e portável em psql puro.

-- Forward-fix de raiz: fn_encrypt_oauth/fn_decrypt_oauth fixavam
-- search_path='public', mas pgcrypto vive no schema `extensions` no Supabase
-- (e faltava no baseline) — pgp_sym_* NUNCA resolvia. Garante a extensão e
-- recria as funções com o search_path correto.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Fonte da chave: Supabase cloud NÃO permite ALTER DATABASE/ROLE SET de GUC
-- custom (42501) — GUC-only nunca funcionaria lá. A chave vive em
-- private.app_secrets (schema sem grants; só as SECURITY DEFINER leem);
-- a GUC, quando setada (VPS/psql/testes), tem precedência como override.
create schema if not exists private;
create table if not exists private.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on schema private from public;
revoke all on all tables in schema private from public;

create or replace function private.fn_oauth_key() returns text
    language sql security definer
    set search_path to 'private', 'pg_temp'
    as $$
  select coalesce(
    nullif(current_setting('app.nuvemshop_oauth_key', true), ''),
    (select value from private.app_secrets where name = 'nuvemshop_oauth_key')
  );
$$;
revoke all on function private.fn_oauth_key() from public;

create or replace function public.fn_encrypt_oauth(plaintext text) returns bytea
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
begin
  if k is null or length(k) < 32 then
    raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente';
  end if;
  return pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256');
end$$;

create or replace function public.fn_decrypt_oauth(ciphertext bytea) returns text
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_oauth_key();
begin
  return pgp_sym_decrypt(ciphertext, k);
end$$;

revoke all on function public.fn_encrypt_oauth(text) from public;
revoke all on function public.fn_decrypt_oauth(bytea) from public;
grant execute on function public.fn_encrypt_oauth(text) to service_role;
grant execute on function public.fn_decrypt_oauth(bytea) to service_role;

alter table public.webhook_sources
  add column if not exists secret_encrypted bytea;

do $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
  has_plain boolean;
  n_dropped int;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'webhook_sources' and column_name = 'secret'
  ) into has_plain;
  if not has_plain then
    return; -- já migrado
  end if;

  if k is not null and length(k) >= 32 then
    update public.webhook_sources
      set secret_encrypted = public.fn_encrypt_oauth(secret)
      where secret is not null and secret_encrypted is null;
  else
    select count(*) into n_dropped from public.webhook_sources where secret is not null;
    if n_dropped > 0 then
      raise warning 'webhook_sources: % secret(s) plaintext descartado(s) — GUC app.nuvemshop_oauth_key ausente; re-configure os secrets pela UI', n_dropped;
    end if;
  end if;

  alter table public.webhook_sources drop column secret;
end$$;

-- automation_rules: reescreve configs de call_webhook trocando secret -> secret_enc
do $$
declare
  k text := current_setting('app.nuvemshop_oauth_key', true);
  r record;
  new_actions jsonb;
  a jsonb;
  n_dropped int := 0;
begin
  for r in
    select id, actions from public.automation_rules
    where actions::text like '%"secret"%'
  loop
    new_actions := '[]'::jsonb;
    for a in select * from jsonb_array_elements(r.actions) loop
      if a->>'type' = 'call_webhook' and (a->'config') ? 'secret' then
        if k is not null and length(k) >= 32 then
          a := jsonb_set(
            a #- '{config,secret}',
            '{config,secret_enc}',
            to_jsonb(encode(public.fn_encrypt_oauth(a#>>'{config,secret}'), 'hex'))
          );
        else
          a := a #- '{config,secret}';
          n_dropped := n_dropped + 1;
        end if;
      end if;
      new_actions := new_actions || jsonb_build_array(a);
    end loop;
    update public.automation_rules set actions = new_actions, updated_at = now()
      where id = r.id;
  end loop;
  if n_dropped > 0 then
    raise warning 'automation_rules: % secret(s) de call_webhook descartado(s) — GUC app.nuvemshop_oauth_key ausente; re-configure pela UI', n_dropped;
  end if;
end$$;
