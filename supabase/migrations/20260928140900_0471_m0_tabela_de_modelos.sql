-- 0471 — Onda M0 (fundamento de modelos): proposal_templates guarda só
-- CÓPIAS por organização (decisão da spec-mãe §6.1: a base da plataforma mora
-- no código, MODELOS_BASE, nunca no banco com organization_id nulo — a spec
-- de 21/09 pedia base+cópia no mesmo banco, e isso violaria "toda tabela
-- tenant-aware tem organization_id not null" da casa).
--
-- SEM CHECK fechado de slug: os 8 modelos-piloto da spec de 21/09 não estão
-- no repositório (medido em 24/09/2026 — nenhum template.json além dos 3
-- anexos desta spec, que são conteúdo diferente). Inventar o vocabulário
-- agora seria suposição. Validação de slug fica no Zod da aplicação até o
-- piloto de 3 modelos ser definido e uma migration futura fechar o CHECK.
create table if not exists public.proposal_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  slug text not null,
  version int not null default 1,
  -- Da onde a cópia veio (spec-mãe §6.1: "ao personalizar → nasce a cópia,
  -- com base_slug e base_version de onde veio" — sem isto, "atualização
  -- sugerida" da base, decisão 15, não tem como saber se a cópia está
  -- atrasada). Nascem e morrem juntos, como template_slug/version em
  -- crm_proposals (migration 0468). Nullable nesta onda: quem escreve a
  -- primeira linha é a Onda M1, que ainda não existe.
  base_slug text,
  base_version int,
  sections jsonb not null default '[]'::jsonb,
  section_order text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.proposal_templates drop constraint if exists proposal_templates_base_slug_versao_juntos_check;
alter table public.proposal_templates add constraint proposal_templates_base_slug_versao_juntos_check
  check ((base_slug is null) = (base_version is null));

comment on table public.proposal_templates is
  'Cópia por organização de um modelo de proposta. A base da plataforma (os modelos-piloto) mora no código (MODELOS_BASE), nunca aqui com organization_id nulo — ver spec-mãe §6.1.';

-- Só uma versão ATIVA por slug por organização.
create unique index if not exists proposal_templates_ativo_por_slug_org_uidx
  on public.proposal_templates (organization_id, slug)
  where is_active;

-- Duas linhas não disputam o mesmo número de versão do mesmo slug/organização.
create unique index if not exists proposal_templates_slug_versao_org_uidx
  on public.proposal_templates (organization_id, slug, version);

create index if not exists proposal_templates_org_idx
  on public.proposal_templates (organization_id);

alter table public.proposal_templates enable row level security;

-- Achado Important da revisão final da M0: a policy original ("tenant_
-- isolation_proposal_templates_all") só filtrava organização, sem piso de
-- papel — qualquer `viewer` da organização conseguia escrever/apagar modelo
-- pela REST direto. Molde de crm_proposals (migration 0466/baseline): SELECT
-- aberto a todo membro (mais bypass de suporte da plataforma), WRITE exige
-- `fn_role_at_least(organization_id, 'agent')`. A spec de modelos quer
-- edição só de manager+ (decisão 10) — esse piso mais estrito é gate de ROTA
-- (Onda M1/M3, que ainda não existem), igual a `revise`/`send` hoje; a RLS
-- é a mesma régua de piso que a tabela irmã já usa.
drop policy if exists tenant_isolation_proposal_templates_all on public.proposal_templates;

drop policy if exists proposal_templates_select on public.proposal_templates;
create policy proposal_templates_select on public.proposal_templates
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists proposal_templates_write on public.proposal_templates;
create policy proposal_templates_write on public.proposal_templates
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'agent'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent'));

revoke all on public.proposal_templates from anon;
grant select, insert, update, delete on public.proposal_templates to authenticated;
grant all on public.proposal_templates to service_role;

notify pgrst, 'reload schema';
