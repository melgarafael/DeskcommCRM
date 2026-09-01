---
title: Spec Técnica 02 — Customer 360 + Identity Resolution
parent: 02-prd-customer-360.md
depends_on: 01-spec-platform-base.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
escopo: Schema SQL completo, RLS, triggers, identity resolution, merge, custom fields, vocabulary, search & filters, eventos canônicos.
---

# Spec Técnica 02 — Customer 360 + Identity Resolution

> Esta Spec **detalha** o Sub-PRD 02 ao nível de DDL, função PL/pgSQL, código TypeScript e fluxos transacionais. Toda decisão deferida no PRD é resolvida aqui. Schema apresentado é **a fonte canônica** que migrations deverão materializar — divergências futuras requerem ADR explícito. Estrutura herda integralmente o template de RLS, audit e event_log da Spec 01 (Plataforma Base) e referencia regras de negócio do `docs/business-rules/00-business-rules-catalog.md` (P-01 a P-08, L-04, L-07, L-08).

---

## 1. Visão Geral

### 1.1 Posicionamento da Spec

A Spec 02 materializa o **núcleo gravitacional** do SonghaiCRM: as 5 tabelas core CRM herdadas do bundle (`crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`) + a tabela `contacts` (fonte canônica de identidade) + tabela auxiliar `merge_queue`. Toda capacidade subsequente do produto (atendimento WhatsApp, IA conversacional, integração Nuvemshop, MCP server) **opera sobre** estas estruturas, nunca em paralelo a elas. Mudanças de schema aqui têm efeito-cascade pra toda a arquitetura.

### 1.2 Decisões consolidadas nesta Spec

| Decisão deferida no PRD | Resolução nesta Spec |
|---|---|
| Particionamento de `crm_lead_activities` | Particionamento declarativo por RANGE em `(performed_at)` com partições mensais; estratégia de detach + archive aos 24 meses (§11). |
| Coluna gerada vs índice JSONB pra custom fields | GIN `jsonb_path_ops` em `custom_fields` por default; promoção a coluna gerada (`generated always as ... stored`) **somente** quando filtro for `top-3` no tenant em volume de queries (decisão data-driven, runbook em §6.5). |
| "Qual contact vence no merge automático" | Algoritmo `primary wins` documentado em §5.2: maior completude > mais antigo > maior atividade. Override manual sempre disponível. |
| Política de tags | Free-form por default; `canonical_tags` whitelist como soft policy por pipeline; case-sensitive no MVP. |
| Lista canônica de `lost_reason` | Definida em §8.3, com extensibilidade via `pipeline.settings.lost_reasons[]` adicional. |
| Algoritmo exato de identity resolution | Pseudocódigo + TypeScript em §4. |

### 1.3 Limites da Spec

**Dentro:** schema + triggers + RLS + algoritmos de identity resolution e merge + API search/filters + lista de eventos emitidos.

**Fora:** UI Kanban (Spec 04), webhook handler que popula activities de WAHA (Spec 03), webhook Nuvemshop (Spec 06), pipeline RAG que consome timeline (Spec 05).

### 1.4 Convenções

- DDL escrita pra Postgres 15+ (Supabase). Testada conceitualmente; migration final precisa rodar contra branch ephemeral antes de merge.
- Toda função PL/pgSQL com `language plpgsql security invoker set search_path = public, pg_temp` — exceto helpers explicitamente `security definer` (documentados).
- Comentários SQL `comment on column ... is '...'` em **todo** campo de domínio (não só constraints) — viram documentação automática via `pg_dump --schema-only`.
- TypeScript: Zod 3.x, Node 20+, ESM. Imports relativos com `.ts` ou `.js` conforme tsconfig do monorepo (decisão na Spec 01).

---

## 2. Schema SQL Completo

### 2.1 Tabela `contacts`

Fonte canônica de identidade de pessoa física no escopo de um tenant. CPF criptografado at-rest via `pgcrypto` (regra L-07).

```sql
-- Pré-requisitos (já habilitados pela Spec 01):
-- create extension if not exists "pgcrypto";
-- create extension if not exists "pg_trgm";

create table public.contacts (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,

  -- Dados pessoais
  name                     text,
  display_name             text,
  email                    text,
  email_normalized         text generated always as (lower(trim(email))) stored,
  phone_number             text,                 -- E.164: ^\+\d{8,15}$
  cpf_encrypted            bytea,                -- pgp_sym_encrypt(cpf_digits, key)
  cpf_hash                 text,                 -- sha256(cpf_digits) p/ matching sem decrypt
  birthdate                date,

  -- Estado
  is_blocked               boolean not null default false,
  blocked_reason           text,                 -- 'stop_keyword' | 'manual' | 'lgpd' | ...
  blocked_at               timestamptz,
  is_anonymized            boolean not null default false,
  anonymized_at            timestamptz,
  is_merged_into           uuid references public.contacts(id) on delete set null,
  merged_at                timestamptz,

  -- Consentimento LGPD (regra L-05)
  consent                  jsonb not null default jsonb_build_object(
                             'marketing',     jsonb_build_object('granted_at', null, 'source', null, 'version', null),
                             'transactional', jsonb_build_object('granted_at', null, 'source', null, 'version', null),
                             'profiling',     jsonb_build_object('granted_at', null, 'source', null, 'version', null)
                           ),

  -- Tags livres
  tags                     text[] not null default '{}',

  -- Origem
  source                   text not null default 'manual',  -- whatsapp_inbound | nuvemshop | manual | api | import
  source_metadata          jsonb not null default '{}'::jsonb,

  -- Auditoria leve (a auditoria densa fica em api_audit_log)
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by_user_id       uuid,                 -- soft FK p/ auth.users
  last_activity_at         timestamptz,          -- denormalizado por trigger

  -- Constraints
  constraint contacts_phone_e164_format
    check (phone_number is null or phone_number ~ '^\+\d{8,15}$'),
  constraint contacts_email_format
    check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint contacts_cpf_consistency
    check ((cpf_encrypted is null) = (cpf_hash is null)),
  constraint contacts_anonymized_locked
    check (is_anonymized = false or (is_anonymized = true and anonymized_at is not null))
);

comment on table  public.contacts                is 'Pessoa física no escopo de um tenant. CPF criptografado at-rest (pgcrypto). is_anonymized é irreversível (regra L-04).';
comment on column public.contacts.email_normalized is 'Coluna gerada (lower+trim) usada por todo matching e unique constraint.';
comment on column public.contacts.cpf_encrypted   is 'Bytea com pgp_sym_encrypt(digits, current_setting(''app.cpf_key'')). Acesso via decrypt_cpf().';
comment on column public.contacts.cpf_hash        is 'SHA256 hex dos 11 dígitos. Único por tenant. Permite match sem decrypt.';
comment on column public.contacts.is_merged_into  is 'Tombstone de merge (§5.4). NULL = contact ativo. NOT NULL = perdedor de merge, redireciona p/ primary.';
comment on column public.contacts.last_activity_at is 'Denormalizado pela trigger fn_update_last_activity_at em insert de crm_lead_activities.';

-- Unique constraints por tenant (parciais pra ignorar nulls)
create unique index uniq_contacts_org_email
  on public.contacts (organization_id, email_normalized)
  where email_normalized is not null and is_merged_into is null;

create unique index uniq_contacts_org_phone
  on public.contacts (organization_id, phone_number)
  where phone_number is not null and is_merged_into is null;

create unique index uniq_contacts_org_cpf
  on public.contacts (organization_id, cpf_hash)
  where cpf_hash is not null and is_merged_into is null;

-- Indexes operacionais
create index idx_contacts_org_blocked
  on public.contacts (organization_id) where is_blocked = true;

create index idx_contacts_org_last_activity
  on public.contacts (organization_id, last_activity_at desc nulls last);

create index idx_contacts_tags_gin
  on public.contacts using gin (tags);

create index idx_contacts_consent_gin
  on public.contacts using gin (consent jsonb_path_ops);

-- Trigram pra busca por nome (opcional MVP; suportado pela extensão pg_trgm)
create index idx_contacts_org_name_trgm
  on public.contacts using gin (organization_id, name gin_trgm_ops);

-- updated_at automático
create trigger trg_contacts_updated_at
  before update on public.contacts
  for each row execute function public.fn_set_updated_at();
```

**Helper `decrypt_cpf`:**

```sql
create or replace function public.decrypt_cpf(p_contact_id uuid)
returns text
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_cipher bytea;
  v_org    uuid;
begin
  select cpf_encrypted, organization_id into v_cipher, v_org
    from public.contacts where id = p_contact_id;

  if v_cipher is null then return null; end if;

  -- Verifica se caller tem acesso ao tenant
  if not exists (
    select 1 from public.fn_user_org_ids() x where x.organization_id = v_org
  ) and not public.fn_is_platform_admin() then
    raise exception 'forbidden_org';
  end if;

  -- Audit: toda decrypt é registrada
  insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_org, auth.uid(), 'contact.cpf_decrypted', 'contact', p_contact_id, jsonb_build_object('purpose', current_setting('app.decrypt_purpose', true)));

  return pgp_sym_decrypt(v_cipher, current_setting('app.cpf_key', true));
end$$;

comment on function public.decrypt_cpf(uuid) is
  'Decripta CPF com check de tenancy + audit obrigatório. Setar app.decrypt_purpose antes do call.';
```

### 2.2 Tabela `crm_pipelines`

```sql
create table public.crm_pipelines (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,

  name                text not null,
  slug                text not null,            -- ex: 'pedidos', 'suporte'
  description         text,
  is_default          boolean not null default false,
  is_archived         boolean not null default false,
  position            numeric not null default 1000,

  -- Vocabulary customizável (Sub-PRD 02 §3.7)
  vocabulary          jsonb not null default jsonb_build_object(
                        'lead',         'Cliente',
                        'lead_plural',  'Clientes',
                        'deal',         'Pedido',
                        'deal_plural',  'Pedidos',
                        'won',          'Pago',
                        'lost',         'Cancelado',
                        'stage',        'Etapa',
                        'stage_plural', 'Etapas'
                      ),

  -- Settings declarativos
  settings            jsonb not null default jsonb_build_object(
                        'fields',          '[]'::jsonb,        -- custom fields (§6)
                        'canonical_tags',  '[]'::jsonb,        -- whitelist opcional (§7 abaixo)
                        'lost_reasons',    '[]'::jsonb,        -- override de lost_reasons (§8.3)
                        'identity_resolution', jsonb_build_object(
                          'fields_in_priority_order', jsonb_build_array('cpf','phone_e164','email')
                        )
                      ),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint crm_pipelines_slug_format check (slug ~ '^[a-z0-9_-]{2,40}$')
);

create unique index uniq_crm_pipelines_org_slug
  on public.crm_pipelines (organization_id, slug);

create unique index uniq_crm_pipelines_org_default
  on public.crm_pipelines (organization_id) where is_default = true;

create index idx_crm_pipelines_org_position
  on public.crm_pipelines (organization_id, position) where is_archived = false;

create trigger trg_crm_pipelines_updated_at
  before update on public.crm_pipelines
  for each row execute function public.fn_set_updated_at();

comment on column public.crm_pipelines.vocabulary is
  'Mapeia rótulos canônicos (lead/deal/won/lost/stage) p/ termos do nicho. UI consome via usePipelineVocabulary (§7.2).';
comment on column public.crm_pipelines.settings is
  'Schema declarativo: settings.fields[] = custom fields; settings.canonical_tags[] = whitelist opcional; settings.lost_reasons[] = override; settings.identity_resolution = config matching.';
```

### 2.3 Tabela `crm_stages`

```sql
create table public.crm_stages (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  pipeline_id         uuid not null references public.crm_pipelines(id) on delete cascade,

  name                text not null,
  slug                text not null,            -- ex: 'aguardando_pagamento', 'pago'
  description         text,
  position            numeric not null,         -- fractional indexing entre stages
  color               text,                     -- hex '#RRGGBB' p/ UI

  is_won              boolean not null default false,  -- mover lead aqui → status='won'
  is_lost             boolean not null default false,  -- mover lead aqui → status='lost'
  is_archived         boolean not null default false,

  -- Telemetria opcional (alvo de SLA por stage)
  expected_duration_hours numeric,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint crm_stages_won_lost_mutex
    check (not (is_won and is_lost)),
  constraint crm_stages_slug_format
    check (slug ~ '^[a-z0-9_-]{2,40}$'),
  constraint crm_stages_color_format
    check (color is null or color ~ '^#[0-9a-fA-F]{6}$')
);

create unique index uniq_crm_stages_pipeline_slug
  on public.crm_stages (pipeline_id, slug);

create index idx_crm_stages_pipeline_position
  on public.crm_stages (pipeline_id, position) where is_archived = false;

-- Apenas 1 stage `is_won` e 1 `is_lost` por pipeline (relaxável; ver §8)
create unique index uniq_crm_stages_pipeline_won
  on public.crm_stages (pipeline_id) where is_won = true and is_archived = false;

create unique index uniq_crm_stages_pipeline_lost
  on public.crm_stages (pipeline_id) where is_lost = true and is_archived = false;

create trigger trg_crm_stages_updated_at
  before update on public.crm_stages
  for each row execute function public.fn_set_updated_at();
```

### 2.4 Tabela `crm_leads`

Card principal do funil. `position_in_stage` é `numeric` (fractional indexing — regra P-05). `contact_id` opcional pra permitir leads "anônimos" temporários (raro).

```sql
create table public.crm_leads (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  pipeline_id         uuid not null references public.crm_pipelines(id) on delete restrict,
  stage_id            uuid not null references public.crm_stages(id)    on delete restrict,
  contact_id          uuid     references public.contacts(id)            on delete set null,

  title               text not null,
  description         text,

  status              text not null default 'open',  -- open | won | lost
  lost_reason         text,                          -- obrigatório quando status='lost' (regra P-03)

  -- Posição (fractional indexing)
  position_in_stage   numeric not null default 1000,

  -- Valor
  value_cents         bigint,
  currency            text default 'MZN',  -- moeda padrão do negócio (migration 0161); ver MANIFEST.md

  -- Atribuição
  owner_user_id       uuid,                          -- soft FK auth.users
  assigned_at         timestamptz,

  -- Timeline denormalizada
  last_activity_at    timestamptz,                   -- denorm via trigger
  expected_close_date date,
  closed_at           timestamptz,

  -- Origem polimórfica
  source              text not null default 'manual',
  source_metadata     jsonb not null default '{}'::jsonb,
  external_id         text,                          -- p/ idempotência cross-source (regra W-05 análoga)

  -- Custom fields declarativos (§6)
  custom_fields       jsonb not null default '{}'::jsonb,

  -- Tags
  tags                text[] not null default '{}',

  -- Auditoria leve
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by_user_id  uuid,

  constraint crm_leads_status_enum
    check (status in ('open','won','lost')),
  constraint crm_leads_currency_iso
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint crm_leads_lost_reason_required
    check (status <> 'lost' or (lost_reason is not null and length(lost_reason) > 0)),
  constraint crm_leads_closed_at_consistency
    check (
      (status = 'open'  and closed_at is null) or
      (status in ('won','lost') and closed_at is not null)
    )
);

-- Idempotência cross-source (P-08): mesma origem + mesmo external_id = mesmo lead
create unique index uniq_crm_leads_org_source_external
  on public.crm_leads (organization_id, source, external_id)
  where external_id is not null;

-- Indexes operacionais (cobrindo filters comuns)
create index idx_crm_leads_org_pipeline_status
  on public.crm_leads (organization_id, pipeline_id, status);

create index idx_crm_leads_org_stage_position
  on public.crm_leads (organization_id, stage_id, position_in_stage);

create index idx_crm_leads_org_owner_status
  on public.crm_leads (organization_id, owner_user_id, status)
  where status = 'open';

create index idx_crm_leads_org_contact
  on public.crm_leads (organization_id, contact_id);

create index idx_crm_leads_org_last_activity
  on public.crm_leads (organization_id, last_activity_at desc nulls last);

create index idx_crm_leads_org_expected_close_overdue
  on public.crm_leads (organization_id, expected_close_date)
  where status = 'open' and expected_close_date is not null;

create index idx_crm_leads_custom_fields_gin
  on public.crm_leads using gin (custom_fields jsonb_path_ops);

create index idx_crm_leads_tags_gin
  on public.crm_leads using gin (tags);

create trigger trg_crm_leads_updated_at
  before update on public.crm_leads
  for each row execute function public.fn_set_updated_at();

comment on column public.crm_leads.position_in_stage is
  'Fractional indexing (regra P-05). NUNCA usar int. Mover via midpoint(prev, next) sem reescrever vizinhos.';
comment on column public.crm_leads.custom_fields is
  'Valores governados por crm_pipelines.settings.fields[]. Validação via Zod gerado dinamicamente (§6).';
```

**Função `midpoint`** (utilitário pra fractional indexing — exposta também ao TS):

```sql
create or replace function public.midpoint(p_prev numeric, p_next numeric)
returns numeric language sql immutable as $$
  select case
    when p_prev is null and p_next is null then 1000::numeric
    when p_prev is null then p_next - 1
    when p_next is null then p_prev + 1
    else (p_prev + p_next) / 2
  end
$$;
comment on function public.midpoint(numeric, numeric) is
  'Calcula posição entre dois cards. Usado por API /leads/:id/move.';
```

### 2.5 Tabela `crm_lead_activities` (polimórfica)

Timeline event-sourced. **Particionada por mês** em `(performed_at)` (§11). Append-only (regra de UI: 405 em UPDATE/DELETE; reforçado por revogação de privilégio).

```sql
create table public.crm_lead_activities (
  id                  uuid not null default gen_random_uuid(),
  organization_id     uuid not null,
  lead_id             uuid not null,
  contact_id          uuid,                  -- conveniência (denorm a partir do lead)

  -- Polimorfismo explícito (referência §3 do bundle)
  source_module       text not null,         -- 'whatsapp' | 'nuvemshop' | 'crm' | 'ai' | 'system' | 'lgpd'
  source_id           uuid,                  -- ex: messages.id, orders.id
  type                text not null,         -- catálogo canônico (§10)

  payload             jsonb not null default '{}'::jsonb,
  metadata            jsonb not null default '{}'::jsonb,

  performed_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  performed_by_user_id uuid,                 -- quem agiu (atendente, super-admin, system=null)

  primary key (id, performed_at)
) partition by range (performed_at);

comment on table public.crm_lead_activities is
  'Timeline append-only polimórfica. Particionada por mês. Activities NÃO disparam HTTP (anti-pattern §9 bundle); emitem evento via fn_emit_event_on_lead_change.';

-- Partição default (segura) — partições mensais criadas por job (§11)
create table public.crm_lead_activities_default
  partition of public.crm_lead_activities default;

-- Indexes nas partições (criados por template ao gerar partição mensal)
-- Template:
--   create index on <part> (organization_id, lead_id, performed_at desc);
--   create index on <part> (organization_id, type, performed_at desc);
--   create index on <part> (organization_id, contact_id, performed_at desc);
--   create index on <part> using gin (payload jsonb_path_ops);

-- Soft FK constraint (em particionada, FK é mais cara; usamos trigger de validação leve)
create or replace function public.fn_validate_activity_lead_org()
returns trigger language plpgsql as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.crm_leads where id = new.lead_id;
  if v_org is null then
    raise exception 'lead_not_found' using errcode = '23503';
  end if;
  if v_org <> new.organization_id then
    raise exception 'lead_org_mismatch' using errcode = '23514';
  end if;
  return new;
end$$;

create trigger trg_validate_activity_lead_org
  before insert on public.crm_lead_activities
  for each row execute function public.fn_validate_activity_lead_org();

-- Append-only: revogar UPDATE/DELETE do role da app
revoke update, delete on public.crm_lead_activities from authenticated, anon;
```

### 2.6 Tabela `crm_lead_links` (polimórfica)

Vínculos entre lead e qualquer recurso externo (`orders`, `conversations`, `messages`, `appointments`, etc.).

```sql
create table public.crm_lead_links (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  lead_id           uuid not null references public.crm_leads(id)     on delete cascade,

  target_kind       text not null,          -- 'order' | 'conversation' | 'message' | 'appointment' | ...
  target_id         uuid not null,
  link_kind         text not null,          -- 'primary' | 'related' | 'duplicate_of' | 'merged_from' | ...

  metadata          jsonb not null default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  created_by_user_id uuid,

  constraint crm_lead_links_target_kind_enum
    check (target_kind in ('order','conversation','message','appointment','contact','lead','external'))
);

create unique index uniq_crm_lead_links_lead_target_link
  on public.crm_lead_links (lead_id, target_kind, target_id, link_kind);

create index idx_crm_lead_links_org_target
  on public.crm_lead_links (organization_id, target_kind, target_id);

create index idx_crm_lead_links_lead
  on public.crm_lead_links (lead_id);
```

### 2.7 Tabela `merge_queue`

Fila de candidatos ambíguos quando identity resolution encontra >1 contact.

```sql
create table public.merge_queue (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,

  candidates        uuid[] not null,        -- array de contacts.id, len ≥ 2
  reason            text not null,          -- 'identity_ambiguous' | 'manual_request' | 'cross_source_collision'
  trigger_payload   jsonb not null default '{}'::jsonb,  -- snapshot do input que gerou ambiguidade

  status            text not null default 'pending',  -- pending | resolved | discarded
  resolution        jsonb,                  -- {action: 'merged_into', primary_id, losers, audit_id}
  resolved_by_user_id uuid,
  resolved_at       timestamptz,

  created_at        timestamptz not null default now(),

  constraint merge_queue_status_enum
    check (status in ('pending','resolved','discarded')),
  constraint merge_queue_candidates_min2
    check (array_length(candidates, 1) >= 2)
);

create index idx_merge_queue_org_status
  on public.merge_queue (organization_id, status, created_at);
```

### 2.8 Indexes — visão consolidada

| Tabela | Index | Tipo | Cobre |
|---|---|---|---|
| `contacts` | `uniq_contacts_org_email` | btree partial | unique email/org (não anonimizado) |
| `contacts` | `uniq_contacts_org_phone` | btree partial | unique phone/org |
| `contacts` | `uniq_contacts_org_cpf` | btree partial | unique cpf_hash/org |
| `contacts` | `idx_contacts_consent_gin` | GIN jsonb_path_ops | filter por consent.X.granted_at |
| `contacts` | `idx_contacts_org_name_trgm` | GIN trgm | search ILIKE em name |
| `crm_leads` | `idx_crm_leads_org_pipeline_status` | btree | filter pipeline+status |
| `crm_leads` | `idx_crm_leads_org_owner_status` | btree partial (open) | "minha caixa" |
| `crm_leads` | `idx_crm_leads_org_last_activity` | btree desc | order_by last_activity_at |
| `crm_leads` | `idx_crm_leads_org_expected_close_overdue` | btree partial | filter is_overdue |
| `crm_leads` | `idx_crm_leads_custom_fields_gin` | GIN jsonb_path_ops | filter custom_field[X]=Y |
| `crm_leads` | `idx_crm_leads_tags_gin` | GIN | filter tag |
| `crm_lead_activities_*` | `(org, lead_id, performed_at desc)` | btree | timeline por lead |
| `crm_lead_activities_*` | `(org, type, performed_at desc)` | btree | filter por type |
| `crm_lead_links` | `idx_crm_lead_links_org_target` | btree | reverse lookup recurso → leads |

### 2.9 RLS Policies

Aplicada em **todas** as 7 tabelas. Template idêntico ao da Spec 01 §3 (Plataforma Base). Helper `fn_user_org_ids()` + bypass via `fn_is_platform_admin()`.

```sql
-- Template (repetido por tabela)
alter table public.contacts             enable row level security;
alter table public.crm_pipelines        enable row level security;
alter table public.crm_stages           enable row level security;
alter table public.crm_leads            enable row level security;
alter table public.crm_lead_activities  enable row level security;
alter table public.crm_lead_links       enable row level security;
alter table public.merge_queue          enable row level security;

-- Exemplo (replicar substituindo <T>):
create policy "tenant_isolation_contacts_all" on public.contacts for all
  using  (organization_id in (select organization_id from public.fn_user_org_ids())
          or public.fn_is_platform_admin())
  with check
         (organization_id in (select organization_id from public.fn_user_org_ids())
          or public.fn_is_platform_admin());

-- crm_lead_activities: SELECT/INSERT only (UPDATE/DELETE revogado em §2.5)
create policy "tenant_isolation_crm_lead_activities_select" on public.crm_lead_activities for select
  using  (organization_id in (select organization_id from public.fn_user_org_ids())
          or public.fn_is_platform_admin());

create policy "tenant_isolation_crm_lead_activities_insert" on public.crm_lead_activities for insert
  with check
         (organization_id in (select organization_id from public.fn_user_org_ids())
          or public.fn_is_platform_admin());

-- merge_queue: agent não vê (apenas manager+)
create policy "tenant_isolation_merge_queue_select_manager" on public.merge_queue for select
  using  ((organization_id in (select organization_id from public.fn_user_org_ids()) and public.fn_user_role_in(organization_id) >= 3)
          or public.fn_is_platform_admin());

create policy "tenant_isolation_merge_queue_write_manager" on public.merge_queue for all
  using  ((organization_id in (select organization_id from public.fn_user_org_ids()) and public.fn_user_role_in(organization_id) >= 3)
          or public.fn_is_platform_admin())
  with check
         ((organization_id in (select organization_id from public.fn_user_org_ids()) and public.fn_user_role_in(organization_id) >= 3)
          or public.fn_is_platform_admin());
```

`fn_user_role_in(uuid)` retorna inteiro 1-4 (vide Spec 01 §3.3). Manager = 3.

---

## 3. Triggers Postgres

> Anti-pattern letal (regra herdada §9 do bundle): **trigger NUNCA faz HTTP**. Toda integração externa passa por `event_log` consumido por workers.

### 3.1 `fn_crm_lead_close_on_stage`

Auto won/lost via stage flags (regra P-02).

```sql
create or replace function public.fn_crm_lead_close_on_stage()
returns trigger language plpgsql as $$
declare
  v_stage record;
  v_old_status text;
begin
  if (tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id)
     and (tg_op = 'UPDATE' and new.status   is not distinct from old.status) then
    return new;
  end if;

  select is_won, is_lost into v_stage
    from public.crm_stages where id = new.stage_id;

  v_old_status := coalesce(old.status, 'open');

  if v_stage.is_won then
    new.status    := 'won';
    new.closed_at := coalesce(new.closed_at, now());
  elsif v_stage.is_lost then
    new.status    := 'lost';
    new.closed_at := coalesce(new.closed_at, now());
  else
    -- Reabertura (regra P-04)
    if v_old_status in ('won','lost') then
      new.status    := 'open';
      new.closed_at := null;
    end if;
  end if;
  return new;
end$$;

create trigger trg_crm_lead_close_on_stage
  before insert or update of stage_id on public.crm_leads
  for each row execute function public.fn_crm_lead_close_on_stage();
```

### 3.2 `fn_update_last_activity_at`

Denormalização de `last_activity_at` em `crm_leads` e `contacts` (DIRC = **I**ntegrar).

```sql
create or replace function public.fn_update_last_activity_at()
returns trigger language plpgsql as $$
begin
  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;

  return new;
end$$;

create trigger trg_update_last_activity_at
  after insert on public.crm_lead_activities
  for each row execute function public.fn_update_last_activity_at();
```

### 3.3 `fn_emit_event_on_lead_change`

Emite linha em `event_log` (tabela governada pela Spec 01) — **NÃO faz HTTP**. Workers consomem.

```sql
create or replace function public.fn_emit_event_on_lead_change()
returns trigger language plpgsql as $$
declare
  v_event text;
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    v_event := 'lead.created';
    v_payload := jsonb_build_object('lead_id', new.id, 'pipeline_id', new.pipeline_id, 'stage_id', new.stage_id, 'contact_id', new.contact_id, 'source', new.source);

  elsif tg_op = 'UPDATE' then
    if new.stage_id is distinct from old.stage_id then
      v_event := 'lead.stage_changed';
      v_payload := jsonb_build_object('lead_id', new.id, 'from_stage_id', old.stage_id, 'to_stage_id', new.stage_id);
      perform public.fn_log_event(new.organization_id, v_event, v_payload);
    end if;

    if new.status is distinct from old.status then
      if new.status = 'won' then
        v_event := 'lead.won';
      elsif new.status = 'lost' then
        v_event := 'lead.lost';
        v_payload := jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason);
      else
        v_event := 'lead.reopened';
      end if;
      v_payload := coalesce(v_payload, jsonb_build_object('lead_id', new.id, 'status', new.status));
      perform public.fn_log_event(new.organization_id, v_event, v_payload);
      return new;
    end if;

    if new.owner_user_id is distinct from old.owner_user_id then
      v_event := 'lead.assigned';
      v_payload := jsonb_build_object('lead_id', new.id, 'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id);
    end if;
  end if;

  if v_event is not null then
    perform public.fn_log_event(new.organization_id, v_event, v_payload);
  end if;
  return new;
end$$;

create trigger trg_emit_event_on_lead_change
  after insert or update on public.crm_leads
  for each row execute function public.fn_emit_event_on_lead_change();
```

`fn_log_event(uuid, text, jsonb)` é helper definido pela Spec 01 que faz `insert into event_log (organization_id, event, payload, created_at)`.

### 3.4 `fn_seed_default_pipeline_for_org`

Seedador chamado em insert de `organizations` (regra T-06).

```sql
create or replace function public.fn_seed_default_pipeline_for_org()
returns trigger language plpgsql as $$
declare
  v_pipeline_id uuid;
  v_stage record;
  v_position numeric := 1000;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position)
  values (new.id, 'Pedidos', 'pedidos', true, 1000)
  returning id into v_pipeline_id;

  for v_stage in
    select * from (values
      ('Carrinho abandonado',      'carrinho_abandonado',      false, false),
      ('Aguardando pagamento',     'aguardando_pagamento',     false, false),
      ('Pago',                     'pago',                     true,  false),
      ('Em separação',             'em_separacao',             false, false),
      ('Enviado',                  'enviado',                  false, false),
      ('Entregue',                 'entregue',                 false, false),
      ('Pós-venda',                'pos_venda',                false, false),
      ('Cancelado',                'cancelado',                false, true)
    ) as t(name, slug, is_won, is_lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, v_stage.name, v_stage.slug, v_position, v_stage.is_won, v_stage.is_lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;

create trigger trg_seed_default_pipeline_for_org
  after insert on public.organizations
  for each row execute function public.fn_seed_default_pipeline_for_org();
```

> **Nota:** stage `is_won='Pago'` reflete vocabulário e-commerce. `Cancelado` é `is_lost`. Stages intermediárias não têm flag.

### 3.5 `fn_validate_lost_reason_required`

Reforça a regra P-03 (já há check constraint, mas o trigger devolve mensagem amigável e pode validar contra whitelist canônica + `pipeline.settings.lost_reasons`).

```sql
create or replace function public.fn_validate_lost_reason_required()
returns trigger language plpgsql as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other'];
  v_pipeline_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    select coalesce(
      array(select jsonb_array_elements_text(settings->'lost_reasons')), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (v_canonical) or new.lost_reason = any (v_pipeline_extra)) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;

create trigger trg_validate_lost_reason_required
  before insert or update of status, lost_reason on public.crm_leads
  for each row execute function public.fn_validate_lost_reason_required();
```

---

## 4. Identity Resolution Algorithm

### 4.1 Pseudocódigo

```
fn resolveContact(input: { organization_id, email?, phone?, cpf?, name? }) :
  cfg ← organization_settings.identity_resolution
        OR pipeline.settings.identity_resolution
        OR DEFAULT(['cpf','phone_e164','email'])

  normalized ← {
    email_norm = lower(trim(input.email)),
    phone_e164 = normalize_e164(input.phone),
    cpf_hash   = sha256(strip_non_digits(input.cpf))  if cpf válido
  }

  candidates ← []

  for each field in cfg.fields_in_priority_order:
    matches ← SELECT id FROM contacts
              WHERE organization_id = input.org
                AND is_merged_into IS NULL
                AND <field-specific-condition>(normalized)
    if len(matches) == 1:
      single_match ← matches[0]
      if candidates.empty():
        return { contact: single_match, action: 'matched', confidence: HIGH if field in ['cpf','phone'] else MEDIUM }
      else if single_match in candidates:
        continue
      else:
        candidates ← candidates ∪ matches
    else if len(matches) > 1:
      candidates ← candidates ∪ matches

  if candidates.size() == 0:
    contact ← INSERT contacts (...)
    emit('contact.created')
    return { contact, action: 'created' }

  if candidates.size() == 1:
    return { contact: candidates[0], action: 'matched', confidence: derived }

  # >= 2 candidatos
  INSERT merge_queue (org, candidates, reason='identity_ambiguous', trigger_payload=input)
  emit('contact.merge_pending')
  # política: criar contact provisório vinculado ao primeiro candidato OU recusar
  # MVP: cria contact provisório com flag em metadata.merge_pending_queue_id
  return { contact: candidates[0], action: 'merge_pending', queue_id }
```

**Observações:**
- "Confidence" é metadado emitido em `crm_lead_activities.metadata.confidence` quando o resolve dispara criação de lead — útil pra revisão posterior.
- CPF tem **prioridade absoluta** quando presente e válido. Telefone E.164 é o segundo eixo (alta confiança porque WhatsApp é canal primário). Email tem confiança média (compartilhamento entre familiares é comum no e-commerce BR).
- Mismatches **silenciosos** (ex: phone match mas email diverge no payload) **não** invalidam o match — apenas registram em metadata pra inspeção. A premissa: o contact existente é a fonte de verdade até evidência contrária explícita.

### 4.2 Configuração por tenant

```json
// crm_pipelines.settings.identity_resolution OU
// organizations.settings.identity_resolution (fallback global)
{
  "fields_in_priority_order": ["cpf", "phone_e164", "email"],
  "auto_create_on_no_match": true,
  "block_match_on_blocked_contact": false,
  "store_input_in_activity": true
}
```

### 4.3 Empate (>1 candidato)

Sempre vai pra `merge_queue`. **Nunca** merge automático no MVP (regra C1 do PRD: preferir criar e enfileirar a errar). Manager+ resolve manualmente via UI:
- (a) escolher um existente como primary,
- (b) criar novo separado (descartar match),
- (c) merge formal (§5).

### 4.4 Função TypeScript `resolveContact`

```ts
// src/server/services/identity/resolveContact.ts
import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "@/server/db";
import { logEvent } from "@/server/services/eventLog";
import { encryptCpf, hashCpf, normalizeE164, isValidCpf, isValidEmail } from "./normalize";

export const ResolveContactInput = z.object({
  organization_id: z.string().uuid(),
  email:           z.string().optional().nullable(),
  phone:           z.string().optional().nullable(),
  cpf:             z.string().optional().nullable(),
  name:            z.string().optional().nullable(),
  source:          z.enum(["whatsapp_inbound","nuvemshop","manual","api","import"]),
  source_metadata: z.record(z.unknown()).optional(),
});

export type ResolveContactResult =
  | { contact: ContactRow; action: "matched";        confidence: "high"|"medium"; matched_by: "cpf"|"phone_e164"|"email" }
  | { contact: ContactRow; action: "created"; }
  | { contact: ContactRow; action: "merge_pending";  queue_id: string; candidates: string[] };

export async function resolveContact(
  raw: z.input<typeof ResolveContactInput>
): Promise<ResolveContactResult> {
  const input = ResolveContactInput.parse(raw);

  const cfg = await loadIdentityResolutionConfig(input.organization_id);
  const order = cfg.fields_in_priority_order; // ['cpf','phone_e164','email']

  const norm = {
    email_norm: input.email ? input.email.trim().toLowerCase() : null,
    phone_e164: input.phone ? normalizeE164(input.phone) : null,
    cpf_hash:   input.cpf && isValidCpf(input.cpf) ? hashCpf(input.cpf) : null,
  };

  // Hard validations
  if (input.email && !isValidEmail(input.email)) throw httpErr(422, "invalid_email");
  if (input.phone && !norm.phone_e164)           throw httpErr(422, "phone_must_be_e164");
  if (input.cpf   && !norm.cpf_hash)             throw httpErr(422, "invalid_cpf");

  // Coletar candidatos por campo, em ordem de prioridade
  const candidatesById = new Map<string, ContactRow>();
  let firstHighConfidence: { row: ContactRow; field: typeof order[number] } | null = null;

  for (const field of order) {
    const rows = await findCandidates(input.organization_id, field, norm);
    for (const r of rows) candidatesById.set(r.id, r);
    if (rows.length === 1 && !firstHighConfidence && (field === "cpf" || field === "phone_e164")) {
      firstHighConfidence = { row: rows[0], field };
    }
  }

  // Caso 0: nenhum candidato → cria
  if (candidatesById.size === 0) {
    const contact = await createContact(input, norm);
    await logEvent(input.organization_id, "contact.created", {
      contact_id: contact.id,
      source: input.source,
    });
    return { contact, action: "created" };
  }

  // Caso 1: único candidato (qualquer eixo) → match
  if (candidatesById.size === 1) {
    const [contact] = [...candidatesById.values()];
    const matched_by =
      firstHighConfidence?.field ??
      (norm.email_norm && contact.email_normalized === norm.email_norm ? "email" : "phone_e164");
    return {
      contact,
      action: "matched",
      confidence: matched_by === "email" ? "medium" : "high",
      matched_by,
    };
  }

  // Caso 2+: ambigüidade → merge_queue, devolve o "menos errado"
  const candidates = [...candidatesById.keys()];
  const queue = await db.insertInto("merge_queue").values({
    organization_id: input.organization_id,
    candidates,
    reason: "identity_ambiguous",
    trigger_payload: { input, norm },
  }).returningAll().executeTakeFirstOrThrow();

  await logEvent(input.organization_id, "contact.merge_pending", {
    queue_id: queue.id, candidates,
  });

  // Heurística: devolve candidato com mais "evidência" no input atual
  const best = pickBestCandidate([...candidatesById.values()], norm);
  return { contact: best, action: "merge_pending", queue_id: queue.id, candidates };
}

async function findCandidates(
  org: string,
  field: "cpf"|"phone_e164"|"email",
  norm: { email_norm: string|null; phone_e164: string|null; cpf_hash: string|null }
) {
  switch (field) {
    case "cpf":
      if (!norm.cpf_hash) return [];
      return db.selectFrom("contacts").selectAll()
        .where("organization_id","=",org)
        .where("cpf_hash","=",norm.cpf_hash)
        .where("is_merged_into","is",null)
        .execute();
    case "phone_e164":
      if (!norm.phone_e164) return [];
      return db.selectFrom("contacts").selectAll()
        .where("organization_id","=",org)
        .where("phone_number","=",norm.phone_e164)
        .where("is_merged_into","is",null)
        .execute();
    case "email":
      if (!norm.email_norm) return [];
      return db.selectFrom("contacts").selectAll()
        .where("organization_id","=",org)
        .where("email_normalized","=",norm.email_norm)
        .where("is_merged_into","is",null)
        .execute();
  }
}
```

`normalizeE164`, `hashCpf`, `encryptCpf`, `isValidCpf`, `isValidEmail`, `pickBestCandidate`, `loadIdentityResolutionConfig` ficam em `src/server/services/identity/normalize.ts` — implementações pequenas e bem testadas (TDD obrigatório, vide §12).

---

## 5. Merge de Contacts

### 5.1 Operação atômica

Toda a operação roda em **uma transação serializável** (`set transaction isolation level serializable`) com SAVEPOINTs por tabela afetada. Se qualquer step falha, rollback completo. Idempotência: re-executar o mesmo merge (mesmo `audit_id`) é no-op.

```ts
// src/server/services/contacts/mergeContacts.ts
export async function mergeContacts(args: {
  organization_id: string;
  primary_id: string;
  loser_ids: string[];          // ≥ 1
  actor_user_id: string;
  reason?: string;
}): Promise<{ audit_id: string }> {
  if (args.loser_ids.length === 0) throw httpErr(400, "no_losers");
  if (args.loser_ids.includes(args.primary_id)) throw httpErr(400, "primary_in_losers");

  return db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
    // Snapshot before-state pra audit
    const before = await trx.selectFrom("contacts")
      .selectAll()
      .where("id","in", [args.primary_id, ...args.loser_ids])
      .where("organization_id","=", args.organization_id)
      .execute();

    if (before.length !== args.loser_ids.length + 1) throw httpErr(404, "contacts_not_found");
    if (before.some(c => c.is_anonymized && c.id === args.primary_id))
      throw httpErr(409, "primary_anonymized");

    // SP1: crm_leads
    await trx.savepoint("sp_leads").execute(async (trx2) => {
      await trx2.updateTable("crm_leads")
        .set({ contact_id: args.primary_id })
        .where("contact_id","in", args.loser_ids)
        .where("organization_id","=", args.organization_id)
        .execute();
    });

    // SP2: crm_lead_activities (denorm contact_id)
    await trx.savepoint("sp_activities").execute(async (trx2) => {
      await trx2.updateTable("crm_lead_activities")
        .set({ contact_id: args.primary_id })
        .where("contact_id","in", args.loser_ids)
        .where("organization_id","=", args.organization_id)
        .execute();
    });

    // SP3: conversations (Sub-PRD 03 — coluna contact_id)
    await trx.savepoint("sp_conversations").execute(async (trx2) => {
      await trx2.updateTable("conversations")
        .set({ contact_id: args.primary_id })
        .where("contact_id","in", args.loser_ids)
        .where("organization_id","=", args.organization_id)
        .execute();
    });

    // SP4: tombstones nos perdedores
    await trx.savepoint("sp_tombstones").execute(async (trx2) => {
      await trx2.updateTable("contacts")
        .set({
          is_merged_into: args.primary_id,
          merged_at: new Date(),
          is_anonymized: true,
          anonymized_at: new Date(),
          // Apaga campos pessoais (preserva histórico via FK preservada)
          name: null, display_name: null, email: null, phone_number: null,
          cpf_encrypted: null, cpf_hash: null, birthdate: null,
        })
        .where("id","in", args.loser_ids)
        .where("organization_id","=", args.organization_id)
        .execute();
    });

    // SP5: primary recebe merge dos custom_fields (primary wins, mas absorve nulls)
    await trx.savepoint("sp_primary_enrich").execute(async (trx2) => {
      const primary = before.find(c => c.id === args.primary_id)!;
      const losers  = before.filter(c => c.id !== args.primary_id);
      const enriched = enrichByPrimaryWins(primary, losers);
      await trx2.updateTable("contacts")
        .set(enriched.diff)
        .where("id","=", args.primary_id)
        .execute();
    });

    // SP6: audit_log
    const auditId = crypto.randomUUID();
    await trx.savepoint("sp_audit").execute(async (trx2) => {
      await trx2.insertInto("api_audit_log").values({
        id: auditId,
        organization_id: args.organization_id,
        actor_user_id: args.actor_user_id,
        action: "contact.merged",
        resource_type: "contact",
        resource_id: args.primary_id,
        metadata: {
          primary_id: args.primary_id,
          loser_ids: args.loser_ids,
          before_state: before,           // snapshot pra rollback humano
          reason: args.reason ?? null,
        },
      }).execute();
    });

    // Emite evento (workers consomem: invalida RAG, atualiza caches, recalc segments)
    await trx.insertInto("event_log").values({
      organization_id: args.organization_id,
      event: "contact.merged",
      payload: { primary_id: args.primary_id, loser_ids: args.loser_ids, audit_id: auditId },
    }).execute();

    return { audit_id: auditId };
  });
}
```

### 5.2 Algoritmo "primary wins" (auto-pick) 

Quando a UI sugere primary automaticamente, ranking:

1. **Maior completude** (count de campos não-null entre `name`, `email`, `phone_number`, `cpf_hash`, `birthdate`).
2. Em empate: **mais antigo** (`created_at` ASC) — preserva histórico.
3. Em empate: **mais ativo** (`last_activity_at` DESC).
4. Em empate: **menor UUID** (determinístico).

Override manual sempre presente — UI mostra ranking sugerido com toggle.

`enrichByPrimaryWins(primary, losers)`:
- Pra cada campo escalar (`name`, `email`, etc): se primary tem valor, mantém; senão, pega do primeiro loser que tem.
- `tags`: união (`primary.tags ∪ losers.tags`).
- `consent`: pega o `granted_at` mais recente por categoria (mais permissivo). Se `revoked_at` mais recente, prevalece (mais conservador).
- `custom_fields`: shallow merge primary-wins. Diff registrado em audit.

### 5.3 Cascade de updates

Toda tabela com FK soft (sem `on delete cascade` real, porque é `set null`) é atualizada manualmente nos savepoints. **Tabelas afetadas no MVP:**

| Tabela | Coluna | Ação |
|---|---|---|
| `crm_leads` | `contact_id` | redirect → primary |
| `crm_lead_activities` | `contact_id` (denorm) | redirect → primary |
| `crm_lead_links` | `target_id` quando `target_kind='contact'` | redirect → primary |
| `conversations` (Spec 03) | `contact_id` | redirect → primary |
| `messages` (Spec 03) | indireto via `conversations` | nada |
| `orders` (Spec 06) | `contact_id` | redirect → primary |

### 5.4 Tombstone

Loser permanece na tabela `contacts` com:
- `is_merged_into = primary_id`
- `is_anonymized = true`
- `anonymized_at = now()`
- Todos os campos pessoais nulificados.

GET no loser retorna 410 `contact_merged` com header `Location: /api/v1/contacts/{primary_id}` — clientes (incluindo MCP) seguem.

### 5.5 Audit log

`api_audit_log.action = 'contact.merged'`, `metadata.before_state` traz snapshot completo dos contacts antes do merge — habilita auditoria humana (apesar do merge ser irreversível formalmente).

---

## 6. Custom Fields Declarativos

### 6.1 Schema jsonb de field definition

```ts
// Zod canônico (espelhado na UI)
const FieldDefinition = z.discriminatedUnion("type", [
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("text"),       required: z.boolean().default(false), max_length: z.number().int().positive().max(4096).optional(), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("textarea"),   required: z.boolean().default(false), max_length: z.number().int().positive().max(16384).optional(), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("number"),     required: z.boolean().default(false), min: z.number().optional(), max: z.number().optional(), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("currency"),   required: z.boolean().default(false), currency: z.string().regex(/^[A-Z]{3}$/).default("BRL"), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("date"),       required: z.boolean().default(false), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("boolean"),    required: z.boolean().default(false), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("select"),     required: z.boolean().default(false), options: z.array(z.string().min(1)).min(1).max(100), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("multiselect"),required: z.boolean().default(false), options: z.array(z.string().min(1)).min(1).max(100), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("url"),        required: z.boolean().default(false), deprecated: z.boolean().default(false) }),
  z.object({ key: KeyId, label: z.string().min(1).max(80), type: z.literal("email"),      required: z.boolean().default(false), deprecated: z.boolean().default(false) }),
]);

const KeyId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "key_invalid_format");
const PipelineFields = z.array(FieldDefinition).max(30); // limite C4 do PRD
```

### 6.2 Tipos suportados

`text` | `textarea` | `number` | `date` | `boolean` | `select` | `multiselect` | `currency` | `url` | `email`.

Storage no banco:
- `currency` → number (cents). UI formata.
- `date` → ISO `YYYY-MM-DD`.
- `multiselect` → array de strings (subset de `options`).
- Demais → escalar conforme tipo nativo JSON.

### 6.3 Geração dinâmica de Zod

```ts
// src/shared/customFields/buildSchema.ts
export function buildLeadCustomFieldsSchema(fields: PipelineFieldDefinition[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) {
    if (f.deprecated) continue;
    let s: z.ZodTypeAny;
    switch (f.type) {
      case "text":        s = z.string().max(f.max_length ?? 4096);  break;
      case "textarea":    s = z.string().max(f.max_length ?? 16384); break;
      case "number":      s = z.number().refine(v => (f.min == null || v >= f.min) && (f.max == null || v <= f.max), "out_of_range"); break;
      case "currency":    s = z.number().int().nonnegative();        break;
      case "date":        s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); break;
      case "boolean":     s = z.boolean();                            break;
      case "select":      s = z.enum(f.options as [string, ...string[]]); break;
      case "multiselect": s = z.array(z.enum(f.options as [string, ...string[]])).max(f.options.length); break;
      case "url":         s = z.string().url();                       break;
      case "email":       s = z.string().email();                     break;
    }
    shape[f.key] = f.required ? s : s.optional().nullable();
  }
  return z.object(shape).strict(); // strict() proíbe keys desconhecidas
}
```

### 6.4 Validação no save

```ts
// POST /api/v1/leads e PATCH /api/v1/leads/:id
const pipeline = await loadPipeline(body.pipeline_id);
const cfSchema = buildLeadCustomFieldsSchema(pipeline.settings.fields);
const customFields = cfSchema.parse(body.custom_fields ?? {}); // 422 detalhado
```

Erros viram 422 `field_value_not_in_options` / `field_required` / `field_unknown_key`.

### 6.5 Indexação JSONB e coluna gerada

**Default:** GIN `jsonb_path_ops` em `custom_fields` cobre `WHERE custom_fields @> '{"k":"v"}'` em latência aceitável até ~1M leads.

**Promoção a coluna gerada:** quando um filter passa a ser top-3 em volume de queries do tenant (medido em `pg_stat_statements` rodando por 7 dias):

```sql
alter table public.crm_leads
  add column cf_tamanho_preferido text
  generated always as (custom_fields->>'tamanho_preferido') stored;

create index idx_crm_leads_cf_tamanho_preferido
  on public.crm_leads (organization_id, cf_tamanho_preferido)
  where cf_tamanho_preferido is not null;
```

Runbook: `docs/runbooks/custom-fields-promote-to-column.md` (a escrever fase 1.5).

---

## 7. Vocabulary Customizável

### 7.1 Schema

```ts
const Vocabulary = z.object({
  lead:         z.string().min(1).max(40),
  lead_plural:  z.string().min(1).max(40),
  deal:         z.string().min(1).max(40),
  deal_plural:  z.string().min(1).max(40),
  won:          z.string().min(1).max(40),
  lost:         z.string().min(1).max(40),
  stage:        z.string().min(1).max(40),
  stage_plural: z.string().min(1).max(40),
});
```

Default e-commerce já é populado pelo `crm_pipelines` default em §2.2.

### 7.2 Hook React

```tsx
// src/client/hooks/usePipelineVocabulary.ts
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

export function usePipelineVocabulary(pipelineId: string | null) {
  const q = useQuery({
    queryKey: ["pipeline-vocabulary", pipelineId],
    queryFn:  async () => {
      if (!pipelineId) return DEFAULT_VOCABULARY;
      const res = await fetch(`/api/v1/pipelines/${pipelineId}/vocabulary`);
      return Vocabulary.parse((await res.json()).data);
    },
    enabled: !!pipelineId,
    staleTime: 60_000,
  });
  return { vocab: q.data ?? DEFAULT_VOCABULARY, isLoading: q.isLoading };
}

const DEFAULT_VOCABULARY = {
  lead: "Cliente", lead_plural: "Clientes",
  deal: "Pedido",  deal_plural: "Pedidos",
  won: "Pago",     lost: "Cancelado",
  stage: "Etapa",  stage_plural: "Etapas",
};
```

Uso:

```tsx
const { vocab } = usePipelineVocabulary(pipelineId);
return <h1>Novo {vocab.deal}</h1>;
```

Linter custom (Spec 04 §UI) detecta strings hardcoded ("Pedido", "Cliente") em componentes que recebem `pipelineId` por prop — força uso do hook.

### 7.3 Cache invalidation

- Mudança em `crm_pipelines.vocabulary` emite evento `pipeline.vocabulary_changed`.
- Worker realtime via Supabase Realtime (`postgres_changes`) notifica frontend; React Query invalida `["pipeline-vocabulary", pipelineId]`.
- Tempo alvo: <5s da gravação à UI atualizada (AC §3.7 do PRD).

---

## 8. Lead Status Lifecycle

### 8.1 Máquina de estado

```
              ┌──────────────────────┐
              │       open           │◀────────────┐
              └──────┬──────┬────────┘             │
       move to       │      │      move to         │
       is_won stage  │      │      is_lost stage   │
                     ▼      ▼                      │
              ┌──────────┐ ┌──────────┐            │
              │   won    │ │   lost   │            │
              └────┬─────┘ └────┬─────┘            │
                   │            │                  │
                   │ move to non-flag stage        │
                   └────────────┴──────────────────┘
                          (reabertura)
```

Transições não listadas (ex: `won → lost` direto) **só** via passar por `open` (mover pra stage neutra primeiro). Trigger §3.1 garante consistência.

### 8.2 Regras

- `status` é **derivado** do `stage_id` + flags `is_won/is_lost`. Setar `status` manualmente em UPDATE é ignorado pelo trigger.
- `closed_at` preenchido automaticamente em won/lost; nullificado em reabertura.
- Reabertura emite `lead.reopened` no event_log + activity `reopened`.

### 8.3 Lista canônica de `lost_reason`

```
requested_by_customer
price
no_response
product_unavailable
cancelled_by_store
cancelled_by_customer
payment_failed
other
```

Extensão por pipeline via `pipelines.settings.lost_reasons[]` (array de strings adicionais). Validação em §3.5.

---

## 9. Search & Filters API (`GET /api/v1/leads`)

### 9.1 Filters suportados

| Filter | Tipo | Notação |
|---|---|---|
| `pipeline_id` | uuid | `?pipeline_id=...` |
| `stage_id` | uuid | `?stage_id=...` |
| `owner_user_id` | uuid \| `me` | `?owner_user_id=me` |
| `contact_id` | uuid | `?contact_id=...` |
| `status` | open\|won\|lost | `?status=open` |
| `source` | text | `?source=nuvemshop_order` |
| `tag` | text | `?tag=vip` |
| `tags_any` | text[] (CSV) | `?tags_any=vip,recompra` |
| `tags_all` | text[] (CSV) | `?tags_all=vip,vip-prime` |
| `search` | text (ILIKE em title) | `?search=joao` |
| `value_cents[gte\|lte]` | number | `?value_cents[gte]=10000` |
| `created_at[gte\|lte]` | iso8601 | `?created_at[gte]=2026-01-01T00:00:00Z` |
| `last_activity_at[gte\|lte]` | iso8601 | `?last_activity_at[gte]=...` |
| `expected_close_date[gte\|lte]` | date | `?expected_close_date[lte]=2026-05-01` |
| `is_overdue` | boolean | `?is_overdue=true` |
| `custom_field[KEY]` | jsonb path | `?custom_field[tamanho_preferido]=GG` |
| `lost_reason` | text | `?lost_reason=price` |
| `order_by` | enum | `?order_by=last_activity_at` |
| `order_dir` | asc\|desc | `?order_dir=desc` |
| `limit` | int 1..200 | `?limit=50` |
| `cursor` | opaque | `?cursor=...` |

### 9.2 Parser `?campo[op]=valor`

```ts
const OPS = ["eq","gt","gte","lt","lte","in","contains","ilike"] as const;
type Op = typeof OPS[number];

function parseQueryFilters(qs: URLSearchParams): ParsedFilters {
  const out: Record<string, Array<{ op: Op; value: string }>> = {};
  for (const [rawKey, value] of qs.entries()) {
    const m = rawKey.match(/^([a-z_][a-z0-9_]*)(?:\[(.+?)\])?$/);
    if (!m) throw httpErr(422, "filter_key_invalid", { key: rawKey });
    const [, field, opOrSubKey] = m;

    if (field === "custom_field") {
      // ?custom_field[KEY]=value (eq) ou ?custom_field[KEY][op]=value (futuro)
      out[`custom_field.${opOrSubKey}`] = [{ op: "eq", value }];
      continue;
    }

    const op: Op = (opOrSubKey as Op) ?? "eq";
    if (!OPS.includes(op)) throw httpErr(422, "filter_op_unknown", { op });
    out[field] ??= [];
    out[field].push({ op, value });
  }
  return out;
}
```

### 9.3 Cursor pagination (HMAC)

```ts
type CursorPayload = {
  v: 1;                        // schema version
  k: { id: string; sort: string|number|null }; // last seen
  o: "asc"|"desc";
  f: string;                   // hash do filter set (detecta mudança)
};

function encodeCursor(p: CursorPayload, secret: string): string {
  const json   = JSON.stringify(p);
  const data   = Buffer.from(json).toString("base64url");
  const sig    = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function decodeCursor(token: string, secret: string): CursorPayload {
  const [data, sig] = token.split(".");
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    throw httpErr(400, "cursor_invalid_signature");
  const p = JSON.parse(Buffer.from(data, "base64url").toString("utf-8")) as CursorPayload;
  if (p.v !== 1) throw httpErr(400, "cursor_version_mismatch");
  return p;
}
```

Filter set hash (`f`) garante que mudar filter rejeita cursor antigo (evita janela inconsistente).

### 9.4 Performance

- `idx_crm_leads_org_pipeline_status` cobre o caso Kanban (filter pipeline+status).
- `idx_crm_leads_org_owner_status (partial open)` cobre "minha caixa".
- `idx_crm_leads_org_last_activity` cobre order desc.
- `idx_crm_leads_custom_fields_gin` cobre filter custom.
- Limit 200 hard-cap. Limit default 50.
- p95 alvo (PRD §4.1): <500ms até 1M leads/tenant. Validado por benchmark sintético em §12.

---

## 10. Eventos emitidos no `event_log`

Lista canônica gerada por triggers/serviços desta Spec. Workers (Spec 01 §event_log) consomem.

| Event | Disparado por | Payload |
|---|---|---|
| `contact.created` | `resolveContact` (ação `created`) | `{ contact_id, source }` |
| `contact.merge_pending` | `resolveContact` (ambíguo) | `{ queue_id, candidates[] }` |
| `contact.merged` | `mergeContacts` | `{ primary_id, loser_ids[], audit_id }` |
| `contact.blocked` | `is_blocked → true` | `{ contact_id, reason }` |
| `contact.consent_changed` | PATCH consent | `{ contact_id, category, granted_at, source }` |
| `lead.created` | trigger §3.3 | `{ lead_id, pipeline_id, stage_id, contact_id, source }` |
| `lead.stage_changed` | trigger §3.3 | `{ lead_id, from_stage_id, to_stage_id }` |
| `lead.won` | trigger §3.3 | `{ lead_id, status: 'won' }` |
| `lead.lost` | trigger §3.3 | `{ lead_id, lost_reason }` |
| `lead.reopened` | trigger §3.3 | `{ lead_id, previous_status }` |
| `lead.assigned` | trigger §3.3 | `{ lead_id, from_user_id, to_user_id }` |
| `lead_activity.recorded` | insert em `crm_lead_activities` | `{ lead_id, activity_id, type }` |
| `pipeline.vocabulary_changed` | UPDATE vocabulary | `{ pipeline_id, before, after }` |
| `pipeline.field_added` | UPDATE settings.fields | `{ pipeline_id, field_key, type }` |
| `pipeline.field_deprecated` | UPDATE field.deprecated=true | `{ pipeline_id, field_key }` |

---

## 11. Particionamento de `crm_lead_activities`

### 11.1 Estratégia

- **RANGE** em `performed_at` por mês (`YYYY_MM`).
- Partições criadas por job mensal (cron `partition-rotate`) **com 1 mês de antecedência**.
- Partição "default" recebe inserts fora do range esperado (alarme em Sentry se >0 linhas).

```sql
-- Exemplo de partição mensal
create table public.crm_lead_activities_2026_05
  partition of public.crm_lead_activities
  for values from ('2026-05-01 00:00:00+00') to ('2026-06-01 00:00:00+00');

-- Aplicar indexes via template
create index on public.crm_lead_activities_2026_05 (organization_id, lead_id, performed_at desc);
create index on public.crm_lead_activities_2026_05 (organization_id, type, performed_at desc);
create index on public.crm_lead_activities_2026_05 (organization_id, contact_id, performed_at desc);
create index on public.crm_lead_activities_2026_05 using gin (payload jsonb_path_ops);
```

### 11.2 Archive

- Aos **24 meses** de idade, partição é detached (`alter table ... detach partition`) e exportada pra cold storage S3 (parquet).
- Retenção legal LGPD: dados pessoais já anonimizados via redact; activities ficam comprimidas e read-only.
- Restore on-demand via `attach partition` em ambiente de auditoria isolado.

### 11.3 Quando ativar

MVP roda **sem partições mensais** (apenas a partição default). Ativação automática quando:
- Tabela ultrapassa 5M linhas, OU
- p95 de query timeline ultrapassa 200ms.

Ambos detectados em monitoring; runbook `docs/runbooks/activate-activity-partitioning.md`.

---

## 12. Plano de Validação (Testes)

### 12.1 Testes unitários (Vitest)

| Suite | Cobertura |
|---|---|
| `normalize.test.ts` | `normalizeE164` (BR + formato local + inválido), `isValidCpf` (dígito verificador), `hashCpf` determinístico, `isValidEmail` |
| `resolveContact.test.ts` | 4 ramos: matched, created, merge_pending, validações 422 |
| `mergeContacts.test.ts` | savepoint rollback, primary wins, tombstone, audit registrado |
| `buildSchema.test.ts` | gera Zod p/ todos os 10 tipos; rejeita key desconhecida com `strict()` |
| `cursor.test.ts` | encode/decode roundtrip; sig inválido → 400; version mismatch → 400 |
| `parseQueryFilters.test.ts` | parsing de notação `?campo[op]=valor`, ops válidos, custom_field[KEY] |

### 12.2 Testes de integração (Postgres real, branch ephemeral)

| Suite | Cobertura |
|---|---|
| `rls.contacts.test.ts` | tenant A não vê contacts de B; super-admin vê tudo |
| `rls.leads.test.ts` | idem leads; agent só edita próprios; manager deleta |
| `triggers.lead-close.test.ts` | mover pra is_won → status=won; reabrir → status=open |
| `triggers.lost-reason.test.ts` | sem reason → 22023; reason fora da whitelist → erro |
| `triggers.seed-pipeline.test.ts` | criar org → pipeline "Pedidos" + 8 stages |
| `merge.atomic.test.ts` | matar conexão no meio do merge → rollback completo, contacts intactos |
| `partitioning.test.ts` | insert em mês futuro vai pra default; alarme |

### 12.3 Testes E2E (Playwright + API)

- Pedido Nuvemshop simulado → resolveContact → lead criado → timeline com 1 activity `nuvemshop_order_created`.
- Mensagem WhatsApp → resolveContact → activity `whatsapp_inbound`.
- Drag-drop card pra stage `is_won` → lead.status=won; closed_at preenchido; evento emitido.
- Manager edita vocabulary; UI atualiza em <5s (Realtime).

### 12.4 Critérios de gating

PR não merge sem:
- 100% dos testes passando.
- Migration rodada em branch ephemeral sem warning de RLS desabilitada.
- Teste de isolamento cross-tenant explícito por nova tabela.
- Linter SQL custom (a escrever na Spec 01) sem erros.

---

## 13. Migrations Sequence

Ordem **canônica** (respeitando dependências de FK):

| # | Arquivo | Conteúdo |
|---|---|---|
| 020 | `2026XXXX_extensions.sql` | `pgcrypto`, `pg_trgm` (idempotente; presumida da Spec 01 — incluir se ausente) |
| 021 | `2026XXXX_helpers_midpoint_updated_at.sql` | `midpoint`, `fn_set_updated_at` (presumido da Spec 01) |
| 022 | `2026XXXX_contacts.sql` | tabela `contacts` + indexes + `decrypt_cpf` |
| 023 | `2026XXXX_crm_pipelines.sql` | tabela `crm_pipelines` |
| 024 | `2026XXXX_crm_stages.sql` | tabela `crm_stages` + uniques won/lost |
| 025 | `2026XXXX_crm_leads.sql` | tabela `crm_leads` + indexes |
| 026 | `2026XXXX_crm_lead_activities.sql` | tabela particionada + default partition + trigger validação |
| 027 | `2026XXXX_crm_lead_links.sql` | tabela `crm_lead_links` |
| 028 | `2026XXXX_merge_queue.sql` | tabela `merge_queue` |
| 029 | `2026XXXX_rls_policies.sql` | RLS em todas as 7 tabelas |
| 030 | `2026XXXX_triggers_close_on_stage.sql` | `fn_crm_lead_close_on_stage` |
| 031 | `2026XXXX_triggers_last_activity.sql` | `fn_update_last_activity_at` |
| 032 | `2026XXXX_triggers_emit_event.sql` | `fn_emit_event_on_lead_change` |
| 033 | `2026XXXX_triggers_seed_pipeline.sql` | `fn_seed_default_pipeline_for_org` |
| 034 | `2026XXXX_triggers_validate_lost_reason.sql` | `fn_validate_lost_reason_required` |
| 035 | `2026XXXX_grants_revoke_activity_writes.sql` | `revoke update, delete on crm_lead_activities` |

Cada migration é idempotente (`if not exists` onde possível) e tem rollback documentado em `docs/runbooks/migrations/02-customer-360-rollback.md`.

---

## Anexos

- `docs/research/reference-synthesis.md` — bundle herdado, especialmente §3 Data model.
- `docs/business-rules/00-business-rules-catalog.md` — regras P-01 a P-08, L-04, L-07, L-08.
- `docs/prd/02-prd-customer-360.md` — PRD pai.
- `docs/specs/01-spec-platform-base.md` — RLS, audit, event_log, helpers.
