-- 0449 — a anonimização (LGPD) alcança a pessoa que decide e a linha de planilha
-- importada (metade B2B do #1621, contribuição de @renatofortal).
--
-- A 0448 criou duas tabelas que guardam gente e que o botão "Anonimizar" não
-- alcançava:
--
--   people        — nome, e-mail e anotações da PESSOA para quem o contato
--                   aponta (`contacts.person_id`). É o mesmo titular: o
--                   contato é um telefone dele.
--   import_rows   — a linha da planilha como ela veio (`raw_data`) e como foi
--                   lida (`normalized_data`): nome, telefone, e-mail, cargo. E o
--                   `error` da linha recusada, que citava o telefone.
--
-- E `company_people`, o vínculo da pessoa com a empresa: `job_title`,
-- `department` e `notes` são texto sobre a pessoa ("Diretor financeiro da
-- Empresa X" identifica alguém mesmo com o nome trocado).
--
-- ─── Por que gatilho, e não mais um passo em fn_lgpd_cascade_redact_contact ──
--
-- Os dois caminhos de anonimizar (pedido formal e botão da ficha) terminam na
-- mesma função desde a 0414, e a virada `is_anonymized false → true` em
-- `contacts` é o último fato dos dois — o molde de
-- `trg_redigir_tarefas_ao_anonimizar` (0210). Há também uma razão de ORDEM: a
-- 0477 (proposta comercial, timestamp posterior a este) reescreve o corpo da
-- função inteira; um passo acrescentado aqui seria apagado por ela em quem
-- aplica a cadeia de migrations. O gatilho é independente do corpo da função.
--
-- ─── O que fica, e o que NÃO se alcança ─────────────────────────────────────
--
-- Fica: a linha de `import_rows` (número, status, lote) — é a prova de que o
-- lote rodou —, a linha de `people` (com o nome trocado pelo rótulo) e o
-- vínculo com a empresa. A EMPRESA não é tocada: razão social, CNPJ e endereço
-- são da pessoa jurídica, não do titular.
--
-- NÃO se alcançam os OUTROS contatos da mesma pessoa. Um telefone de pessoa
-- pode ser a linha da recepção da empresa, dividida com quem não pediu nada, e
-- anonimizar é irreversível: cada telefone é anonimizado pelo próprio pedido.
-- As linhas de planilha desses outros telefones, porém, carregam o NOME do
-- titular — por isso a redação de `import_rows` casa também por `person_id`.
create or replace function public.fn_redigir_b2b_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.import_rows
     set raw_data = '{}'::jsonb,
         normalized_data = '{}'::jsonb,
         error = null
   where organization_id = new.organization_id
     and (contact_id = new.id
          or (new.person_id is not null and person_id = new.person_id));

  if new.person_id is not null then
    update public.people
       set full_name = 'Pessoa anonimizada #' || substring(new.person_id::text from 1 for 8),
           normalized_name = null,
           email = null,
           notes = null
     where organization_id = new.organization_id
       and id = new.person_id;

    update public.company_people
       set job_title = null,
           department = null,
           notes = null
     where organization_id = new.organization_id
       and person_id = new.person_id;
  end if;
  return new;
end;
$$;

-- Função de gatilho não exige EXECUTE de quem dispara o UPDATE; revogar das
-- três origens a mantém fora da lista de exceções do invariante de hardening.
revoke execute on function public.fn_redigir_b2b_do_contato_anonimizado() from public, anon, authenticated;
grant  execute on function public.fn_redigir_b2b_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_b2b_ao_anonimizar on public.contacts;
create trigger trg_redigir_b2b_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_b2b_do_contato_anonimizado();
