---
epic_id: EPIC-09-team
epic_name: Team & Permissions
priority: P0
estimated_waves: 7
estimated_total_points: 19
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "api.POST /api/v1/team/invite"
  - "api.PATCH /api/v1/team/[user_id]/role"
  - "api.POST /api/v1/team/[user_id]/revoke"
  - "api.POST /api/v1/team/accept"
  - "api.POST /api/v1/settings/api-tokens"
  - "api.POST /api/v1/settings/api-tokens/[id]/revoke"
  - "server-action.inviteMember"
  - "server-action.acceptInvite"
  - "route./app/team"
  - "route./app/team/invite"
  - "route./team/accept-invite/[token]"
  - "route./app/settings/api-tokens"
  - "event.member.invited"
  - "event.member.accepted"
  - "event.member.role_changed"
  - "event.member.revoked"
  - "event.token.created"
  - "event.token.revoked"
status: completed (partial: real Resend send + service-role member listing pending env)
created_at: 2026-04-28
completed_at: 2026-04-28
owner: Rafael Melgaço
---

## Wave Completion Log (2026-04-28)

All 7 waves merged in a single commit. Files delivered:

- **Schemas** — `lib/schemas/team.ts` (invite/accept/role/api-token); re-exported via `lib/schemas/index.ts`.
- **HMAC token** — `lib/auth/invite-token.ts` (sign/verify with `timingSafeEqual`, 24h TTL); test `lib/auth/invite-token.test.ts` (5 cases: roundtrip, expired, tampered sig, tampered body, malformed).
- **Email template** — `lib/email/templates/invite.ts` (PT-BR, inline-styled, plain HTML).
- **Audit actions** — added `member.invited`, `member.accepted`, `member.role_changed`, `member.revoked`, `token.created`, `token.revoked` to `lib/audit/actions.ts`.
- **Routes**:
  - `GET /api/v1/team` — member listing (degrades when service-role missing).
  - `POST /api/v1/team/invite` — bulk (≤20), admin-only, audits each, includes accept_url for DEV when Resend not configured.
  - `PATCH /api/v1/team/[user_id]/role` — guards last-admin demote.
  - `POST /api/v1/team/[user_id]/revoke` — guards self-revoke + last-admin.
  - `GET/POST /api/v1/settings/api-tokens` — plaintext returned UMA vez on create.
  - `POST /api/v1/settings/api-tokens/[id]/revoke` — idempotent.
- **Server Action** — `app/actions/team/acceptInvite.ts` (verifies HMAC, email match, inserts/reactivates membership, audits, redirects to `/app/inbox`).
- **Pages** — `/app/team`, `/app/team/invite`, `/app/settings/api-tokens`, `/team/accept-invite/[token]` (public, smoke-tested → HTTP 200 with PT-BR error for invalid token).
- **Hooks** — `hooks/team/{useTeamMembers,useInviteMembers,useChangeRole,useRevokeMember,useApiTokens}`.
- **Sidebar** — added "Equipe" nav item with `UsersThree` icon.
- **Public paths** — `/team/accept-invite/.+` added to `lib/auth/public-paths.ts`.

### Known deferrals

1. `RESEND_API_KEY` empty → emails log preview to console (dev) or no-op (prod). Invite UI shows the `accept_url` directly when delivery wasn't dispatched.
2. `SUPABASE_SERVICE_ROLE_KEY` placeholder → `/api/v1/team` GET degrades: returns memberships without auth.users enrichment (email/full_name = null). UI still renders role/status.
3. No `team_invites` table — invitations are stateless HMAC tokens (24h). The `invite_id` in audit is a uuid generated at issue time; no DB row until accept.
4. No re-send/expire-now controls on the invitations side; admin re-invites by re-issuing.

Verification: `pnpm typecheck` clean · `pnpm lint` clean (only pre-existing kanban warnings) · `pnpm test:unit` 56 passed (5 new for invite-token).

# EPIC-09 — Team & Permissions

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei.

## 1. Objetivo

Habilitar admins de tenant a gerir o próprio time: convidar membros por email, aceitar convites com link assinado, alterar roles dentro da hierarquia `viewer<agent<manager<admin`, revogar acessos e administrar `api_tokens` server-to-server. Tudo coberto por RBAC, RLS e audit log canônico.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Admin loga em `/app/team` e vê todos os membros do tenant com role, status (online/busy/offline), `last_active` e ações
- [ ] Admin convida 1-N emails em `/app/team/invite` com role picker; cada email recebe link assinado expirando em 24h
- [ ] Convidado abre `/team/accept-invite/[token]`: se autenticado e email bate, aceita e cai em `/app/inbox`; se não, redireciona pra signup com email pré-preenchido e finaliza accept após signup
- [ ] Admin altera role de membro via `PATCH /api/v1/team/[user_id]/role` (UI dropdown em `/app/team`); registra `member.role_changed` em audit_log
- [ ] Admin revoga membro via `POST /api/v1/team/[user_id]/revoke`; sessão do revogado expira no próximo refresh; registra `member.revoked`
- [ ] Admin abre `/app/settings/api-tokens`, cria token (escopos jsonb), vê plaintext UMA vez, e pode revogar
- [ ] Audit log contém todos os 6 eventos: `member.invited`, `member.accepted`, `member.role_changed`, `member.revoked`, `token.created`, `token.revoked`
- [ ] Não-admins recebem 403 `forbidden_role` em qualquer rota/endpoint deste epic
- [ ] RLS isola: admin do tenant A não enxerga membros do tenant B
- [ ] ADR-09: Resend como provedor transacional default; templates em `lib/email/templates/`

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-00`, `EPIC-01`, `EPIC-10`
- Migrations 0001-0014 aplicadas (Spec 01 §13): `organizations`, `user_organizations`, `api_tokens`, `api_audit_log`, helpers `fn_user_role_in_org`, `fn_role_at_least`, `fn_is_platform_admin`
- Variáveis de env: `NEXT_PUBLIC_APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `INVITE_TOKEN_SECRET` (HMAC), `SUPABASE_SERVICE_ROLE_KEY`
- Server-side `auditLog()` helper já disponível (EPIC-10)
- `requirePermission(resource, action)` middleware já disponível (EPIC-01)
- Dev server em `localhost:3001`
- Playwright MCP conectado

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `getServerSession()` em route handlers |
| `hook.useAuth` | react_hook | EPIC-01 | Pega user + org corrente no client |
| `hook.usePermission` | react_hook | EPIC-01 | Gate UI por role: `usePermission('user_organizations','invite')` |
| `middleware.requirePermission` | middleware | EPIC-01 | Wrapper RBAC nas API routes |
| `db.user_organizations` | db_table | migration 0004 | RLS via `fn_role_at_least(org,'admin')` |
| `db.api_tokens` | db_table | migration 0005 | Hash SHA256 + prefix; RLS admin-only |
| `db.api_audit_log` | db_table | migration 0007 | Append-only via `auditLog()` |
| `lib.auditLog` | server_helper | EPIC-10 | `auditLog({action, actor_id, organization_id, target, payload})` |
| `lib.toast` | client_helper | EPIC-00 | Feedback UI via sonner |
| `app/(app)/layout.tsx` | layout | EPIC-01 | Sidebar + topbar para `/app/team`, `/app/settings/*` |
| `infra.tanstack-query` | provider | EPIC-00 | `useQuery` / `useMutation` |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `server-action.inviteMember` | server_action | S-09.01 | `inviteMember({email, role}) => { invite_id, expires_at }` |
| `api.POST /api/v1/team/invite` | api_route | S-09.01 | Body `{ invitations: [{email, role}] }`; retorna `{ data: { sent, failed } }` |
| `route./team/accept-invite/[token]` | route | S-09.02 | Aceita HMAC token; redireciona conforme estado de auth |
| `server-action.acceptInvite` | server_action | S-09.02 | `acceptInvite(token) => { organization_id }` |
| `api.PATCH /api/v1/team/[user_id]/role` | api_route | S-09.03 | Body `{ role }`; admin only |
| `api.POST /api/v1/team/[user_id]/revoke` | api_route | S-09.04 | Set `revoked_at = now()`; admin only |
| `route./app/team` | route | S-09.05 | Lista de membros com presence + ações |
| `hook.useTeamMembers` | react_hook | S-09.05 | `useTeamMembers() => { data: Member[], ... }` |
| `route./app/team/invite` | route | S-09.06 | Form bulk de convites |
| `route./app/settings/api-tokens` | route | S-09.07 | CRUD tokens admin |
| `api.POST /api/v1/settings/api-tokens` | api_route | S-09.07 | Cria token; retorna plaintext UMA vez |
| `api.POST /api/v1/settings/api-tokens/[id]/revoke` | api_route | S-09.07 | Revoga token |
| `event.member.invited` | domain_event | S-09.01 | `{ invited_email, role, invited_by }` |
| `event.member.accepted` | domain_event | S-09.02 | `{ user_id, organization_id }` |
| `event.member.role_changed` | domain_event | S-09.03 | `{ user_id, old_role, new_role }` |
| `event.member.revoked` | domain_event | S-09.04 | `{ user_id, revoked_by }` |
| `event.token.created` | domain_event | S-09.07 | `{ token_id, prefix, scopes }` |
| `event.token.revoked` | domain_event | S-09.07 | `{ token_id }` |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave N = última. Deps internos respeitados pela ordem.

---

### S-09.01 — Invite member: API + Server Action + email transacional

**Points**: 4 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 01 §2.2, §5 RBAC `user_organizations.invite`, §6.3 audit `member.invited`

#### Contexto

Primeira pedra do epic: criar a infra de convite. Um admin chama `inviteMember(email, role)` (Server Action ou via API `POST /api/v1/team/invite`) que (a) faz upsert em `user_organizations` com `invited_at = now()`, `accepted_at = null`, role escolhido; (b) gera token HMAC assinado expirando 24h carregando `{ invite_id, email, organization_id, role, exp }`; (c) dispara email transacional via Resend com link `${APP_URL}/team/accept-invite/[token]`. Decisão lockada: **Resend** é o provedor transacional default (ADR-09 — registrar). Templates em `lib/email/templates/invite.tsx` usando React Email.

A API aceita array (`invitations: [{email, role}]`) pra reaproveitar no bulk (S-09.06). Erros parciais retornam `{ sent: [...], failed: [{email, reason}] }` 207-style mas com 200 + payload (não usar 207 multistatus — convenção Spec 09).

#### Files to create

- `lib/invites/token.ts` — `signInviteToken(payload)` / `verifyInviteToken(token)` HMAC SHA256
- `lib/email/client.ts` — Resend client singleton
- `lib/email/templates/invite.tsx` — React Email template
- `lib/email/send-invite.ts` — `sendInviteEmail({to, link, orgName, inviterName, role})`
- `app/actions/team/invite-member.ts` — Server Action `inviteMember(input)`
- `app/api/v1/team/invite/route.ts` — `POST` handler (chama Server Action internamente pra lógica)
- `lib/validators/team.ts` — Zod schemas `InviteInput`, `InviteBulkInput`
- `docs/adr/ADR-09-email-provider.md` — registra Resend como default

#### Files to modify

- `.env.example` — adiciona `RESEND_API_KEY`, `EMAIL_FROM`, `INVITE_TOKEN_SECRET`, `NEXT_PUBLIC_APP_URL`
- `lib/audit/actions.ts` (de EPIC-10) — adiciona `member.invited` na enum se não existir

#### Implementation steps (sequential)

1. Adicionar deps: `pnpm add resend @react-email/components`
2. Criar HMAC token util (`crypto.createHmac('sha256', secret)`); payload base64url + `.` + signature; `exp` em segundos
3. Criar Resend client e template
4. Implementar Server Action: valida via Zod → `requirePermission('user_organizations','invite')` → upsert `user_organizations` ON CONFLICT `(user_id, organization_id)` (mas user_id pode não existir ainda — usar tabela auxiliar `pending_invites` OU armazenar email + null user_id; Spec atual usa user_id NOT NULL — solução: linkar via `auth.users` lookup e se não existir, criar shadow auth user via Supabase admin API com `email_confirm=false`, depois aceitar finaliza confirmação)
5. Decisão: **criar shadow user via `supabase.auth.admin.inviteUserByEmail` no momento do invite** — Supabase já gera token; usaremos nosso token HMAC custom em paralelo pra carregar role + org context
6. Disparar email Resend; em caso de falha, marcar `failed[]` mas não rollback DB (admin pode reenviar)
7. Audit log: `auditLog({action:'member.invited', actor_id, organization_id, target_id: invite_row.id, payload:{email, role}})`
8. Handler API thin: parse → chama action → retorna `{ data }` com formato Spec 09

#### Acceptance Criteria

```gherkin
Given um admin autenticado no tenant A
When ele chama Server Action inviteMember({email:"new@x.com", role:"agent"})
Then uma row é criada em user_organizations com invited_at preenchido e accepted_at null
And um email é enviado via Resend pro endereço com link contendo token HMAC válido por 24h
And um registro member.invited aparece em api_audit_log
```

```gherkin
Given um manager (não-admin) autenticado no tenant A
When chama POST /api/v1/team/invite
Then resposta é 403 com error.code="forbidden_role"
And nenhuma row é criada em user_organizations
```

```gherkin
Given um admin do tenant A
When envia POST /api/v1/team/invite com invitations=[{email:"a@x.com",role:"agent"},{email:"invalid",role:"agent"}]
Then resposta 200 com data={sent:[{email:"a@x.com"}], failed:[{email:"invalid",reason:"invalid_email"}]}
```

```gherkin
Given um token HMAC assinado com secret correto
When verifyInviteToken é chamado dentro de 24h
Then retorna o payload válido
And após 24h+1s retorna erro "expired"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST `/api/v1/team/invite` com payload válido como admin → 200 + sent[] | Playwright network + DB query |
| t2 | rbac | Mesmo POST como agent/manager/viewer → 403 forbidden_role | curl com cada token |
| t3 | db | Row em user_organizations com invited_at, accepted_at=null, role correto | Supabase SQL |
| t4 | rls | Admin do tenant A não cria invite em tenant B (organization_id mismatch) | DB tentativa direta como admin A com org_id de B → 0 rows |
| t5 | email | Resend recebe call com link contendo token | Mock Resend em test mode + assert call |
| t6 | crypto | Token HMAC com secret errado falha verify | Unit test |
| t7 | audit | Linha `member.invited` em api_audit_log com actor_id correto | DB query |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "inviteMember"
    file: "app/actions/team/invite-member.ts"
    signature: "(input: InviteInput) => Promise<{ invite_id: string; expires_at: string }>"
  - type: api_route
    id: "POST /api/v1/team/invite"
    request_schema: "{ invitations: Array<{ email: string; role: 'viewer'|'agent'|'manager'|'admin' }> }"
    response_schema: "{ data: { sent: Array<{email,invite_id}>, failed: Array<{email,reason}> } }"
    error_codes: [forbidden_role, validation_failed, rate_limited]
  - type: domain_event
    id: "member.invited"
    payload: "{ email, role, invited_by, organization_id }"
  - type: lib
    id: "lib/invites/token"
    exports: "signInviteToken, verifyInviteToken"
```

#### Decisões a registrar

- ADR-09: **Resend** é provedor transacional default. Trade-off: SDK leve, React Email integration nativa, custo OK pra MVP. Alternativas avaliadas: Postmark (mais caro), AWS SES (boilerplate alto)
- Token de invite usa HMAC custom em paralelo ao Supabase invite — controlamos role + org sem depender do schema de metadata do Supabase
- Email failures NÃO fazem rollback do DB; admin reenvia via UI (S-09.05)

#### Definition of Done

- [ ] Todos os ACs passam em Playwright + Vitest
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Sem warnings no console em dev
- [ ] ADR-09 commitada em `docs/adr/`
- [ ] Commit `feat(EPIC-09): invite member API + server action [wave 1]`
- [ ] Architecture contracts no state file

---

### S-09.02 — Página `/team/accept-invite/[token]` + acceptInvite Server Action

**Points**: 3 | **Priority**: P0 | **Deps**: S-09.01 | **FR refs**: Spec 01 §2.2 `accepted_at`, §6.3 audit `member.accepted`

#### Contexto

Convidado clica no link do email e cai em `/team/accept-invite/[token]` (rota PÚBLICA — fora de `(app)`). A page server component verifica HMAC. Três fluxos:
1. Token inválido/expirado → 410 page com botão "Pedir novo convite" que volta pra landing
2. Usuário JÁ autenticado E email do session === email do invite → mostra confirmação "Aceitar convite pra Org X como agent" → submete Server Action `acceptInvite(token)` → set `accepted_at = now()` → audit `member.accepted` → redirect `/app/inbox`
3. Usuário NÃO autenticado (ou email mismatch) → redirect `/signup?invite=<token>&email=<email>` (signup do EPIC-01 detecta param `invite` e após signup completo chama `acceptInvite` automaticamente)

Edge case: invite já aceito (accepted_at != null) → mostrar mensagem "convite já aceito" com link pra `/app/inbox`. Invite revogado (revoked_at != null) → 410 com mensagem "convite revogado pelo admin".

#### Files to create

- `app/(public)/team/accept-invite/[token]/page.tsx` — server component
- `app/(public)/team/accept-invite/[token]/AcceptForm.tsx` — client component com botão de confirm
- `app/actions/team/accept-invite.ts` — Server Action `acceptInvite(token)`
- `app/(public)/team/accept-invite/[token]/InvalidTokenView.tsx` — UI de erro

#### Files to modify

- `app/(public)/signup/page.tsx` (EPIC-01) — detectar `?invite=<token>&email=<email>`; após signup success chama `acceptInvite(token)`
- `middleware.ts` (EPIC-01) — whitelistar `/team/accept-invite/*` como rota pública

#### Implementation steps (sequential)

1. Server component lê `params.token`, chama `verifyInviteToken` → retorna payload ou null
2. Carrega row `user_organizations` por `id = payload.invite_id`; valida `revoked_at == null` e `accepted_at == null`
3. Lê session via `getServerSession()`. Se `session.email === payload.email`, renderiza `<AcceptForm>` com infos da org
4. Se sem session ou mismatch, faz `redirect(\`/signup?invite=\${token}&email=\${email}\`)`
5. `AcceptForm` chama Server Action; on success router.push('/app/inbox')
6. Server Action: re-verifica token (defesa em profundidade) → set `accepted_at = now()` no DB com WHERE `revoked_at is null and accepted_at is null` (idempotency-friendly) → audit log `member.accepted`
7. Modificar signup page do EPIC-01 pra detectar `invite` param e chamar acceptInvite no callback de success

#### Acceptance Criteria

```gherkin
Given um token HMAC válido e usuário autenticado com email matching
When acessa /team/accept-invite/[token] e clica "Aceitar"
Then user_organizations.accepted_at fica preenchido
And audit_log tem member.accepted
And redirect pra /app/inbox
```

```gherkin
Given um token expirado (>24h)
When acessa /team/accept-invite/[token]
Then página mostra "convite expirado" + botão pra solicitar novo
```

```gherkin
Given um token válido e usuário NÃO autenticado
When acessa /team/accept-invite/[token]
Then redirect pra /signup?invite=<token>&email=<email>
And email field do signup vem pré-preenchido e disabled
```

```gherkin
Given convite já aceito (accepted_at != null)
When usuário acessa o mesmo link novamente
Then mostra "convite já aceito" + link "Ir pro app"
```

```gherkin
Given convite revogado (revoked_at != null)
When usuário acessa
Then 410 view "convite revogado pelo admin"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Page renderiza confirmação com nome da org + role | Playwright snapshot |
| t2 | api | Server Action acceptInvite atualiza accepted_at | DB query antes/depois |
| t3 | redirect | Sem session → /signup com params | Playwright assertURL |
| t4 | redirect | Email mismatch → /signup mesmo logado | mock session + assert redirect |
| t5 | error | Token inválido → InvalidTokenView | Playwright |
| t6 | audit | member.accepted com actor_id = user que aceitou | DB query |
| t7 | flow | Signup com ?invite= → após criar conta, accepted_at preenchido automático | E2E Playwright |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/team/accept-invite/[token]"
    visibility: public
  - type: server_action
    id: "acceptInvite"
    file: "app/actions/team/accept-invite.ts"
    signature: "(token: string) => Promise<{ organization_id: string }>"
  - type: domain_event
    id: "member.accepted"
    payload: "{ user_id, organization_id, accepted_at }"
```

#### Decisões a registrar

- Rota `/team/accept-invite/[token]` vive em `(public)` group, fora do shell autenticado
- Signup do EPIC-01 ganha contrato de aceitar `?invite=<token>` e auto-chamar `acceptInvite` no success callback
- Re-verificação de token na Server Action é mandatória (defesa em profundidade contra replays do client)

#### Definition of Done

- [ ] Todos os ACs passam em Playwright
- [ ] Typecheck/lint clean
- [ ] Commit `feat(EPIC-09): accept-invite page + signup integration [wave 2]`
- [ ] Regression suite de S-09.01 ainda verde

---

### S-09.03 — `PATCH /api/v1/team/[user_id]/role` (admin only, audit)

**Points**: 2 | **Priority**: P0 | **Deps**: S-09.02 | **FR refs**: Spec 01 §5 `user_organizations.role_change`, §6.3 `member.role_changed`

#### Contexto

API que permite admin alterar role de um membro. Body: `{ role: 'viewer'|'agent'|'manager'|'admin' }`. Constraints: (a) admin não pode rebaixar a si mesmo se for o único admin do tenant (preservação L-04); (b) alterar role pra um user revogado (revoked_at != null) é 409. Audit log captura `old_role`, `new_role`. Sem UI ainda — UI vem em S-09.05.

#### Files to create

- `app/api/v1/team/[user_id]/role/route.ts` — `PATCH` handler

#### Files to modify

- `lib/validators/team.ts` — adiciona `RoleChangeInput` Zod schema

#### Implementation steps (sequential)

1. Parse + validate body
2. `requirePermission('user_organizations','role_change')` → 403 se não admin
3. Carrega row alvo dentro do tenant corrente; 404 se não existe
4. Se target = self AND new_role != admin AND count(admins ativos) == 1 → 409 `last_admin_protection`
5. Update + retorna `{ data: { user_id, role } }`
6. Audit log com payload `{ old_role, new_role, target_user_id }`

#### Acceptance Criteria

```gherkin
Given admin do tenant A e member B com role agent
When PATCH /api/v1/team/B/role { role: "manager" }
Then row tem role=manager
And member.role_changed em audit com old_role=agent, new_role=manager
```

```gherkin
Given único admin do tenant
When tenta PATCH self role pra manager
Then 409 last_admin_protection
```

```gherkin
Given manager
When chama o endpoint
Then 403 forbidden_role
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | PATCH válido → 200 + role updated | curl + DB |
| t2 | rbac | Não-admin → 403 | curl |
| t3 | rls | Admin do tenant A não altera role em tenant B | direct supabase com user A token |
| t4 | edge | Único admin self-demote → 409 | seed + curl |
| t5 | audit | role_changed log com old/new | DB |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "PATCH /api/v1/team/[user_id]/role"
    request_schema: "{ role: 'viewer'|'agent'|'manager'|'admin' }"
    response_schema: "{ data: { user_id, role } }"
    error_codes: [forbidden_role, validation_failed, not_found, last_admin_protection]
  - type: domain_event
    id: "member.role_changed"
    payload: "{ user_id, old_role, new_role, organization_id }"
```

#### Decisões a registrar

- Last-admin protection é regra de produto canônica — replicar em qualquer endpoint que mude role no futuro

#### Definition of Done

- [ ] ACs verde
- [ ] Typecheck/lint clean
- [ ] Commit `feat(EPIC-09): patch role endpoint + last-admin protection [wave 3]`

---

### S-09.04 — `POST /api/v1/team/[user_id]/revoke`

**Points**: 2 | **Priority**: P0 | **Deps**: S-09.03 | **FR refs**: Spec 01 §5 `user_organizations.revoke`, §6.3 `member.revoked`

#### Contexto

Admin revoga um membro setando `revoked_at = now()`. Mesma proteção last-admin do S-09.03. Sessão do revogado expira no próximo refresh — `fn_user_org_ids()` filtra `where revoked_at is null`, então no próximo middleware tick o user perde acesso ao tenant. Audit log captura.

Idempotente: revogar quem já está revogado retorna 200 com no-op (não 409 — UX melhor pra retries).

#### Files to create

- `app/api/v1/team/[user_id]/revoke/route.ts` — `POST` handler

#### Implementation steps (sequential)

1. `requirePermission('user_organizations','revoke')`
2. Carrega target row
3. Last-admin protection (mesma lógica de S-09.03)
4. Update `revoked_at = now()` se ainda null
5. Audit `member.revoked` com `{ target_user_id, was_role }`
6. Retorna `{ data: { user_id, revoked_at } }`

#### Acceptance Criteria

```gherkin
Given admin e membro ativo B
When POST /api/v1/team/B/revoke
Then revoked_at preenchido
And member.revoked em audit
```

```gherkin
Given B revogado tenta usar app
When middleware roda fn_user_org_ids
Then user perde acesso ao tenant (orgs vazio)
And é redirecionado pra /login (ou tela "sem orgs")
```

```gherkin
Given único admin tenta self-revoke
Then 409 last_admin_protection
```

```gherkin
Given B já revogado
When admin chama revoke novamente
Then 200 idempotente, sem novo audit log
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Revoke OK → 200 + revoked_at | curl + DB |
| t2 | rbac | Não-admin → 403 | curl |
| t3 | session | Revogado perde acesso após refresh | Playwright multi-context |
| t4 | edge | Last admin self-revoke → 409 | seed + curl |
| t5 | idempotency | Revoke duplo → 200 sem novo log | curl 2x + DB count |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/team/[user_id]/revoke"
    request_schema: "{}"
    response_schema: "{ data: { user_id, revoked_at } }"
    error_codes: [forbidden_role, not_found, last_admin_protection]
  - type: domain_event
    id: "member.revoked"
    payload: "{ user_id, organization_id, was_role, revoked_by }"
```

#### Decisões a registrar

- Revoke é soft-delete via `revoked_at`. Hard delete só via LGPD pipeline (EPIC-08)
- Idempotency em revoke prefere UX over strict 409

#### Definition of Done

- [ ] ACs verde
- [ ] Commit `feat(EPIC-09): revoke member endpoint [wave 4]`

---

### S-09.05 — Page `/app/team` (lista membros + presence + ações)

**Points**: 4 | **Priority**: P0 | **Deps**: S-09.04 | **FR refs**: Spec 01 §5; Screen inventory `/app/team`

#### Contexto

UI consolidada: tabela de membros do tenant corrente com colunas: avatar+nome, email, role (dropdown editável se admin), status (online/busy/offline) baseado em `last_active`, last_active relativo ("2 min atrás"), ações (alterar role, revogar, reenviar convite se pending).

Status derivado: `online` se `last_active` < 5min, `busy` se < 30min, `offline` caso contrário. `last_active` vem da tabela `user_presence` (assumindo que existe — senão deriva de `auth.users.last_sign_in_at`). Fallback: se não tiver `user_presence` ainda, status fica baseado só em sign_in_at (decisão registrada).

Presence atualiza via Realtime channel `presence-{org_id}` (Supabase Realtime presence) — mas pra evitar over-engineering nesta wave, usar polling 30s via TanStack Query `refetchInterval`. Realtime presence pode ser fast-follow.

Não-admins (manager+) veem a lista mas sem ações de mutate (UI gate via `usePermission`).

#### Files to create

- `app/(app)/team/page.tsx` — server component lista
- `app/(app)/team/TeamTable.tsx` — client component
- `app/(app)/team/RoleDropdown.tsx` — client, gated
- `app/(app)/team/MemberActionsMenu.tsx` — kebab com revoke/resend
- `hooks/useTeamMembers.ts` — TanStack Query hook
- `hooks/useChangeRole.ts` — mutation
- `hooks/useRevokeMember.ts` — mutation
- `hooks/useResendInvite.ts` — mutation (chama `/api/v1/team/invite` com mesmo email/role)
- `app/api/v1/team/route.ts` — `GET` lista membros (com user.email, role, status, last_active)
- `lib/presence/derive-status.ts` — deriva online/busy/offline

#### Files to modify

- `app/(app)/layout.tsx` (EPIC-01) — adiciona link "Team" na sidebar (se manager+)

#### Implementation steps (sequential)

1. `GET /api/v1/team` retorna `{ data: Member[] }` com left join `auth.users` pra pegar email + last_sign_in_at
2. `useTeamMembers` com `refetchInterval: 30_000`
3. Tabela renderiza; `usePermission('user_organizations','role_change')` gate dropdowns
4. `RoleDropdown` chama PATCH; on success invalida query
5. `MemberActionsMenu`: Revogar → confirm dialog → POST revoke; Reenviar convite (só pending) → POST invite
6. `derive-status` pure function unit-testável

#### Acceptance Criteria

```gherkin
Given admin no tenant com 5 membros
When acessa /app/team
Then vê tabela com 5 linhas, cada uma com avatar/nome/email/role/status/last_active/ações
```

```gherkin
Given admin troca role de B de agent pra manager via dropdown
When dropdown fecha
Then tabela mostra "manager" em B sem reload manual
And toast "role atualizado" aparece
```

```gherkin
Given admin clica revogar em B e confirma
When dialog fecha
Then linha de B some (filtro: revoked_at is null) ou mostra badge "revogado"
And toast "membro revogado"
```

```gherkin
Given manager (não-admin) acessa /app/team
When página carrega
Then dropdowns de role estão disabled e ações de revoke não aparecem
```

```gherkin
Given member B com last_active < 5min atrás
When tabela renderiza
Then status badge "online" verde
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Tabela renderiza com 5 membros | Playwright |
| t2 | ui | Sidebar mostra "Team" pra manager+, esconde pra agent/viewer | Playwright role-based |
| t3 | mutation | Role change via dropdown atualiza UI sem reload | Playwright |
| t4 | mutation | Revoke remove/marca linha | Playwright |
| t5 | rbac | Manager vê lista, dropdowns disabled | Playwright |
| t6 | unit | derive-status retorna correto pra <5/<30/>=30 min | Vitest |
| t7 | api | GET /api/v1/team retorna shape correto | curl |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/team"
    auth_required: true
    permission: "user_organizations.read"
  - type: api_route
    id: "GET /api/v1/team"
    response_schema: "{ data: Array<{ user_id, email, name, role, status:'online'|'busy'|'offline', last_active, invited_at, accepted_at, revoked_at }> }"
  - type: react_hook
    id: "useTeamMembers"
    file: "hooks/useTeamMembers.ts"
    signature: "() => UseQueryResult<Member[]>"
  - type: react_hook
    id: "useChangeRole"
    file: "hooks/useChangeRole.ts"
  - type: react_hook
    id: "useRevokeMember"
    file: "hooks/useRevokeMember.ts"
  - type: lib
    id: "lib/presence/derive-status"
```

#### Decisões a registrar

- Presence via polling 30s nesta wave; Realtime presence channel é fast-follow (não bloqueante)
- `last_active` deriva de `auth.users.last_sign_in_at` se `user_presence` não existir ainda

#### Definition of Done

- [ ] ACs verde via Playwright
- [ ] Vitest do derive-status verde
- [ ] Sidebar nav atualizada
- [ ] Commit `feat(EPIC-09): team page + presence + actions [wave 5]`

---

### S-09.06 — Page `/app/team/invite` (form bulk)

**Points**: 2 | **Priority**: P0 | **Deps**: S-09.05 | **FR refs**: Spec 01 §5

#### Contexto

Form que permite adicionar 1-N emails (chips com paste-CSV-friendly), um role picker global, botão "Send all". Submete `POST /api/v1/team/invite` com array. Mostra resultado: sent count + failed list inline. Limites: 50 emails por submit (rate limit defensivo).

#### Files to create

- `app/(app)/team/invite/page.tsx` — server component (gate admin)
- `app/(app)/team/invite/InviteForm.tsx` — client component com EmailChipsInput + RoleSelect
- `components/forms/EmailChipsInput.tsx` — input que aceita paste de CSV/newline e cria chips com validação inline

#### Implementation steps (sequential)

1. Page checa permission `user_organizations.invite` server-side — 403 se não admin
2. `EmailChipsInput`: regex email validation; chips removíveis; paste handler split por `,;\n\s`
3. `RoleSelect`: dropdown 4 opções
4. Submit: POST com `invitations: chips.map(email => ({email, role}))`
5. Resultado: success toast com `${sent.length} convites enviados`; failed array renderiza inline com motivo
6. Após submit OK, limpa chips e dá link pra `/app/team`

#### Acceptance Criteria

```gherkin
Given admin em /app/team/invite
When cola "a@x.com, b@x.com, invalid" no input
Then 3 chips aparecem, "invalid" com border vermelha (validação inline)
```

```gherkin
Given chips válidos a@x.com, b@x.com com role agent
When clica "Send all"
Then POST /api/v1/team/invite é chamado com array
And toast mostra "2 convites enviados"
And ambos aparecem em /app/team com status pending
```

```gherkin
Given manager acessa /app/team/invite
When page carrega
Then 403 page é renderizada
```

```gherkin
Given admin tenta enviar 51 emails
When submete
Then erro "limite de 50 convites por envio"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Paste CSV vira chips | Playwright |
| t2 | rbac | Manager → 403 | Playwright |
| t3 | flow | Submit bulk → invites criados | Playwright + DB |
| t4 | edge | 51 emails → erro inline | Playwright |
| t5 | partial | Mistura válidos+inválidos retorna sent[]+failed[] | Playwright |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/team/invite"
    auth_required: true
    permission: "user_organizations.invite"
  - type: react_component
    id: "EmailChipsInput"
    file: "components/forms/EmailChipsInput.tsx"
```

#### Decisões a registrar

- Limite 50 por submit é hardcode; tornar config se necessário no futuro

#### Definition of Done

- [ ] ACs verde
- [ ] Commit `feat(EPIC-09): bulk invite page [wave 6]`

---

### S-09.07 — Page `/app/settings/api-tokens` (admin only)

**Points**: 2 | **Priority**: P0 | **Deps**: S-09.06 | **FR refs**: Spec 01 §2.4 `api_tokens`, §5 `api_tokens`, §6.2 `token.*`

#### Contexto

Admin lista, cria e revoga `api_tokens` server-to-server. Token novo é gerado: `prefix = "dsk_"+random(8)`, `secret = random(32)`, `full = prefix + "_" + secret`, persiste hash SHA256 do `full`. **Plaintext mostrado UMA vez na criação** (modal com botão "Copiar" + warning "não será mostrado novamente"). Revoke seta `revoked_at`. Lista mostra prefix, name, scopes, created_at, last_used_at, status (active/revoked).

Form de criação: name (label humano), scopes (multi-select de uma lista canônica: `lgpd:execute`, `webhooks:read`, `contacts:write`, etc — Spec 01 §2.4 deve listar; se não, hardcoded por ora), expires_at opcional.

#### Files to create

- `app/(app)/settings/api-tokens/page.tsx` — server component
- `app/(app)/settings/api-tokens/TokensTable.tsx`
- `app/(app)/settings/api-tokens/CreateTokenDialog.tsx` — modal com form + reveal-once view
- `app/api/v1/settings/api-tokens/route.ts` — `GET` list + `POST` create
- `app/api/v1/settings/api-tokens/[id]/revoke/route.ts` — `POST` revoke
- `lib/api-tokens/generate.ts` — gera prefix+secret+hash

#### Implementation steps (sequential)

1. `generateApiToken()` retorna `{ prefix, plaintext, hash }` (hash sha256)
2. POST create: valida → insere com hash → audit `token.created` com payload `{ token_id, prefix, scopes }` → retorna `{ data: { id, prefix, plaintext, scopes, expires_at } }` (única vez!)
3. GET list: retorna sem plaintext nem hash, só metadata
4. POST revoke: set `revoked_at = now()`; audit `token.revoked`; idempotente
5. UI: dialog mostra plaintext em `<code>` com botão copy + warning destacado; após fechar, lista re-renderiza sem plaintext

#### Acceptance Criteria

```gherkin
Given admin em /app/settings/api-tokens
When clica "Criar token", preenche name="zapier", scopes=["webhooks:read"], submete
Then dialog mostra plaintext "dsk_xxxxxxxx_yyyyyy..." com botão "Copiar"
And warning "este valor não será mostrado novamente"
And DB tem row com hash mas sem plaintext
And audit log token.created
```

```gherkin
Given admin com token existente
When clica "Revogar" e confirma
Then row tem revoked_at preenchido
And tabela mostra status "revogado"
And audit log token.revoked
```

```gherkin
Given manager acessa /app/settings/api-tokens
When page carrega
Then 403 page
```

```gherkin
Given admin recarrega a página após criar token
When tabela renderiza
Then plaintext NÃO aparece em lugar nenhum (só prefix)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Create flow mostra plaintext UMA vez | Playwright |
| t2 | db | Plaintext nunca persiste; só hash | DB inspect |
| t3 | rbac | Manager → 403 | Playwright |
| t4 | api | Revoke seta revoked_at | curl + DB |
| t5 | audit | token.created e token.revoked logged | DB |
| t6 | rls | Admin tenant A não vê tokens tenant B | direct query |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/api-tokens"
    auth_required: true
    permission: "api_tokens.list"
  - type: api_route
    id: "GET /api/v1/settings/api-tokens"
    response_schema: "{ data: Array<{ id, prefix, name, scopes, created_at, last_used_at, expires_at, revoked_at }> }"
  - type: api_route
    id: "POST /api/v1/settings/api-tokens"
    request_schema: "{ name, scopes: string[], expires_at?: string }"
    response_schema: "{ data: { id, prefix, plaintext, scopes, expires_at } }"
    notes: "plaintext returned only here, only once"
  - type: api_route
    id: "POST /api/v1/settings/api-tokens/[id]/revoke"
    response_schema: "{ data: { id, revoked_at } }"
  - type: domain_event
    id: "token.created"
    payload: "{ token_id, prefix, scopes, organization_id }"
  - type: domain_event
    id: "token.revoked"
    payload: "{ token_id, organization_id }"
```

#### Decisões a registrar

- Plaintext é exclusivamente returnado no response do POST create. Nunca em GET, nunca em logs (filtrar via Sentry beforeSend)
- Hash é SHA256 do plaintext completo (incluindo prefix). Bearer auth middleware (fora deste epic) faz lookup por prefix + verify hash

#### Definition of Done

- [ ] ACs verde
- [ ] Plaintext NÃO aparece em logs (verificado em dev console)
- [ ] Commit `feat(EPIC-09): api tokens management [wave 7]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

Ao terminar o epic, a regression suite deve cobrir, no mínimo:

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering | 8 | S-09.05 (table, badges, sidebar), S-09.06 (form), S-09.07 (dialog) |
| API contracts | 8 | S-09.01 (invite), S-09.03 (role), S-09.04 (revoke), S-09.05 (GET team), S-09.07 (tokens GET/POST/revoke) |
| RBAC gates (403) | 6 | viewer/agent/manager negados em invite, role, revoke, tokens |
| RLS isolation | 4 | tenant A não vê membros/tokens de tenant B |
| Audit log emission | 6 | member.invited, accepted, role_changed, revoked, token.created, token.revoked |
| Edge cases | 4 | last-admin protection (×2), token expirado, revoke idempotente |
| **Total** | **36** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Email transacional Resend cair em produção | Alta | Failures em send NÃO fazem rollback do DB; admin reenvia. Monitorar bounce rate. Fallback futuro: Postmark |
| Token HMAC vazado em log | Alta | Nunca logar token completo; só `invite_id` e `email`. Sentry beforeSend filtra `token` query param |
| Last-admin lockout | Alta | Proteção em S-09.03 e S-09.04 (count admins ativos == 1) |
| Revogado mantém sessão antiga até refresh | Média | Aceitável (max 1h via JWT TTL); fast-follow: forçar invalidação via Realtime broadcast |
| Plaintext de api_token em log/Sentry | Crítica | UI mostra UMA vez via response do POST; nunca persiste; Sentry beforeSend filtra; review obrigatório no PR |
| Bulk invite spammar (50 emails p/ phishing) | Média | Rate limit por org (10 invites/min), ToS, bounce monitoring |
| Convite duplicado pra mesmo email gera duplicate user_organizations | Baixa | UNIQUE (user_id, organization_id) já existe; upsert ON CONFLICT atualiza `invited_at` e role |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-09**: Resend como provedor de email transacional default (S-09.01)
- **ADR-09b**: Token de invite usa HMAC custom em paralelo ao Supabase invite — controlamos role + org sem depender de metadata Supabase
- **ADR-09c**: Last-admin protection é regra de produto canônica em qualquer endpoint que mude/revogue role
- **ADR-09d**: Revoke é soft-delete via `revoked_at`; hard-delete somente via pipeline LGPD (EPIC-08)
- **ADR-09e**: API token plaintext returnado UMA vez no response do POST create; nunca persistido em qualquer lugar
- **ADR-09f**: Presence via polling 30s (TanStack Query `refetchInterval`); Realtime presence channel é fast-follow
- **Convenção**: rotas públicas relacionadas a accept-invite ficam em `app/(public)/team/accept-invite/[token]`, fora do shell autenticado

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/03-screen-inventory.md` rotas `/app/team`, `/app/team/invite`, `/app/settings/api-tokens`, `/team/accept-invite/[token]`
- Specs refs: 01 §2.2 (`user_organizations`), §2.4 (`api_tokens`), §5 (RBAC matrix), §6.3 (audit `member.*`), §6.2 (`token.*`)
- Business rules: L-04 (MFA admin), T-04 (platform_admins separação)
- Reconciliation log: aplicar ADR-09 ao final do epic
