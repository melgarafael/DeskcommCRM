-- Migration 0100 — ciclo de vida do contexto do agente (Spec 16 §3).
--
-- Duas peças, ambas não-destrutivas e reversíveis:
--   1. contacts.context_reset_at — marca de corte. Enquanto NULL, comportamento
--      idêntico ao atual. Setada pelo worker de expiração (C3) ou pelo reset
--      manual (C2); limpar o campo restaura o contexto integralmente.
--   2. crm_stages.resets_context / context_reset_after_days — a política de
--      expiração vive na etapa que o TENANT nomeou, nunca em is_won/is_lost.
--      Default false: nenhuma etapa existente passa a expirar contexto sozinha.
--
-- Idempotente: add column if not exists, create index if not exists, e a
-- constraint é guardada por bloco `do $$` para não falhar em re-aplicação.
-- Sem backfill: os defaults já reproduzem o comportamento anterior à migration.

alter table contacts
  add column if not exists context_reset_at timestamptz,
  add column if not exists context_reset_reason text;

comment on column contacts.context_reset_at is
  'Corte do contexto do agente: mensagens, checkpoints e lead_state anteriores a este instante deixam de ser lidos pelo turno. NADA é apagado — limpar o campo restaura.';

comment on column contacts.context_reset_reason is
  'Motivo do corte (ex.: stage_policy, manual) — só telemetria/UI, nunca lido pelo turno.';

-- Índice parcial: worker e leituras só se importam com contatos marcados.
create index if not exists idx_contacts_context_reset_at
  on contacts (organization_id, context_reset_at)
  where context_reset_at is not null;

alter table crm_stages
  add column if not exists resets_context boolean not null default false,
  add column if not exists context_reset_after_days integer not null default 7;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_stages_context_reset_days_range'
  ) then
    alter table crm_stages
      add constraint crm_stages_context_reset_days_range
      check (context_reset_after_days >= 0 and context_reset_after_days <= 365);
  end if;
end $$;

comment on column crm_stages.resets_context is
  'Quando true, negócio parado nesta etapa por context_reset_after_days dias tem o contexto do agente expirado. Padrão de fábrica false — nada expira sem escolha do tenant.';

comment on column crm_stages.context_reset_after_days is
  'Carência em dias antes de expirar, contada de crm_leads.stage_changed_at. Default 7 — dá tempo ao pós-venda antes de cortar o contexto.';
