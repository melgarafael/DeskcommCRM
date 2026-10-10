-- 0070_crm_lead_owner_kind
-- CRM Vivo · Wave 1 (CORE 1): a IA é dona do NEGÓCIO, não só da conversa.
--
-- A 0032 tornou a IA assignee de 1ª classe na conversa
-- (conversations.assignee_kind 'user'|'ai'). O padrão nunca foi propagado para
-- o funil: crm_leads.owner_user_id só aceita humano. Esta migration repete o
-- MESMO padrão no lead — CHECK de coerência em forma de implicação e backfill
-- ANTES da constraint (doutrina de migrations §8).
--
-- 1. owner_kind ('user'|'ai') desambigua quem é dono do negócio; owner_agent_id
--    aponta para ai_agents (a IDENTIDADE do agente), NUNCA para
--    ai_agent_versions: o tooltip do card mostra "Agente Beta · v3" resolvendo a
--    versão publicada no momento da exibição por join. Congelar a versão no lead
--    faria o card mentir para sempre depois de um republish.
-- 2. on delete set null (não cascade): apagar um agente não pode apagar o
--    negócio. O lead volta a ficar sem dono e reaparece na fila — o backfill
--    desta migration é o mesmo caminho que cura essa linha depois.
-- 3. owner_kind null continua válido (lead sem dono / escrita legada que não
--    conhece a coluna) — semântica forte chega pelos caminhos canônicos.
-- 4. O trigger de eventos passa a enxergar o dono agente: trocar de dono humano
--    já emitia lead.assigned; trocar para/de um agente era silencioso. Coluna
--    que ninguém escuta é ilha (doutrina sistema-vivo, invariante 3).
--
-- Idempotente, portável em psql puro (sem BEGIN/COMMIT, sem temp tables).

-- A. Colunas
alter table public.crm_leads
  add column if not exists owner_kind text
  check (owner_kind in ('user','ai'));

alter table public.crm_leads
  add column if not exists owner_agent_id uuid
  references public.ai_agents(id) on delete set null;

-- B. Backfill (ANTES da constraint — corrige qualquer banco de clone):
--    dono humano ⇒ 'user'; 'user' órfão (sem dono nenhum) ⇒ null;
--    dono agente ⇒ 'ai'.
update public.crm_leads
   set owner_kind = 'user'
 where owner_user_id is not null
   and owner_kind is distinct from 'user';

update public.crm_leads
   set owner_kind = null
 where owner_user_id is null
   and owner_agent_id is null
   and owner_kind = 'user';

update public.crm_leads
   set owner_kind = 'ai'
 where owner_agent_id is not null
   and owner_kind is distinct from 'ai';

-- C. Constraint de coerência (drop+add — re-aplicável).
--    Exatamente um dono, e o kind concorda com a coluna preenchida.
alter table public.crm_leads
  drop constraint if exists crm_leads_owner_kind_coherence;
alter table public.crm_leads
  add constraint crm_leads_owner_kind_coherence check (
    (owner_kind = 'user' and owner_user_id is not null and owner_agent_id is null) or
    (owner_kind = 'ai'   and owner_agent_id is not null and owner_user_id is null) or
    (owner_kind is null)
  );

-- D. Índice parcial: "os leads do agente X" (filtro de responsável e métricas).
--    Parcial porque a maioria dos leads não tem dono agente.
create index if not exists idx_crm_leads_owner_agent
  on public.crm_leads (organization_id, owner_agent_id)
  where owner_agent_id is not null;

-- E. lead.assigned passa a cobrir o dono agente (mesmo evento, payload maior).
--    Corpo idêntico ao vigente (migration 0043) + o ramo do agente; nenhum
--    consumidor lê from_user_id/to_user_id hoje, então o payload só cresce.
create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    -- lead.created é emitido pelo createLeadHandler (entity_kind='crm_lead').
    return new;
  end if;

  -- lead.stage_changed é emitido pelo moveLeadHandler (entity_kind='crm_lead').

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents));
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id
     or new.owner_agent_id is distinct from old.owner_agent_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object(
        'lead_id', new.id,
        'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id,
        'from_agent_id', old.owner_agent_id, 'to_agent_id', new.owner_agent_id,
        'owner_kind', new.owner_kind));
  end if;

  return new;
end$$;
