-- manifest: decifrar o CPF de um contato pelo poder de PLATAFORMA (fora do papel na própria organização) passa a exigir `scope = 'full'` e a sessão confirmada pelo código (`aal2`) de quem tem fator verificado — a régua da `fn_is_platform_admin_full` (0757); o membro manager+ da organização do contato segue lendo como antes.
--
-- Leitura de dado pessoal sensível pelo poder de plataforma segue a mesma régua
-- da escrita: nos dois portões de `decrypt_cpf` (organização e papel), o ramo de
-- plataforma passa a perguntar `fn_is_platform_admin_full()` em vez de
-- `fn_is_platform_admin()`. Corpo igual ao da 0597 fora isso.
--
-- O app não chega a este ramo: o get do contato confere o papel manager+ na
-- própria organização antes de chamar a RPC, e o export passa por
-- `requireRole("manager")` sem atalho de plataforma — o acompanhamento de
-- suporte entra pelo papel que `fn_user_org_ids`/`fn_role_at_least` já dão.
-- `create or replace` preserva os grants; o revoke/grant abaixo repete a 0597.

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

  -- Tenancy: só quem pertence à organização do contato (ou o poder de
  -- plataforma com `scope = 'full'` e a sessão confirmada — ver a 0762).
  -- `fn_user_org_ids()` devolve SETOF uuid — a spec 02 escrevia
  -- `x.organization_id`, que não compila contra a assinatura real.
  if not exists (
    select 1 from public.fn_user_org_ids() o where o = v_org
  ) and not public.fn_is_platform_admin_full() then
    raise exception 'forbidden_org';
  end if;

  -- Papel: a mesma régua de getContactHandler (manager+), conferida também
  -- dentro da função, como fazem as funções irmãs.
  if not public.fn_role_at_least(v_org, 'manager') and not public.fn_is_platform_admin_full() then
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

revoke execute on function public.decrypt_cpf(uuid) from public, anon;
grant  execute on function public.decrypt_cpf(uuid) to authenticated, service_role;
