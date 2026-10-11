-- manifest: tabela pol_call_queue — fila de ligações políticas do War Room 2.0, consolidando call_queue do WR1 com status de chamada, resultado político e controle de lock/tentativas

-- ══════════════════════════════════════════════════════════════════
-- pol_call_queue — fila de ligações políticas
--
-- Consolida call_queue do WR1.
-- Cada item é uma ligação pendente/em andamento para um contato,
-- com atribuição de operador, lock otimista, contagem de tentativas
-- e resultado político da chamada.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.pol_call_queue (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  -- Contato alvo da ligação
  contact_id              uuid         not null references public.contacts(id) on delete cascade,
  -- Atribuição
  assigned_to             uuid         references auth.users(id),
  locked_by               uuid         references auth.users(id),
  locked_at               timestamptz,
  -- Status da chamada
  call_status             text         not null default 'pending'
                          check (call_status in (
                            'pending', 'locked', 'calling', 'completed',
                            'no_answer', 'busy', 'callback', 'cancelled'
                          )),
  -- Resultado político da ligação
  political_result        text
                          check (political_result is null or political_result in (
                            'apoio_confirmado', 'indeciso', 'recusa',
                            'mudou_apoio', 'sem_contato', 'agendou_visita',
                            'pediu_retorno', 'outro'
                          )),
  -- Controle de tentativas
  attempt_count           integer      not null default 0,
  return_after            timestamptz,
  -- Notas do operador
  notes                   text,
  -- Timestamps da chamada
  call_started_at         timestamptz,
  call_finished_at        timestamptz,
  -- Prioridade
  priority                integer      not null default 0,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.pol_call_queue is
  'Fila de ligações políticas — consolida call_queue do WR1. Status de chamada, resultado político, lock otimista e controle de tentativas.';

-- Índices
create index if not exists pol_call_queue_org_status_idx
  on public.pol_call_queue (organization_id, call_status);

create index if not exists pol_call_queue_org_assigned_idx
  on public.pol_call_queue (organization_id, assigned_to)
  where assigned_to is not null;

create index if not exists pol_call_queue_org_priority_idx
  on public.pol_call_queue (organization_id, priority desc, created_at);

create index if not exists pol_call_queue_org_pending_idx
  on public.pol_call_queue (organization_id, return_after)
  where call_status in ('pending', 'callback');

create index if not exists pol_call_queue_contact_idx
  on public.pol_call_queue (contact_id);

create index if not exists pol_call_queue_created_idx
  on public.pol_call_queue (created_at);

-- Touch updated_at
create or replace trigger pol_call_queue_touch
  before update on public.pol_call_queue
  for each row execute function public.fn_touch_updated_at();

-- RLS
alter table public.pol_call_queue enable row level security;

create policy tenant_isolation_pol_call_queue_all
  on public.pol_call_queue for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));
