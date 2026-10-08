-- manifest: **O CPF do contato passa a ser cifrado de verdade: `encrypt_cpf`/`decrypt_cpf` nascem no schema (issue #2522).** Toda gravação de contato COM CPF falhava em produção — importação CSV (`POST /api/v1/contacts/import`), cadastro (`POST /api/v1/contacts`) e edição — com `new row for relation "contacts" violates check constraint "contacts_cpf_consistency"`. Duas causas encadeadas: `encryptCpfSql()` (`lib/contacts/cpf.ts`) chama a RPC `encrypt_cpf`, que NÃO existia em `supabase/` (o próprio comentário dizia "not yet provisioned"), e quando a RPC falhava o código gravava só `cpf_hash` deixando `cpf_encrypted` nulo — enquanto o CHECK do baseline exige `(cpf_encrypted IS NULL) = (cpf_hash IS NULL)`. Numa base importada de ~3.000 contatos todas as linhas com CPF foram rejeitadas e o CPF teve de ser guardado em texto plano num campo personalizado (perdendo a busca). A migration cria o par que a coluna espera no desenho da 0041 (`fn_encrypt_oauth`): chave em `private.app_secrets.name = 'cpf_key'` com a GUC `app.cpf_key` como override — Supabase cloud NÃO permite `ALTER DATABASE ... SET` de GUC custom (42501) e a chave NUNCA entra em SQL versionado (L-09) —, `pgp_sym_encrypt`/`pgp_sym_decrypt` aes256 com pgcrypto no schema `extensions` (forward-fix medido da 0041: `search_path` sem `extensions` nunca resolve o `pgp_sym_*`). `decrypt_cpf(p_contact_id uuid)` é o helper da spec 02 §2.1: checa tenancy (`fn_user_org_ids()` + `fn_is_platform_admin()`), audita `contact.cpf_decrypted` em `api_audit_log` ANTES de devolver o texto e só então lê a coluna. Grants na régua das funções chamáveis pela sessão (`revoke public, anon` / `grant authenticated, service_role`): o cliente de servidor usa a ANON key com o JWT do usuário. Com a RPC no schema a linha nasce com os DOIS campos e o CHECK é respeitado; o lado do código passa a não gravar `cpf_hash` sem `cpf_encrypted` (`camposCpfParaGravar`), então instalação cuja chave ainda não foi semeada salva o contato SEM CPF em vez de reprovar a linha inteira — a degradação documentada que a issue pede como alternativa mínima. Reaplicável: `create or replace` + `create extension/schema/table if not exists`.

-- 0597 — `encrypt_cpf(p_plaintext)` / `decrypt_cpf(p_contact_id)` existem no schema
--
-- Por quê: a coluna `contacts.cpf_encrypted bytea` nasceu com a promessa de
-- pgcrypto (spec 02 §2.1, comentário da própria coluna: "Acesso via
-- decrypt_cpf()") e a rotina de gravação chama `encrypt_cpf` — mas nenhuma
-- migration criava as duas. O CHECK `contacts_cpf_consistency` exige que
-- `cpf_encrypted` e `cpf_hash` estejam JUNTOS ou AMBOS nulos; com a RPC
-- ausente o código gravava só o hash e o banco recusava a linha inteira
-- (#2522: 496 de 500 linhas rejeitadas na importação do reportante).
--
-- Chave: MESMO desenho da 0041 — `private.app_secrets` é a casa (a cloud nega
-- `ALTER DATABASE ... SET` de GUC custom com 42501), a GUC `app.cpf_key` é o
-- override para VPS/psql/testes, e o valor NUNCA aparece em SQL versionado.
-- O kit do self-host semeia a linha a partir de `CPF_ENCRYPTION_KEY`
-- (`hostgator-setup-kit/_common.sh`, `ensure_encryption_key`).
--
-- Sem chave a função levanta `CPF_ENCRYPTION_KEY ausente` (a régua da
-- `fn_encrypt_oauth`); o chamador então grava a linha SEM CPF — nunca só o
-- hash, que é o que o CHECK recusa.
--
-- Idempotente e auto-curativo: `create or replace`, `if not exists` e grants
-- repetidos. Nenhum dado existente é tocado (a coluna nasce vazia).

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
create table if not exists private.app_secrets (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
revoke all on schema private from public;
revoke all on all tables in schema private from public;

-- Fonte da chave da cifra de CPF: GUC `app.cpf_key` como override, senão a
-- linha `cpf_key` de private.app_secrets (mesma precedência de private.fn_oauth_key).
create or replace function private.fn_cpf_key() returns text
    language sql security definer
    set search_path to 'private', 'pg_temp'
    as $$
  select coalesce(
    nullif(current_setting('app.cpf_key', true), ''),
    (select value from private.app_secrets where name = 'cpf_key')
  );
$$;
revoke all on function private.fn_cpf_key() from public;

create or replace function public.encrypt_cpf(p_plaintext text) returns bytea
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  k text := private.fn_cpf_key();
begin
  if k is null or length(k) < 32 then
    raise exception 'CPF_ENCRYPTION_KEY ausente';
  end if;
  return pgp_sym_encrypt(p_plaintext, k, 'cipher-algo=aes256');
end$$;

create or replace function public.decrypt_cpf(p_contact_id uuid) returns text
    language plpgsql security definer
    set search_path to 'public', 'private', 'extensions', 'pg_temp'
    as $$
declare
  v_cipher bytea;
  v_org    uuid;
begin
  select cpf_encrypted, organization_id into v_cipher, v_org
    from public.contacts where id = p_contact_id;

  -- Guardas na MESMA ordem da 0240 (#754): null, depois o piso medido, depois a
  -- cara de pacote PGP, e só então decifra — `get_byte` em bytea vazio estoura.
  -- `contacts.cpf_encrypted` é nullable (não há linha de enfeite), mas cifra nova
  -- carrega guarda nova: é o que a catraca `credencial-de-enfeite` cobra.
  if v_cipher is null then return null; end if;
  if octet_length(v_cipher) < 66 then
    raise exception 'cpf_ciphertext_invalido';
  end if;
  if get_byte(v_cipher, 0) < 128 then
    raise exception 'cpf_ciphertext_invalido';
  end if;

  -- Tenancy: só quem pertence à organização do contato (ou platform admin).
  -- `fn_user_org_ids()` devolve SETOF uuid — a spec 02 escrevia
  -- `x.organization_id`, que não compila contra a assinatura real.
  if not exists (
    select 1 from public.fn_user_org_ids() o where o = v_org
  ) and not public.fn_is_platform_admin() then
    raise exception 'forbidden_org';
  end if;

  -- Papel: a mesma régua de getContactHandler (manager+), conferida também
  -- dentro da função, como fazem as funções irmãs.
  if not public.fn_role_at_least(v_org, 'manager') and not public.fn_is_platform_admin() then
    raise exception 'forbidden_role';
  end if;

  -- Audit antes do plaintext: decrypt sem rastro é decrypt que a LGPD não vê.
  insert into public.api_audit_log
    (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values
    (v_org, auth.uid(), 'contact.cpf_decrypted', 'contact', p_contact_id,
     jsonb_build_object('purpose', current_setting('app.decrypt_purpose', true)));

  return pgp_sym_decrypt(v_cipher, private.fn_cpf_key());
end$$;

revoke execute on function public.encrypt_cpf(text) from public, anon;
grant  execute on function public.encrypt_cpf(text) to authenticated, service_role;

revoke execute on function public.decrypt_cpf(uuid) from public, anon;
grant  execute on function public.decrypt_cpf(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
