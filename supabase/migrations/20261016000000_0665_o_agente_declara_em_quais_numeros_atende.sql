-- manifest: O agente passa a declarar em QUAIS números atende: tabela de vínculo versão↔número (ai_agent_version_channels), tenant-aware, RLS por organização e única por (versão, número). channel_session_id continua como número PRINCIPAL — agente antigo fica igual, sem data migration (#2796, fatia 1).
-- ============================================================================
-- 2026-10-16 — 0665: O AGENTE DECLARA EM QUAIS NÚMEROS ATENDE (#2796, fatia 1)
--
-- DEFEITO: cada versão publicada de agente aponta para UM número
-- (`ai_agent_versions.channel_session_id`) e publicar sem número é recusado
-- (migration 0239). Para uma operação com um WhatsApp por vendedor — QR pelo
-- Perfil ou coexistência pela API oficial, que o CRM já suporta — o MESMO
-- agente precisa existir em N cópias, uma por número. Toda mudança de prompt,
-- base de conhecimento, follow-up armado, capacidade e palavra de passagem é
-- repetida N vezes, e as cópias desgarram com o tempo. Com 5 vendedores são 5
-- agentes iguais; com 20, ninguém mantém.
--
-- CONSERTO (esta fatia): o agente passa a DECLARAR em quais números atende —
-- um, vários, ou todos. O vínculo mora numa tabela própria, `versão ↔ número`,
-- e a versão continua com o seu número PRINCIPAL em `channel_session_id`
-- (o agente antigo não muda: nada é reescrito, nenhuma linha precisa migrar).
-- Quem escolhe o agente por conversa (a fatia seguinte) passa a casar
-- "número da conversa ∈ números da versão", com o mesmo desempate
-- `priority desc, created_at asc` de hoje.
--
-- O QUE ESTA FATIA NÃO ENTREGA (declarado, e não por omissão):
--   * `fn_publish_ai_agent_version` aceitando a lista — a issue não decide se,
--     ao publicar com N números, o principal passa a ser derivado da lista ou
--     se segue exigindo `channel_session_id`. Decidir isso é regra de produto;
--     fica para a fatia que também lê o vínculo no turno.
--   * o casamento no runtime (`agente-da-conversa.ts`, `loadPublishedAgentConfig`),
--     a tela multi-seleção ("Atende nestes números"), o `VersionDiff`, o
--     `{{vendedor}}` por turno e a tabela irmã do roteador.
--   * o que acontece ao DESCONECTAR um número vinculado. É decisão de produto
--     em aberto; por ora o FK espelha o de `ai_agent_versions.channel_session_id`
--     (`on delete restrict`), que é o comportamento de hoje — a linha continua
--     protegida contra apagar a sessão por baixo, exatamente como já era.
--
-- RLS: LEITURA por organização via `fn_user_org_ids()`, ESCRITA com o mesmo
-- gate de papel de `ai_agent_versions` (admin). A policy NÃO cita
-- `conversations` em lugar nenhum — citar a tabela de conversas dentro de uma
-- policy é o caminho para recursão infinita de RLS, e a tabela é só
-- `organization_id` + duas FKs (mesmo molde de `team_invites`, 0238). Há cerca
-- própria para isso em `tests/invariants/vinculo-do-agente-ao-numero.test.ts`.
--
-- Idempotente: `if not exists` na tabela e no índice, `drop policy if exists`
-- e `drop trigger if exists` antes de recriar. O `update.sh` de um clone
-- reaplica o apêndice do baseline inteiro sem erro.
-- ============================================================================

-- Alvo da FK composta da versão (o de channel_sessions já existe:
-- channel_sessions_org_id_unique).
create unique index if not exists uq_ai_agent_versions_org_id
  on public.ai_agent_versions (organization_id, id);

create table if not exists public.ai_agent_version_channels (
  id uuid primary key default gen_random_uuid(),

  -- `organization_id` na própria linha (doutrina: toda tabela tenant-aware),
  -- para a policy de RLS isolar por organização sem precisar subir por join.
  organization_id uuid not null references public.organizations(id) on delete cascade,

  agent_version_id uuid not null,
  channel_session_id uuid not null,

  created_at timestamptz not null default now(),

  -- FK COMPOSTA pela doutrina multi-tenant (mesmo molde de
  -- campaign_channel_sessions, 0377): a linha não pode apontar para a versão nem
  -- para o número de OUTRA organização. A checagem de FK não passa pela RLS, então
  -- só a FK por (organization_id, id) amarra os três à mesma organização.
  -- Apagar a versão apaga o vínculo; apagar o número segue barrado (restrict),
  -- espelhando ai_agent_versions_channel_session_id_fkey.
  constraint ai_agent_version_channels_versao_da_org_fk
    foreign key (organization_id, agent_version_id)
    references public.ai_agent_versions (organization_id, id) on delete cascade,
  constraint ai_agent_version_channels_numero_da_org_fk
    foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete restrict,

  -- Único por (versão, número): a mesma versão não declara o mesmo número duas vezes.
  constraint ai_agent_version_channels_unico unique (agent_version_id, channel_session_id)
);

-- A consulta da fatia seguinte: "quais versões atendem neste número da org".
create index if not exists ai_agent_version_channels_por_numero_idx
  on public.ai_agent_version_channels (organization_id, channel_session_id);

alter table public.ai_agent_version_channels enable row level security;

-- Mesmo molde de `ai_agent_versions` na 0150 (#150): LEITURA por organização (é
-- assim que quem atende enxerga em quais números o agente está), ESCRITA
-- por organização + papel `admin` (ligar um número ao agente é config do
-- agente, mesma superfície que já exige admin hoje). O gate de papel não é
-- enfeite: `rbac-config-ia-canais.test.ts` reprova tabela NOVA que entre com
-- policy `ALL` só-tenancy — a dívida antiga está congelada numa allowlist e
-- não cresce.
drop policy if exists tenant_isolation_ai_agent_version_channels_all on public.ai_agent_version_channels;

drop policy if exists tenant_isolation_ai_agent_version_channels_select on public.ai_agent_version_channels;
create policy tenant_isolation_ai_agent_version_channels_select on public.ai_agent_version_channels
  for select using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_agent_version_channels_write on public.ai_agent_version_channels;
create policy tenant_isolation_ai_agent_version_channels_write on public.ai_agent_version_channels
  for all using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  ) with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

-- O ALTER DEFAULT PRIVILEGES do baseline concede a anon TODA tabela criada
-- depois dele. Sem o revoke, a anon key (que vai para o browser) alcança a
-- tabela; `authenticated` lê e escreve sob a policy de organização.
revoke all on public.ai_agent_version_channels from anon;
grant select, insert, update, delete on public.ai_agent_version_channels to authenticated;
grant all on public.ai_agent_version_channels to service_role;

drop trigger if exists trg_ai_agent_version_channels_audit on public.ai_agent_version_channels;
create trigger trg_ai_agent_version_channels_audit
  after insert or update or delete on public.ai_agent_version_channels
  for each row execute function public.fn_audit_log_row();

comment on table public.ai_agent_version_channels is
  'Em quais números uma versão de agente atende (um, vários, ou todos). O número PRINCIPAL segue em ai_agent_versions.channel_session_id; esta tabela é o vínculo adicional. Agente antigo não tem linha aqui e continua como antes.';
comment on column public.ai_agent_version_channels.channel_session_id is
  'Um dos números em que a versão atende. `on delete restrict` espelha ai_agent_versions_channel_session_id_fkey — desconectar número vinculado ainda é decisão de produto em aberto (#2796).';
