-- 0466 — Onda C2 da spec de Propostas (2026-09-23): D9 (contador que não
-- depende das linhas existentes), D3 (estado intermediário `enviando`) e D10
-- (a proposta sobrevive ao negócio). Uma migration só porque as três mexem na
-- mesma tabela e a tripla da casa fica mais fácil de auditar junta.
--
-- D9 — auditoria de produção (org 59914589, 19/09/2026): `fn_proposta_aloca_
-- numero` calculava `max(numero)+1` sobre as linhas que EXISTEM. Apagou o
-- negócio (cascata apagou a proposta), o número voltou a estar livre, e o
-- número 1/2026 foi entregue a dois clientes diferentes. O contador abaixo
-- nunca deriva de linha nenhuma — só cresce.

-- ── D9 — contador próprio, nunca derivado das linhas existentes ────────────
create table if not exists public.crm_proposal_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ano int not null,
  ultimo_numero int not null default 0,
  primary key (organization_id, ano)
);
comment on table public.crm_proposal_counters is
  'D9: numeração de propostas. Só cresce; apagar proposta, negócio ou dados operacionais NUNCA mexe aqui.';
alter table public.crm_proposal_counters enable row level security;
revoke all on public.crm_proposal_counters from anon, authenticated;

-- Semente: o maior número já visto em crm_proposals OU no audit log de
-- proposal.sent (a auditoria sobrevive a um apagamento; a linha, não).
-- Idempotente via GREATEST — reaplicar não derruba um valor maior já gravado.
insert into public.crm_proposal_counters (organization_id, ano, ultimo_numero)
select organization_id, ano, max(numero)
from public.crm_proposals
where numero is not null
group by organization_id, ano
on conflict (organization_id, ano) do update
  set ultimo_numero = greatest(public.crm_proposal_counters.ultimo_numero, excluded.ultimo_numero);

-- `organization_id` de api_audit_log aceita nulo (ON DELETE SET NULL) e é
-- exatamente essa a linha que sobrevive à organização apagada — mas
-- `crm_proposal_counters.organization_id` é NOT NULL, então sem os dois
-- filtros abaixo esta migration falha (e o update.sh trava) na primeira
-- instalação que já teve uma organização removida.
insert into public.crm_proposal_counters (organization_id, ano, ultimo_numero)
select a.organization_id,
       (a.metadata->>'ano')::int as ano,
       max((a.metadata->>'numero')::int) as ultimo_numero
from public.api_audit_log a
where a.action = 'proposal.sent'
  and a.organization_id is not null
  and exists (select 1 from public.organizations o where o.id = a.organization_id)
  and a.metadata->>'numero' is not null
  and a.metadata->>'ano' is not null
group by a.organization_id, (a.metadata->>'ano')::int
on conflict (organization_id, ano) do update
  set ultimo_numero = greatest(public.crm_proposal_counters.ultimo_numero, excluded.ultimo_numero);

-- Antes era `stable` (só lia). Agora escreve — `volatile` é o default ao
-- omitir a palavra-chave, e o INSERT...ON CONFLICT DO UPDATE serializa pelo
-- lock de linha da chave (organization_id, ano): duas chamadas concorrentes
-- para a MESMA organização/ano nunca devolvem o mesmo número.
create or replace function public.fn_proposta_aloca_numero(p_org uuid, p_ano int)
returns int language sql security definer set search_path = public, pg_temp as $$
  insert into public.crm_proposal_counters (organization_id, ano, ultimo_numero)
    values (p_org, p_ano, 1)
  on conflict (organization_id, ano) do update
    set ultimo_numero = public.crm_proposal_counters.ultimo_numero + 1
  returning ultimo_numero;
$$;
revoke execute on function public.fn_proposta_aloca_numero(uuid, int) from public, anon;
revoke execute on function public.fn_proposta_aloca_numero(uuid, int) from authenticated;
grant execute on function public.fn_proposta_aloca_numero(uuid, int) to service_role;

-- ── D3 — estado intermediário `enviando` ────────────────────────────────────
-- Separa "número reservado" de "entregue": alocarNumero (Task 2/3 do plano)
-- passa a marcar `enviando` ao alocar, e só o status DEVOLVIDO pela mensagem
-- de WhatsApp decide se vira `enviada` de verdade.
alter table public.crm_proposals drop constraint if exists crm_proposals_status_check;
alter table public.crm_proposals add constraint crm_proposals_status_check
  check (status in ('rascunho','enviando','enviada','aceita','recusada','vencida','cancelada','substituida'));

alter table public.crm_proposals add column if not exists message_id uuid references public.messages(id) on delete set null;
alter table public.crm_proposals add column if not exists ultima_falha_envio text;

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required','appointment_recovery_review','qr_rescan','routing_unassigned',
    'job_dead','event_dead','budget_exceeded','handoff','promotion_review','judge_unaligned',
    'followup_dead','snooze_expired','next_action_ambiguous','risk_backlog_seeded',
    'reactivation_expired','capabilities_missing','message_send_stuck','midia_nao_lida',
    'channel_template_review','channel_number_alert','promise_unfulfilled','contact_proposal_expired',
    'budget_warning','conhecimento_nao_indexado','voice_call_missed','case_stale',
    'aviso_de_caso_nao_entregue','followup_sem_agente','canal_mudo_sem_numero',
    'proposal_expired_notice','proposal_acceptance_rate_drop','proposal_promised_not_created',
    -- (D3) proposta presa em 'enviando' há mais de 5min — o mesmo padrão do
    -- 'message_send_stuck', cron próprio (proposta-travada).
    'proposta_travada',
    'other'
  ));

-- ── D10 — a proposta sobrevive ao negócio ───────────────────────────────────
-- Antes: lead_id/contact_id eram NOT NULL com `on delete cascade` — apagar o
-- negócio apagava em cascata um documento que o cliente já tinha na mão
-- (anti-pattern 7, "cascata fantasma"). Agora: SET NULL, e o nome impresso no
-- PDF fica gravado (destinatario_nome) para o documento continuar legível
-- sozinho.
alter table public.crm_proposals add column if not exists destinatario_nome text;

alter table public.crm_proposals alter column lead_id drop not null;
alter table public.crm_proposals alter column contact_id drop not null;

alter table public.crm_proposals drop constraint if exists crm_proposals_lead_id_fkey;
alter table public.crm_proposals add constraint crm_proposals_lead_id_fkey
  foreign key (lead_id) references public.crm_leads(id) on delete set null;

alter table public.crm_proposals drop constraint if exists crm_proposals_contact_id_fkey;
alter table public.crm_proposals add constraint crm_proposals_contact_id_fkey
  foreign key (contact_id) references public.contacts(id) on delete set null;

-- Rascunho não tem valor fora do negócio (nunca foi enviado, não é
-- documento) — vira `cancelada` em vez de ficar órfão. Enviada e além
-- (enviada/aceita/recusada/vencida/substituida) SOBREVIVEM via o SET NULL
-- acima. O trigger roda ANTES do delete: lead_id ainda aponta para a linha
-- que vai sumir, então o UPDATE por lead_id funciona.
create or replace function public.fn_cancelar_propostas_rascunho_do_lead()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.crm_proposals
    set status = 'cancelada'
    where lead_id = old.id and organization_id = old.organization_id and status = 'rascunho';
  return old;
end;
$$;
revoke execute on function public.fn_cancelar_propostas_rascunho_do_lead() from public, anon;
revoke execute on function public.fn_cancelar_propostas_rascunho_do_lead() from authenticated;

drop trigger if exists trg_crm_leads_cancelar_propostas_rascunho on public.crm_leads;
create trigger trg_crm_leads_cancelar_propostas_rascunho
  before delete on public.crm_leads
  for each row execute function public.fn_cancelar_propostas_rascunho_do_lead();

notify pgrst, 'reload schema';
