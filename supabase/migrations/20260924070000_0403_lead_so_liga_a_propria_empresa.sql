-- ---- o lead só se liga a contato e responsável da própria empresa (migration 0403) ----
--
-- `crm_leads_contact_id_fkey` referencia só `contacts(id)` e a FK de
-- `owner_user_id` só garante que a pessoa existe: nenhuma pergunta de QUAL
-- organização. Os handlers de lead já conferem (app/api/v1/leads/_handler.ts),
-- mas não são o único caminho: a REST do banco (`/rest/v1/crm_leads`, com GRANT
-- para `authenticated` e políticas que não olham `contact_id`) e a RPC
-- `fn_nascer_lead_da_conversa` (security invoker) gravavam o vínculo cruzado.
-- A regra passa a morar na tabela, onde todo escritor passa.
--
-- 1 · CURA, antes do gatilho, genérica (sem id fixo) e idempotente:
--     - lead cujo contato é de OUTRA organização perde o contato;
--     - lead cujo responsável NUNCA foi membro da organização do lead (nenhum
--       vínculo, revogado ou não) perde o responsável.
--     Cada lead curado ganha uma atividade `lead_edited` de sistema dizendo o
--     porquê, sem o id da outra organização. Reaplicar não acha mais nada.
--     Responsável DESLIGADO (vínculo revogado) ou viewer NÃO é curado: é um
--     estado legítimo do passado — o lead era dele — e o gatilho não o exige
--     de quem não mexe no campo.
--
-- 2 · GATILHO BEFORE INSERT OR UPDATE OF contact_id, owner_user_id,
--     organization_id: no INSERT confere o que vier preenchido; no UPDATE só o
--     campo que MUDOU (IS DISTINCT FROM OLD) — reenviar o que o lead já tem não
--     é ligar de novo. A régua do responsável é a do handler (G3-04): vínculo
--     não revogado e papel acima de viewer.
--
-- 3 · O ERRO não diz se o id existe noutra organização. SQLSTATE `PT404` /
--     `PT422`: o PostgREST devolve 404 / 422 com a mensagem genérica, e o
--     handler traduz os mesmos códigos.
--
-- Security definer com search_path fixo: a função precisa ler `contacts` e
-- `user_organizations` de quem chama sob RLS (um `agent` não vê o vínculo dos
-- colegas). Não é RPC: revoga as duas origens de EXECUTE e não concede a
-- ninguém — o gatilho roda com o dono da função, não com o privilégio de quem
-- escreve.

-- 1 · cura ------------------------------------------------------------------
with curados as (
  update public.crm_leads l
     set contact_id = null
   where l.contact_id is not null
     and not exists (
       select 1 from public.contacts c
        where c.id = l.contact_id
          and c.organization_id = l.organization_id
     )
  returning l.id, l.organization_id
)
insert into public.crm_lead_activities
  (organization_id, lead_id, contact_id, source_module, source_id, type,
   actor_kind, reason, payload)
select organization_id, id, null, 'crm', id, 'lead_edited', 'system',
       'Contato desvinculado: ele não pertence a esta empresa',
       jsonb_build_object('fields', jsonb_build_array('contact_id'),
                          'motivo', 'contato_de_outra_organizacao')
  from curados;

with curados as (
  update public.crm_leads l
     set owner_user_id = null,
         owner_kind = case when l.owner_kind = 'user' then null else l.owner_kind end
   where l.owner_user_id is not null
     and not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = l.owner_user_id
          and uo.organization_id = l.organization_id
     )
  returning l.id, l.organization_id
)
insert into public.crm_lead_activities
  (organization_id, lead_id, contact_id, source_module, source_id, type,
   actor_kind, reason, payload)
select organization_id, id, null, 'crm', id, 'lead_edited', 'system',
       'Responsável removido: a pessoa não é membro desta empresa',
       jsonb_build_object('fields', jsonb_build_array('owner_user_id'),
                          'motivo', 'responsavel_de_outra_organizacao')
  from curados;

-- 2 · gatilho ---------------------------------------------------------------
create or replace function public.fn_lead_so_liga_a_propria_empresa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mudou_org boolean := tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id;
begin
  if new.contact_id is not null
     and (tg_op = 'INSERT' or v_mudou_org or new.contact_id is distinct from old.contact_id)
     and not exists (
       select 1 from public.contacts c
        where c.id = new.contact_id
          and c.organization_id = new.organization_id
     )
  then
    raise exception 'Contato não encontrado.' using errcode = 'PT404';
  end if;

  if new.owner_user_id is not null
     and (tg_op = 'INSERT' or v_mudou_org or new.owner_user_id is distinct from old.owner_user_id)
     and not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = new.owner_user_id
          and uo.organization_id = new.organization_id
          and uo.revoked_at is null
          and uo.role <> 'viewer'
     )
  then
    raise exception 'Responsável não é um atendente ativo desta organização.' using errcode = 'PT422';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_lead_so_liga_a_propria_empresa() from public, anon, authenticated;

comment on function public.fn_lead_so_liga_a_propria_empresa() is
  'Gatilho de crm_leads (migration 0403): contact_id e owner_user_id só apontam para a própria organização. No UPDATE só confere o campo que mudou. Erro genérico PT404/PT422, sem dizer se o id existe noutra organização.';

drop trigger if exists trg_lead_so_liga_a_propria_empresa on public.crm_leads;
create trigger trg_lead_so_liga_a_propria_empresa
  before insert or update of contact_id, owner_user_id, organization_id on public.crm_leads
  for each row execute function public.fn_lead_so_liga_a_propria_empresa();
