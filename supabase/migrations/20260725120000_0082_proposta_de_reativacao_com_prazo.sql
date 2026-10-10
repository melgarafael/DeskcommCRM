-- 0082 — a proposta de reativação, com PRAZO e destino
--
-- O cenário 23 fecha o ciclo da wave 7: o negócio esfria (0078-0081), alguém
-- decide reativá-lo, o agente envia, a atividade fica registrada e o estado
-- volta ao normal.
--
-- ⚠️ O BLOCO OBRIGATÓRIO, e ele é RECURSIVO: a wave existe para "esfriando"
-- virar DEMANDA, e a demanda que ela cria TAMBÉM PODE MORRER. Proposta de
-- reativação que ninguém decide fica pendente para sempre, e o negócio volta a
-- ser card parado AGORA COM UM BOTÃO EM CIMA — que é pior que antes: card
-- parado sem nada se lê como abandono; com proposta pendente SIMULA ATENÇÃO, e
-- simulação de atendimento ADIA a intervenção humana em vez de provocá-la.
--
-- Daí `expires_at` ser NOT NULL: não existe proposta sem prazo nesta tabela, e
-- é o banco que garante. No vencimento ela sai do card e vira item de caixa —
-- demanda sem dono não mora no Kanban.
--
-- ⚠️ POR QUE NÃO REUSAR `lead_state.next_action`: ela é por CONTATO (unique
-- organization_id, contact_id) e o risco é por NEGÓCIO — um contato com dois
-- negócios, um esfriando e outro quente, teria uma proposta só para os dois. E
-- é texto livre, sem estado nem prazo. Caberia à força, distorcendo as duas
-- coisas; a decisão é registrada aqui para ninguém "simplificar" depois.
--
-- ⚠️ O ENVIO NÃO NASCE AQUI. Aceitar a proposta dispara o caminho que já existe
-- (`cron_jobs` + o motor de follow-up). Esta tabela guarda a DECISÃO, não a
-- mensagem — criar um segundo caminho de envio seria o mesmo erro de ter duas
-- definições de "esfriando".

create table if not exists public.crm_lead_reactivations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'pending',
  -- Carimbados pelo BANCO, nunca pelo processo: a 0081 custou um worker
  -- abortando inteiro porque `since` vinha do banco e `detected_at` do Node,
  -- com 2 segundos de deriva entre eles. Instantes comparados entre si vêm do
  -- mesmo relógio.
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- O texto que o agente enviaria. É proposta do AGENTE — texto de máquina —,
  -- não campo do negócio: vale a mesma regra do `reason` da timeline, e nenhum
  -- dado do lead entra aqui por cópia.
  draft text,
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.crm_lead_reactivations is
  'Proposta de reativação de negócio esfriado (wave 7, cenário 23). SEMPRE com prazo: proposta que ninguém decide vira card parado com botão em cima, que simula atenção e adia a intervenção humana. No vencimento sai do card e vira item de caixa.';

alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_status_check;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_status_check check (
    status = any (array['pending', 'accepted', 'dismissed', 'expired']::text[])
  );

-- Prazo no futuro em relação à proposta. Trava o erro de nascer vencida — que
-- criaria um item de caixa no primeiro tick e ninguém entenderia de onde veio.
alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_prazo_no_futuro;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_prazo_no_futuro check (expires_at > proposed_at);

-- Decisão e decisor andam juntos: status decidido SEM `decided_at` é registro
-- que não sabe dizer quando aconteceu, e a timeline depende dessa resposta.
alter table public.crm_lead_reactivations
  drop constraint if exists crm_lead_reactivations_decisao_datada;
alter table public.crm_lead_reactivations
  add constraint crm_lead_reactivations_decisao_datada check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- UMA proposta viva por negócio. Índice parcial: propostas já decididas ficam
-- como histórico e não bloqueiam a próxima — o negócio pode esfriar de novo, e
-- impedir isso deixaria o segundo esfriamento sem proposta nenhuma.
create unique index if not exists uq_crm_lead_reactivations_uma_viva
  on public.crm_lead_reactivations (lead_id)
  where status = 'pending';

-- O worker de vencimento varre por aqui.
create index if not exists idx_crm_lead_reactivations_vencendo
  on public.crm_lead_reactivations (organization_id, expires_at)
  where status = 'pending';

alter table public.crm_lead_reactivations enable row level security;

drop policy if exists tenant_isolation_crm_lead_reactivations_all on public.crm_lead_reactivations;
create policy tenant_isolation_crm_lead_reactivations_all on public.crm_lead_reactivations
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- `proposed_at` e `updated_at` são do banco, como na 0081.
create or replace function public.fn_carimba_reativacao()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  if tg_op = 'INSERT' then
    new.proposed_at := now();
  end if;
  new.updated_at := now();
  return new;
end$function$;

drop trigger if exists trg_crm_lead_reactivations_carimbo on public.crm_lead_reactivations;
create trigger trg_crm_lead_reactivations_carimbo
  before insert or update on public.crm_lead_reactivations
  for each row
  execute function public.fn_carimba_reativacao();

-- DENTRO da publicação de realtime, pela mesma regra da 0078: proposta nascendo
-- ou vencendo é MUDANÇA DE ESTADO que o card precisa mostrar sem reload —
-- não é telemetria.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_reactivations'
  ) then
    execute 'alter publication supabase_realtime add table public.crm_lead_reactivations';
  end if;
end $$;
