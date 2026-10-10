-- 20260928004000_0465_a_proposta_nao_aponta_para_outra_organizacao.sql
--
-- Uma proposta não aponta para negócio, contato ou conversa de OUTRA
-- organização. A RLS de `crm_proposals` só confere o `organization_id` da
-- própria linha; sem esta trava, um usuário de A gravava pela API do banco
-- uma proposta de A com o `lead_id` de B — vínculo cruzado que a `on delete
-- cascade` do lead transformaria em B apagando dado de A.
--
-- Mesmo molde de `fn_verificar_org_do_item_da_proposta` (0464) e de
-- `fn_validate_activity_lead_org`. `security invoker`: lê só a linha que o
-- comando já está gravando e as tabelas que quem grava já enxerga.
--
-- Referência NULA passa: `conversation_id` é opcional hoje, e o conserto
-- "a proposta enviada sobrevive ao negócio" vai tornar `lead_id` e
-- `contact_id` anuláveis por `on delete set null` — o UPDATE que a FK dispara
-- nessa hora não pode ser recusado aqui.
--
-- Só vale para escrita NOVA: linha antiga não é revalidada, então o
-- `update.sh` de nenhum clone quebra por dado legado.

create or replace function public.fn_verificar_org_da_proposta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lead_id is not null and not exists (
    select 1 from public.crm_leads where id = new.lead_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_proposal_lead_org_mismatch' using errcode = '23514';
  end if;
  if new.contact_id is not null and not exists (
    select 1 from public.contacts where id = new.contact_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_proposal_contact_org_mismatch' using errcode = '23514';
  end if;
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations where id = new.conversation_id and organization_id = new.organization_id
  ) then
    raise exception 'crm_proposal_conversation_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_da_proposta() from public, anon;

drop trigger if exists trg_crm_proposals_org_consistente on public.crm_proposals;
create trigger trg_crm_proposals_org_consistente
  before insert or update of organization_id, lead_id, contact_id, conversation_id
  on public.crm_proposals
  for each row execute function public.fn_verificar_org_da_proposta();
