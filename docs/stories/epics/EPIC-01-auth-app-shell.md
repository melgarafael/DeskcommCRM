---
epic_id: EPIC-01-auth-app-shell
epic_name: Auth & App Shell
priority: P0
estimated_waves: 12
estimated_total_points: 38
depends_on: [EPIC-00-foundation]
exposes_contracts:
  - "hook.useAuth"
  - "hook.useUser"
  - "hook.useActiveOrg"
  - "hook.usePermission"
  - "middleware.ts"
  - "route./login"
  - "route./login/mfa"
  - "route./login/recovery"
  - "ui.<Sidebar>"
  - "ui.<TopBar>"
  - "ui.<TenantSwitcher>"
  - "ui.<UserMenu>"
  - "ui.<ThemeToggle>"
  - "layout.app-authenticated"
  - "cookie.sb-deskcomm-auth"
status: completed
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-01 — Auth & App Shell

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Stories estão em ordem de dependência. Cada story = 1 wave. `Deps:` é lei. Toda wave passa por build → QA → fix → regression → checkpoint antes da próxima começar.

## 1. Objetivo

Entregar autenticação completa (email+senha + MFA TOTP + recovery codes) com middleware de proteção de rotas, hooks canônicos de identidade (`useAuth`, `useUser`, `useActiveOrg`, `usePermission`), e o layout autenticado padrão (sidebar fixa 240px + topbar com tenant switcher, busca global Cmd+K e user menu) — base que TODOS os epics seguintes consomem.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Usuário não autenticado em `/app/*` ou `/admin/*` é redirecionado pra `/login?next=<path>` pelo middleware
- [ ] Usuário consegue logar em `/login` com email+senha e cair em `/app/inbox` (ou `next` query)
- [ ] Admin/platform_admin com MFA cadastrado faz challenge TOTP em `/login/mfa` antes de logar
- [ ] Admin/platform_admin sem MFA cadastrado é forçado a enrollar via modal blocker no primeiro login (com display once de 10 recovery codes + copy-to-clipboard)
- [ ] Recovery code válido em `/login/recovery` reseta MFA do user (usado UMA vez, marcado `used_at`)
- [ ] Logout limpa cookie `sb-deskcomm-auth` + redireciona pra `/login`
- [ ] Layout `app/(app)/layout.tsx` renderiza com `<Sidebar>` (Inbox, Kanban, Contacts, Settings, com Phosphor icons + collapse persistido em cookie) + `<TopBar>` (`<TenantSwitcher>`, trigger Cmd+K, `<UserMenu>` com avatar/logout/profile/theme)
- [ ] Hooks `useAuth`, `useUser`, `useActiveOrg`, `usePermission(action)` disponíveis em `lib/auth/` e cobertos por unit test
- [ ] Auto-refresh de sessão a cada 40min (`useAuth`) — JWT não expira em sessão longa
- [ ] Audit actions emitidas: `auth.login_success`, `auth.login_failed`, `auth.mfa_enrolled`, `auth.mfa_failed`, `auth.logout`, `auth.recovery_code_used`
- [ ] 100% das rotas protegidas falham fechado (redirect, nunca render parcial)
- [ ] Regression suite cumulativa verde

## 3. Pré-requisitos

- EPIC-00-foundation completo (Phosphor, sonner, TanStack Query, theme provider, test runners)
- Migrations 0001-0007 do Supabase aplicadas (inclui `user_organizations`, `platform_admins`, `user_recovery_codes`, `api_audit_log`, helpers `fn_user_org_ids`, `fn_is_platform_admin`)
- Variáveis env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA
- Pelo menos 1 user seed: 1 admin com email/senha conhecida + 1 agent (Spec 01 §9.3 trigger T-06 já cobre)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `infra.tanstack-query` | provider | EPIC-00 | `QueryClientProvider` no root layout |
| `lib.toast` | lib | EPIC-00 | `toast.error(...)` em error handler |
| `lib.phosphor` | lib | EPIC-00 | `import { House, ChatCircle, ... } from '@phosphor-icons/react'` |
| `hook.useTheme` | react_hook | EPIC-00 | `<ThemeToggle>` consome |
| `hook.useApiClient` | react_hook | EPIC-00 | Server Actions usam server-side equivalent |
| `db.user_organizations` | db_table | migration 0001 | Carrega orgs via RLS |
| `db.platform_admins` | db_table | migration 0001 | Bypass de tenant pra super-admin |
| `db.user_recovery_codes` | db_table | migration 0001 | Persiste hashes de recovery codes |
| `db.api_audit_log` | db_table | migration 0001 | Insert append-only de audit actions |
| `fn.fn_user_org_ids` | sql_fn | migration 0001 | RLS de tenant |
| `fn.fn_is_platform_admin` | sql_fn | migration 0001 | Gating de `/admin/*` |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `middleware.ts` | next_middleware | S-01.01 | Protege `/app/*` e `/admin/*`; injeta `x-request-id`; refresh JWT < 60s |
| `route./login` | next_route | S-01.02 | Form email+senha; redirect pra `next` ou `/app/inbox` |
| `action.signInWithPassword` | server_action | S-01.03 | `(input) => Promise<{ ok } \| { error: 'mfa_required' \| 'mfa_enrollment_required' \| 'invalid_credentials' \| 'rate_limited' }>` |
| `route./login/mfa` | next_route | S-01.04 | TOTP 6 dígitos challenge |
| `action.verifyMfa` | server_action | S-01.04 | `(code) => Promise<{ ok } \| { error }>` |
| `route./login/recovery` | next_route | S-01.05 | Recovery code 8 chars; reset MFA |
| `action.useRecoveryCode` | server_action | S-01.05 | `(email, code) => Promise<{ ok, reset_mfa: true }>` |
| `hook.useAuth` | react_hook | S-01.06 | `() => { user, signOut, refreshing, isAuthenticated }` (auto-refresh 40min) |
| `hook.useUser` | react_hook | S-01.06 | `() => User` (throws se ausente — usar dentro de `(app)` layout) |
| `hook.useActiveOrg` | react_hook | S-01.06 | `() => { orgId, name, role }` |
| `hook.usePermission` | react_hook | S-01.06 | `(action: string) => boolean` derivado da matriz RBAC Spec 01 §5 |
| `action.signOut` | server_action | S-01.07 | `() => Promise<void>` (limpa cookie + redirect) |
| `layout.app-authenticated` | next_layout | S-01.08 | `app/(app)/layout.tsx` — sidebar 240px + topbar 56px |
| `ui.<Sidebar>` | react_component | S-01.09 | Phosphor icons; collapse via cookie `sidebar_collapsed` |
| `ui.<TopBar>` | react_component | S-01.10 | Slots: tenant switcher, busca Cmd+K, user menu |
| `ui.<TenantSwitcher>` | react_component | S-01.10 | Lista orgs do user; chama Server Action `setActiveOrg` |
| `ui.<UserMenu>` | react_component | S-01.10 | Avatar + dropdown logout/profile/theme |
| `ui.<ThemeToggle>` | react_component | S-01.10 | Wrapper sobre `useTheme` |
| `ui.<MfaEnrollModal>` | react_component | S-01.11 | Blocker; QR + TOTP input + display once recovery codes |
| `ui.<RecoveryCodesPanel>` | react_component | S-01.12 | Lista 10 codes com copy-all e download .txt |
| `cookie.sb-deskcomm-auth` | cookie | S-01.01 | Nome canônico do cookie de sessão Supabase em todos os ambientes |
| `cookie.active_org` | cookie | S-01.10 | `httpOnly`, `sameSite=strict` |
| `cookie.sidebar_collapsed` | cookie | S-01.09 | Boolean `'1' \| '0'` |
| `event.audit.auth.*` | domain_event | S-01.03/04/05/07 | Inseridos em `api_audit_log` (Spec 01 §6.1) |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave 12 = última. Deps internos respeitados pela ordem.

---

### S-01.01 — Middleware de proteção de rotas

**Points**: 3 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 09 §3.2, Spec 01 §4.1, Sitemap §1

#### Contexto

Primeira pedra do shell autenticado. Sem middleware nada funciona — qualquer rota `/app/*` ou `/admin/*` precisa falhar fechado pra usuário sem cookie. Decisão lockada: **cookie name canônico = `sb-deskcomm-auth`** em todos os ambientes (dev/staging/prod). Lista pública (`PUBLIC_PATHS`) inclui `/`, `/login`, `/login/mfa`, `/login/recovery`, `/api/v1/webhooks/*`, `/api/v1/health`. `/admin/*` exige `fn_is_platform_admin()` true além de auth.

#### Files to create

- `middleware.ts` — proteção de rotas, refresh < 60s, inject `x-request-id`
- `lib/auth/public-paths.ts` — array de regex compartilhado
- `tests/middleware.spec.ts` — Playwright e2e

#### Files to modify

- `next.config.ts` — garantir `output: 'standalone'` ainda válido (não tocar se já ok)

#### Implementation steps (sequential)

1. Criar `lib/auth/public-paths.ts` com `PUBLIC_PATHS` regex array
2. Criar `middleware.ts` espelhando Spec 09 §3.2 (createServerClient ssr, getUser, redirect com `next` query)
3. Adicionar gating de `/admin/*` via `supabase.rpc('fn_is_platform_admin')` → redirect `/403` se false
4. Configurar `matcher` excluindo assets estáticos
5. Forçar nome de cookie: `cookieOptions: { name: 'sb-deskcomm-auth', sameSite: 'strict', httpOnly: true, secure: true }` (dev pode `secure: false` via env)
6. Escrever Playwright spec

#### Acceptance Criteria

```gherkin
Given um usuário não autenticado
When ele faz GET /app/inbox
Then ele recebe 307 redirect pra /login?next=%2Fapp%2Finbox
And nenhum HTML do shell é renderizado
```

```gherkin
Given um usuário autenticado como agent (sem platform_admin)
When ele faz GET /admin/inbox
Then ele recebe 307 redirect pra /403
```

```gherkin
Given uma rota pública /api/v1/health
When ela é acessada sem cookie
Then retorna 200 sem redirect
```

```gherkin
Given um cookie com JWT que expira em <60s
When middleware processa o request
Then JWT é refreshado e Set-Cookie sai com novo token
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Redirect anônimo | Playwright: `goto('/app/inbox')` → expect URL `/login?next=...` |
| t2 | e2e | Redirect admin sem permissão | Login como agent, `goto('/admin')` → expect `/403` |
| t3 | api | Health pública | `curl /api/v1/health` sem cookie → 200 |
| t4 | api | Header injection | Inspect response headers em qualquer rota → `x-request-id` presente |
| t5 | rls | Cookie name canônico | Inspect Set-Cookie em login → `sb-deskcomm-auth=...` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: next_middleware
    id: "middleware.ts"
    behavior: "redirect_to_login_with_next + admin_gating + jwt_refresh"
  - type: cookie
    id: "sb-deskcomm-auth"
    options: "{ httpOnly, sameSite: strict, secure: true (prod), path: / }"
```

#### Decisões a registrar

- **D-01.01**: Cookie de sessão chama-se `sb-deskcomm-auth` em todos os ambientes (locked)
- **D-01.02**: `/admin/*` faz RPC `fn_is_platform_admin` no middleware (1 round-trip extra aceito por security)

#### Definition of Done

- [ ] Todos os ACs passam em Playwright
- [ ] `pnpm typecheck` zero erros novos
- [ ] `pnpm lint` zero erros novos
- [ ] Sem warnings no console em dev
- [ ] Commit `feat(EPIC-01): middleware [wave 1]`
- [ ] Contracts registrados no state file
- [ ] Sem regressão em waves anteriores (none — primeira wave)

---

### S-01.02 — Página `/login` com form email+senha

**Points**: 3 | **Priority**: P0 | **Deps**: S-01.01 | **FR refs**: Sitemap §2 (`/login`), Journeys J1 step 1, ADR-08

#### Contexto

Tela pública, server component que renderiza um `<LoginForm>` client. Form via `react-hook-form` + Zod resolver (ADR-08). Não chama Server Action ainda — apenas valida e exibe states (loading/error). A action vem na próxima story.

#### Files to create

- `app/(public)/login/page.tsx` — server component (metadata, layout)
- `app/(public)/layout.tsx` — layout público minimal (logo centralizada, sem sidebar)
- `components/auth/LoginForm.tsx` — client component com RHF
- `lib/auth/schemas.ts` — `loginSchema = z.object({ email, password })`

#### Files to modify

- (none)

#### Implementation steps

1. Criar `(public)/layout.tsx` com container centralizado max-w-sm
2. Criar `loginSchema` em `lib/auth/schemas.ts`
3. Criar `<LoginForm>` com fields email/password, useForm + zodResolver
4. Renderizar erros inline (`<FormMessage>`) e estado disabled durante submit
5. Wire submit handler com placeholder `console.log` (action vem em S-01.03)
6. Garantir aria-labels + autoComplete corretos (`email`, `current-password`)

#### Acceptance Criteria

```gherkin
Given anônimo em /login
When ele submete email inválido
Then erro "Email inválido" aparece inline sem navegar
```

```gherkin
Given /login carregada
When usuário tab pelo form
Then ordem é email → password → submit (a11y)
```

```gherkin
Given /login carregada via mobile (375px)
When inspeciono layout
Then card cabe sem scroll horizontal
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Form renderiza | Playwright: `getByLabel('Email')`, `getByLabel('Senha')`, `getByRole('button', { name: /Entrar/ })` |
| t2 | ui | Validação Zod inline | Submit com email vazio → `getByText('Email obrigatório')` |
| t3 | a11y | Tab order | Playwright: tab × 3 → submit focused |
| t4 | ui | Mobile layout | Resize 375 → screenshot diff vs baseline |

#### Architecture contracts emitted

```yaml
exposes:
  - type: next_route
    id: "/login"
    component: "app/(public)/login/page.tsx"
  - type: react_component
    id: "<LoginForm>"
    file: "components/auth/LoginForm.tsx"
  - type: zod_schema
    id: "loginSchema"
    file: "lib/auth/schemas.ts"
```

#### Decisões a registrar

- **D-01.03**: Schemas de form moram em `lib/auth/schemas.ts`, compartilhados entre client e Server Action

#### Definition of Done

- [ ] ACs passam
- [ ] Typecheck/lint limpos
- [ ] Commit `feat(EPIC-01): /login page + form [wave 2]`
- [ ] Regression: middleware ainda redireciona

---

### S-01.03 — Server Action `signInWithPassword`

**Points**: 4 | **Priority**: P0 | **Deps**: S-01.02 | **FR refs**: Spec 01 §4.1, Spec 09 §11, ADR-02

#### Contexto

Lógica server-side do login. Reuso do pseudo-código da Spec 01 §4.1 — Server Action (não API route) porque é form simples com revalidação. Trata 4 outcomes: ok / `invalid_credentials` / `mfa_required` / `mfa_enrollment_required` / `rate_limited`. Em `mfa_required` retorna sucesso parcial e redireciona pra `/login/mfa` (cookie `mfa_pending` curto). Em `mfa_enrollment_required` redireciona pra `/login/mfa` em modo enrollment (S-01.11 trata).

#### Files to create

- `app/actions/auth/signInWithPassword.ts` — Server Action
- `lib/auth/server.ts` — `requireAuth()`, `loadUserOrgs()`, `checkPlatformAdmin()`, `isMfaEnrolled()`
- `lib/audit/index.ts` — wrapper `audit({ action, actorUserId?, metadata?, requestId? })`
- `lib/audit/actions.ts` — union type `AuditAction` (subset auth.* desta wave)

#### Files to modify

- `components/auth/LoginForm.tsx` — wire `useFormStatus` + invocação da action; redirect baseado em retorno

#### Implementation steps

1. Criar `lib/audit/actions.ts` com union de `auth.*` (Spec 01 §6.1)
2. Criar `lib/audit/index.ts` com função `audit()` que insere em `api_audit_log` via service role
3. Criar helpers em `lib/auth/server.ts`
4. Criar Server Action `signInWithPassword` espelhando Spec 01 §4.1 pseudocódigo
5. Mapear erros pra discriminated union de retorno (sem throws)
6. No client: ao receber `mfa_required` → set cookie `mfa_pending` (1min) e `redirect('/login/mfa')`
7. Audit `auth.login_success` e `auth.login_failed`
8. Rate limit (Spec 01 §7.4) — 5 tentativas / 15min por IP+email_hash; em fallback degrada open

#### Acceptance Criteria

```gherkin
Given user agent com email/senha válidos sem MFA
When submete /login
Then cookie sb-deskcomm-auth é setado
And redirect pra /app/inbox (ou next query)
And api_audit_log tem row auth.login_success
```

```gherkin
Given email/senha errados
When submete /login
Then mensagem "Email ou senha incorretos" aparece
And api_audit_log tem row auth.login_failed com email_hash
```

```gherkin
Given admin com MFA cadastrado
When submete /login com creds válidas
Then redirect pra /login/mfa
And cookie mfa_pending=1 TTL 60s
```

```gherkin
Given mesmo IP+email faz 6 tentativas em <15min
When submete a 6ª
Then resposta { error: 'rate_limited' } e UI mostra cooldown
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Login agent ok | Playwright: form submit → URL `/app/inbox` |
| t2 | e2e | Login admin → mfa | Playwright: form submit admin → URL `/login/mfa` |
| t3 | api | Audit row inserida | Supabase query `SELECT * FROM api_audit_log WHERE action='auth.login_success' ORDER BY created_at DESC LIMIT 1` |
| t4 | e2e | Erro inválido | Submit com password errada → toast/inline "incorretos" |
| t5 | rls | Rate limit | Loop 6 attempts → 6º bloqueado |
| t6 | e2e | Next param respeitado | `/login?next=/app/contacts` → após login URL = `/app/contacts` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "signInWithPassword"
    file: "app/actions/auth/signInWithPassword.ts"
    signature: "(input: { email, password }) => Promise<{ ok: true } | { ok: false; error: 'invalid_credentials' | 'mfa_required' | 'mfa_enrollment_required' | 'rate_limited'; details? }>"
  - type: lib
    id: "lib/audit"
    api: "audit({ action, actorUserId?, metadata?, requestId? })"
  - type: domain_event
    id: "audit.auth.login_success"
    payload: "{ user_id, is_platform_admin, orgs_count }"
  - type: domain_event
    id: "audit.auth.login_failed"
    payload: "{ email_hash, reason }"
```

#### Decisões a registrar

- **D-01.04**: Login é Server Action (não `/api/v1/auth/login` route) — pra UI humana. Bearer/server-to-server sai por API route (vem em EPIC-10/11)
- **D-01.05**: MFA pending state via cookie `mfa_pending` httpOnly TTL 60s

#### Definition of Done

- [ ] ACs passam (incluindo audit query)
- [ ] Typecheck/lint limpos
- [ ] Commit `feat(EPIC-01): signInWithPassword action [wave 3]`
- [ ] Regression: anônimo ainda redirecionado; /login ainda renderiza

---

### S-01.04 — Página `/login/mfa` + verify

**Points**: 3 | **Priority**: P0 | **Deps**: S-01.03 | **FR refs**: Spec 01 §4.1/§4.2, Journeys J1 step 2

#### Contexto

Recebe usuário com cookie `mfa_pending=1`. Mostra `<TOTPInput>` (6 dígitos, auto-submit ao 6º char). Server Action `verifyMfa` chama `supabase.auth.mfa.challenge` + `verify`. Em sucesso: limpa `mfa_pending`, audit `auth.mfa_success` (alias de `login_success` com flag), redirect `next || /app/inbox`. Em falha: audit `auth.mfa_failed`, mensagem "Código inválido". 3 falhas → bloqueia 5min.

#### Files to create

- `app/(public)/login/mfa/page.tsx`
- `components/auth/MfaForm.tsx` — `<TOTPInput>` (6 boxes com auto-advance)
- `app/actions/auth/verifyMfa.ts`

#### Files to modify

- `lib/audit/actions.ts` — adicionar `auth.mfa_failed`, `auth.mfa_enrolled` ao union

#### Implementation steps

1. Criar `<TOTPInput>` com 6 inputs `inputMode="numeric"` + auto-focus next
2. Criar page server component que verifica cookie `mfa_pending` ou redirect `/login`
3. Criar `verifyMfa` action espelhando Spec 01 §4.2 (challenge + verify)
4. Mapear erros: `mfa_invalid`, `mfa_expired`, `mfa_locked` (após 3 fails)
5. Audit em ambos os outcomes

#### Acceptance Criteria

```gherkin
Given user pós-login com mfa_pending=1
When digita TOTP correto
Then sb-deskcomm-auth elevated, redirect /app/inbox
And audit auth.mfa_success existe
```

```gherkin
Given mesmo user
When erra TOTP 3x
Then UI bloqueia por 5min com countdown
And audit auth.mfa_failed × 3 existe
```

```gherkin
Given user sem mfa_pending tenta /login/mfa direto
When abre URL
Then redirect pra /login
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Auto-advance TOTP | Playwright: type "1" no box 1 → focus box 2 |
| t2 | e2e | Auto-submit ao 6º char | type 6 dígitos → form submitted sem clicar |
| t3 | e2e | TOTP correto | gerar TOTP via lib (test fixture) → submit → /app/inbox |
| t4 | api | Audit failed | submit "000000" → audit row mfa_failed |
| t5 | e2e | Sem cookie → redirect | `goto('/login/mfa')` sem mfa_pending → /login |

#### Architecture contracts emitted

```yaml
exposes:
  - type: next_route
    id: "/login/mfa"
  - type: server_action
    id: "verifyMfa"
    signature: "(code: string) => Promise<{ ok } | { error: 'mfa_invalid' | 'mfa_expired' | 'mfa_locked' }>"
  - type: react_component
    id: "<TOTPInput>"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Typecheck/lint limpos
- [ ] Commit `feat(EPIC-01): mfa challenge [wave 4]`
- [ ] Regression: agent sem MFA ainda loga direto

---

### S-01.05 — Página `/login/recovery` + reset MFA

**Points**: 3 | **Priority**: P1 | **Deps**: S-01.04 | **FR refs**: Spec 01 §4.5, Journeys J4 step 2, Sitemap §2

#### Contexto

Saída de emergência quando user perde TOTP. Form pede email + recovery code (8 chars). Server Action verifica hash em `user_recovery_codes` (single-use), marca `used_at`, força regeneração de TOTP no próximo login, emite `auth.recovery_code_used`. Após sucesso → redireciona pra `/login/mfa?enrollment=1` (S-01.11 recobre).

#### Files to create

- `app/(public)/login/recovery/page.tsx`
- `components/auth/RecoveryForm.tsx`
- `app/actions/auth/useRecoveryCode.ts`

#### Files to modify

- `lib/audit/actions.ts` — adicionar `auth.recovery_code_used`

#### Implementation steps

1. Form `email + recovery_code` (RHF + Zod, code regex `[A-Z0-9]{8}`)
2. Action: `select id, code_hash, used_at from user_recovery_codes where user_id=(...) and code_hash=sha256($code) and used_at is null`
3. Se válido: `update used_at=now(), used_ip=...`; resetar TOTP via `supabase.auth.admin.mfa.deleteFactor` (todos factors)
4. Audit `auth.recovery_code_used` com `metadata: { masked_code }`
5. Redirect pra `/login/mfa?enrollment=1`

#### Acceptance Criteria

```gherkin
Given user admin com recovery code válido não-usado
When submete email + code corretos
Then used_at é setado em user_recovery_codes
And audit auth.recovery_code_used existe
And redirect pra /login/mfa?enrollment=1
```

```gherkin
Given recovery code já usado (used_at != null)
When submete
Then erro "Código inválido ou já utilizado"
And nenhuma mutation feita
```

```gherkin
Given recovery code não cadastrado
When submete
Then mesma mensagem genérica (sem leak de existência)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Recovery flow ok | Seed code → submit → URL `/login/mfa?enrollment=1` |
| t2 | db | Single-use enforced | Tentar mesmo code 2× → 2ª falha |
| t3 | api | Audit row | Query `auth.recovery_code_used` |
| t4 | e2e | Mensagem genérica | Code inválido vs já-usado → mesma mensagem |

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): recovery code flow [wave 5]`
- [ ] Regression: login normal + MFA ainda funcionam

---

### S-01.06 — Hooks `useAuth`, `useUser`, `useActiveOrg`, `usePermission`

**Points**: 4 | **Priority**: P0 | **Deps**: S-01.05 | **FR refs**: Spec 09 §13 Tier 1, Spec 01 §5 RBAC

#### Contexto

Coração do shell. Hooks ficam em `lib/auth/hooks/` (NÃO em `hooks/` direto — convenção pra auth domain). `useAuth` faz auto-refresh com `setInterval(40min)` chamando `supabase.auth.refreshSession()` (Spec 09 §3.6). `usePermission` lê role do `useActiveOrg` e cruza com matriz RBAC declarada em `lib/auth/rbac.ts` (Spec 01 §5).

#### Files to create

- `lib/auth/hooks/useAuth.ts`
- `lib/auth/hooks/useUser.ts`
- `lib/auth/hooks/useActiveOrg.ts`
- `lib/auth/hooks/usePermission.ts`
- `lib/auth/rbac.ts` — matriz `Role × Action → boolean`
- `lib/auth/AuthProvider.tsx` — context + initial bootstrap from server
- `tests/auth/hooks.spec.ts` — Vitest unit

#### Files to modify

- `app/(app)/layout.tsx` — wrap em `<AuthProvider initialUser={...}>` (placeholder; layout completo em S-01.08)

#### Implementation steps

1. Criar matriz RBAC em `lib/auth/rbac.ts` cobrindo todas as actions da Spec 01 §5
2. Criar `<AuthProvider>` que recebe `initialUser`, `initialOrgs`, `initialActiveOrg` do server e popula context + TanStack Query cache (`['auth']`, `['orgs']`, `['active-org']`)
3. `useAuth`: retorna `{ user, isAuthenticated, signOut, refreshing }` + `useEffect` com `setInterval(40 * 60_000)` chamando `refreshSession`
4. `useUser`: throws se ausente (uso só dentro de `(app)`)
5. `useActiveOrg`: lê de query cache + cookie `active_org`
6. `usePermission(action)`: cruza role de `useActiveOrg` com `rbac[role][action]`; super-admin sempre true
7. Unit tests pra rbac matrix + hooks (renderHook)

#### Acceptance Criteria

```gherkin
Given useAuth montado em /app/inbox
When 40min passam
Then refreshSession é chamada e novo JWT cookie é setado
```

```gherkin
Given user agent com active org X
When chama usePermission('leads.delete')
Then retorna false
```

```gherkin
Given user admin
When chama usePermission('leads.delete')
Then retorna true
```

```gherkin
Given platform_admin
When chama usePermission(qualquer action sensata)
Then retorna true
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | RBAC matrix | Vitest: `rbac.agent['leads.delete']` === false |
| t2 | unit | usePermission | renderHook com mock active org agent → permission false |
| t3 | e2e | Auto-refresh | Spy em `refreshSession`, fast-forward timer 40min → spy called |
| t4 | unit | useUser throws | render fora de provider → throws |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "useAuth"
    file: "lib/auth/hooks/useAuth.ts"
    signature: "() => { user, isAuthenticated, signOut, refreshing }"
  - type: react_hook
    id: "useUser"
    signature: "() => User"  # throws
  - type: react_hook
    id: "useActiveOrg"
    signature: "() => { orgId, name, role: 'viewer'|'agent'|'manager'|'admin' }"
  - type: react_hook
    id: "usePermission"
    signature: "(action: string) => boolean"
  - type: lib
    id: "lib/auth/rbac"
    description: "Matriz declarativa Role × Action conforme Spec 01 §5"
```

#### Decisões a registrar

- **D-01.06**: Hooks de auth ficam em `lib/auth/hooks/`, não em `hooks/` (separação de domínio crítico)
- **D-01.07**: Auto-refresh JWT a cada 40min via `setInterval` no `useAuth` — JWT TTL Supabase default 1h

#### Definition of Done

- [ ] Unit tests passam (Vitest)
- [ ] Commit `feat(EPIC-01): auth hooks + RBAC matrix [wave 6]`
- [ ] Regression: login flows ainda OK

---

### S-01.07 — Logout

**Points**: 2 | **Priority**: P0 | **Deps**: S-01.06 | **FR refs**: Spec 01 §6.1 `auth.logout`

#### Contexto

Server Action `signOut` que chama `supabase.auth.signOut()` server-side, deleta cookies (`sb-deskcomm-auth`, `active_org`, `mfa_pending` se existir, `sidebar_collapsed`), audit `auth.logout`, `redirect('/login')`. Botão dispara via `<UserMenu>` (componente vem em S-01.10, mas action precisa estar pronta).

#### Files to create

- `app/actions/auth/signOut.ts`

#### Files to modify

- `lib/auth/hooks/useAuth.ts` — wire `signOut` no retorno

#### Implementation steps

1. Server Action `signOut` com `requireAuth()` no topo
2. `supabase.auth.signOut({ scope: 'local' })` (não desloga outros devices)
3. Limpar cookies via `cookies().delete(...)`
4. Audit `auth.logout`
5. `redirect('/login')`

#### Acceptance Criteria

```gherkin
Given user autenticado
When chama signOut
Then cookie sb-deskcomm-auth removido
And redirect pra /login
And audit auth.logout existe
```

```gherkin
Given após logout
When tenta /app/inbox
Then redirecionado pra /login (middleware)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Logout limpa cookie | Login → invocar action → cookie ausente |
| t2 | e2e | Pós-logout protected | goto /app/inbox → /login |
| t3 | api | Audit row | query `auth.logout` |

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): signOut action [wave 7]`

---

### S-01.08 — Layout `app/(app)/layout.tsx`

**Points**: 3 | **Priority**: P0 | **Deps**: S-01.07 | **FR refs**: Sitemap §3 (Layout pai `/app`), Components §00-overview

#### Contexto

Shell autenticado base. Grid: sidebar fixa 240px (collapsable pra 64px) + topbar fixa 56px + main area com `<Outlet>`. Server component que faz `requireAuth()`, carrega user/orgs/active-org e injeta no `<AuthProvider>`. Reserva slots pros componentes que vêm nas próximas waves (Sidebar S-01.09, TopBar S-01.10).

#### Files to create

- `app/(app)/layout.tsx` — server component
- `app/(app)/_components/AppShell.tsx` — client wrapper que usa cookie `sidebar_collapsed`
- `app/(app)/page.tsx` — redirect pra `/app/inbox` (placeholder até EPIC-03)

#### Files to modify

- (none)

#### Implementation steps

1. Layout server component: `requireAuth()` + `loadUserOrgs()` + read cookie `active_org`
2. Pass initial state pro `<AuthProvider>` (S-01.06)
3. `<AppShell>` client com grid 240px / 1fr e topbar absoluta
4. Slots placeholder pra Sidebar e TopBar (renderiza `<aside>` e `<header>` vazios — preenchidos nas próximas waves)
5. Read cookie `sidebar_collapsed` no server pra evitar flash

#### Acceptance Criteria

```gherkin
Given user autenticado
When acessa /app/inbox
Then layout renderiza com sidebar 240px + topbar 56px + main
```

```gherkin
Given cookie sidebar_collapsed=1
When SSR
Then sidebar renderiza colapsada (64px) sem flash
```

```gherkin
Given user sem active_org cookie mas com 1+ orgs
When SSR
Then primeira org é selecionada como default e cookie setado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Layout grid | Playwright: `aside` width 240; `header` height 56 |
| t2 | e2e | Sem flash colapso | Cookie set → reload → screenshot ainda colapsado |
| t3 | e2e | Default org | Login → cookie `active_org` setado |

#### Architecture contracts emitted

```yaml
exposes:
  - type: next_layout
    id: "app/(app)/layout.tsx"
    behavior: "requireAuth + AuthProvider + AppShell grid"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): app authenticated layout [wave 8]`

---

### S-01.09 — `<Sidebar>` component com Phosphor icons

**Points**: 3 | **Priority**: P0 | **Deps**: S-01.08 | **FR refs**: Iconography Phosphor (DS §05), ADR-05

#### Contexto

Sidebar fixa com nav items: **Inbox** (ChatCircle), **Kanban** (Kanban), **Contacts** (Users), **Settings** (Gear). Phosphor é único pacote (ADR-05). Item ativo via `usePathname`. Collapse via botão no rodapé que toggla cookie `sidebar_collapsed` via Server Action.

#### Files to create

- `components/shell/Sidebar.tsx`
- `components/shell/SidebarItem.tsx`
- `app/actions/shell/toggleSidebar.ts`

#### Files to modify

- `app/(app)/_components/AppShell.tsx` — montar `<Sidebar>` no slot

#### Implementation steps

1. `<SidebarItem>` com props `{ href, icon, label, collapsed }` + active state via `usePathname`
2. `<Sidebar>`: lista de nav items + footer com `<SidebarToggle>`
3. Server Action `toggleSidebar()` que flipa cookie
4. Tooltip nos items quando colapsado (Tooltip não instalado ainda — usar `title` HTML como fallback aceito)
5. Visual matches DS density-aerada (DS §04)

#### Acceptance Criteria

```gherkin
Given sidebar expandida
When clico em "Inbox"
Then navego pra /app/inbox e item fica ativo (background sage)
```

```gherkin
Given sidebar
When clico no toggle
Then sidebar reduz pra 64px e cookie sidebar_collapsed=1
```

```gherkin
Given sidebar colapsada
When hover em item
Then label aparece via title tooltip
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Nav funciona | Click Inbox → URL /app/inbox |
| t2 | e2e | Active state | URL /app/inbox → item Inbox tem aria-current="page" |
| t3 | e2e | Collapse persistido | Toggle → reload → ainda colapsada |
| t4 | a11y | aria-current | Inspect DOM |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<Sidebar>"
    file: "components/shell/Sidebar.tsx"
  - type: server_action
    id: "toggleSidebar"
  - type: cookie
    id: "sidebar_collapsed"
    values: "'1' | '0'"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): sidebar [wave 9]`

---

### S-01.10 — `<TopBar>` + `<TenantSwitcher>` + `<UserMenu>` + Cmd+K trigger

**Points**: 4 | **Priority**: P0 | **Deps**: S-01.09 | **FR refs**: Sitemap §3, Components §06, Server Actions catalog (Spec 09 §11)

#### Contexto

Topbar 56px com 3 zonas: esquerda (`<TenantSwitcher>` se 2+ orgs), centro (botão "Buscar... Cmd+K" — só trigger; modal vem em epic futuro), direita (`<UserMenu>` com avatar, dropdown profile/theme/logout). `setActiveOrg` Server Action conforme Spec 09 §11.

#### Files to create

- `components/shell/TopBar.tsx`
- `components/shell/TenantSwitcher.tsx`
- `components/shell/UserMenu.tsx`
- `components/shell/ThemeToggle.tsx`
- `components/shell/SearchTrigger.tsx`
- `app/actions/shell/setActiveOrg.ts` — espelha Spec 09 §11

#### Files to modify

- `app/(app)/_components/AppShell.tsx` — montar `<TopBar>` no slot

#### Implementation steps

1. `<TopBar>` grid layout
2. `<TenantSwitcher>`: `<DropdownMenu>` shadcn com lista de orgs do user; click → `setActiveOrg(id)` action; visualmente esconde se só 1 org
3. `<SearchTrigger>`: button + kbd hint "⌘K"; `useHotkeys('mod+k', () => ...)` (placeholder console.log)
4. `<UserMenu>`: avatar via `<Avatar>` + `<DropdownMenu>` com items [Profile, Theme submenu, Sair]
5. `<ThemeToggle>` consome `useTheme` (EPIC-00)
6. Logout item invoca `signOut` action (S-01.07)

#### Acceptance Criteria

```gherkin
Given user com 2 orgs
When clico no TenantSwitcher e seleciono outra
Then cookie active_org muda e layout revalida
And meus dados (sidebar contagens etc) refletem nova org
```

```gherkin
Given /app/inbox
When pressiono Cmd+K
Then SearchTrigger handler dispara (placeholder)
```

```gherkin
Given UserMenu aberto
When clico em "Sair"
Then logout executa e redireciona /login
```

```gherkin
Given user com 1 org só
When inspeciono TopBar
Then TenantSwitcher não renderiza (visual hide)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Switch tenant | Click switcher → assert cookie + layout reload |
| t2 | e2e | Cmd+K | Press → assert handler called |
| t3 | e2e | Logout via menu | Open menu → click Sair → URL /login |
| t4 | e2e | Theme toggle | Click → cookie theme atualiza, classe `dark` toggla |
| t5 | a11y | Dropdown teclado | Tab into menu → arrow keys → enter |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<TopBar>"
  - type: react_component
    id: "<TenantSwitcher>"
  - type: react_component
    id: "<UserMenu>"
  - type: react_component
    id: "<ThemeToggle>"
  - type: server_action
    id: "setActiveOrg"
    signature: "(orgId: string) => Promise<void>"
  - type: cookie
    id: "active_org"
    options: "{ httpOnly, sameSite: strict, path: / }"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): topbar + tenant switcher + user menu [wave 10]`

---

### S-01.11 — Force MFA enrollment pra admin sem MFA

**Points**: 4 | **Priority**: P0 | **Deps**: S-01.10 | **FR refs**: Spec 01 §4.1 (mfa_enrollment_required), Journeys J4 step 4

#### Contexto

Admin/platform_admin que loga sem MFA cadastrado **não pode** acessar app — tela bloqueadora `<MfaEnrollModal>` no layout `(app)` que renderiza acima de tudo até enrollment completar. Modal mostra QR code (Spec 01 §4.2 enrollment), TOTP input pra confirmar, e ao verify mostra os 10 recovery codes (display once — S-01.12 trata o componente).

#### Files to create

- `components/auth/MfaEnrollModal.tsx`
- `app/actions/auth/enrollMfa.ts` — chama `supabase.auth.mfa.enroll`, retorna QR
- `app/actions/auth/confirmMfaEnroll.ts` — verify + gera recovery codes + audit `auth.mfa_enrolled`

#### Files to modify

- `app/(app)/layout.tsx` — checagem `requiresMfa && !mfaEnrolled` → renderiza `<MfaEnrollModal>` em vez do shell normal
- `lib/auth/server.ts` — helper `requiresMfa(role, isPlatformAdmin)`

#### Implementation steps

1. Helper `requiresMfa(role, isPlatformAdmin)` (true se admin || platform_admin)
2. Layout server check: se `requiresMfa && !mfaEnrolled` → render `<MfaEnrollModal>` único; **não** renderiza Sidebar/TopBar/Outlet
3. `enrollMfa` action: `supabase.auth.mfa.enroll({ factorType: 'totp' })` → `{ factor_id, qr_svg, uri }`
4. `confirmMfaEnroll(code)`: challenge + verify; em sucesso gera 10 recovery codes (8 chars random base32), persiste hashes em `user_recovery_codes`, audit `auth.mfa_enrolled`, retorna `{ recovery_codes: [...] }` UMA vez
5. Modal mostra QR → TOTP input → após verify mostra `<RecoveryCodesPanel>` (S-01.12) → botão "Concluí, salvei meus códigos" → reload pra acessar app
6. Modal não pode ser fechado via Esc/click outside (blocker real)

#### Acceptance Criteria

```gherkin
Given admin sem MFA recém-logado
When chega em /app/inbox
Then MfaEnrollModal cobre a tela com QR code
And não consegue ver/clicar Sidebar nem TopBar
```

```gherkin
Given QR scaneado
When digito TOTP correto
Then 10 recovery codes aparecem na tela (display once)
And audit auth.mfa_enrolled existe
And user_recovery_codes tem 10 rows pro user
```

```gherkin
Given após confirmar enrollment
When recarrego /app/inbox
Then layout normal renderiza (modal sumiu)
```

```gherkin
Given agent (não admin) sem MFA
When loga
Then MFA modal NÃO aparece (não é mandatório)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Modal blocker | Login admin novo → modal visível, esc não fecha |
| t2 | e2e | QR renderiza | Inspect img/svg presente |
| t3 | e2e | Confirm flow | Type valid TOTP → recovery codes view aparece |
| t4 | db | Recovery codes persistidos | `SELECT count(*) FROM user_recovery_codes WHERE user_id=...` = 10 |
| t5 | api | Audit | `auth.mfa_enrolled` existe |
| t6 | e2e | Agent sem modal | Login agent → goes direto |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<MfaEnrollModal>"
  - type: server_action
    id: "enrollMfa"
    signature: "() => Promise<{ factor_id, qr_svg, uri }>"
  - type: server_action
    id: "confirmMfaEnroll"
    signature: "(code: string) => Promise<{ recovery_codes: string[] }>"
  - type: domain_event
    id: "audit.auth.mfa_enrolled"
```

#### Decisões a registrar

- **D-01.08**: Force-MFA é gating do layout `(app)`, não do middleware — escolha pra evitar cold path no middleware (DB query extra) e centralizar a lógica de produto

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): force mfa enrollment [wave 11]`
- [ ] Regression: agent ainda acessa app sem modal; admin com MFA ainda passa direto

---

### S-01.12 — Recovery codes generation + display once + copy

**Points**: 2 | **Priority**: P0 | **Deps**: S-01.11 | **FR refs**: Spec 01 §4.5, Journeys J4 step 4

#### Contexto

Componente `<RecoveryCodesPanel>` reusável: lista 10 codes em grid 2×5, botões "Copiar todos" (clipboard), "Baixar .txt" (blob download), e checkbox obrigatório "Salvei meus códigos em local seguro". Usado em (a) modal de enrollment (S-01.11) e (b) `/app/settings/security/mfa` (regenerate — Server Action `regenerateRecoveryCodes` do catálogo Spec 09 §11, wireado em EPIC-10 mas componente exposto agora).

#### Files to create

- `components/auth/RecoveryCodesPanel.tsx`
- `lib/auth/recovery-codes.ts` — gerador (10 × 8 chars `[A-Z0-9]`, sem ambíguos `0/O/1/I`)

#### Files to modify

- `components/auth/MfaEnrollModal.tsx` — usar `<RecoveryCodesPanel>` na fase pós-verify

#### Implementation steps

1. `generateRecoveryCodes(): string[]` em `lib/auth/recovery-codes.ts` — `crypto.randomBytes` + base32 alphabet sem `0OIL1`
2. `<RecoveryCodesPanel>` com props `{ codes: string[], onAcknowledge: () => void }`
3. Grid 2×5 mono font; copy via `navigator.clipboard.writeText(codes.join('\n'))`
4. Download .txt via `Blob` + `URL.createObjectURL`
5. Checkbox + botão "Continuar" disabled até checkbox marcado
6. Toast success após copy

#### Acceptance Criteria

```gherkin
Given recovery codes view
When clico em "Copiar todos"
Then clipboard contém 10 linhas
And toast "Códigos copiados" aparece
```

```gherkin
Given recovery codes view
When clico em "Baixar .txt"
Then download de recovery-codes.txt inicia com 10 linhas
```

```gherkin
Given recovery codes view
When não marco checkbox
Then botão Continuar fica disabled
```

```gherkin
Given gero 10 codes
When inspeciono
Then nenhum contém 0/O/1/I/L
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Copy clipboard | Click → assert clipboard via Playwright `evaluate(navigator.clipboard.readText)` |
| t2 | e2e | Download .txt | Click → expect download event |
| t3 | unit | Gerador sem ambíguos | Vitest: gera 1000× e assert nenhum char ambíguo |
| t4 | a11y | Continuar disabled | Inspect aria-disabled |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "<RecoveryCodesPanel>"
  - type: lib
    id: "lib/auth/recovery-codes"
    api: "generateRecoveryCodes(): string[]"
```

#### Definition of Done

- [ ] ACs passam
- [ ] Commit `feat(EPIC-01): recovery codes panel [wave 12]`
- [ ] **Regression suite cumulativa do epic verde**

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering | 14 | S-01.02, .04, .05, .08, .09, .10, .11, .12 |
| Server Actions / API | 9 | S-01.03, .04, .05, .07, .10, .11 (×2) |
| RLS / audit | 6 | S-01.03, .04, .05, .07, .11 |
| Middleware redirect | 3 | S-01.01 |
| RBAC unit | 4 | S-01.06 |
| A11y (tab order, aria-current, dropdown keyboard) | 4 | S-01.02, .09, .10 |
| Persistência cookie (sidebar, theme, active_org) | 3 | S-01.08, .09, .10 |
| **Total** | **~43** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Cookie name divergente entre dev e prod quebra refresh silenciosamente | Alta | D-01.01: nome único `sb-deskcomm-auth` em todos envs; teste cobre |
| Middleware DB roundtrip (`fn_is_platform_admin`) adiciona latência em `/admin/*` | Média | Aceitar — só super-admin paga; cache curto opcional em wave futura |
| Auto-refresh JWT a cada 40min causa request burst se 100+ usuários | Baixa | Spread aleatório: `40min + jitter(0-2min)` no `setInterval` |
| Force-MFA modal pode ser bypassado se layout falhar | Alta | Server-side check no layout (não client); render condicional total — Sidebar/TopBar simplesmente não montam |
| Recovery codes vazam via log se devs logarem `confirmMfaEnroll` retorno | Crítica | Audit metadata exclui codes; lint rule futura proíbe `console.log` no path `app/actions/auth/*` |
| TOTP input com auto-submit dispara antes de paste completo | Baixa | Detect paste event e diferir submit por 50ms |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-13**: Hooks de domínio crítico (auth) ficam em `lib/auth/hooks/`, não em `hooks/` — separação de blast radius (D-01.06)
- **ADR-14**: Cookie de sessão Supabase nomeado `sb-deskcomm-auth` em todos os ambientes (D-01.01)
- **ADR-15**: Force-MFA é gating do layout `(app)`, não do middleware (D-01.08)
- **ADR-16**: Login flow é Server Action (não API route) — API route reservada pra Bearer/server-to-server (D-01.04)
- **ADR-17**: JWT auto-refresh a cada 40min com jitter no `useAuth`

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/01-sitemap.md` §2 (auth), `02-journeys.md` J1 e J4
- Specs refs: `01-spec-platform-base.md` §4 (auth flow), §5 (RBAC), §6.1 (audit auth.*); `09-spec-frontend-backend-integration.md` §3 (auth propagation), §11 (Server Actions), §13 Tier 1
- Design system refs: `06-components.md` (Avatar, DropdownMenu, Dialog, Toast), `05-iconography-phosphor.md`, `04-density-aerada.md`, `08-accessibility.md`
- Business rules: L-04 (force-MFA admin), T-02 (audit cross-tenant), T-06 (seed)
- Reconciliation log: ver `docs/specs/RECONCILIATION-LOG.md` pra eventuais R-XX que tocam auth

---

## ✅ Wave Completion Log

Concluído em 2026-04-28 (sessões 1-2).

| Wave | Story | Commit |
|------|-------|--------|
| 1 | S-01.01 Middleware proteção (cookie sb-deskcomm-auth) | `1310d4e` |
| 2 | S-01.02 /login page (RHF+Zod) | `60990bb` |
| 3 | S-01.03 signInWithPassword + audit | `60990bb` |
| 4 | S-01.04 /login/mfa challenge (TOTPInput auto-advance) | `b7acbc6` |
| 5 | S-01.05 /login/recovery + useRecoveryCode | `b7acbc6` |
| 6 | S-01.06 useAuth/useUser/useActiveOrg/usePermission | `efb1b55` |
| 7 | S-01.07 signOut action | `efb1b55` |
| 8 | S-01.08 app/(app)/layout.tsx → app/app/layout.tsx | `d7de254` + `a078f83` |
| 9 | S-01.09 Sidebar + collapse | `d7de254` |
| 10 | S-01.10 TopBar + TenantSwitcher + UserMenu | `d7de254` |
| 11 | S-01.11 MfaEnrollGate + MfaEnrollModal | `b7acbc6` |
| 12 | S-01.12 RecoveryCodesPanel + lib/auth/recovery-codes | `b7acbc6` |

### Bugs caçados na E2E manual
1. Cookie name mismatch (server.ts/browser.ts não passavam cookieOptions.name)
2. Server Action cookie propagation race — fixado com `redirect()` server-side
3. Route group `(app)` produzia URLs sem `/app` prefix → renomeado pra `app/app/`
4. Phosphor icons em RSC — usar variant `/dist/ssr`
5. `organizations.name` não existe — schema real tem `display_name`
6. Service role placeholder — refatorado pra user-scoped client + RLS-safe queries

### Seed admin user
- Email: `info@songhai.cc` / Senha: `DeskcommAdmin@2026` (TROCAR APÓS PRIMEIRO LOGIN)
- Criado via GoTrue REST signup + email confirmado via SQL + membership inserida
- Role: admin → MfaEnrollGate aparece no primeiro login
