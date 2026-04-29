---
epic_id: EPIC-10-audit-settings
epic_name: Audit & Settings
priority: P0
estimated_waves: 9
estimated_total_points: 26
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "route./app/audit"
  - "route./app/settings/profile"
  - "route./app/settings/security"
  - "route./app/settings/notifications"
  - "route./app/settings/tenant"
  - "route./app/settings/tenant/whatsapp"
  - "route./app/settings/billing"
  - "api.GET /api/v1/audit"
  - "api.GET/PATCH /api/v1/settings/profile"
  - "api.POST /api/v1/settings/security/mfa"
  - "api.POST /api/v1/settings/security/sessions/:id/revoke"
  - "api.GET/PATCH /api/v1/settings/notifications"
  - "api.GET/PATCH /api/v1/settings/tenant"
  - "action.updateTenant"
  - "action.updateProfile"
  - "action.updateNotificationPrefs"
  - "action.regenerateRecoveryCodes"
  - "action.revokeSession"
  - "event.org.updated"
  - "event.consent.changed"
  - "event.notification_pref.changed"
status: completed (partial: notification_prefs stubbed; sessions/storage/email change deferred)
created_at: 2026-04-28
completed_at: 2026-04-28
owner: Rafael Melgaço
---

## Wave Completion Log (2026-04-28)

Implemented in 9 waves with documented deferrals:

- **W1 — Audit API**: `GET /api/v1/audit` + `GET /api/v1/audit/export` (CSV, ≤10k rows). Filters: `actor_id`, `action` (ilike substring), `resource_type`, `from`, `to`, `cursor`, `limit≤100`. Keyset pagination over `(created_at DESC, id DESC)`. Manager+ gate (or `is_platform_admin`). Schema: `lib/schemas/audit.ts`.
- **W2 — Audit page**: `/app/audit` server-gated (manager+) with `useAuditQuery` infinite query, filter bar, CSV export button, empty state. Hook: `hooks/audit/useAuditQuery.ts`.
- **W3 — Profile**: `/app/settings/profile` editable `full_name/locale/timezone/avatar_url` via `auth.updateUser({ data: ... })`. Email read-only ("em breve"). Avatar = URL only (Storage upload deferred).
- **W4 — Security**: `/app/settings/security` reads MFA factor status; "Regenerar códigos de recuperação" wipes + reissues 10 codes (audited as `mfa.recovery_codes_regenerated`). "Sair de todos" = `signOut({ scope: 'global' })`. Per-session list **deferred** (requires service-role admin API).
- **W5 — Notifications [STUB]**: `/app/settings/notifications` shows 4 categories × 3 channels matrix with **disabled** toggles + amber banner. `updateNotificationPrefs` returns `feature_not_yet_available`. **`notification_prefs` table not migrated.**
- **W6 — Tenant**: `/app/settings/tenant` admin-only edits `display_name/legal_name/cnpj/timezone/locale/media_retention_days/dpo_email/privacy_policy_url` + `settings.lost_reasons_extra` (CSV input). Audited as `org.updated`, emits `org.updated` domain event.
- **W7 — WhatsApp**: `/app/settings/tenant/whatsapp` admin-only **read-only** list of `channel_sessions`. Edit/re-warm **deferred** (requires WAHA container).
- **W8 — Pipelines**: `/app/settings/tenant/pipelines` admin-only per-pipeline editor for vocabulary + `settings.fields` (JSON array) + `settings.lost_reasons`. Server Action `updatePipelineConfig` audited as `pipeline.config_updated`.
- **W9 — Billing**: `/app/settings/billing` static placeholder card pointing to `suporte@deskcomm.app`.

### Settings hub
`/app/settings/page.tsx` rewritten as a hub of cards routing to all subsections (admin/manager-aware visibility).

### Audit actions added (`lib/audit/actions.ts`)
`profile.updated`, `org.updated`, `pipeline.config_updated`, `mfa.recovery_codes_regenerated`, `notification_prefs.changed` (reserved for future).

### Deferrals
| Item | Reason |
|---|---|
| `notification_prefs` table + functional toggles | Table missing in current schema |
| Per-session listing on `/app/settings/security` | Requires `auth.admin.listSessions` (service role); replaced by global signout |
| WAHA writes (edit `daily_message_limit`, re-warm) | Requires running WAHA container |
| Avatar/logo upload to Supabase Storage | Requires service role + bucket creation |
| Email change confirmation flow | Requires Supabase confirmation-link infra |

### Verification
- `pnpm typecheck` clean (0 errors)
- `pnpm lint` clean (only pre-existing KanbanBoard warnings)
- `pnpm test:unit` 68/68 pass (added `lib/schemas/settings.test.ts` with 12 cases)
- Smoke (anon HTTP):
  - `GET /app/audit` → 307 → `/login?next=/app/audit`
  - `GET /app/settings/profile` → 307 → `/login?next=/app/settings/profile`
  - All `/app/settings/*` subroutes → 307 to `/login`
  - `GET /api/v1/audit` → 307 (middleware redirect for unauth)


# EPIC-10 — Audit & Settings

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. `Deps:` é lei. Stories de admin-only (S-10.02, S-10.06, S-10.07) precisam validar `usePermission('platform.admin')` antes de renderizar — qualquer bypass é bug crítico.

## 1. Objetivo

Entregar (a) viewer de audit log filtrável + exportável pra admins (Spec 01 §3.5), e (b) hub completo de Settings cobrindo perfil, segurança (MFA + sessões), notificações, configuração de tenant (vocabulary, custom fields, lost_reasons), WhatsApp/WAHA sessions e placeholder de billing. Ao final, todo write em `organizations`/`users`/`notification_prefs`/`waha_sessions` emite domain event canônico (Spec 01 §6) e cai no audit log.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Admin abre `/app/audit`, filtra por actor + action + resource_type + date range, paginação cursor funciona, export CSV baixa arquivo com mesma query
- [ ] Usuário comum acessando `/app/audit` recebe 403 (UI + API)
- [ ] `/app/settings/profile` permite editar nome, locale, timezone com optimistic update; troca de email exige confirmation por link
- [ ] Avatar upload via Supabase Storage (`avatars/` bucket) com preview + crop básico
- [ ] `/app/settings/security` mostra MFA status, permite enroll (TOTP) e disable (com double-confirm + senha), regenerar recovery codes (10 códigos one-time), listar sessions ativas com revoke individual
- [ ] `/app/settings/notifications` lista 4 categorias (nova msg, handoff, SLA LGPD, banimento WAHA) × 3 canais (email/in-app/push) com toggles persistindo em `notification_prefs`
- [ ] Admin abre `/app/settings/tenant` e edita: logo (upload), display_name, vocabulary por pipeline (lead/cliente/oportunidade), custom fields (add/edit/remove com tipo + required), lost_reasons (custom list)
- [ ] Admin abre `/app/settings/tenant/whatsapp` e vê 1-2 sessões WAHA com status (warming/active/banned), daily_limit por sessão editável, botão re-warm
- [ ] `/app/settings/billing` renderiza placeholder "Em breve" + link de contato (não bloqueia outras settings)
- [ ] Todo PATCH em tenant/profile/notifications/security emite evento canônico (`org.updated`, `consent.changed`, `notification_pref.changed`) no `event_log` E linha em `audit_log`
- [ ] Server Action `updateTenant(...)` faz `revalidatePath('/app/settings/tenant')` + `revalidateTag('tenant-config')`
- [ ] Regression suite: 100% das ACs cobertas em Playwright + RLS isolation em audit_log

## 3. Pré-requisitos

- EPIC-01 completo: `useAuth`, `usePermission`, app shell, middleware
- EPIC-09 completo: `roles` table populada, `fn_user_has_permission()` disponível
- Migration 0001-0007 aplicadas: tabelas `audit_log`, `event_log`, `notification_prefs`, `waha_sessions`, `organizations.vocabulary`, `organizations.custom_fields_schema`, `organizations.lost_reasons`, `users.locale`, `users.timezone`, `users.avatar_url`, `mfa_factors`, `recovery_codes`, `auth_sessions`
- Variáveis de env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WAHA_BASE_URL`
- Supabase Storage bucket `avatars` (public-read) + `tenant-logos` (public-read) criados
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()` retorna `{ user, organization_id }` |
| `hook.usePermission` | react_hook | EPIC-01 | `usePermission('platform.admin')` para gates de admin-only |
| `db.organizations` | db_table | migration 0001 | RLS via `fn_user_org_ids()`; updates só admin |
| `db.users` | db_table | migration 0001 | Edição self-only via `auth.uid()` |
| `db.audit_log` | db_table | migration 0003 | Append-only; query por filters |
| `db.event_log` | db_table | migration 0003 | Append eventos canônicos Spec 01 §6 |
| `db.notification_prefs` | db_table | migration 0004 | upsert por (user_id, category, channel) |
| `db.waha_sessions` | db_table | migration 0006 | Read+limited update por admin |
| `db.mfa_factors` / `recovery_codes` / `auth_sessions` | db_tables | migration 0002 | Self-only |
| `lib.toast` | toast | EPIC-00 | Sonner para feedback |
| `infra.tanstack-query` | query_provider | EPIC-00 | Mutations + invalidação |
| `hook.useApiClient` | react_hook | EPIC-00 | HTTP wrapper com idempotency-key |
| `lib.supabase.storage` | storage_client | EPIC-00 | Upload de avatar/logo |
| `vocab.canonical_actions` | spec | Spec 01 §6 | Source of truth pra `event_log.action` |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `api.GET /api/v1/audit` | api_route | S-10.01 | Query: `?actor_id&action&resource_type&from&to&cursor&limit` → `{ data: AuditEntry[], next_cursor }` |
| `route./app/audit` | route | S-10.02 | Admin-only; gate via `usePermission('platform.admin')` |
| `hook.useAuditQuery` | react_hook | S-10.01 | `useAuditQuery(filters): { data, fetchNextPage, isLoading }` (TanStack `useInfiniteQuery`) |
| `route./app/settings/profile` | route | S-10.03 | Self-edit |
| `action.updateProfile` | server_action | S-10.03 | `(input) => Promise<Result>` com `revalidatePath` |
| `route./app/settings/security` | route | S-10.04 | MFA + sessions |
| `action.regenerateRecoveryCodes` | server_action | S-10.04 | Retorna 10 códigos plaintext 1× |
| `action.revokeSession` | server_action | S-10.04 | Por session_id |
| `route./app/settings/notifications` | route | S-10.05 | Toggles de prefs |
| `action.updateNotificationPrefs` | server_action | S-10.05 | Upsert em batch |
| `route./app/settings/tenant` | route | S-10.06 | Admin-only |
| `action.updateTenant` | server_action | S-10.08 | `(patch) => Promise<Result>` com `revalidatePath('/app/settings/tenant')` + `revalidateTag('tenant-config')` |
| `route./app/settings/tenant/whatsapp` | route | S-10.07 | Admin-only WAHA panel |
| `route./app/settings/billing` | route | S-10.09 | Placeholder Fase 2 |
| `event.org.updated` | domain_event | S-10.06/S-10.08 | Payload `{ organization_id, fields: string[], by: user_id }` |
| `event.consent.changed` | domain_event | S-10.04 | Payload `{ user_id, consent_type, value, at }` (MFA enroll/disable) |
| `event.notification_pref.changed` | domain_event | S-10.05 | Payload `{ user_id, category, channel, enabled }` |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave. Wave 1 = S-10.01.

---

### S-10.01 — API `GET /api/v1/audit` com filters + cursor pagination

**Points**: 3 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 01 §3.5, Spec 09 §4.2 (cursor pagination canon)

#### Contexto

Endpoint que serve a tabela de audit log. Admin-only no nível de API (não dá pra confiar só no UI). Cursor pagination canônica: `cursor` = base64 de `{ ts, id }` do último registro. `event_log` é a tabela source: cada write canônico (Spec 01 §6) escreve nela. Audit log é a projeção legível com joins de actor (users) e resource. RLS já garante isolamento por `organization_id` mas a verificação extra de `platform.admin` permission impede que um operator veja audit.

#### Files to create

- `app/api/v1/audit/route.ts` — handler `GET` com Zod validation + admin gate
- `lib/api/audit.ts` — query builder + cursor encode/decode
- `types/audit.ts` — `AuditEntry`, `AuditFilters`, `AuditCursor`
- `hooks/useAuditQuery.ts` — `useInfiniteQuery` wrapper

#### Files to modify

- `lib/auth/permissions.ts` — adicionar helper `assertPlatformAdmin()` se ainda não existir
- `lib/api/errors.ts` — garantir que `forbidden` retorna 403 com shape canônico

#### Implementation steps (sequential)

1. Criar Zod schema `AuditFiltersSchema` com `actor_id?, action?, resource_type?, from?: ISO, to?: ISO, cursor?, limit?: 1..100 default 50`
2. Implementar `encodeCursor({ts,id})` / `decodeCursor(s)` em base64url
3. Query builder: `from('audit_log').select('*, actor:users(id,name,email,avatar_url)').eq('organization_id', orgId).order('created_at', desc).order('id', desc).limit(limit+1)` aplicando filters condicionalmente; se `cursor`, adicionar `.or('created_at.lt.<ts>,and(created_at.eq.<ts>,id.lt.<id>)')`
4. Handler `GET`: parse query → assertPlatformAdmin → query → split (limit+1 → next_cursor se overflow) → return `{ data, next_cursor }`
5. Hook `useAuditQuery(filters)`: `useInfiniteQuery` com `getNextPageParam: (last) => last.next_cursor`

#### Acceptance Criteria (testáveis)

```gherkin
Given um admin autenticado da org A
When GET /api/v1/audit?limit=50
Then status 200
And response.data tem ≤50 entries
And cada entry tem organization_id === A
And se >50 existem, response.next_cursor é string não-vazia
```

```gherkin
Given um operator (não-admin) autenticado
When GET /api/v1/audit
Then status 403 com error.code === "forbidden"
```

```gherkin
Given audit log tem 120 entries pra org A
When GET /api/v1/audit?limit=50, depois GET com cursor=<resp1.next_cursor>, depois com cursor=<resp2.next_cursor>
Then 50 + 50 + 20 entries retornadas, sem duplicatas, ordenadas desc por created_at
And última request tem next_cursor === null
```

```gherkin
Given audit log tem entries com action=conversation.claimed e action=lead.moved
When GET /api/v1/audit?action=lead.moved
Then todas entries retornadas têm action === "lead.moved"
```

```gherkin
Given audit log tem entries de org A e org B
When admin de A chama GET /api/v1/audit
Then nenhuma entry de B aparece (RLS + permission gate)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | 200 + shape `{data, next_cursor}` para admin | curl com session cookie de admin → asserta JSON |
| t2 | api | 403 para operator | curl com session de operator → asserta 403 |
| t3 | api | Filter por action funciona | seed 5 entries `lead.moved` + 5 outras → query com filter retorna só 5 |
| t4 | api | Cursor pagination não duplica | seed 120 entries → 3 chamadas seguidas → 120 ids únicos |
| t5 | rls | Admin de A não vê B | seed orgs A+B → admin A query → 0 entries de B |
| t6 | api | Date range respeitado | seed entries cross-day → query `from`/`to` → só intervalo retorna |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/v1/audit"
    request_schema: "query: { actor_id?, action?, resource_type?, from?, to?, cursor?, limit? }"
    response_schema: "{ data: AuditEntry[], next_cursor: string|null }"
    error_codes: [unauthorized, forbidden, validation_error]
  - type: react_hook
    id: "useAuditQuery"
    signature: "(filters: AuditFilters) => UseInfiniteQueryResult<{data, next_cursor}>"
    file: "hooks/useAuditQuery.ts"
```

#### Decisões a registrar

- Cursor é base64url de `{ts, id}` (composto pra desempate em mesmo timestamp). Padrão pra TODAS rotas de listagem deste epic.
- Limit max 100, default 50.

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Commit `feat(EPIC-10): audit api with cursor pagination [wave 1]`
- [ ] Contracts registrados no state file

---

### S-10.02 — Page `/app/audit` (admin only) com tabela + filters + export CSV

**Points**: 3 | **Priority**: P0 | **Deps**: S-10.01 | **FR refs**: Spec 01 §3.5

#### Contexto

UI de admin pra inspecionar audit log. Tabela com 6 colunas (timestamp, actor, action, resource_type, resource_id, metadata preview), filters bar reativa, infinite scroll, export CSV gera arquivo client-side a partir de fetch paginado completo (cap 10k linhas para não derreter o browser; se overflow, mostra warning).

#### Files to create

- `app/(app)/audit/page.tsx` — Server Component que faz gate via `usePermission` (HOC ou redirect pra 403)
- `app/(app)/audit/AuditClient.tsx` — Client Component com tabela + filters
- `app/(app)/audit/components/FiltersBar.tsx` — actor select + action select + resource_type select + date range picker
- `app/(app)/audit/components/AuditTable.tsx` — virtualized table (TanStack Table)
- `app/(app)/audit/components/ExportCSVButton.tsx` — trigger fetch loop + download
- `lib/csv.ts` — escape + blob helper

#### Files to modify

- `app/(app)/layout.tsx` — adicionar item "Audit" na sidebar visível só para admin

#### Implementation steps (sequential)

1. Page server: checar permission server-side; se não admin → `notFound()` ou redirect `/app/forbidden`
2. AuditClient: estado de filters em URL (searchParams) pra deep-linking
3. Hook `useAuditQuery(filters)` retorna pages; flatten em rows; tabela virtualizada
4. Filters: actor combobox (search async em users da org), action combobox (lista hardcoded de Spec 01 §6), resource_type select, date range com presets (hoje, 7d, 30d, custom)
5. Export CSV: loop até next_cursor === null OR atingir 10k; gerar Blob; `URL.createObjectURL` + `<a download>`
6. Empty state com mensagem "Sem registros pra esses filtros"
7. Loading skeleton + error boundary

#### Acceptance Criteria

```gherkin
Given um admin
When navega a /app/audit
Then tabela renderiza com últimos 50 registros
And filtros bar mostra 4 inputs (actor, action, resource_type, date range)
```

```gherkin
Given um operator
When navega a /app/audit
Then é redirecionado pra /app/forbidden ou recebe 404
And item "Audit" não aparece na sidebar
```

```gherkin
Given admin filtra por action=conversation.claimed
When confirma filtro
Then URL atualiza pra ?action=conversation.claimed
And tabela mostra só essas entries
```

```gherkin
Given admin clica "Export CSV"
When download conclui
Then arquivo .csv tem header + N linhas correspondentes ao filter atual
And se >10k entries, toast warning "Limitado a 10k registros — refine filters"
```

```gherkin
Given admin scrolla até o fim da tabela
When chega no bottom
Then próxima página é fetched automaticamente
And spinner inline aparece durante fetch
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Admin vê tabela | Playwright: login admin → goto /app/audit → asserta `<table>` visível |
| t2 | ui | Operator é bloqueado | Playwright: login operator → goto /app/audit → asserta redirect/404 |
| t3 | ui | Filter persiste em URL | Playwright: aplica filter → reload → filter ainda ativo |
| t4 | ui | CSV download | Playwright: clica export → asserta download event + file content tem header esperado |
| t5 | ui | Infinite scroll | Playwright: scroll → asserta novas rows aparecem sem reload |
| t6 | a11y | Tabela navegável por keyboard | Tab through filters → focus visible |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/audit"
    auth: "admin only (platform.admin permission)"
  - type: react_component
    id: "AuditTable"
    file: "app/(app)/audit/components/AuditTable.tsx"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Sidebar atualiza condicional
- [ ] Commit `feat(EPIC-10): audit page with filters and csv export [wave 2]`

---

### S-10.03 — Page `/app/settings/profile` (avatar, name, email change, locale, timezone)

**Points**: 3 | **Priority**: P0 | **Deps**: S-10.01 | **FR refs**: Spec 01 §3.4

#### Contexto

Self-service de perfil. Avatar via Supabase Storage bucket `avatars` (path `users/{user_id}/{uuid}.png`). Email change requer fluxo de confirmation: PATCH `/api/v1/settings/profile/email` envia magic link pro email novo; só atualiza `auth.users.email` quando link clicado (delegado ao Supabase Auth via `updateUser({email})` que já dispara confirmation). Locale: `pt-BR | en-US`. Timezone: lista de IANA (default `America/Sao_Paulo`).

#### Files to create

- `app/(app)/settings/layout.tsx` — sidebar de settings (Profile / Security / Notifications / Tenant / Billing)
- `app/(app)/settings/profile/page.tsx` — Server Component carrega user atual
- `app/(app)/settings/profile/ProfileForm.tsx` — Client com react-hook-form + zod
- `app/(app)/settings/profile/AvatarUpload.tsx` — drag-drop + preview + crop simples (square)
- `app/api/v1/settings/profile/route.ts` — `PATCH` (name/locale/timezone/avatar_url)
- `app/api/v1/settings/profile/email/route.ts` — `POST` trigger confirmation
- `actions/updateProfile.ts` — Server Action wrapper
- `lib/storage/avatars.ts` — upload helper

#### Files to modify

- `hooks/useAuth.ts` — invalidar query após updateProfile pra refletir novo nome/avatar no topbar

#### Implementation steps (sequential)

1. Layout `/app/settings` com sidebar nav
2. Server page: carrega `users` row + organização atual
3. Form com fields: avatar (file input), name (string 2-80), locale (select), timezone (combobox com search)
4. AvatarUpload: validar tipo (image/png|jpeg|webp), tamanho ≤2MB, upload pra Storage, retorna URL pública
5. Email change: input + button "Mudar email"; confirma com modal "Vamos enviar link pra <novo>"; chama POST `/api/v1/settings/profile/email`; mostra estado "pendente confirmação"
6. Submit principal chama `updateProfile` Server Action → `revalidatePath('/app/settings/profile')` + retorna `{ ok: true }`
7. Toast success + optimistic update do topbar via query invalidation

#### Acceptance Criteria

```gherkin
Given user logado
When edita name de "João" pra "João Silva" e clica salvar
Then toast "Perfil atualizado"
And topbar mostra "João Silva" sem reload
And audit_log tem entry action="user.profile_updated" com fields=["name"]
```

```gherkin
Given user faz upload de avatar 1MB png
When upload conclui
Then preview mostra novo avatar
And users.avatar_url no DB aponta pro novo path
And topbar mostra novo avatar
```

```gherkin
Given user tenta upload de arquivo 5MB
When seleciona arquivo
Then erro inline "Máximo 2MB"
And nenhum upload é iniciado
```

```gherkin
Given user pede troca de email pra "novo@x.com"
When confirma modal
Then magic link é enviado pra "novo@x.com"
And UI mostra "Pendente confirmação" até clicar link
And users.email no DB SÓ atualiza após confirmação Supabase
```

```gherkin
Given user muda locale pt-BR → en-US
When salva
Then strings da UI seguinte renderizam em inglês (após reload)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Form renderiza com valores atuais | Playwright |
| t2 | api | PATCH /profile retorna 200 | curl |
| t3 | storage | Avatar é uploadado | Asserta GET na URL retornada → 200 |
| t4 | audit | Audit entry criada | DB query após edit |
| t5 | validation | Email change exige confirmation | Asserta que `auth.users.email` não muda imediato |
| t6 | i18n | Locale change persiste | Reload → users.locale = "en-US" |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/profile"
  - type: server_action
    id: "updateProfile"
    signature: "(input: ProfileInput) => Promise<{ok:true}|{error:string}>"
    file: "actions/updateProfile.ts"
  - type: api_route
    id: "PATCH /api/v1/settings/profile"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): profile settings with avatar upload [wave 3]`

---

### S-10.04 — Page `/app/settings/security` (MFA, recovery codes, sessions)

**Points**: 4 | **Priority**: P0 | **Deps**: S-10.03 | **FR refs**: Spec 01 §3.4, EPIC-01 (MFA flow)

#### Contexto

Hub de segurança self-service. MFA: enroll TOTP via Supabase `auth.mfa.enroll()` (mostra QR + secret); disable exige re-auth com senha atual + código MFA atual (double-confirm). Recovery codes: gerar 10 códigos one-time (hash bcrypt no DB, plaintext mostrado 1× no UI com botão copy/print). Sessions: listar `auth_sessions` rows (id, user_agent, ip, created_at, last_seen_at) com botão revoke por sessão (não pode revogar a sessão atual sem warning).

#### Files to create

- `app/(app)/settings/security/page.tsx`
- `app/(app)/settings/security/MFAPanel.tsx` — enroll/disable
- `app/(app)/settings/security/RecoveryCodes.tsx` — display + regenerate
- `app/(app)/settings/security/SessionsList.tsx` — tabela + revoke
- `app/api/v1/settings/security/mfa/route.ts` — POST `enroll` / `disable` / `verify`
- `app/api/v1/settings/security/recovery-codes/route.ts` — POST `regenerate`
- `app/api/v1/settings/security/sessions/route.ts` — GET list
- `app/api/v1/settings/security/sessions/[id]/revoke/route.ts` — POST
- `actions/regenerateRecoveryCodes.ts`
- `actions/revokeSession.ts`
- `lib/security/recovery-codes.ts` — gerar + hash

#### Implementation steps (sequential)

1. MFAPanel: 3 estados (no MFA / pending verify / enrolled)
2. Enroll: chama Supabase `auth.mfa.enroll()` → mostra QR (otpauth URL → qrcode lib) + secret texto → input pra primeiro código de verificação → verify → estado enrolled
3. Disable: modal com inputs senha + código TOTP atual → POST verify → audit + delete factor → emit `consent.changed { user_id, consent_type:"mfa", value:false }`
4. Recovery codes: ao enroll, mostrar 10 códigos auto-gerados (hex 10 chars); botão "Regenerar" exige re-auth com TOTP; após regenerar, antigos invalidados
5. Sessions: GET lista; cada row com badge "atual" se id === session atual; revoke: confirm modal → POST → row some
6. Eventos: enroll → `event.consent.changed value:true`, disable → false, regenerate → audit `user.recovery_codes_regenerated`

#### Acceptance Criteria

```gherkin
Given user sem MFA
When clica "Ativar MFA"
Then QR code aparece + secret texto
And after typar código TOTP válido + submit, MFA fica enrolled
And event_log tem evento "consent.changed" com value=true
And 10 recovery codes aparecem 1× com botão copy
```

```gherkin
Given user com MFA enrolled
When clica "Desativar MFA"
Then modal exige senha + código TOTP
And só após ambos válidos, MFA é desativado
And event_log tem evento "consent.changed" com value=false
```

```gherkin
Given user enrolled clica "Regenerar recovery codes"
When confirma com TOTP
Then 10 novos códigos aparecem
And códigos antigos não funcionam mais em /login/recovery
```

```gherkin
Given user tem 3 sessions ativas
When abre /app/settings/security e clica revoke na session #2
Then session #2 some da lista
And tentativa de uso desse cookie cai em 401
```

```gherkin
Given user clica revoke na sessão atual
When confirma
Then warning "Você será deslogado" aparece
And após confirm, redirect pra /login
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | MFA enroll fluxo | Playwright |
| t2 | api | MFA disable exige senha+TOTP | curl sem senha → 400 |
| t3 | ui | Recovery codes só aparecem 1× | Reload page → não aparecem mais |
| t4 | api | Sessions list isola por user | DB seed → query → só sessions do user |
| t5 | api | Revoke invalida cookie | Após revoke, próxima request com cookie → 401 |
| t6 | event | consent.changed emitido | DB query event_log após enroll/disable |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/security"
  - type: api_route
    id: "POST /api/v1/settings/security/mfa"
  - type: api_route
    id: "POST /api/v1/settings/security/sessions/:id/revoke"
  - type: server_action
    id: "regenerateRecoveryCodes"
  - type: server_action
    id: "revokeSession"
  - type: domain_event
    id: "consent.changed"
    payload: "{ user_id, consent_type, value, at }"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): security settings mfa+sessions+recovery [wave 4]`

---

### S-10.05 — Page `/app/settings/notifications` (preferências email/in-app/push)

**Points**: 2 | **Priority**: P0 | **Deps**: S-10.03 | **FR refs**: Spec 01 §3.4, Spec 07 (workers de notification)

#### Contexto

Matriz 4×3 de preferências. Categorias: `new_message`, `handoff`, `lgpd_sla`, `waha_ban`. Canais: `email`, `in_app`, `push`. Estado em `notification_prefs(user_id, category, channel, enabled)` com unique constraint. Defaults: tudo `in_app=true`, `email=true` para `lgpd_sla`+`waha_ban`+`handoff`, `email=false` para `new_message` (evita spam), `push=false` em todos (ative explicitamente).

#### Files to create

- `app/(app)/settings/notifications/page.tsx`
- `app/(app)/settings/notifications/NotificationsMatrix.tsx`
- `app/api/v1/settings/notifications/route.ts` — GET (matrix) + PATCH (batch upsert)
- `actions/updateNotificationPrefs.ts`

#### Implementation steps (sequential)

1. Server page carrega prefs atuais (left join com defaults)
2. Matrix: tabela 4 linhas × 3 colunas com `<Switch>` em cada célula
3. PATCH é batch: array `[{category, channel, enabled}, ...]` upsert
4. Optimistic UI: toggle altera state local imediato; rollback em erro
5. Cada toggle emite `event.notification_pref.changed`

#### Acceptance Criteria

```gherkin
Given user com defaults
When abre /app/settings/notifications
Then matriz renderiza com toggles refletindo defaults
```

```gherkin
Given user toggla email de new_message off→on
When toggle dispara
Then state UI muda imediato
And PATCH /api/v1/settings/notifications retorna 200
And notification_prefs row (user_id, "new_message", "email") tem enabled=true
And event_log tem evento notification_pref.changed
```

```gherkin
Given erro 500 no PATCH
When toggle dispara
Then state UI faz rollback pro valor anterior
And toast "Erro ao salvar"
```

```gherkin
Given user A tem prefs
When user B abre suas notifications
Then user B vê apenas suas próprias prefs (RLS)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Matrix renderiza 4×3 | Playwright count |
| t2 | api | Batch upsert | curl |
| t3 | event | notification_pref.changed | DB query após toggle |
| t4 | rollback | Optimistic rollback | Playwright + mock 500 |
| t5 | rls | Isolamento user | Seed 2 users → cada um vê só seus |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/notifications"
  - type: api_route
    id: "GET/PATCH /api/v1/settings/notifications"
  - type: server_action
    id: "updateNotificationPrefs"
  - type: domain_event
    id: "notification_pref.changed"
    payload: "{ user_id, category, channel, enabled }"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): notification prefs matrix [wave 5]`

---

### S-10.06 — Page `/app/settings/tenant` (admin only): logo, vocabulary, custom fields, lost_reasons

**Points**: 4 | **Priority**: P0 | **Deps**: S-10.05 | **FR refs**: Spec 02 §3.7, Spec 01 §3.4

#### Contexto

Configuração da organização. Vocabulary editor: por pipeline, override de termos canônicos (`lead`, `customer`, `opportunity`, etc.) por sinônimos da empresa (e.g. "prospect", "cliente", "negócio"). Custom fields: schema JSON `[{key, label, type:'text|number|select|date|boolean', required, options?}]` por pipeline. Lost reasons: array de strings custom (defaults seeded). Logo upload: bucket `tenant-logos`, public-read.

#### Files to create

- `app/(app)/settings/tenant/page.tsx` — Server Component, gate admin
- `app/(app)/settings/tenant/TenantForm.tsx` — display_name + logo
- `app/(app)/settings/tenant/VocabularyEditor.tsx` — per-pipeline override
- `app/(app)/settings/tenant/CustomFieldsEditor.tsx` — list + add/edit/remove
- `app/(app)/settings/tenant/LostReasonsEditor.tsx` — chips editáveis
- `app/(app)/settings/tenant/LogoUpload.tsx`
- `app/api/v1/settings/tenant/route.ts` — GET + PATCH
- `lib/storage/tenant-logos.ts`

#### Implementation steps (sequential)

1. Page server gate: `assertPlatformAdmin()` ou redirect
2. TenantForm: name + logo (similar a avatar)
3. VocabularyEditor: dropdown pipelines → tabela `term_canonical → override` editável
4. CustomFieldsEditor: dropdown pipelines → lista de fields → modal "Adicionar field" com type, label, key (auto-slug), required, options (se select)
5. LostReasonsEditor: chip input (add/remove); seed defaults na primeira load
6. Submit chama Server Action `updateTenant` (S-10.08)

#### Acceptance Criteria

```gherkin
Given admin abre /app/settings/tenant
When page carrega
Then form renderiza display_name, logo atual, vocabulary, custom fields, lost_reasons
```

```gherkin
Given operator tenta /app/settings/tenant
When entra
Then 403/redirect
```

```gherkin
Given admin adiciona vocabulary override "lead → prospect" no pipeline X
When salva
Then organizations.vocabulary[pipeline_x].lead === "prospect"
And kanban deste pipeline (em outra tab) renderiza "Prospects" no header (após revalidate)
And event_log tem org.updated com fields=["vocabulary"]
```

```gherkin
Given admin adiciona custom field "CNPJ" tipo text required no pipeline X
When salva
Then organizations.custom_fields_schema[pipeline_x] inclui esse field
And novo lead criado neste pipeline exige CNPJ no form
```

```gherkin
Given admin remove lost_reason "Preço alto"
When salva
Then opção some do dropdown ao marcar lead como lost
```

```gherkin
Given admin faz upload de logo png 500KB
When upload conclui
Then organizations.logo_url atualiza
And topbar mostra novo logo
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Admin acessa | Playwright |
| t2 | rls | Operator bloqueado | Playwright |
| t3 | api | PATCH atualiza vocabulary | curl + DB |
| t4 | api | Custom fields schema valida tipo | curl com type inválido → 400 |
| t5 | event | org.updated emitido | DB query |
| t6 | revalidate | Vocabulary reflete em kanban | Playwright cross-tab |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/tenant"
    auth: "admin only"
  - type: api_route
    id: "GET/PATCH /api/v1/settings/tenant"
  - type: domain_event
    id: "org.updated"
    payload: "{ organization_id, fields: string[], by: user_id }"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): tenant settings vocabulary+custom-fields [wave 6]`

---

### S-10.07 — Page `/app/settings/tenant/whatsapp` (admin only): WAHA sessions

**Points**: 3 | **Priority**: P0 | **Deps**: S-10.06 | **FR refs**: Spec 03 §4 (WAHA sessions), Spec 01 §3.4

#### Contexto

Painel admin pra ver/gerir 1-2 sessões WAHA. Status pode ser `warming | active | banned | disconnected`. Daily limit de mensagens por sessão (default 200 quando warming, 1000 quando active). Botão re-warm reseta contador e estado pra warming. Não vamos provisionar novas sessões aqui (isso é EPIC-11 admin platform); só read+limited update.

#### Files to create

- `app/(app)/settings/tenant/whatsapp/page.tsx`
- `app/(app)/settings/tenant/whatsapp/SessionCard.tsx` — status + QR placeholder + daily_limit input
- `app/(app)/settings/tenant/whatsapp/SessionsList.tsx`
- `app/api/v1/settings/tenant/whatsapp/route.ts` — GET (lista)
- `app/api/v1/settings/tenant/whatsapp/[session_id]/route.ts` — PATCH (daily_limit, re-warm)

#### Implementation steps (sequential)

1. Server page gate admin
2. GET lista `waha_sessions` da org
3. SessionCard: badge de status (color-coded), número de telefone, last_seen, daily_limit input, used_today / daily_limit progress, botão "Re-warm" se status !== warming
4. PATCH daily_limit: clamp 50-2000
5. PATCH re-warm: muda status pra warming + zera counters + emit `org.updated` com fields=["waha_session.warmup_reset"]
6. Polling 30s pra refletir status updates do worker

#### Acceptance Criteria

```gherkin
Given admin abre /app/settings/tenant/whatsapp
When page carrega
Then lista das sessões da org renderiza
And cada uma mostra status badge + número + daily_limit + used_today
```

```gherkin
Given operator tenta acessar
When entra
Then 403/redirect
```

```gherkin
Given admin altera daily_limit de 500 pra 800
When salva
Then waha_sessions.daily_limit no DB = 800
And event_log tem org.updated
```

```gherkin
Given sessão com status=banned
When admin clica "Re-warm"
Then status muda pra warming
And counters zeram
And worker recebe sinal (via realtime ou job)
```

```gherkin
Given admin tenta daily_limit=10000
When submit
Then validation error "max 2000"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Lista renderiza | Playwright |
| t2 | rls | Operator bloqueado | Playwright |
| t3 | api | PATCH clamp | curl daily_limit=10k → 400 |
| t4 | api | Re-warm muda status | DB query após PATCH |
| t5 | event | org.updated | DB query |
| t6 | polling | Status atualiza sem reload | Mock DB change → assert UI updates |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/tenant/whatsapp"
    auth: "admin only"
  - type: api_route
    id: "GET /api/v1/settings/tenant/whatsapp"
  - type: api_route
    id: "PATCH /api/v1/settings/tenant/whatsapp/:session_id"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): waha sessions panel [wave 7]`

---

### S-10.08 — Server Action `updateTenant(...)` com revalidation

**Points**: 2 | **Priority**: P0 | **Deps**: S-10.06 | **FR refs**: Spec 09 §5 (Server Actions canon)

#### Contexto

Centralizar a mutação de tenant em uma única Server Action testável. Recebe um patch parcial e:
1. Valida (Zod) com discriminated union por field type
2. Aplica diff entre estado atual e patch (pra emitir event com fields exatos mudados)
3. Atualiza `organizations` row
4. Insere `audit_log` + `event_log` com `org.updated`
5. `revalidatePath('/app/settings/tenant')` + `revalidateTag('tenant-config')`
6. Retorna `{ ok: true, fields: string[] }`

Esta story formaliza o que S-10.06 e S-10.07 já chamavam, garantindo um único entry-point.

#### Files to create

- `actions/updateTenant.ts` — Server Action com `'use server'`
- `lib/tenant/diff.ts` — `diffOrgPatch(current, patch): string[]`
- `lib/cache/tags.ts` — exportar `TAG_TENANT_CONFIG = 'tenant-config'` (e outros)

#### Files to modify

- `app/(app)/settings/tenant/TenantForm.tsx` — usar Server Action via `useFormState`
- `app/(app)/settings/tenant/whatsapp/SessionCard.tsx` — refatorar pra usar action quando aplicável (ou ficar com API se preferir read/write granular)
- `lib/cache/queries.ts` — wrap reads de tenant config com `unstable_cache` taggeado `TAG_TENANT_CONFIG`

#### Implementation steps (sequential)

1. Definir `UpdateTenantInput` Zod (partial de display_name, logo_url, vocabulary, custom_fields_schema, lost_reasons, waha defaults)
2. Implementar diff helper
3. Action body: auth → assertPlatformAdmin → validate → load current → diff → update → audit/event → revalidate
4. Migrar S-10.06 forms para chamar via `useFormState`
5. Asserta que `revalidateTag` invalida reads em outras páginas (e.g. kanban que lê vocabulary)

#### Acceptance Criteria

```gherkin
Given admin altera display_name de "Acme" pra "Acme Corp"
When submit form
Then updateTenant é chamado
And organizations.display_name = "Acme Corp"
And event_log tem org.updated com fields=["display_name"]
And topbar reflete novo nome após revalidate (sem hard reload)
```

```gherkin
Given operator chama updateTenant via fetch hack
When request chega
Then action retorna { error: "forbidden" }
And nada muda no DB
```

```gherkin
Given patch com vocabulary inválido (key não-canônico)
When submit
Then action retorna { error: "validation_error", details: [...] }
```

```gherkin
Given admin altera vocabulary
When action conclui
Then queries com tag "tenant-config" são invalidadas
And próximo render do kanban busca vocabulary fresh
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Diff helper retorna fields corretos | Vitest |
| t2 | action | Action 200 + revalidate | Playwright + asserta novo render |
| t3 | action | Operator → forbidden | Playwright |
| t4 | action | Validation error | Playwright |
| t5 | cache | Tag invalidation | Mock cache + asserta evicted |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "updateTenant"
    signature: "(input: UpdateTenantInput) => Promise<{ok:true, fields:string[]} | {error:string}>"
    file: "actions/updateTenant.ts"
  - type: cache_tag
    id: "tenant-config"
    file: "lib/cache/tags.ts"
```

#### Decisões a registrar

- Cache tag canônica: `tenant-config`. Qualquer leitura de `organizations.{vocabulary,custom_fields_schema,lost_reasons,display_name,logo_url}` que use Next cache deve usar essa tag.

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): updateTenant server action with revalidation [wave 8]`

---

### S-10.09 — Page `/app/settings/billing` (Fase 2 placeholder)

**Points**: 2 | **Priority**: P2 | **Deps**: S-10.05 | **FR refs**: Spec 01 §3.4 (billing fica fora do MVP-B)

#### Contexto

Placeholder explícito pra não deixar item quebrado na sidebar de settings. Mostra mensagem "Em breve" + benefícios do plano + link `mailto:contato@deskcomm.com.br?subject=Billing` ou link pro WhatsApp da Deskcomm. Nenhuma lógica de billing real.

#### Files to create

- `app/(app)/settings/billing/page.tsx` — estático

#### Files to modify

- `app/(app)/settings/layout.tsx` — incluir item "Billing" na sidebar com badge "Em breve"

#### Implementation steps (sequential)

1. Page server estática
2. Card central: ícone + título "Billing & Planos" + texto + CTA `<a href="mailto:..." />`
3. Badge "Em breve" no item da sidebar

#### Acceptance Criteria

```gherkin
Given user abre /app/settings/billing
When page carrega
Then mensagem "Em breve" visível
And botão "Falar com a Deskcomm" abre mailto
```

```gherkin
Given user vê sidebar de settings
When inspeciona item Billing
Then badge "Em breve" aparece ao lado
```

```gherkin
Given user comum (não-admin)
When acessa /app/settings/billing
Then página carrega normal (não-restrita)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Página renderiza | Playwright |
| t2 | ui | mailto abre | Asserta href |
| t3 | a11y | CTA acessível por keyboard | Tab + Enter |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/app/settings/billing"
    auth: "any authenticated user"
```

#### Definition of Done

- [ ] Todos ACs passam
- [ ] Commit `feat(EPIC-10): billing placeholder [wave 9]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering | 18 | S-10.02 a S-10.09 (≈2 por story) |
| API contracts | 14 | S-10.01, S-10.03..S-10.08 |
| RLS / permission gates | 8 | S-10.01, S-10.02, S-10.06, S-10.07, S-10.08 |
| Domain events emitted | 6 | S-10.04, S-10.05, S-10.06, S-10.07, S-10.08 |
| Optimistic UI rollback | 3 | S-10.03, S-10.05, S-10.06 |
| Storage uploads | 2 | S-10.03 (avatar), S-10.06 (logo) |
| Cache revalidation | 2 | S-10.08 (tag-based) |
| **Total** | **~53** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Admin gate só no UI deixa API exposta | Alto | `assertPlatformAdmin()` em TODA route + Server Action; teste de regression específico (operator → 403) por endpoint |
| MFA disable sem double-confirm vira ataque | Alto | Exigir senha + TOTP atual no PATCH; rate limit 5/15min |
| Recovery codes em plaintext no logs | Alto | Hash bcrypt no DB; mostrar plaintext apenas no response da geração; nunca logar |
| Vocabulary override quebra strings hardcoded em outros epics | Médio | Garantir que TODA UI consome via hook `useVocabulary(pipeline_id)`; `tenant-config` tag invalida |
| Custom fields schema corrompido bloqueia kanban | Médio | Validate Zod no PATCH; migration zero-downtime; fallback render quando schema inválido |
| Avatar/logo upload sem limite de tamanho derruba storage | Médio | Validate client + Edge function antes de aceitar (≤2MB avatar, ≤500KB logo) |
| Audit log query sem index = lento com volume | Médio | Index composto `(organization_id, created_at desc, id desc)` na migration; verify EXPLAIN |
| Sessions revoke não invalida JWT em uso | Médio | Adicionar `auth_sessions.revoked_at` checked pelo middleware antes de aceitar request |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-NN: Cache tag canônica `tenant-config`** — toda leitura de campos editáveis em `/app/settings/tenant` deve usar `unstable_cache` com essa tag. Server Action `updateTenant` revalida.
- **ADR-NN: Cursor pagination canon** — `base64url({ts, id})` é o cursor padrão pra todas as listagens admin/audit. Documentar em Spec 09.
- **ADR-NN: Server Action vs API route** — escrita que muda config global do tenant → Server Action (revalidate first-class). Escrita que precisa de idempotency-key explícita ou é cross-tab → API route. Documentado.
- **ADR-NN: Recovery codes** — 10 códigos hex de 10 chars, hash bcrypt, one-time, regeneração invalida todos.

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/03-screen-inventory.md` rotas `/app/audit`, `/app/settings/*`
- Specs refs: 01 §3.4 (settings), 01 §3.5 (audit), 01 §6 (canonical actions/events), 02 §3.7 (vocabulary + custom fields), 03 §4 (WAHA sessions), 09 §4 (cursor pagination), 09 §5 (Server Actions)
- Business rules: T-MFA-01, T-AUDIT-01, AT-VOCAB-01
- Reconciliation log: revisar R-NN sobre `tenant-config` tag (criar entry após implementação)
