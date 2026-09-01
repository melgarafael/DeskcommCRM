---
title: Spec Técnica 01 — Plataforma Base
parent: 01-prd-platform-base.md
version: 0.1
status: v0.1
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
regras_aplicadas: [T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, L-04, L-06, L-07, L-08, L-10, B-04]
---

# Spec Técnica 01 — Plataforma Base

> Spec foundational do SonghaiCRM. Define schema SQL completo, RLS policies, fluxos de auth, contratos de API REST `/api/v1/`, endpoints LGPD e onboarding de tenant. Toda spec posterior (Customer 360, WhatsApp, Pipeline, IA, Nuvemshop) **depende** desta. Divergências exigem ADR explícito.

---

## 1. Visão Geral & Objetivos

### 1.1 O que esta spec entrega

A Plataforma Base é a camada onde **identidade, tenancy, autorização, auditoria e LGPD** vivem. É invisível ao cliente final, mas governa todas as garantias do produto. Esta spec materializa o Sub-PRD 01 em:

1. **Schema SQL completo** (Postgres 15+ via Supabase) com todas as tabelas foundational, índices, constraints e triggers
2. **Templates de RLS policy canônicos** que serão reusados em todo subsistema
3. **Fluxos de auth detalhados** (login email+senha, MFA TOTP, Bearer token server-to-server, recovery codes)
4. **Matriz RBAC densa** com permissões por role × resource × ação
5. **Lista canônica de ~50 actions auditadas** com naming convention `{entity}.{action}`
6. **Contratos da API REST `/api/v1/`** — wrappers, paginação cursor HMAC-protected, idempotência, rate limit, error codes
7. **Endpoints LGPD** (`data-request`, `redact`) com cascade SQL e layout de export
8. **Onboarding de tenant** via CLI + UI super-admin
9. **Health check + observability hooks**
10. **Plano de validação** (testes E2E mínimos)
11. **Sequência de migrations**

### 1.2 Não-objetivos

- Modelagem de domínio (contacts, leads, pipelines) — vai pra Specs 02/04
- Webhooks externos (Nuvemshop, WAHA) — vai pras Specs 03/06
- UI completa do super-admin — esta spec define apenas as APIs e o contrato de auditoria
- Self-service signup público — fora do MVP

### 1.3 Restrições de stack (herdadas)

- **DB**: Supabase Postgres 15+, com extensions `pgcrypto`, `pgjwt`, `uuid-ossp`, `citext`
- **Auth**: Supabase Auth via `@supabase/ssr` (cookie SameSite=Strict, HttpOnly, Secure)
- **Backend**: Next.js 14+ App Router (Route Handlers + Server Actions)
- **Rate limit**: Upstash Redis sliding window com fallback in-memory
- **Observability**: Sentry com `beforeSend` sanitizer
- **Storage**: Supabase Storage (bucket privado, URLs assinadas)

### 1.4 Trade-offs estruturantes

| Decisão | Alternativa rejeitada | Justificativa |
|---|---|---|
| `platform_admins` como **tabela separada** | Coluna `is_platform_admin` em `auth.users` | Auth.users é gerenciada pelo Supabase; adicionar colunas é frágil entre upgrades. Tabela separada permite metadata rica (granted_by, granted_at, scope), audit trail próprio e revogação atômica. |
| RLS via helper `fn_user_org_ids()` retornando set | Subquery inline em cada policy | Helper centraliza a lógica; mudar tenancy (ex: roles por pipeline em fase futura) exige editar 1 função em vez de 50 policies. `STABLE` permite cache do plano. |
| Cursor opaco **HMAC-protected** | Cursor base64 cru (sem assinatura) | Cursor cru é mutável pelo cliente — vira vetor de IDOR. HMAC com `CURSOR_SIGNING_KEY` garante integridade; servidor rejeita cursors forjados em <1ms. |
| `api_audit_log` **append-only** (REVOKE UPDATE/DELETE) | Soft delete com flag `deleted_at` | Auditoria que pode ser editada não tem valor jurídico. Compliance LGPD/ANPD exige imutabilidade real. DBA com double-confirmation é a única exceção (raro: purga de PII coletada por bug). |
| API key **NUNCA** em query string | Aceitar como fallback | Query strings vazam em logs de Vercel/CloudFlare/proxies. Rejeitar com 400 explícito é mais seguro que aceitar silenciosamente. |
| Idempotency-Key com **TTL de 24h** | TTL infinito | Storage cresce indefinidamente; 24h cobre 99% dos retries de cliente; conflito após 24h é semanticamente uma operação nova. |
| `tenant_id` no JWT como **array de orgs do user** | Único `tenant_id` (último selecionado) | Operador BPO atende N tenants; carregar array no JWT evita roundtrip pra resolver permissões. RLS usa `IN` clause naturalmente. |

---

## 2. Schema SQL Completo (Postgres)

> Todas as tabelas vivem no schema `public` salvo indicação contrária. Extensions pré-requeridas: `pgcrypto`, `uuid-ossp`, `citext`. Convenção: nomes em `snake_case`, PKs `id uuid default gen_random_uuid()`, timestamps `created_at` / `updated_at` com default `now()` e trigger de touch.

### 2.0 Extensions e helpers utilitários

```sql
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";
create extension if not exists "citext";

-- Trigger de touch reusável
create or replace function public.fn_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
```

### 2.1 `organizations`

Tenant raiz. **Não** tem `organization_id` próprio (é a entidade que define o tenant).

```sql
create table public.organizations (
  id              uuid primary key default gen_random_uuid(),
  slug            citext not null unique,
  legal_name      text not null,
  display_name    text not null,
  cnpj            text unique, -- nullable pra tenants internos
  status          text not null default 'active'
                  check (status in ('active','suspended','redacted','archived')),
  timezone        text not null default 'America/Sao_Paulo',
  locale          text not null default 'pt-BR',
  rate_limit_rps  integer not null default 100, -- B-04
  ai_budget_cents bigint, -- nullable = ilimitado
  media_retention_days integer not null default 365, -- B-03
  settings        jsonb not null default '{}'::jsonb,
  -- LGPD/legal
  dpo_email       citext,
  privacy_policy_url text,
  -- Onboarding
  onboarded_at    timestamptz,
  suspended_at    timestamptz,
  redacted_at     timestamptz,
  -- Timestamps
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null
);

create trigger trg_organizations_touch
  before update on public.organizations
  for each row execute function public.fn_touch_updated_at();

comment on table public.organizations is 'Tenants do SonghaiCRM. Cada linha = 1 e-commerce cliente.';
comment on column public.organizations.cnpj is 'CNPJ formatado XX.XXX.XXX/XXXX-XX. Único por tenant ativo.';
comment on column public.organizations.status is 'active=operando | suspended=pausado por admin | redacted=LGPD store/redact aplicado | archived=cancelado.';
```

### 2.2 `user_organizations` (junção user × org × role)

Materializa a relação N:N entre usuários e tenants, carregando o role.

```sql
create table public.user_organizations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role            text not null
                  check (role in ('viewer','agent','manager','admin')),
  -- Para 'agent', restringe leads visíveis a owner_user_id = self quando aplicável
  invited_by      uuid references auth.users(id) on delete set null,
  invited_at      timestamptz,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, organization_id)
);

create trigger trg_user_orgs_touch
  before update on public.user_organizations
  for each row execute function public.fn_touch_updated_at();

create index idx_user_orgs_user      on public.user_organizations(user_id) where revoked_at is null;
create index idx_user_orgs_org_role  on public.user_organizations(organization_id, role) where revoked_at is null;

comment on column public.user_organizations.role is '4 roles canônicos: viewer (1) < agent (2) < manager (3) < admin (4). Hierarquia.';
```

### 2.3 `platform_admins` (tabela separada — decisão registrada)

> **Trade-off**: optei por **tabela separada** em vez de coluna `is_platform_admin` em `auth.users` por três razões: (1) `auth.users` é gerenciada pelo Supabase e mexer no schema dela é frágil entre upgrades; (2) tabela separada permite metadata rica (granted_by, granted_at, scope, mfa_required); (3) revogação fica atômica e auditada via `revoked_at`, sem alterar a row do user.

```sql
create table public.platform_admins (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  granted_by      uuid not null references auth.users(id) on delete restrict,
  granted_at      timestamptz not null default now(),
  scope           text not null default 'full'
                  check (scope in ('full','support_readonly')),
  mfa_required    boolean not null default true,
  reason          text not null, -- justificativa obrigatória
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users(id) on delete set null,
  revoke_reason   text
);

comment on table public.platform_admins is 'Super-admins que cruzam tenants. Modificação SOMENTE via DBA + double-confirmation. T-04.';
```

### 2.4 `api_tokens` (Bearer server-to-server)

Tokens API com hash SHA256, prefixo visível e escopos jsonb.

```sql
create table public.api_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by      uuid not null references auth.users(id) on delete restrict,
  name            text not null,
  prefix          text not null, -- ex: 'tok_live_a3f9' (mostrado na UI; primeiros 12 chars)
  token_hash      bytea not null, -- sha256(plaintext) — plaintext NUNCA volta após criação
  scopes          jsonb not null default '[]'::jsonb,
                  -- ex: ["leads:read","leads:write","contacts:read","lgpd:execute"]
  last_used_at    timestamptz,
  last_used_ip    inet,
  expires_at      timestamptz, -- nullable = não expira
  revoked_at      timestamptz,
  revoked_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, prefix)
);

create trigger trg_api_tokens_touch
  before update on public.api_tokens
  for each row execute function public.fn_touch_updated_at();

create index idx_api_tokens_hash on public.api_tokens(token_hash) where revoked_at is null;
create index idx_api_tokens_org  on public.api_tokens(organization_id) where revoked_at is null;

comment on table public.api_tokens is 'Bearer tokens. Plaintext mostrado UMA vez na criação; depois apenas hash. Prefix visível na UI.';
```

**Formato do plaintext**: `tok_<env>_<base62 random 32 chars>`. Ex: `tok_live_a3f9b2c4d5e6f7g8h9i0j1k2l3m4n5o6`. Os primeiros 12 chars (`tok_live_a3f9`) viram o `prefix`.

### 2.5 `api_audit_log` (append-only)

```sql
create table public.api_audit_log (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid references public.organizations(id) on delete set null,
  -- Quem
  actor_user_id           uuid references auth.users(id) on delete set null,
  actor_api_token_id      uuid references public.api_tokens(id) on delete set null,
  acting_as_platform_admin boolean not null default false,
  actor_ip                inet,
  actor_user_agent        text,
  -- O quê
  action                  text not null, -- ex: 'lead.created', 'token.revoked'
  resource_type           text,          -- ex: 'lead', 'api_token', 'contact'
  resource_id             uuid,
  -- Contexto
  request_id              text,          -- correlaciona com X-Request-Id
  bypassed_rls            boolean not null default false, -- T-02
  metadata                jsonb not null default '{}'::jsonb,
                          -- diff, params relevantes (sanitizados)
  -- Quando
  created_at              timestamptz not null default now()
);

create index idx_audit_org_time      on public.api_audit_log(organization_id, created_at desc);
create index idx_audit_actor_time    on public.api_audit_log(actor_user_id, created_at desc);
create index idx_audit_action_time   on public.api_audit_log(action, created_at desc);
create index idx_audit_resource      on public.api_audit_log(resource_type, resource_id);
create index idx_audit_request       on public.api_audit_log(request_id);

-- L-10: append-only. Revoga UPDATE/DELETE do role da app.
revoke update, delete on public.api_audit_log from authenticated, anon, service_role;
-- DBA com superuser pode editar manualmente (raro, double-confirmation)

comment on table public.api_audit_log is 'L-10: Append-only. Retenção 5 anos (90d hot + cold storage S3). Logging fire-and-forget.';
```

### 2.6 Indexes essenciais (resumo)

```sql
-- Organizations
create index idx_orgs_status on public.organizations(status) where status = 'active';
create index idx_orgs_slug   on public.organizations(slug);

-- User_organizations já criados em 2.2

-- API tokens já criados em 2.4

-- Audit log já criados em 2.5

-- Recovery codes (ver §4.5)
create index idx_recovery_user on public.user_recovery_codes(user_id) where used_at is null;

-- Idempotency keys (ver §7.3)
create index idx_idem_lookup on public.idempotency_keys(organization_id, key, endpoint);
create index idx_idem_expiry on public.idempotency_keys(expires_at);
```

### 2.7 Habilitar RLS + helpers canônicos

```sql
-- ============================================================
-- Helper 1: orgs do usuário corrente
-- ============================================================
create or replace function public.fn_user_org_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
  select organization_id
  from public.user_organizations
  where user_id = auth.uid()
    and revoked_at is null;
$$;

-- ============================================================
-- Helper 2: detecta super-admin de plataforma
-- ============================================================
create or replace function public.fn_is_platform_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
      and revoked_at is null
  );
$$;

-- ============================================================
-- Helper 3: role do usuário em uma org específica (hierárquico)
-- ============================================================
create or replace function public.fn_user_role_in_org(p_org uuid)
returns text
language sql stable
security definer
set search_path = public
as $$
  select role
  from public.user_organizations
  where user_id = auth.uid()
    and organization_id = p_org
    and revoked_at is null
  limit 1;
$$;

-- ============================================================
-- Helper 4: comparador hierárquico de role
-- ============================================================
create or replace function public.fn_role_at_least(p_org uuid, p_min text)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  with levels(role, lvl) as (
    values ('viewer',1),('agent',2),('manager',3),('admin',4)
  )
  select coalesce(
    (select user_lvl.lvl >= min_lvl.lvl
     from levels user_lvl
     join levels min_lvl on min_lvl.role = p_min
     where user_lvl.role = public.fn_user_role_in_org(p_org)),
    false
  );
$$;

-- ============================================================
-- Habilitar RLS nas tabelas tenant-aware desta spec
-- ============================================================
alter table public.organizations         enable row level security;
alter table public.user_organizations    enable row level security;
alter table public.api_tokens            enable row level security;
alter table public.api_audit_log         enable row level security;
alter table public.platform_admins       enable row level security;
```

---

## 3. Templates de RLS Policy (canônicos pra reuso)

> Esses 4 templates cobrem 95% dos casos. Toda spec posterior **deve referenciá-los** ao invés de reinventar. T-01 é hard constraint: nenhuma tabela tenant-aware merge sem 1 desses templates.

### 3.1 Template A — Isolamento simples por tenant (CRUD)

Aplicado a tabelas onde qualquer membro do tenant pode operar (sujeito a RBAC na API).

```sql
-- Template A: tenant_isolation_<tabela>_all
create policy "tenant_isolation_<tabela>_all" on public.<tabela>
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );
```

### 3.2 Template B — Read-write split (admin-only writes)

Pra tabelas onde leitura é geral mas escrita exige `manager+`.

```sql
-- SELECT: qualquer membro do tenant
create policy "<tabela>_select" on public.<tabela>
  for select
  using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

-- INSERT/UPDATE/DELETE: apenas manager+
create policy "<tabela>_write" on public.<tabela>
  for all
  using (
    public.fn_role_at_least(organization_id, 'manager')
    or public.fn_is_platform_admin()
  )
  with check (
    public.fn_role_at_least(organization_id, 'manager')
    or public.fn_is_platform_admin()
  );
```

### 3.3 Template C — Owner-scoped (agent só vê o que é seu)

Pra tabelas onde `agent` deve ver apenas linhas atribuídas a si (ex: leads). Combina com Template A pra `manager+`.

```sql
create policy "<tabela>_select_owner_or_manager" on public.<tabela>
  for select
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        public.fn_role_at_least(organization_id, 'manager')
        or owner_user_id = auth.uid()
      )
    )
  );
```

### 3.4 Template D — Append-only audit

Pra `api_audit_log` e similares.

```sql
-- SELECT: admin do tenant ou platform admin
create policy "audit_log_select" on public.api_audit_log
  for select
  using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
    )
  );

-- INSERT: qualquer service_role (handler) — outras roles via SECURITY DEFINER function
create policy "audit_log_insert_service" on public.api_audit_log
  for insert
  with check (true); -- inserção é controlada na camada de aplicação

-- UPDATE/DELETE: nenhuma policy. Permissão revogada explicitamente (§2.5).
```

### 3.5 Policies aplicadas nas tabelas desta spec

```sql
-- organizations: usuário lê suas orgs; só platform admin cria/edita/deleta
create policy "orgs_select" on public.organizations
  for select using (
    id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

create policy "orgs_write_platform_admin" on public.organizations
  for all using (public.fn_is_platform_admin())
  with check (public.fn_is_platform_admin());

-- user_organizations: usuário lê suas linhas; admin do tenant lê todas; admin escreve
create policy "user_orgs_select" on public.user_organizations
  for select using (
    user_id = auth.uid()
    or public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  );

create policy "user_orgs_write" on public.user_organizations
  for insert with check (
    public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  );

create policy "user_orgs_update" on public.user_organizations
  for update using (
    public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  );

create policy "user_orgs_delete" on public.user_organizations
  for delete using (
    public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  );

-- api_tokens: apenas admin do tenant ou platform admin
create policy "api_tokens_admin_only" on public.api_tokens
  for all using (
    public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  )
  with check (
    public.fn_role_at_least(organization_id, 'admin')
    or public.fn_is_platform_admin()
  );

-- platform_admins: apenas platform admins veem; modificação NÃO via API (T-04)
create policy "platform_admins_self" on public.platform_admins
  for select using (public.fn_is_platform_admin());
-- Nenhuma policy de INSERT/UPDATE/DELETE — bloqueio total via API

-- api_audit_log: usar Template D (já aplicado em §3.4)
```

---

## 4. Auth Flow Detalhado

### 4.1 Login com email + senha

```
┌──────────┐                ┌──────────────┐               ┌─────────────┐
│ Browser  │                │ Next.js (BFF)│               │  Supabase   │
└────┬─────┘                └──────┬───────┘               └──────┬──────┘
     │ POST /api/v1/auth/login     │                              │
     │ { email, password }         │                              │
     ├────────────────────────────▶│                              │
     │                             │ supabase.auth.               │
     │                             │   signInWithPassword()       │
     │                             ├─────────────────────────────▶│
     │                             │                              │
     │                             │   ◀──── { session, user } ───┤
     │                             │                              │
     │                             │ 1. Verifica `mfa_enrolled`   │
     │                             │ 2. Se admin sem MFA → exige  │
     │                             │    enrollment antes de logar │
     │                             │ 3. Carrega user_orgs +       │
     │                             │    is_platform_admin         │
     │                             │ 4. Emite cookie SameSite=    │
     │                             │    Strict, HttpOnly, Secure  │
     │                             │ 5. Loga `auth.login_success` │
     │                             │                              │
     │ ◀── 200 { user, orgs[] } ───┤                              │
     │     Set-Cookie: sb-access   │                              │
```

**Pseudocódigo do handler (TypeScript)**:

```ts
// app/api/v1/auth/login/route.ts
import { z } from 'zod';
import { createServerClient } from '@/lib/supabase/server';
import { audit } from '@/lib/audit';
import { jsonError, jsonOk } from '@/lib/api/wrapper';

const Body = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  mfa_code: z.string().regex(/^\d{6}$/).optional(),
});

export async function POST(req: Request) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return jsonError(422, 'validation_error', parsed.error.flatten());

  const sb = createServerClient();
  const { data, error } = await sb.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    await audit({
      action: 'auth.login_failed',
      metadata: { reason: error.message, email_hash: hashEmail(parsed.data.email) },
      requestId,
    });
    return jsonError(401, 'invalid_credentials', { message: 'Email ou senha incorretos' });
  }

  // Carrega contexto multi-tenant
  const orgs = await loadUserOrgs(data.user.id);
  const isPlatformAdmin = await checkPlatformAdmin(data.user.id);

  // L-04 / RBAC: força MFA pra admin/platform_admin
  const adminOrgs = orgs.filter(o => o.role === 'admin');
  const requiresMfa = adminOrgs.length > 0 || isPlatformAdmin;
  const mfaEnrolled = await isMfaEnrolled(data.user.id);

  if (requiresMfa && !mfaEnrolled) {
    return jsonError(403, 'mfa_enrollment_required', {
      enroll_url: '/api/v1/auth/mfa/enroll',
    });
  }

  if (requiresMfa && mfaEnrolled && !parsed.data.mfa_code) {
    return jsonError(401, 'mfa_required', { challenge: 'totp' });
  }

  if (requiresMfa && parsed.data.mfa_code) {
    const ok = await verifyTotp(data.user.id, parsed.data.mfa_code);
    if (!ok) {
      await audit({
        action: 'auth.mfa_failed',
        actorUserId: data.user.id,
        requestId,
      });
      return jsonError(401, 'mfa_invalid');
    }
  }

  await audit({
    action: 'auth.login_success',
    actorUserId: data.user.id,
    metadata: { is_platform_admin: isPlatformAdmin, orgs_count: orgs.length },
    requestId,
  });

  return jsonOk({
    user: { id: data.user.id, email: data.user.email },
    organizations: orgs,
    is_platform_admin: isPlatformAdmin,
  });
}
```

### 4.2 MFA TOTP enrollment + verify

**Enrollment**:

```
POST /api/v1/auth/mfa/enroll
→ Backend:
  1. supabase.auth.mfa.enroll({ factorType: 'totp' })
  2. Retorna { factor_id, qr_code (data:image/svg), uri (otpauth://...) }
  3. Frontend exibe QR; user escaneia; digita código de 6 dígitos
POST /api/v1/auth/mfa/verify { factor_id, code }
→ Backend:
  1. supabase.auth.mfa.challenge({ factorId })
  2. supabase.auth.mfa.verify({ factorId, challengeId, code })
  3. Se OK: gera 10 recovery codes (§4.5), persiste hashes em user_recovery_codes
  4. Audit `auth.mfa_enrolled`
  5. Retorna { recovery_codes: [...10] } — UMA ÚNICA VEZ
```

**Verify em login subsequente**: já mostrado em §4.1.

### 4.3 JWT claims structure

Supabase emite JWT default; estendemos com custom claims via Auth Hook (`auth.users.raw_app_meta_data`).

```json
{
  "iss": "https://<project>.supabase.co/auth/v1",
  "sub": "9c7f8a1e-3b2d-4a5c-9e7f-1a2b3c4d5e6f",
  "aud": "authenticated",
  "exp": 1745846400,
  "iat": 1745842800,
  "email": "operador@deskcomm.com.br",
  "role": "authenticated",
  "aal": "aal2",
  "amr": [{"method":"password","timestamp":1745842800},{"method":"totp","timestamp":1745842810}],
  "session_id": "abc123",
  "app_metadata": {
    "tenant_ids": [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    ],
    "is_platform_admin": false,
    "default_tenant_id": "11111111-1111-1111-1111-111111111111"
  },
  "user_metadata": {
    "full_name": "Maria Operadora"
  }
}
```

**Auth Hook que injeta claims** (Supabase Edge Function ou trigger):

```sql
create or replace function public.fn_jwt_custom_claims(uid uuid)
returns jsonb
language sql stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'tenant_ids', coalesce(
      (select jsonb_agg(organization_id)
       from public.user_organizations
       where user_id = uid and revoked_at is null),
      '[]'::jsonb
    ),
    'is_platform_admin', exists(
      select 1 from public.platform_admins
      where user_id = uid and revoked_at is null
    )
  );
$$;
```

### 4.4 Bearer token (server-to-server)

```
POST /api/v1/auth/tokens (admin-only)
Body: { name, scopes: ["leads:read","leads:write"], expires_at: "2026-12-31T00:00:00Z" }
→ Backend:
  1. Gera plaintext: `tok_live_${randomBase62(32)}`
  2. prefix = plaintext.slice(0, 12) // "tok_live_a3f9"
  3. token_hash = sha256(plaintext)
  4. INSERT INTO api_tokens (...)
  5. Audit `token.created`
  6. Retorna { id, prefix, plaintext, expires_at }  ← plaintext só aqui
  7. UI mostra plaintext UMA VEZ com botão copy + warning
```

**Validação de Bearer em request entrante**:

```ts
// middleware.ts
async function authenticateBearer(req: Request) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const plaintext = auth.slice(7);

  // 1. Rejeita se vier em query string (defense-in-depth)
  if (new URL(req.url).searchParams.get('api_key')) {
    throw new ApiError(400, 'auth_in_query_forbidden');
  }

  // 2. Hash + lookup
  const hash = sha256(plaintext);
  const { data: token } = await admin
    .from('api_tokens')
    .select('id, organization_id, scopes, expires_at, revoked_at')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();

  if (!token) throw new ApiError(401, 'token_invalid');
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    throw new ApiError(401, 'token_expired');
  }

  // 3. Atualiza last_used (fire-and-forget)
  void admin.from('api_tokens').update({
    last_used_at: new Date().toISOString(),
    last_used_ip: getIp(req),
  }).eq('id', token.id);

  return {
    organizationId: token.organization_id,
    scopes: token.scopes as string[],
    tokenId: token.id,
  };
}
```

### 4.5 Recovery codes

Gerados na ativação de MFA. 10 códigos de 8 chars alfanuméricos. Cada um uso único.

```sql
create table public.user_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code_hash   bytea not null, -- sha256
  used_at     timestamptz,
  used_ip     inet,
  created_at  timestamptz not null default now()
);

create unique index idx_recovery_unique on public.user_recovery_codes(user_id, code_hash);
```

**Uso**: `POST /api/v1/auth/recovery { email, code }` → valida hash, marca `used_at`, emite token de single-sign + força regeneração de TOTP.

---

## 5. RBAC: matriz de permissões

| Resource | Ação | viewer | agent | manager | admin | platform_admin |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **organizations** | read (self) | ✅ | ✅ | ✅ | ✅ | ✅ |
| organizations | update | ❌ | ❌ | ❌ | ✅ (settings) | ✅ |
| organizations | delete/archive | ❌ | ❌ | ❌ | ❌ | ✅ |
| **user_organizations** | read | ❌ | ❌ | ✅ (own org) | ✅ | ✅ |
| user_organizations | invite/role change | ❌ | ❌ | ❌ | ✅ | ✅ |
| user_organizations | revoke | ❌ | ❌ | ❌ | ✅ | ✅ |
| **api_tokens** | list | ❌ | ❌ | ❌ | ✅ | ✅ |
| api_tokens | create | ❌ | ❌ | ❌ | ✅ | ✅ |
| api_tokens | revoke | ❌ | ❌ | ❌ | ✅ | ✅ |
| **leads** (Spec 02/04) | read | ✅ (all) | ✅ (own) | ✅ (all) | ✅ | ✅ |
| leads | create | ❌ | ✅ | ✅ | ✅ | ✅ |
| leads | update | ❌ | ✅ (own) | ✅ | ✅ | ✅ |
| leads | delete | ❌ | ❌ | ✅ | ✅ | ✅ |
| leads | reassign | ❌ | ❌ | ✅ | ✅ | ✅ |
| **pipelines** | read | ✅ | ✅ | ✅ | ✅ | ✅ |
| pipelines | create/update | ❌ | ❌ | ✅ | ✅ | ✅ |
| pipelines | delete | ❌ | ❌ | ❌ | ✅ | ✅ |
| **stages** | read | ✅ | ✅ | ✅ | ✅ | ✅ |
| stages | mutate | ❌ | ❌ | ✅ | ✅ | ✅ |
| **contacts** | read | ✅ | ✅ | ✅ | ✅ | ✅ |
| contacts | create/update | ❌ | ✅ | ✅ | ✅ | ✅ |
| contacts | delete | ❌ | ❌ | ✅ | ✅ | ✅ |
| contacts.consent | update | ❌ | ✅ | ✅ | ✅ | ✅ |
| **conversations** | read | ✅ | ✅ (own claim) | ✅ | ✅ | ✅ |
| conversations | claim | ❌ | ✅ | ✅ | ✅ | ✅ |
| conversations | reassign | ❌ | ❌ | ✅ | ✅ | ✅ |
| conversations | observe (read-only) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **messages** | send | ❌ | ✅ (own claim) | ✅ | ✅ | ✅ |
| **audit_log** | read | ❌ | ❌ | ❌ | ✅ | ✅ |
| **lgpd.data_request** | execute | ❌ | ❌ | ❌ | ✅ | ✅ |
| **lgpd.redact** | execute | ❌ | ❌ | ❌ | ✅ | ✅ |
| **webhooks** (Spec 06) | manage | ❌ | ❌ | ❌ | ✅ | ✅ |
| **platform_admins** | read | ❌ | ❌ | ❌ | ❌ | ✅ |
| platform_admins | mutate | ❌ | ❌ | ❌ | ❌ | ❌ (DBA only) |

**Implementação**: middleware `requirePermission(resource, action)` checa role via `fn_user_role_in_org(orgId)` + `fn_is_platform_admin()`. Falha → 403 com `error.code='forbidden_role'`.

---

## 6. Audit log: lista canônica de actions

**Convenção**: `{entity}.{action}` snake_case. Tense passado ou perfeito (`created`, `revoked`, `failed`). Verbos consistentes: `created`, `updated`, `deleted`, `revoked`, `failed`, `success`, `triggered`, `executed`, `received`, `delivered`, `viewed`, `exported`, `assigned`, `unassigned`, `changed`.

### 6.1 Auth (`auth.*`)
- `auth.login_success`
- `auth.login_failed`
- `auth.logout`
- `auth.mfa_enrolled`
- `auth.mfa_failed`
- `auth.mfa_disabled`
- `auth.password_changed`
- `auth.password_reset_requested`
- `auth.password_reset_completed`
- `auth.recovery_code_used`

### 6.2 Tokens (`token.*`)
- `token.created`
- `token.revoked`
- `token.expired`
- `token.used` *(amostragem 1/100; full pra escopo `lgpd:execute`)*

### 6.3 Tenancy (`org.*`, `member.*`, `platform_admin.*`)
- `org.created`
- `org.updated`
- `org.suspended`
- `org.reactivated`
- `org.archived`
- `org.redacted` *(L-01 cascade store/redact)*
- `member.invited`
- `member.accepted`
- `member.role_changed`
- `member.revoked`
- `platform_admin.granted`
- `platform_admin.revoked`

### 6.4 Lead/Pipeline (`lead.*`, `pipeline.*`, `stage.*`)
- `lead.created`
- `lead.updated`
- `lead.deleted`
- `lead.assigned`
- `lead.unassigned`
- `lead.stage_changed`
- `lead.won`
- `lead.lost`
- `lead.reopened`
- `pipeline.created`
- `pipeline.updated`
- `pipeline.deleted`
- `pipeline.duplicated`
- `stage.created`
- `stage.updated`
- `stage.deleted`

### 6.5 Conversation/Message (`conversation.*`, `message.*`)
- `conversation.claimed`
- `conversation.reassigned`
- `conversation.resolved`
- `conversation.reopened`
- `conversation.observed_by_supervisor`
- `message.sent`
- `message.failed`
- `message.received`

### 6.6 Contact + LGPD (`contact.*`, `consent.*`, `lgpd.*`)
- `contact.created`
- `contact.updated`
- `contact.deleted`
- `contact.blocked`
- `contact.unblocked`
- `consent.granted`
- `consent.revoked`
- `consent.changed`
- `lgpd.data_request_received`
- `lgpd.export_generated`
- `lgpd.export_delivered`
- `lgpd.redact_requested`
- `lgpd.redact_executed`
- `lgpd.redact_failed`

### 6.7 Webhooks/Integrações (`webhook.*`, `integration.*`)
- `webhook.received`
- `webhook.delivery_attempted`
- `webhook.delivery_failed`
- `webhook.subscription_disabled`
- `integration.connected`
- `integration.disconnected`
- `integration.token_refreshed`

### 6.8 Sistema (`system.*`)
- `system.rls_bypassed` *(T-02 — sempre logado)*
- `system.rate_limit_exceeded`
- `system.idempotency_conflict`

**Total: ~58 actions canônicas**. Lista versionada em `lib/audit/actions.ts` como union type TypeScript:

```ts
export type AuditAction =
  | 'auth.login_success' | 'auth.login_failed' | /* ... */
  | 'token.created' | 'token.revoked' | /* ... */;
```

---

## 7. API REST canônica `/api/v1/`

### 7.1 Wrapper de sucesso/erro (TypeScript)

```ts
// lib/api/types.ts
export type ApiSuccess<T> = {
  data: T;
  meta?: {
    cursor?: string | null;
    has_more?: boolean;
    total?: number;
    request_id: string;
  };
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id: string;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// lib/api/wrapper.ts
export function jsonOk<T>(data: T, meta?: Partial<ApiSuccess<T>['meta']>) {
  const requestId = getRequestId();
  return Response.json(
    { data, meta: { ...meta, request_id: requestId } },
    {
      headers: {
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store',
      },
    }
  );
}

export function jsonError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
  message?: string
) {
  const requestId = getRequestId();
  return Response.json(
    { error: { code, message: message ?? defaultMessage(code), details, request_id: requestId } },
    { status, headers: { 'X-Request-Id': requestId } }
  );
}
```

### 7.2 Paginação cursor (HMAC-protected)

**Algoritmo**:

```ts
// lib/api/cursor.ts
import { createHmac, timingSafeEqual } from 'crypto';

const KEY = process.env.CURSOR_SIGNING_KEY!; // 32+ bytes random
const SEP = '|';

type CursorPayload = {
  o: string;      // organization_id
  t: string;      // table name
  k: Record<string, string | number>; // key tuple (e.g. { created_at, id })
  d: 'asc' | 'desc';
};

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const sig = createHmac('sha256', KEY).update(json).digest('base64url');
  return Buffer.from(json).toString('base64url') + SEP + sig;
}

export function decodeCursor(cursor: string, expectedOrg: string): CursorPayload {
  const [b64, sig] = cursor.split(SEP);
  if (!b64 || !sig) throw new ApiError(400, 'cursor_malformed');

  const json = Buffer.from(b64, 'base64url').toString('utf8');
  const expected = createHmac('sha256', KEY).update(json).digest('base64url');

  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new ApiError(400, 'cursor_invalid_signature');
  }

  const payload = JSON.parse(json) as CursorPayload;
  if (payload.o !== expectedOrg) {
    throw new ApiError(400, 'cursor_tenant_mismatch');
  }
  return payload;
}
```

**Uso em endpoint** (ex: list leads):

```ts
// GET /api/v1/leads?limit=50&cursor=...
const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
const cursor = searchParams.get('cursor');
const where: any[] = [['organization_id', '=', orgId]];

if (cursor) {
  const c = decodeCursor(cursor, orgId);
  // keyset: WHERE (created_at, id) < (c.k.created_at, c.k.id)
  where.push(['(created_at, id)', '<', [c.k.created_at, c.k.id]]);
}

const rows = await db.select(...).order('created_at desc, id desc').limit(limit + 1);
const hasMore = rows.length > limit;
const data = rows.slice(0, limit);
const nextCursor = hasMore
  ? encodeCursor({ o: orgId, t: 'leads', k: { created_at: data.at(-1)!.created_at, id: data.at(-1)!.id }, d: 'desc' })
  : null;

return jsonOk(data, { cursor: nextCursor, has_more: hasMore });
```

### 7.3 Idempotency-Key flow

```sql
create table public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key             text not null,
  endpoint        text not null, -- ex: 'POST /api/v1/leads'
  request_hash    bytea not null, -- sha256 do body normalizado
  status_code     integer not null,
  response_body   jsonb not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  unique (organization_id, key, endpoint)
);
```

**Algoritmo**:

```ts
async function withIdempotency<T>(
  req: Request,
  orgId: string,
  endpoint: string,
  handler: () => Promise<{ status: number; body: T }>
) {
  const key = req.headers.get('idempotency-key');
  if (!key) return handler();

  const body = await req.clone().text();
  const requestHash = sha256(body);

  // Lookup
  const existing = await db
    .from('idempotency_keys')
    .select('*')
    .eq('organization_id', orgId)
    .eq('key', key)
    .eq('endpoint', endpoint)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (existing.data) {
    if (!constantTimeEq(existing.data.request_hash, requestHash)) {
      throw new ApiError(409, 'idempotency_conflict', {
        message: 'Idempotency-Key reused with different body',
      });
    }
    return new Response(JSON.stringify(existing.data.response_body), {
      status: existing.data.status_code,
      headers: { 'X-Idempotent-Replay': 'true' },
    });
  }

  // Execute + persist
  const result = await handler();
  await db.from('idempotency_keys').insert({
    organization_id: orgId,
    key,
    endpoint,
    request_hash: requestHash,
    status_code: result.status,
    response_body: result.body,
  });
  return result;
}
```

**Cron de limpeza**: `DELETE FROM idempotency_keys WHERE expires_at < now()` diário.

### 7.4 Rate limit (Upstash Redis sliding window com fallback)

```ts
// lib/rate-limit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

let limiter: Ratelimit | null = null;
const inMemoryFallback = new Map<string, { count: number; resetAt: number }>();

if (process.env.UPSTASH_REDIS_REST_URL) {
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(100, '1 s'), // B-04: 100 RPS default
    analytics: true,
    prefix: 'deskcomm:rl',
  });
}

export async function checkRateLimit(orgId: string, customRps?: number) {
  const key = `org:${orgId}`;
  if (limiter) {
    const r = await limiter.limit(key);
    return {
      success: r.success,
      remaining: r.remaining,
      reset: r.reset,
      limit: r.limit,
    };
  }

  // Fallback in-memory (dev / Redis offline)
  const now = Date.now();
  const entry = inMemoryFallback.get(key) ?? { count: 0, resetAt: now + 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 1000;
  }
  entry.count++;
  inMemoryFallback.set(key, entry);
  const limit = customRps ?? 100;
  return {
    success: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    reset: entry.resetAt,
    limit,
  };
}

// Middleware
export async function rateLimitMiddleware(req: Request, orgId: string) {
  const r = await checkRateLimit(orgId);
  const headers = {
    'X-RateLimit-Limit': r.limit.toString(),
    'X-RateLimit-Remaining': r.remaining.toString(),
    'X-RateLimit-Reset': r.reset.toString(),
  };
  if (!r.success) {
    return new Response(
      JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests' } }),
      { status: 429, headers: { ...headers, 'Retry-After': '1' } }
    );
  }
  return null; // continue
}
```

### 7.5 Error codes canônicos

| Code | HTTP | Quando |
|---|:---:|---|
| `validation_error` | 422 | Zod schema falhou |
| `body_malformed` | 400 | JSON inválido |
| `auth_required` | 401 | Sem cookie/Bearer |
| `auth_in_query_forbidden` | 400 | API key em query string |
| `token_invalid` | 401 | Hash não bate |
| `token_expired` | 401 | `expires_at < now()` |
| `token_revoked` | 401 | `revoked_at IS NOT NULL` |
| `mfa_required` | 401 | Login admin sem `mfa_code` |
| `mfa_invalid` | 401 | TOTP não confere |
| `mfa_enrollment_required` | 403 | Admin sem MFA enrolado |
| `forbidden_role` | 403 | Role insuficiente |
| `tenant_not_found` | 404 | Org inexistente ou não acessível |
| `resource_not_found` | 404 | UUID não encontrado |
| `idempotency_conflict` | 409 | Mesma key, body diferente |
| `tenant_already_exists` | 409 | CNPJ duplicado |
| `cursor_malformed` | 400 | Cursor estrutura inválida |
| `cursor_invalid_signature` | 400 | HMAC não bate (tampering) |
| `cursor_tenant_mismatch` | 400 | Cursor de outro tenant |
| `rate_limited` | 429 | Janela excedida |
| `lgpd_anonymization_irreversible` | 403 | Tentativa de update em contact anonimizado (L-04) |
| `lgpd_in_progress` | 409 | Outro redact pra mesmo contact em execução |
| `conversation_already_claimed` | 409 | Conversation já tem `assigned_to` quando outro usuário tenta claim atômico (AT-02) |
| `pipeline_immutable_use_clone` | 422 | Tentativa de mover lead pra outro pipeline (P-01) |
| `lost_reason_required` | 422 | Lead → status `lost` sem `lost_reason` (P-03) |
| `lost_reason_invalid` | 422 | `lost_reason` fora da lista canônica (P-03) |
| `phone_must_be_e164` | 422 | Telefone fora do formato `+\d{8,15}` |
| `merge_irreversible` | 405 | Tentativa de desfazer merge de contacts (Sub-PRD 02 §3.4) |
| `internal_error` | 500 | Catch-all, sempre logado em Sentry |

> **Nota canônica (RECONCILIATION-LOG)**: a única forma autorizada pra "sem credencial válida" é `auth_required` (401). Sinônimos como `unauthenticated` ou `not_authenticated` que possam aparecer em specs anteriores são informais — sempre usar `auth_required`.

### 7.6 Request ID propagation

Toda request entra com (ou ganha) `X-Request-Id`:

```ts
// middleware.ts
export function middleware(req: NextRequest) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const res = NextResponse.next();
  res.headers.set('x-request-id', requestId);
  // injeta em AsyncLocalStorage pra ficar acessível em handlers/audit
  requestContext.enterWith({ requestId });
  return res;
}
```

Audit log persiste o `request_id`; cliente pode citar em ticket de suporte → DBA correlaciona em <1 minuto.

---

## 8. LGPD endpoints

### 8.1 `POST /api/v1/lgpd/data-request`

**Payload**:

```json
{
  "subject": {
    "contact_id": "11111111-...",
    "_or_email": "cliente@example.com",
    "_or_phone": "+5511999999999",
    "_or_cpf": "123.456.789-00"
  },
  "delivery": {
    "method": "email",
    "address": "cliente@example.com"
  },
  "reason": "data_subject_request",
  "external_reference": "nuvemshop_webhook_xyz"
}
```

**Response (síncrono, dispara worker async)**:

```json
{
  "data": {
    "request_id": "req_22222222-...",
    "status": "queued",
    "sla_due_at": "2026-05-05T17:00:00-03:00"
  },
  "meta": { "request_id": "..." }
}
```

**Worker async** (Inngest / pg_boss):

```ts
// workers/lgpd-data-request.ts
export const handler = async (job: { request_id: string }) => {
  const req = await db.from('lgpd_requests').select('*').eq('id', job.request_id).single();

  // 1. Resolve contact
  const contact = await resolveContact(req.subject);

  // 2. Coleta dados de TODAS tabelas tenant-aware (lista canônica abaixo)
  const data = {
    contact: contact,
    conversations: await db.select().from('conversations').eq('contact_id', contact.id),
    messages: await db.select().from('messages').in('conversation_id', conversationIds),
    activities: await db.select().from('crm_lead_activities').filter(...),
    leads: await db.select().from('crm_leads').filter(...),
    orders: await db.select().from('orders').eq('contact_id', contact.id),
    consents: contact.consent,
    audit_log: await db.select().from('api_audit_log').eq('resource_id', contact.id),
  };

  // 3. Gera JSON estruturado
  const json = JSON.stringify(data, null, 2);
  const jsonUrl = await uploadToStorage(`lgpd-exports/${req.id}/data.json`, json);

  // 4. Gera PDF assinado (puppeteer / react-pdf)
  const pdf = await renderLgpdPdf(data);
  const pdfUrl = await uploadToStorage(`lgpd-exports/${req.id}/report.pdf`, pdf);

  // 5. Entrega
  await sendEmailWithSignedUrls(req.delivery.address, [jsonUrl, pdfUrl]);

  // 6. Audit
  await audit({
    action: 'lgpd.export_delivered',
    organizationId: req.organization_id,
    resourceType: 'contact',
    resourceId: contact.id,
    metadata: { request_id: req.id, delivery: req.delivery.method },
  });
};
```

### 8.2 `POST /api/v1/lgpd/redact`

**Payload**:

```json
{
  "subject": { "contact_id": "11111111-..." },
  "mode": "anonymize",
  "reason": "data_subject_request",
  "approved_by": "user_id_admin",
  "external_reference": "nuvemshop_redact_xyz"
}
```

**Cascade SQL** (executado em transação pelo worker):

```sql
-- Nota: roda como service_role com `bypassed_rls=true` no audit
begin;

-- 1. Anonimiza o contact (L-04: irreversível)
update public.contacts
set
  full_name      = 'Cliente Anonimizado #' || substr(id::text, 1, 8),
  email          = null,
  phone_number   = null,
  cpf_encrypted  = null,
  is_anonymized  = true,
  anonymized_at  = now(),
  consent        = '{}'::jsonb,
  metadata       = jsonb_build_object('anonymization_request_id', :req_id)
where id = :contact_id and organization_id = :org_id;

-- 2. Conversations: preserva timeline, mas remove dados pessoais em metadata
update public.conversations
set metadata = metadata - 'contact_full_name' - 'contact_phone'
where contact_id = :contact_id;

-- 3. Messages: remove mídia do storage (em worker separado), limpa campos sensíveis
update public.messages
set
  body_text    = case
                   when type='text' then '[mensagem anonimizada]'
                   else body_text
                 end,
  media_url    = null,
  media_thumb  = null,
  metadata     = metadata - 'sender_name' - 'sender_phone'
where conversation_id in (
  select id from public.conversations where contact_id = :contact_id
);

-- 4. Activities: preserva timestamp/type/lead linkage; limpa metadata sensível
update public.crm_lead_activities
set metadata = metadata - 'contact_full_name' - 'contact_phone' - 'contact_email' - 'cpf'
where lead_id in (
  select id from public.crm_leads where contact_id = :contact_id
);

-- 5. Audit final (NÃO toca em api_audit_log — é append-only)
insert into public.api_audit_log (organization_id, action, resource_type, resource_id, actor_user_id, metadata)
values (:org_id, 'lgpd.redact_executed', 'contact', :contact_id, :approved_by,
        jsonb_build_object(
          'mode','anonymize',
          'cascaded_to', jsonb_build_object(
            'conversations', :conv_count,
            'messages', :msg_count,
            'activities', :act_count
          ),
          'request_id', :req_id
        ));

commit;
```

**Worker pós-transação**:
- Deleta arquivos de mídia do bucket Storage (loop sobre `media_url` antigos)
- Marca request como `done`

### 8.3 Layout do export (JSON + PDF)

**JSON** (estrutura canônica):

```json
{
  "export_metadata": {
    "request_id": "req_22222222-...",
    "generated_at": "2026-05-02T14:30:00-03:00",
    "data_subject": {
      "contact_id": "11111111-...",
      "matched_by": "email"
    },
    "tenant": {
      "id": "...",
      "legal_name": "Loja Exemplo LTDA",
      "cnpj": "12.345.678/0001-90"
    },
    "scope": [
      "contacts","conversations","messages","activities","leads","orders","consents","audit_log"
    ],
    "lgpd_basis": "Art. 18, II — confirmação de tratamento e acesso aos dados"
  },
  "contact": { /* registro completo */ },
  "consents": [ /* histórico */ ],
  "conversations": [ /* com mensagens nested */ ],
  "leads_and_orders": [ /* ... */ ],
  "audit_log_extract": [ /* eventos onde resource_id == contact_id */ ]
}
```

**PDF** (gerado via `@react-pdf/renderer`):
- Capa: nome do tenant, CNPJ, DPO email, request_id, data
- Sumário executivo: contagem por categoria
- Seções: dados pessoais, consentimentos, histórico de conversas (resumo + 100 mensagens mais recentes), pedidos, log de auditoria
- Rodapé assinado: hash SHA256 do PDF + URL pública assinada (verificável)

---

## 9. Onboarding de tenant (CLI + UI super-admin)

### 9.1 CLI

```bash
$ deskcomm tenant create \
    --legal-name "Loja Exemplo LTDA" \
    --display-name "Loja Exemplo" \
    --cnpj "12345678000190" \
    --slug "loja-exemplo" \
    --admin-email "lojista@exemplo.com" \
    --timezone "America/Sao_Paulo"

[1/5] Validando inputs...                 ok
[2/5] Criando organization...             ok (id=33333333-...)
[3/5] Seed pipeline default (T-06)...    ok (7 stages)
[4/5] Convidando admin (link 24h)...     ok (sent to lojista@exemplo.com)
[5/5] Audit + verificação pós-criação... ok

Tenant criado:
  ID:    33333333-3333-3333-3333-333333333333
  Slug:  loja-exemplo
  URL:   https://loja-exemplo.deskcomm.com (DNS pending)
  Admin invite: https://app.deskcomm.com/invite/<jwt-1h>

Próximos passos:
  - Admin completa MFA enrollment
  - Conectar Nuvemshop (OAuth) — Sub-PRD 06
  - Conectar WhatsApp (QR) — Sub-PRD 03
```

**Implementação**: script Node em `scripts/tenant-create.ts` que chama API interna `POST /api/v1/admin/organizations` (autenticado com chave de admin de plataforma).

### 9.2 UI super-admin

Wizard em `https://admin.deskcomm.com/tenants/new` com mesma sequência:
1. **Identidade**: legal_name, display_name, CNPJ, slug
2. **Configurações**: timezone, locale, rate_limit_rps, ai_budget_cents
3. **Admin inicial**: email + nome (gera invite link)
4. **Confirmação**: preview + botão "Criar tenant"

Pós-criação, redireciona pra detalhe do tenant com checklist:
- [x] Pipeline default seedado
- [ ] Admin aceitou convite
- [ ] Nuvemshop conectado
- [ ] WhatsApp conectado
- [ ] Primeiro lead criado

### 9.3 Trigger de seed (T-06)

```sql
create or replace function public.fn_seed_default_pipeline_for_org()
returns trigger language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
begin
  insert into public.crm_pipelines (organization_id, name, vocabulary, settings)
  values (new.id, 'Pedidos',
          jsonb_build_object('lead','Cliente','deal','Pedido','won','Pago','lost','Cancelado'),
          '{}'::jsonb)
  returning id into v_pipeline_id;

  insert into public.crm_stages (organization_id, pipeline_id, name, position, is_won, is_lost)
  values
    (new.id, v_pipeline_id, 'Carrinho abandonado', 1, false, false),
    (new.id, v_pipeline_id, 'Aguardando pagamento', 2, false, false),
    (new.id, v_pipeline_id, 'Pago', 3, false, false),
    (new.id, v_pipeline_id, 'Em separação', 4, false, false),
    (new.id, v_pipeline_id, 'Enviado', 5, false, false),
    (new.id, v_pipeline_id, 'Entregue', 6, true, false),
    (new.id, v_pipeline_id, 'Pós-venda', 7, false, false);

  return new;
end $$;

create trigger trg_seed_pipeline_after_org_insert
  after insert on public.organizations
  for each row execute function public.fn_seed_default_pipeline_for_org();
```

> Nota: a Spec 04 (Pipeline) aprofundará `crm_pipelines`/`crm_stages`. Esta spec apenas garante o seed e referencia.

---

## 10. Health check `/api/v1/health`

```ts
// app/api/v1/health/route.ts
export async function GET() {
  const checks = await Promise.allSettled([
    pingSupabase(),
    pingRedis(),
    pingWaha(),
  ]);

  const status = checks.every(c => c.status === 'fulfilled' && c.value.ok)
    ? 'ok'
    : 'degraded';

  return Response.json({
    data: {
      status,
      version: process.env.APP_VERSION ?? 'dev',
      timestamp: new Date().toISOString(),
      dependencies: {
        supabase:  detail(checks[0]),
        redis:     detail(checks[1]),
        waha:      detail(checks[2]),
      },
    },
  }, {
    status: status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
```

**Sem auth** (T-03 exceção). Sem RLS dependency. UptimeRobot + Sentry Cron monitoram.

---

## 11. Observability hooks

### 11.1 Sentry

```ts
// instrumentation.ts (Next.js)
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  beforeSend(event) {
    // Sanitiza headers/cookies/body
    if (event.request?.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
      delete event.request.headers['x-api-key'];
    }
    if (event.request?.data && typeof event.request.data === 'string') {
      event.request.data = event.request.data
        .replace(/"password"\s*:\s*"[^"]+"/g, '"password":"[REDACTED]"')
        .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '***.***.***-**'); // L-08
    }
    return event;
  },
});
```

### 11.2 Structured logs

```ts
// lib/logger.ts
import pino from 'pino';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'deskcomm-api', env: process.env.NODE_ENV },
  redact: {
    paths: ['*.password','*.token','*.api_key','*.cookie','*.cpf','req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

// Toda log carrega organization_id (T-08)
export function logWithCtx(orgId: string, requestId: string) {
  return log.child({ organization_id: orgId, request_id: requestId });
}
```

### 11.3 Métricas custom

Emitidas via OpenTelemetry → Vercel Observability ou Grafana Cloud:

| Métrica | Tipo | Tags |
|---|---|---|
| `api.request.count` | counter | route, status, org_id |
| `api.request.duration_ms` | histogram | route, status, org_id |
| `auth.login.count` | counter | result, mfa, org_id |
| `audit.write.lag_ms` | histogram | action |
| `rls.bypassed.count` | counter | reason, org_id |
| `lgpd.export.duration_s` | histogram | scope_size, org_id |
| `rate_limit.exceeded.count` | counter | org_id |
| `idempotency.replay.count` | counter | endpoint |

---

## 12. Plano de validação (testes E2E mínimos)

A spec é considerada **implementada** quando todos os testes abaixo passam no CI.

### 12.1 Testes de RLS (cross-tenant isolation)

```ts
// tests/rls/isolation.test.ts
describe('RLS — Tenant isolation (T-01)', () => {
  let orgA: string, orgB: string, userA: string, userB: string;

  beforeAll(async () => {
    orgA = await createTenant({ slug: 'org-a' });
    orgB = await createTenant({ slug: 'org-b' });
    userA = await createUser({ email: 'a@test.com', orgs: [{ id: orgA, role: 'admin' }] });
    userB = await createUser({ email: 'b@test.com', orgs: [{ id: orgB, role: 'admin' }] });
  });

  it('user A não consegue ler organizations do user B', async () => {
    const sb = clientAs(userA);
    const { data } = await sb.from('organizations').select('*').eq('id', orgB);
    expect(data).toEqual([]);
  });

  it('user A não consegue listar api_tokens do user B', async () => {
    await createToken(orgB, { name: 'B token' });
    const sb = clientAs(userA);
    const { data } = await sb.from('api_tokens').select('*');
    expect(data?.every(t => t.organization_id === orgA)).toBe(true);
  });

  it('user A não consegue ler user_organizations do user B', async () => {
    const sb = clientAs(userA);
    const { data } = await sb.from('user_organizations').select('*').eq('user_id', userB);
    expect(data).toEqual([]);
  });

  it('platform admin lê tudo', async () => {
    const padmin = await createPlatformAdmin();
    const sb = clientAs(padmin);
    const { data } = await sb.from('organizations').select('*');
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });
});
```

### 12.2 Testes de auth flow

- Login com email+senha válido → 200 + cookie set
- Login com senha errada → 401 `invalid_credentials`
- Login admin sem MFA → 403 `mfa_enrollment_required`
- Login admin com MFA enrolado e código válido → 200
- Login admin com MFA + código errado → 401 `mfa_invalid`
- Recovery code usado uma vez → ok; usar de novo → 401
- Bearer token revogado → 401 `token_revoked`
- API key em query string → 400 `auth_in_query_forbidden`

### 12.3 Testes de RBAC

- Viewer cria lead → 403 `forbidden_role`
- Agent edita lead que não é seu → 403
- Manager deleta lead → 200 + audit `lead.deleted`
- Admin cria api_token → 200 + audit `token.created`
- Manager tenta criar api_token → 403

### 12.4 Testes de audit log

- Toda mutação POST/PATCH/DELETE produz 1 entrada em ≤500ms p99
- Tentativa de UPDATE em `api_audit_log` via API → 405
- Tentativa de DELETE → 405
- Audit log filtrável por (actor, action, resource, date_range)

### 12.5 Testes de paginação cursor

- Cursor válido → próxima página
- Cursor com signature alterada → 400 `cursor_invalid_signature`
- Cursor de outro tenant → 400 `cursor_tenant_mismatch`
- Cursor malformado → 400 `cursor_malformed`

### 12.6 Testes de idempotência

- POST `/leads` 2x com mesmo `Idempotency-Key` + mesmo body → 1 lead criado, 2 responses idênticos
- POST 2x com mesma key + body diferente → 409 `idempotency_conflict`
- POST após 24h com mesma key → 2 leads criados (key expirou)

### 12.7 Testes de rate limit

- 100 RPS num tenant → todos passam
- 101ª request no mesmo segundo → 429 `rate_limited` + `Retry-After`
- Headers `X-RateLimit-*` presentes em toda response

### 12.8 Testes de LGPD

- `data-request` enfileira job, gera JSON+PDF em <60s (mock)
- `redact` aplica cascade em `contacts`, `conversations`, `messages`, `activities`
- Tentativa de update em contact `is_anonymized=true` → 403 `lgpd_anonymization_irreversible`
- Audit registra `lgpd.redact_executed` com `cascaded_to.{conversations,messages,activities}`

### 12.9 Testes de onboarding

- CLI cria tenant + pipeline default em <5s
- Pipeline tem 7 stages na ordem correta
- Convite admin expira em 24h
- CNPJ duplicado → 409 `tenant_already_exists`

### 12.10 Health check

- `/api/v1/health` retorna 200 quando todas dependências OK
- Retorna 503 quando uma dependência cai (mock)
- Não exige auth

---

## 13. Migrations sequence

Ordem de aplicação no Supabase. Cada migration em arquivo numerado:

| # | Arquivo | Conteúdo |
|---|---|---|
| 0001 | `0001_extensions.sql` | `pgcrypto`, `uuid-ossp`, `citext` |
| 0002 | `0002_helpers.sql` | `fn_touch_updated_at`, `fn_user_org_ids` (placeholder), `fn_is_platform_admin` (placeholder) |
| 0003 | `0003_organizations.sql` | Tabela `organizations` + indexes + trigger touch |
| 0004 | `0004_user_organizations.sql` | Tabela + indexes + trigger touch |
| 0005 | `0005_platform_admins.sql` | Tabela + comentário T-04 |
| 0006 | `0006_helpers_v2.sql` | Reescreve `fn_user_org_ids`, `fn_is_platform_admin`, adiciona `fn_user_role_in_org`, `fn_role_at_least` |
| 0007 | `0007_api_tokens.sql` | Tabela + indexes |
| 0008 | `0008_api_audit_log.sql` | Tabela + indexes + REVOKE update/delete |
| 0009 | `0009_user_recovery_codes.sql` | Tabela MFA recovery |
| 0010 | `0010_idempotency_keys.sql` | Tabela idempotency |
| 0011 | `0011_lgpd_requests.sql` | Tabela tracking de data_requests/redacts |
| 0012 | `0012_enable_rls.sql` | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` em tudo |
| 0013 | `0013_rls_policies_organizations.sql` | Policies de §3.5 (orgs) |
| 0014 | `0014_rls_policies_user_orgs.sql` | Policies de user_organizations |
| 0015 | `0015_rls_policies_api_tokens.sql` | Policies de api_tokens |
| 0016 | `0016_rls_policies_audit_log.sql` | Policies append-only de audit |
| 0017 | `0017_rls_policies_platform_admins.sql` | Policy self-only |
| 0018 | `0018_seed_pipeline_trigger.sql` | `fn_seed_default_pipeline_for_org` + trigger (T-06) — **depende de tabelas crm_* da Spec 02/04 — colocar atrás de feature flag se Spec 02 ainda não migrada** |
| 0019 | `0019_jwt_custom_claims.sql` | `fn_jwt_custom_claims` + Auth Hook config |

**Verificação pós-migration**:

```sql
-- 1. Toda tabela tenant-aware tem RLS
select tablename from pg_tables
where schemaname = 'public'
  and tablename in ('organizations','user_organizations','api_tokens','api_audit_log','platform_admins')
  and rowsecurity = false;
-- esperado: 0 linhas

-- 2. api_audit_log NÃO aceita UPDATE/DELETE
select has_table_privilege('authenticated', 'public.api_audit_log', 'UPDATE');
-- esperado: false
select has_table_privilege('authenticated', 'public.api_audit_log', 'DELETE');
-- esperado: false

-- 3. fn_user_org_ids retorna conjunto vazio sem auth.uid()
select count(*) from public.fn_user_org_ids();
-- esperado: 0
```

---

## 14. Apêndice A — Variáveis de ambiente

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Cron / internal
INTERNAL_SECRET=                # diferente do service_role key

# Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# Observability
SENTRY_DSN=
LOG_LEVEL=info
APP_VERSION=

# Crypto
CURSOR_SIGNING_KEY=             # 32+ bytes random
CPF_ENCRYPTION_KEY=             # rotação trimestral (L-07)

# Mail (LGPD export delivery)
RESEND_API_KEY=

# Auth
AUTH_COOKIE_DOMAIN=.deskcomm.com
```

## 15. Apêndice B — Referências cruzadas

- **PRD-Mestre**: `docs/prd/00-prd-master.md`
- **Sub-PRD 01**: `docs/prd/01-prd-platform-base.md`
- **Reference synthesis**: `docs/research/reference-synthesis.md`
- **Regras aplicadas**: T-01 a T-08, L-04, L-06, L-07, L-08, L-10, B-04 (em `docs/business-rules/00-business-rules-catalog.md`)
- **Specs dependentes** (consumirão helpers e templates daqui): Spec 02 (Customer 360), Spec 03 (WhatsApp), Spec 04 (Pipeline), Spec 05 (IA), Spec 06 (Nuvemshop)
