-- 0235 - FISCAL: CC-E, INUTILIZAÇÃO E CFOP EQUIVALENTE (paridade Odivix)
--
-- `fiscal_events.tipo` ganha `carta_correcao`: a CC-e é evento da nota
-- autorizada (sequência = ordem de chegada, teto 20 — contado pela rota).
-- O sidecar só transmite emissão e cancelamento; sem endpoint de CC-e, o
-- evento nasce "registrado localmente" e a timeline diz isso — nunca
-- "transmitida" presumida.
--
-- `fiscal_inutilizacoes`: faixa inutilizada por série + motivo. Sem nota
-- (é numeração que nunca virou documento) — por isso tabela própria, não
-- fiscal_events (que exige invoice_id).
--
-- `fiscal_cfop_equivalentes`: de/para de CFOP por org, lido pelo gerador
-- do SPED (Gera Arquivo) para mapear o CFOP do item.

alter table public.fiscal_events drop constraint if exists fiscal_events_tipo_check;

alter table public.fiscal_events
  add constraint fiscal_events_tipo_check check (
    tipo in ('criada', 'enviada', 'autorizada', 'rejeitada', 'erro', 'retry', 'cancelada', 'carta_correcao')
  );

create table if not exists public.fiscal_inutilizacoes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  serie text not null check (char_length(trim(serie)) between 1 and 10),
  numero_inicial integer not null check (numero_inicial > 0),
  numero_final integer not null check (numero_final > 0),
  motivo text not null check (char_length(trim(motivo)) between 15 and 255),
  ambiente text not null default 'homologacao' check (ambiente in ('homologacao', 'producao')),
  status text not null default 'registrada' check (status in ('registrada', 'transmitida', 'erro')),
  sefaz_protocolo text,
  sefaz_xmotivo text,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.fiscal_inutilizacoes drop constraint if exists fiscal_inutilizacoes_faixa_valida;

alter table public.fiscal_inutilizacoes
  add constraint fiscal_inutilizacoes_faixa_valida check (numero_final >= numero_inicial);

create index if not exists fiscal_inutilizacoes_org_idx
  on public.fiscal_inutilizacoes (organization_id, created_at desc);

create table if not exists public.fiscal_cfop_equivalentes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  cfop_origem text not null check (cfop_origem ~ '^\d{4}$'),
  cfop_destino text not null check (cfop_destino ~ '^\d{4}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint fiscal_cfop_equiv_diferentes check (cfop_destino <> cfop_origem)
);

create unique index if not exists fiscal_cfop_equiv_org_origem_key
  on public.fiscal_cfop_equivalentes (organization_id, cfop_origem);

alter table public.fiscal_inutilizacoes enable row level security;
alter table public.fiscal_cfop_equivalentes enable row level security;

drop policy if exists fiscal_inutilizacoes_select on public.fiscal_inutilizacoes;
create policy fiscal_inutilizacoes_select on public.fiscal_inutilizacoes
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Inutilizar é operação (agent+), como emitir: a rota grava com o client de
-- sessão; mudança de status (transmitida) é service-role.
drop policy if exists fiscal_inutilizacoes_insert on public.fiscal_inutilizacoes;
create policy fiscal_inutilizacoes_insert on public.fiscal_inutilizacoes
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists fiscal_cfop_equiv_select on public.fiscal_cfop_equivalentes;
create policy fiscal_cfop_equiv_select on public.fiscal_cfop_equivalentes
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- CFOP equivalente é config fiscal (manager+), como série e CFOP padrão:
-- mapeamento errado contamina o SPED da empresa inteira.
drop policy if exists fiscal_cfop_equiv_write on public.fiscal_cfop_equivalentes;
create policy fiscal_cfop_equiv_write on public.fiscal_cfop_equivalentes
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.fiscal_inutilizacoes from anon;
grant select on public.fiscal_inutilizacoes to authenticated;
grant all on public.fiscal_inutilizacoes to service_role;

revoke all on public.fiscal_cfop_equivalentes from anon;
grant select, insert, update, delete on public.fiscal_cfop_equivalentes to authenticated;
grant all on public.fiscal_cfop_equivalentes to service_role;

comment on table public.fiscal_inutilizacoes is
  'Faixas de numeração inutilizadas por série + motivo (sem nota: numeração que nunca virou documento). Transmissão à SEFAZ exige sidecar com endpoint próprio; sem ele, fica "registrada".';
comment on table public.fiscal_cfop_equivalentes is
  'De/para de CFOP por org, lido pelo Gera Arquivo do SPED para mapear o CFOP do item.';
