-- manifest: **A linha `contact.cpf_decrypted` passa a carregar o PROPÓSITO da leitura do CPF, e a leitura da ficha deixa de gravar `contact.updated` (#4892).** `decrypt_cpf` ganha a assinatura de DOIS argumentos (`p_contact_id uuid, p_purpose text`), SEM `default null`, com o corpo auditado da 0762 e UMA linha trocada: `jsonb_build_object('purpose', coalesce(p_purpose, current_setting('app.decrypt_purpose', true)))` — o parâmetro tem precedência sobre o GUC, e o GUC continua valendo para quem chama por SQL. A assinatura de um argumento vira CASCA (`security invoker`) que delega com `null`: com `default null` na nova, `decrypt_cpf(id)` fica ambígua e derruba o export de contatos, que chama de um argumento (medido em Postgres 17.11). `app/api/v1/contacts/_handler.ts` passa `p_purpose` na RPC e PARA de gravar a linha `contact.updated` com `decrypt_purpose` — leitura não é atualização. Aditiva e idempotente (`create or replace` nas duas assinaturas, grants reemitidos nas DUAS origens de EXECUTE); espelho no apêndice do `baseline.sql`, antes da VARREDURA anon (0116); `MANIFEST.md` é histórico e não recebe linha. Gate: `tests/invariants/cpf-proposito-na-linha-certa.test.ts`.

-- 9423 — o propósito da leitura do CPF precisa sair na linha certa da trilha (#4892).
--
-- ## O defeito medido
--
-- `decrypt_cpf` (0597, forward-fix 0762) audita `contact.cpf_decrypted` com
-- `current_setting('app.decrypt_purpose', true)`. O handler da ficha chama a RPC
-- pelo PostgREST, que abre a TRANSAÇÃO dele: não há como fixar o GUC na mesma
-- transação da chamada. Resultado medido pela issue: a linha do decrypt nasce
-- com `metadata.purpose = null`, e o propósito vai parar numa SEGUNDA linha —
-- `contact.updated` — gravada pelo handler. Duas coisas erradas numa: a ação é
-- de ESCRITA para um evento de LEITURA, e quem audita LGPD filtrando por
-- `contact.cpf_decrypted` não acha o motivo de a ficha ter sido aberta.
--
-- ## O conserto: o propósito é PARÂMETRO da função
--
-- O caminho que o PostgREST consegue fazer é argumento nomeado. A assinatura
-- nova (`p_contact_id uuid, p_purpose text`) carrega o propósito do handler até
-- o `jsonb_build_object`, com `coalesce(p_purpose, current_setting(...))`:
-- parâmetro VENCE o GUC; o GUC continua atendendo quem chama por psql e quem já
-- usa `set_config` antes da leitura (nenhum chamador de hoje, mas é contrato
-- público da função desde a 0597).
--
-- ## ⚠️ `default null` está PROIBIDO nesta assinatura — medido
--
-- Com `decrypt_cpf(uuid)` e `decrypt_cpf(uuid, text default null)` no catálogo,
-- a chamada de UM argumento fica AMBÍGUA. Medido em Postgres 17.11 nesta frente:
--
--   ERROR:  function public.decrypt_cpf(uuid) is not unique
--   HINT:   Could not choose a best candidate function.
--
-- O mesmo vale para a chamada por nome (`p_contact_id => ...`), que é a forma do
-- PostgREST. Quem quebra primeiro é `app/api/v1/contacts/export/route.ts`, que
-- decifra a lista inteira com a chamada de um argumento. Por isso a assinatura
-- nova NÃO tem DEFAULT e a de um argumento continua existindo — como CASCA.
--
-- ## Por que a casca é `security invoker`
--
-- Ela não lê tabela nem escreve audit: só delega para a assinatura de dois
-- argumentos com `p_purpose` nulo, e é lá que moram as guardas de tenancy/papel
-- (`fn_user_org_ids`, `fn_role_at_least`, `fn_is_platform_admin_full`) e o
-- `security definer`. A casca nascer definer acrescentaria uma porta privilegiada
-- sem nenhuma guarda dentro — exatamente o que a varredura de definer cobra.
-- As guardas NÃO foram afrouxadas: o corpo auditado é o da 0762, com a linha do
-- `purpose` trocada e mais nada.
--
-- ## Ordem dentro do bloco (não é estilo)
--
-- Casca PRIMEIRO, corpo auditado DEPOIS. O corpo auditado precisa ser a ÚLTIMA
-- definição de `decrypt_cpf` do `baseline.sql` — é ele que
-- `tests/unit/credencial-de-enfeite-nao-derruba-a-leitura.test.ts` compara com a
-- última migration que toca a função (install × update), e é ele que instala a
-- guarda. A casca é `plpgsql` de propósito: o corpo em `sql` resolveria o nome
-- da assinatura de dois argumentos no CREATE, e ela ainda não existe nesta linha.

create or replace function public.decrypt_cpf(p_contact_id uuid) returns text
    language plpgsql
    set search_path to ''
    as $$
begin
  -- A casca não tem propósito próprio: quem chama por um argumento usa o GUC
  -- `app.decrypt_purpose` (ou nada), como antes da 9423.
  return public.decrypt_cpf(p_contact_id, null);
end$$;

create or replace function public.decrypt_cpf(p_contact_id uuid, p_purpose text) returns text
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
  -- (9423) O parâmetro VENCE o GUC: quem chama pelo PostgREST não tem como fixar
  -- `app.decrypt_purpose` na transação da chamada.
  insert into public.api_audit_log
    (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values
    (v_org, auth.uid(), 'contact.cpf_decrypted', 'contact', p_contact_id,
     jsonb_build_object('purpose', coalesce(p_purpose, current_setting('app.decrypt_purpose', true))));

  return pgp_sym_decrypt(v_cipher, private.fn_cpf_key());
end$$;

-- As DUAS origens de EXECUTE (CLAUDE.md): o grant direto do ALTER DEFAULT
-- PRIVILEGES a anon, que `revoke from public` não remove, e o grant a PUBLIC,
-- do qual anon herda, que `revoke from anon` não remove. As duas assinaturas
-- são reafirmadas — a de um argumento já tinha grant da 0597, e repetir aqui é
-- o que mantém a régua quando a função é redefinida.
revoke execute on function public.decrypt_cpf(uuid) from public, anon;
grant  execute on function public.decrypt_cpf(uuid) to authenticated, service_role;

revoke execute on function public.decrypt_cpf(uuid, text) from public, anon;
grant  execute on function public.decrypt_cpf(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
