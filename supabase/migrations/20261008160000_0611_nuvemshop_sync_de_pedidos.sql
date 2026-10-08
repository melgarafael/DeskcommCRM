-- manifest: **Nuvemshop sincroniza pedidos (E1).** Cria `integration_sync_state` (estado, trava e cursor da sincronização por organização/provedor/recurso; leitura pela org, escrita só pelo servidor), a função `fn_gravar_pedido_externo` (upsert em `orders` onde o pedido MAIS NOVO vence e o anonimizado nunca é reescrito; `security definer` só para `service_role`) e o kind `integracao_desautorizada` na Central, com um aviso aberto por integração. Idempotente e auto-curativa: a lista do kind só cresce e o dedupe roda antes do índice.

-- 0611 — sincronização de pedidos da Nuvemshop
--
-- Por quê: o EPIC-07 entregou OAuth e recepção de webhook, mas nenhum consumidor
-- gravava `orders` (spec 2026-10-08-nuvemshop-sync-e1-design.md §1).

create table if not exists public.integration_sync_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('nuvemshop')),
  resource text not null check (resource in ('orders')),
  status text not null default 'idle' check (status in ('idle', 'running', 'error')),
  run_id uuid,
  run_origem text check (run_origem in ('conexao', 'reconciliacao', 'manual')),
  trava_ate timestamptz,
  cursor_updated_at timestamptz,
  janela_atual_ini timestamptz,
  janela_atual_fim timestamptz,
  alvo_fim timestamptz,
  pedidos_gravados integer not null default 0,
  pedidos_com_erro integer not null default 0,
  ultimo_erro text,
  ultimo_run_fim timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider, resource)
);

alter table public.integration_sync_state enable row level security;

drop policy if exists tenant_isolation_integration_sync_state_read on public.integration_sync_state;
create policy tenant_isolation_integration_sync_state_read on public.integration_sync_state
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

-- Escrita é do servidor (handlers e cron com service_role). O default ACL do
-- Supabase concede tudo a anon/authenticated em tabela nova; a RLS já barra,
-- e o revoke tira a porta do catálogo também.
revoke insert, update, delete, truncate on public.integration_sync_state from anon, authenticated;
revoke select on public.integration_sync_state from anon;

drop trigger if exists trg_integration_sync_state_updated_at on public.integration_sync_state;
create trigger trg_integration_sync_state_updated_at
  before update on public.integration_sync_state
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_gravar_pedido_externo(p_organization_id uuid, p_pedido jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_contato uuid := nullif(p_pedido->>'contact_id', '')::uuid;
begin
  -- Contato só vale se for DESTA organização: a função ignora RLS.
  if v_contato is not null and not exists (
    select 1 from public.contacts c
     where c.id = v_contato and c.organization_id = p_organization_id
  ) then
    v_contato := null;
  end if;

  insert into public.orders as o (
    organization_id, external_provider, external_id, customer_external_id, contact_id,
    status, total_cents, currency, payment_method, fulfillment_status, tracking_code,
    payload, ordered_at, updated_at_remote
  ) values (
    p_organization_id,
    p_pedido->>'external_provider',
    p_pedido->>'external_id',
    nullif(p_pedido->>'customer_external_id', ''),
    v_contato,
    p_pedido->>'status',
    (p_pedido->>'total_cents')::bigint,
    coalesce(nullif(p_pedido->>'currency', ''), 'BRL'),
    nullif(p_pedido->>'payment_method', ''),
    nullif(p_pedido->>'fulfillment_status', ''),
    nullif(p_pedido->>'tracking_code', ''),
    coalesce(p_pedido->'payload', '{}'::jsonb),
    (p_pedido->>'ordered_at')::timestamptz,
    nullif(p_pedido->>'updated_at_remote', '')::timestamptz
  )
  on conflict (organization_id, external_provider, external_id) do update set
    customer_external_id = excluded.customer_external_id,
    contact_id = coalesce(excluded.contact_id, o.contact_id),
    status = excluded.status,
    total_cents = excluded.total_cents,
    currency = excluded.currency,
    payment_method = excluded.payment_method,
    fulfillment_status = excluded.fulfillment_status,
    tracking_code = excluded.tracking_code,
    payload = excluded.payload,
    ordered_at = excluded.ordered_at,
    updated_at_remote = excluded.updated_at_remote
  where not o.is_anonymized
    and (o.updated_at_remote is null or excluded.updated_at_remote >= o.updated_at_remote)
  returning o.id into v_id;

  return v_id;
end
$$;

revoke execute on function public.fn_gravar_pedido_externo(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_gravar_pedido_externo(uuid, jsonb) to service_role;

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required', 'appointment_recovery_review', 'qr_rescan',
    'routing_unassigned', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired',
    'capabilities_missing', 'message_send_stuck', 'midia_nao_lida',
    'channel_template_review', 'channel_number_alert', 'promise_unfulfilled',
    'contact_proposal_expired', 'budget_warning', 'conhecimento_nao_indexado',
    'voice_call_missed', 'case_stale', 'aviso_de_caso_nao_entregue',
    'followup_sem_agente', 'canal_mudo_sem_numero', 'proposal_expired_notice',
    'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    'proposta_travada', 'proposta_pronta_para_revisao', 'org_reativada',
    'jev_pedido_de_humano', 'jev_parar_de_receber', 'canal_pausado',
    'integracao_desautorizada',
    'other'
  ));

with repetidas as (
  select id, row_number() over (
           partition by organization_id, kind, ref_id order by created_at asc, id asc
         ) as ordem
    from public.agent_inbox_items
   where status = 'open' and kind = 'integracao_desautorizada'
)
update public.agent_inbox_items i
   set status = 'resolved', resolved_at = now()
  from repetidas r
 where i.id = r.id and r.ordem > 1;

create unique index if not exists agent_inbox_integracao_desautorizada_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'integracao_desautorizada';

notify pgrst, 'reload schema';

-- 0611
