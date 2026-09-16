-- 0239 · Fluxo de atendimento robusto: trilha de eventos + síntese.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- 1. `contact_flow_events` — trilha append-only do que aconteceu em cada
--    execução de fluxo: iniciou, o cliente respondeu um campo, desviou do
--    roteiro, a pergunta foi feita, concluiu, esgotou, encadeou. É o
--    "armazena quantas forem necessárias" e a base da síntese/continuação.
-- 2. `followup_enrollments.completion_note` — a SÍNTESE do fluxo (o
--    passa-bastão que alimenta a continuidade da venda).
--
-- As MENSAGENS em si já são guardadas em `messages`; aqui guardamos o VÍNCULO
-- com o fluxo e o significado do turno. `message_id` aponta para a mensagem já
-- existente (sem duplicar conteúdo) e a coluna entra na cascata de anonimização
-- junto das demais do contato.
--
-- `kind` é vocabulário de CONJUNTO com CHECK → par em
-- `lib/followup/contact-flow-data.ts` (CONTACT_FLOW_EVENT_KINDS) cobrado por
-- tests/invariants/vocabulario-banco-x-typescript.test.ts.
--
-- Nenhuma função nova em `public` ⇒ item 9 da doutrina de migrations não aciona.

create table if not exists public.contact_flow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enrollment_id uuid not null references public.followup_enrollments(id) on delete cascade,
  flow_pointer_id uuid not null references public.followup_flow_pointers(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  kind text not null,
  -- Aponta a mensagem JÁ existente em `messages` — sem duplicar conteúdo.
  message_id uuid,
  field_key text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint contact_flow_events_kind_conhecido
    check (kind in ('iniciado', 'resposta', 'fora_do_fluxo', 'pergunta_feita', 'concluido', 'esgotado', 'encadeou')),
  constraint contact_flow_events_field_key_valido
    check (field_key is null or field_key ~ '^[a-z][a-z0-9_]{0,59}$')
);

comment on table public.contact_flow_events is
  'Trilha append-only de uma execução de fluxo de atendimento (surface=atendimento). '
  'Guarda o SIGNIFICADO do turno (respondeu/desviou/perguntou/concluiu); o conteúdo da '
  'mensagem fica em messages. Base da síntese/continuação da venda.';
comment on column public.contact_flow_events.kind is
  'O que aconteceu no turno. Vocabulário fechado; par em lib/followup/contact-flow-data.ts.';

create index if not exists contact_flow_events_enrollment_idx
  on public.contact_flow_events (organization_id, enrollment_id, created_at);

alter table public.contact_flow_events enable row level security;

drop policy if exists tenant_isolation_contact_flow_events_all on public.contact_flow_events;
create policy tenant_isolation_contact_flow_events_all on public.contact_flow_events
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.contact_flow_events from anon;

-- Síntese do fluxo (passa-bastão para a continuidade da venda).
alter table public.followup_enrollments
  add column if not exists completion_note text;

comment on column public.followup_enrollments.completion_note is
  'Síntese do fluxo ao concluir/esgotar; alimenta a continuação da conversa/venda.';

notify pgrst, 'reload schema';
