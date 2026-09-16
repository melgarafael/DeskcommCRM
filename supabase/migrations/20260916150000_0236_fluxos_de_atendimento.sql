-- 0236 · Fluxos de atendimento em tempo real — o chão de dados.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- O motor de fluxo (`followup_flow_pointers`/`followup_flow_versions` + o editor
-- de grafo) nasceu para RETOMADA (lead frio), disparado por relógio. A MESMA
-- máquina serve para ATENDIMENTO: um fluxo que conduz perguntas durante a
-- conversa, no turno, e para quando o cliente completa os dados.
--
-- Esta migration entrega só o CHÃO de dados (o motor e a tela vêm no código):
--   1. `surface = 'atendimento'` — terceira superfície do pointer (um motor,
--      três listas), ao lado de `followup` e `crm_automation` (0196).
--   2. `contact_flow_data` — as respostas coletadas, por contato + fluxo +
--      campo. É o "estado de qualificação" que o agente lê para saber o que já
--      sabe e o que ainda falta perguntar.
--
-- ─── Por que tabela PRÓPRIA, e não `contacts.custom_fields` ─────────────────
-- `custom_fields` é um saco único do contato: dois fluxos que pedem "cidade"
-- colidem, e não há histórico por fluxo. Aqui a chave é (contato, fluxo, campo)
-- — o mesmo contato pode ter respostas em fluxos diferentes sem se misturar.
--
-- ─── Vocabulário do `surface` (regra do bloco único) ────────────────────────
-- O CHECK é de CONJUNTO e vive num bloco ÚNICO do `baseline.sql` (regra de
-- `tests/unit/baseline-constraint-reconstruida.test.ts`): esta migration faz
-- drop+add, mas o apêndice do baseline NÃO reconstrói a constraint — o valor
-- novo já entra no bloco da 0196. Par em
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`
-- (`followup_flow_pointers.surface` ↔ `FOLLOWUP_FLOW_SURFACES`).
--
-- Mesma regra para `contact_flow_data.source`: nasce com o par no MESMO commit
-- (`lib/followup/contact-flow-data.ts` ↔ `CONTACT_FLOW_DATA_SOURCES`).
--
-- Nenhuma função nova em `public` ⇒ o item 9 da doutrina de migrations não é
-- acionado por este arquivo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Superfície nova: 'atendimento'
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.followup_flow_pointers
  drop constraint if exists followup_flow_pointers_surface_check;

alter table public.followup_flow_pointers
  add constraint followup_flow_pointers_surface_check
  check (surface in ('followup', 'crm_automation', 'atendimento'));

comment on column public.followup_flow_pointers.surface is
  'Onde o fluxo aparece: followup = /app/ai/followups; crm_automation = CRM Automação; '
  'atendimento = fluxo de perguntas em tempo real. '
  'Vocabulário cobrado por tests/invariants/vocabulario-banco-x-typescript.test.ts.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. contact_flow_data — as respostas coletadas no atendimento
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.contact_flow_data (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- O fluxo é a identidade do dado (a chave é contato+fluxo+campo). O enrollment
  -- é só a corrida corrente: cai para NULL se a execução for limpa, e o dado do
  -- cliente permanece — é o "estilo o que tenho com clientes".
  flow_pointer_id uuid not null references public.followup_flow_pointers(id) on delete cascade,
  enrollment_id uuid references public.followup_enrollments(id) on delete set null,
  -- Casa com `collect.config.key` no grafo. Formato validado abaixo.
  field_key text not null,
  -- Valor cru (como o cliente escreveu) e normalizado (number/date/bool/select).
  value text,
  value_json jsonb,
  -- Procedência: o cliente informou, a IA interpretou, ou o extrator capturou.
  source text not null default 'client',
  collected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Um valor por campo, por contato, por fluxo. Atualiza o mesmo registro em vez
  -- de empilhar — é o que faz "parar de perguntar quando completar" funcionar.
  constraint contact_flow_data_unico
    unique (organization_id, contact_id, flow_pointer_id, field_key),
  constraint contact_flow_data_field_key_valido
    check (field_key ~ '^[a-z][a-z0-9_]{0,59}$'),
  constraint contact_flow_data_source_conhecido
    check (source in ('client', 'agent', 'deterministic'))
);

comment on table public.contact_flow_data is
  'Respostas coletadas por um fluxo de atendimento (surface=atendimento), por contato+fluxo+campo. '
  'Fonte do bloco PENDENTES do agente: campo sem linha aqui é pergunta em aberto. '
  'Origem do valor em `source`; par de vocabulário em lib/followup/contact-flow-data.ts.';
comment on column public.contact_flow_data.enrollment_id is
  'Corrida corrente do fluxo para este contato. ON DELETE SET NULL: limpar a execução não apaga o dado já coletado do cliente.';
comment on column public.contact_flow_data.value_json is
  'Valor normalizado (number/date/bool/seleção). `value` guarda o texto cru informado.';

create index if not exists contact_flow_data_contato_idx
  on public.contact_flow_data (organization_id, contact_id, flow_pointer_id);

create index if not exists contact_flow_data_enrollment_idx
  on public.contact_flow_data (organization_id, enrollment_id);

alter table public.contact_flow_data enable row level security;

drop policy if exists tenant_isolation_contact_flow_data_all on public.contact_flow_data;
create policy tenant_isolation_contact_flow_data_all on public.contact_flow_data
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.contact_flow_data from anon;

drop trigger if exists trg_contact_flow_data_updated_at on public.contact_flow_data;
create trigger trg_contact_flow_data_updated_at
  before update on public.contact_flow_data
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';
