---
epic_id: EPIC-11-admin-platform
epic_name: Super-Admin Platform
priority: P0
estimated_waves: 14
estimated_total_points: 48
depends_on: [EPIC-01, EPIC-03, EPIC-04, EPIC-05, EPIC-08, EPIC-10]
exposes_contracts:
  - "route./admin/dashboard"
  - "route./admin/inbox"
  - "route./admin/inbox/[conversationId]"
  - "route./admin/tenants"
  - "route./admin/tenants/[id]"
  - "route./admin/tenants/[id]/health"
  - "route./admin/audit"
  - "route./admin/lgpd"
  - "route./admin/incidents"
  - "route./admin/incidents/[id]"
  - "route./admin/usage"
  - "route./admin/users"
  - "route./admin/platform-admins"
  - "api.POST /api/v1/admin/tenants/[id]/impersonate"
  - "api.POST /api/v1/admin/tenants/[id]/suspend"
  - "api.POST /api/v1/admin/tenants/[id]/reactivate"
  - "api.POST /api/v1/admin/tenants"
  - "api.POST /api/v1/admin/incidents/[id]/resolve"
  - "api.GET /api/v1/admin/usage"
  - "realtime.admin-inbox-{platform_admin_id}"
  - "realtime.tenant-health-{tenant_id}"
  - "realtime.alerts-platform"
  - "hook.useAdminGuard"
  - "hook.useAdminInbox"
  - "hook.useTenantHealth"
  - "hook.useResolveIncident"
  - "middleware.requirePlatformAdmin"
status: pending
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-11 — Super-Admin Platform

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei. Este epic constrói a camada **cross-tenant** sob o sub-domínio `admin.deskcomm.com`. Toda query depende de `fn_is_platform_admin()` retornando `true` pra bypassar RLS, conforme Spec 01 §3.4 e §3.6 (T-04). Nada aqui pode vazar pra `/app` regular.

## 1. Objetivo

Entregar o Super-Admin Platform completo: 14 rotas cross-tenant em `admin.deskcomm.com` que permitem ao operador BPO P2 (Spec 01 §3.4) triagem, observabilidade, impersonate, suspensão de tenants, audit cross-tenant, gestão de LGPD/incidents/usage cross-tenant e visibilidade read-only dos `platform_admins`. Inclui inbox unificada cross-tenant via `fn_is_platform_admin()` bypass de RLS e 3 canais realtime dedicados (`admin-inbox-{platform_admin_id}`, `tenant-health-{tenant_id}`, `alerts-platform`).

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Sub-domínio `admin.deskcomm.com` resolve e middleware `requirePlatformAdmin` bloqueia non-admins com 403
- [ ] Layout `/admin/*` distinto: sidebar admin + banner "Modo Plataforma" + tema visualmente diferenciável
- [ ] Dashboard cross-tenant exibe KPIs (tenants ativos, conversas pendentes >10min, alertas WAHA banimento, SLA LGPD em risco, AI budget warnings)
- [ ] Inbox cross-tenant lista conversas de TODOS os tenants com badge `<TenantBadge>` em cada item; novas mensagens chegam via canal `admin-inbox-{platform_admin_id}`
- [ ] Página de tenant individual mostra overview + botão Impersonate + toggle Suspend
- [ ] Health page por tenant: WAHA sessions, Nuvemshop OAuth status, AI budget consumido, audit log lag, todos com indicadores realtime via `tenant-health-{id}`
- [ ] `POST /api/v1/admin/tenants/[id]/impersonate` loga audit `platform_admin.impersonate_started`, seta cookie temporário e redireciona pra `/app` daquele tenant
- [ ] `POST /api/v1/admin/tenants/[id]/suspend` exige `reason` no body (mín. 10 chars), seta `tenants.status='suspended'`, audita
- [ ] Audit page cross-tenant filtra por tenant + actor + action + date range
- [ ] LGPD page cross-tenant lista todos os requests pendentes/em-risco (D+5/D+7) com tenant badge
- [ ] Incidents page lista incidents (banimento WAHA, falhas webhook); `useResolveIncident` move pra `resolved` + audit
- [ ] Usage page mostra mensagens/dia, AI tokens, storage GB por tenant com gráficos
- [ ] Users page lista TODOS users cross-tenant com filtros tenant + role
- [ ] Platform-admins page exibe lista read-only com nota "Modificação SOMENTE via DBA — vide Spec 01 §3.4 T-04"
- [ ] Mobile entrega read-only intencional: composer/mutations escondidos < `md`; só visualização permitida (decisão UX herdada — Anexo §9)

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-01` (auth+MFA), `EPIC-03` (inbox + canais realtime), `EPIC-04` (kanban — usado em tenant detail), `EPIC-05` (customer 360 — usado em links), `EPIC-08` (LGPD requests), `EPIC-10` (audit + settings)
- Migrations 0001-0007 aplicadas (incluindo `platform_admins`, `fn_is_platform_admin()`, RLS policies cross-tabela com bypass)
- Variáveis de env: `NEXT_PUBLIC_ADMIN_HOST=admin.deskcomm.com`, `INTERNAL_SECRET`, `IMPERSONATE_COOKIE_SECRET`
- Pelo menos 2 tenants seedados pra testar cross-tenant
- Pelo menos 1 user em `platform_admins` (seed manual via DBA)
- Dev server rodando em `localhost:3001` com hosts file alias `admin.localhost`
- Playwright MCP conectado pra QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `useAuth()` retorna `is_platform_admin` |
| `hook.useAuth` | react_hook | EPIC-01 | Base do `useAdminGuard` |
| `db.platform_admins` | db_table | migration 0001 | Spec 01 §3.4 — read-only via UI |
| `db.fn_is_platform_admin` | db_function | migration 0002 | Bypass de RLS em todas as queries admin |
| `db.tenants` | db_table | EPIC-02 | List/detail/suspend/reactivate |
| `db.audit_log` | db_table | EPIC-10 | Cross-tenant query com bypass |
| `db.conversations` | db_table | EPIC-03 | Inbox unificada |
| `db.lgpd_requests` | db_table | EPIC-08 | LGPD cross-tenant |
| `db.event_log` | db_table | EPIC-03 | Source de incidents |
| `realtime.inbox-{org_id}` | realtime_channel | EPIC-03 | Reaproveitado conceitualmente |
| `ui.<ConversationList>` | react_component | EPIC-03 | Reuso com prop `crossTenant` |
| `ui.<ChatThread>` | react_component | EPIC-03 | Reuso com `readOnlyHint` em mobile |
| `lib.toast` | lib | EPIC-00 | Feedback de mutations |
| `infra.tanstack-query` | infra | EPIC-00 | Cache layer |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `middleware.requirePlatformAdmin` | middleware | S-11.01 | Helper server-side que valida `fn_is_platform_admin()` + MFA; 403 se falha |
| `hook.useAdminGuard` | react_hook | S-11.01 | Client guard que redireciona pra `/login` se não é platform_admin |
| `route./admin/dashboard` | route | S-11.02 | KPIs cross-tenant landing |
| `realtime.alerts-platform` | realtime_channel | S-11.02 | Subscribe pra alertas críticos cross-tenant |
| `hook.useAdminInbox` | react_hook | S-11.03 | `() => { conversations, isLoading }` cross-tenant com tenant badge |
| `realtime.admin-inbox-{platform_admin_id}` | realtime_channel | S-11.03 | Novas mensagens cross-tenant pro admin |
| `route./admin/tenants` | route | S-11.04 | Lista + filtros + busca |
| `route./admin/tenants/[id]` | route | S-11.05 | Overview + actions |
| `api.POST /api/v1/admin/tenants` | api_route | S-11.04 | Body `{ name, slug, plan }` → cria tenant manualmente |
| `route./admin/tenants/[id]/health` | route | S-11.06 | Health grid |
| `realtime.tenant-health-{tenant_id}` | realtime_channel | S-11.06 | Status realtime de WAHA/Nuvemshop/AI budget |
| `hook.useTenantHealth` | react_hook | S-11.06 | `(tenantId) => { waha, nuvemshop, aiBudget, auditLag }` |
| `api.POST /api/v1/admin/tenants/[id]/impersonate` | api_route | S-11.07 | Loga audit, seta cookie, retorna `redirect_url` |
| `api.POST /api/v1/admin/tenants/[id]/suspend` | api_route | S-11.08 | Body `{ reason }` (≥10 chars) |
| `api.POST /api/v1/admin/tenants/[id]/reactivate` | api_route | S-11.08 | Body `{ reason }` |
| `route./admin/audit` | route | S-11.09 | Cross-tenant audit |
| `route./admin/lgpd` | route | S-11.10 | Cross-tenant LGPD |
| `route./admin/incidents` | route | S-11.11 | Lista de incidents |
| `api.POST /api/v1/admin/incidents/[id]/resolve` | api_route | S-11.11 | Body `{ resolution_note }` |
| `hook.useResolveIncident` | react_hook | S-11.11 | Mutation TanStack |
| `route./admin/usage` | route | S-11.12 | Uso/custo por tenant |
| `api.GET /api/v1/admin/usage` | api_route | S-11.12 | Query params `tenant_id?, range?` |
| `route./admin/users` | route | S-11.13 | Users cross-tenant |
| `route./admin/platform-admins` | route | S-11.14 | Read-only |
| `event.platform_admin.impersonate_started` | domain_event | S-11.07 | Emitido em `audit_log` com `acting_as_platform_admin=true` |
| `event.tenant.suspended` | domain_event | S-11.08 | Emitido com `reason` |
| `event.tenant.reactivated` | domain_event | S-11.08 | idem |
| `event.incident.resolved` | domain_event | S-11.11 | Emitido com `resolution_note` |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave N = última. Deps internos respeitados pela ordem.

---

### S-11.01 — Layout `/admin` + guard + sidebar + banner "Modo Plataforma"

**Points**: 4 | **Priority**: P0 | **Deps**: (none, mas requer EPIC-01 completo) | **FR refs**: Spec 01 §3.4, §3.6 (T-04), Sitemap §4

#### Contexto
Primeira story do epic — fornece a fundação visual e de segurança pra todas as outras. O sub-domínio `admin.deskcomm.com` precisa ter middleware específico que valida `fn_is_platform_admin()` server-side antes de renderizar qualquer rota `/admin/*`. Visualmente, o layout precisa ser **inequivocadamente diferente** do `/app` regular — banner persistente "Modo Plataforma" no topo, sidebar admin com ícones distintos, possivelmente acento de cor diferente (mantendo Sage palette). Isso evita confusão operacional e reforça que toda ação ali é cross-tenant.

#### Files to create
- `app/admin/layout.tsx` — server component, chama `requirePlatformAdmin` + renderiza `<AdminShell>`
- `app/admin/page.tsx` — redirect server-side pra `/admin/dashboard`
- `lib/auth/requirePlatformAdmin.ts` — helper server-side: lê session, checa `fn_is_platform_admin()`, exige MFA recente, joga 403 ou redirect
- `hooks/useAdminGuard.ts` — client guard, redireciona se sessão perde flag
- `components/admin/AdminShell.tsx` — wrapper com sidebar + banner + topbar
- `components/admin/AdminSidebar.tsx` — sidebar com 14 entradas
- `components/admin/PlatformModeBanner.tsx` — sticky top, label "MODO PLATAFORMA", botão "Sair pra app pessoal"
- `middleware.ts` — adicionar rama: se `host === ADMIN_HOST` então `requirePlatformAdmin`
- `app/admin/forbidden/page.tsx` — 403 dedicada com instruções

#### Files to modify
- `middleware.ts` — branch por host (`admin.*` → admin guard, senão fluxo normal)
- `next.config.js` — confirmar que sub-domain rewrite/host matching tá habilitado

#### Implementation steps (sequential)
1. Criar `lib/auth/requirePlatformAdmin.ts` que: (a) pega session via supabase server client; (b) chama `select fn_is_platform_admin()`; (c) checa `aal === 'aal2'` (MFA recente); (d) retorna `{ user, platformAdminId }` ou throw `redirect('/admin/forbidden')`
2. Atualizar `middleware.ts` pra detectar host `admin.*` e exigir auth + flag (early return 401/403)
3. Criar `<AdminShell>` com slots `<sidebar>` + `<banner>` + `<children>`
4. Criar `<PlatformModeBanner>` sticky com cor de destaque (não vermelho — usar `--sage-warn` da palette)
5. Criar `<AdminSidebar>` com 14 entries (dashboard/inbox/tenants/audit/lgpd/incidents/usage/users/platform-admins) + ícones Phosphor distintos
6. `app/admin/layout.tsx` invoca `requirePlatformAdmin()` no top do server component, renderiza `<AdminShell>`
7. `useAdminGuard.ts` client-side checa `useAuth().is_platform_admin` em mount; se false → `router.replace('/login')`
8. Criar `/admin/forbidden/page.tsx` com mensagem clara e link "Voltar"
9. Documentar host setup no README do projeto (linha sobre `/etc/hosts` ou Vercel multi-domain)

#### Acceptance Criteria (testáveis)

```gherkin
Given um user que NÃO está em platform_admins
When ele acessa admin.localhost:3001/admin/dashboard
Then ele recebe 403 (página /admin/forbidden) ou redirect pra /login
And nenhuma query cross-tenant é executada (verificar Supabase logs)
```

```gherkin
Given um user que ESTÁ em platform_admins com MFA aal2
When ele acessa admin.localhost:3001/admin
Then ele é redirecionado pra /admin/dashboard
And o banner "MODO PLATAFORMA" está visível sticky no topo
And a sidebar admin renderiza com 14 entradas distintas da sidebar /app
```

```gherkin
Given um platform_admin logado em admin.localhost
When ele clica "Sair pra app pessoal" no banner
Then ele vai pra app.localhost:3001/app/inbox sem perder sessão
And o banner "MODO PLATAFORMA" some
```

```gherkin
Given um platform_admin com sessão aal1 (sem MFA recente)
When ele acessa admin.localhost:3001/admin/dashboard
Then ele é redirecionado pra /login/mfa
```

#### QA test cases (pra QA gate subagent)

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | middleware | Host non-admin não passa pelo guard | Playwright: GET app.localhost/app/inbox como user normal funciona |
| t2 | middleware | Host admin sem session → 401 | curl admin.localhost/admin sem cookie → 302 /login |
| t3 | middleware | Host admin com session non-platform-admin → 403 | Playwright: login user comum, navega admin.localhost → /admin/forbidden |
| t4 | rls | `fn_is_platform_admin()` retorna false pra user normal | DB query `select fn_is_platform_admin()` impersonando user normal → false |
| t5 | ui | Banner sticky persiste em todas as rotas /admin/* | Playwright snapshot em /admin/dashboard, /admin/tenants, /admin/audit |
| t6 | ui | Sidebar admin tem entradas distintas das de /app | Playwright: comparar `getByRole('navigation')` em /admin vs /app |
| t7 | a11y | Banner tem `role=region` + `aria-label="Modo Plataforma"` | Playwright + axe-core |

#### Architecture contracts emitted

```yaml
exposes:
  - type: middleware
    id: "requirePlatformAdmin"
    file: "lib/auth/requirePlatformAdmin.ts"
    signature: "() => Promise<{ user, platformAdminId }>"
    throws: "redirect('/admin/forbidden') | redirect('/login/mfa')"
  - type: react_hook
    id: "useAdminGuard"
    file: "hooks/useAdminGuard.ts"
    signature: "() => void (side-effect: redirect if drops)"
  - type: react_component
    id: "<AdminShell>"
    file: "components/admin/AdminShell.tsx"
  - type: react_component
    id: "<PlatformModeBanner>"
    file: "components/admin/PlatformModeBanner.tsx"
  - type: route
    id: "/admin"
    behavior: "redirect server-side pra /admin/dashboard"
```

#### Decisões a registrar
- Sub-domínio é `admin.deskcomm.com` em prod, `admin.localhost:3001` em dev (alias /etc/hosts)
- Banner usa cor de acento `--sage-warn` (não vermelho — vermelho fica reservado pra suspended/critical)
- Cookie de sessão é o mesmo `sb-deskcomm-auth` (compartilhado entre app e admin) — diferenciação é por flag `is_platform_admin`, não por cookie separado

#### Definition of Done
- [ ] Todos os ACs passam em Playwright
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Sem warnings no console em dev
- [ ] Commit `feat(EPIC-11): admin layout + guard + banner [wave 1]`
- [ ] Architecture contracts registrados no state file
- [ ] Smoke test: user normal NÃO acessa nenhuma rota /admin

---

### S-11.02 — Page `/admin/dashboard` (KPIs cross-tenant + alerts banner)

**Points**: 4 | **Priority**: P0 | **Deps**: S-11.01 | **FR refs**: Sitemap §4, Jornada 2 passo 2-3

#### Contexto
Landing default do admin após login. Mostra 5 KPIs cross-tenant em cards e um banner de alertas críticos clicável (Jornada 2 passo 3 → "Acme Loja • 12 pendentes >10min" leva a `/admin/tenants/[id]/health`). Subscribe a canal `alerts-platform` pra receber alertas em tempo real (banimento WAHA, SLA LGPD em risco D+5, AI budget estourado).

#### Files to create
- `app/admin/dashboard/page.tsx` — server component, busca KPIs initial + hidrata
- `components/admin/dashboard/KPICards.tsx` — 5 cards: tenants ativos, conversas pendentes >10min, alertas WAHA, SLA LGPD em risco, AI budget warnings
- `components/admin/dashboard/AlertsBanner.tsx` — lista de alertas críticos clicáveis
- `components/admin/dashboard/AlertItem.tsx` — item individual com severity (critical/warning/info)
- `hooks/useAdminDashboardKPIs.ts` — TanStack query, refetch a cada 30s
- `hooks/useAlertsRealtime.ts` — subscribe `alerts-platform`
- `app/api/v1/admin/dashboard/kpis/route.ts` — GET endpoint com queries agregadas

#### Files to modify
- `lib/realtime/channels.ts` — adicionar `alertsPlatform()` builder

#### Implementation steps (sequential)
1. Criar SQL views ou queries agregadas: `count(tenants) where status='active'`, `count(conversations) where status='pending' and now()-created_at > '10min'`, etc.
2. Criar `GET /api/v1/admin/dashboard/kpis` que invoca `requirePlatformAdmin()` server-side
3. Criar `useAdminDashboardKPIs` (TanStack, `staleTime=15s`, `refetchInterval=30s`)
4. Criar `<KPICards>` com 5 cards Sage-styled, cada um com label + valor + delta
5. Criar `<AlertsBanner>` com `<AlertItem>` clicável → router.push pra rota relevante (health, lgpd request, etc.)
6. `useAlertsRealtime` subscribe a `alerts-platform`, on event invalida cache do dashboard + push notification toast
7. `app/admin/dashboard/page.tsx` renderiza grid `<KPICards>` + `<AlertsBanner>` + recent activity

#### Acceptance Criteria (testáveis)

```gherkin
Given um platform_admin logado
When ele navega pra /admin/dashboard
Then 5 KPI cards renderizam com valores numéricos em < 1s p95
And eventual alerts banner aparece com items clicáveis
```

```gherkin
Given dashboard aberto
When um worker emite event "alert.waha_ban" no canal alerts-platform
Then o banner ganha um novo <AlertItem severity=critical> sem reload
And um toast "Novo alerta crítico" aparece
```

```gherkin
Given um <AlertItem> "Acme Loja • 12 pendentes >10min"
When o admin clica
Then ele vai pra /admin/tenants/{acme-id}/health
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET /api/v1/admin/dashboard/kpis retorna 200 com 5 fields | curl com cookie admin |
| t2 | api | Mesmo endpoint com user normal → 403 | curl com cookie user comum |
| t3 | rls | KPIs contam ROWS de TODOS tenants (não só do user) | DB seed 2 tenants, conta esperada = soma |
| t4 | realtime | broadcast em alerts-platform → banner atualiza | Playwright + supabase realtime simulado |
| t5 | ui | KPICards renderizam 5 cards | Playwright snapshot |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/dashboard"
  - type: api_route
    id: "GET /api/v1/admin/dashboard/kpis"
    response_schema: "{ tenants_active, conv_pending_10min, waha_ban_alerts, lgpd_at_risk, ai_budget_warnings, alerts: AlertItem[] }"
  - type: realtime_channel
    id: "alerts-platform"
    events: ["alert.waha_ban", "alert.lgpd_at_risk", "alert.ai_budget_exceeded", "alert.tenant_pending_overflow"]
  - type: react_hook
    id: "useAlertsRealtime"
    file: "hooks/useAlertsRealtime.ts"
```

#### Definition of Done
- [ ] ACs passam em Playwright
- [ ] Typecheck/lint clean
- [ ] Commit `feat(EPIC-11): admin dashboard + alerts realtime [wave 2]`
- [ ] Regression S-11.01 ainda passa

---

### S-11.03 — Page `/admin/inbox` cross-tenant unificada

**Points**: 5 | **Priority**: P0 | **Deps**: S-11.01, S-11.02 | **FR refs**: Sitemap §4 (3 col cross-tenant), Jornada 1 adaptada cross-tenant, Spec 01 §3.6 (T-04 bypass RLS)

#### Contexto
Inbox unificada que mostra conversas de TODOS os tenants num só feed. Reusa `<ConversationList>` e `<ChatThread>` do EPIC-03 com prop `crossTenant={true}`, que adiciona `<TenantBadge>` em cada item. Server-side a query roda com `fn_is_platform_admin()` retornando true → bypass de RLS conforme Spec 01 §3.6 policies. Canal realtime dedicado `admin-inbox-{platform_admin_id}` consolida broadcasts de todos os `inbox-{org_id}` que o admin tem acesso.

#### Files to create
- `app/admin/inbox/layout.tsx` — 3 col layout (lista + thread + side panel)
- `app/admin/inbox/page.tsx` — empty state (escolha conversa)
- `app/admin/inbox/[conversationId]/page.tsx` — server component, busca conversation cross-tenant + renderiza thread
- `hooks/useAdminInbox.ts` — TanStack query lista cross-tenant
- `hooks/useAdminInboxRealtime.ts` — subscribe `admin-inbox-{platform_admin_id}`
- `components/admin/inbox/TenantBadge.tsx` — chip com nome + slug do tenant
- `lib/realtime/admin-inbox-fanout.ts` — worker/edge function que recebe events de TODOS os `inbox-{org_id}` e fan-out pro canal admin

#### Files to modify
- `components/inbox/ConversationList.tsx` — aceitar prop `crossTenant?: boolean` que ativa render de `<TenantBadge>`
- `components/inbox/ChatThread.tsx` — quando `crossTenant`, exibir tenant header acima da thread
- `app/api/v1/conversations/route.ts` — quando chamado de `/admin/*`, NÃO restringir por org_id (delega à RLS bypass)

#### Implementation steps (sequential)
1. Criar `useAdminInbox` que chama `GET /api/v1/conversations?cross_tenant=true` (server valida `fn_is_platform_admin()`)
2. Modificar `<ConversationList>` pra renderizar `<TenantBadge tenant={conv.tenant}>` quando `crossTenant=true`
3. Criar canal `admin-inbox-{platform_admin_id}` no Supabase Realtime + edge function fanout que escuta inserts em `messages` cross-tenant e broadcast pro canal
4. `useAdminInboxRealtime` invalida cache + atualiza badge count
5. `app/admin/inbox/[conversationId]/page.tsx` busca conversation com bypass RLS, hidrata thread
6. CRMSidePanel reutilizado mostra contact + deal **do tenant da conversa** (não do admin)
7. Composer **desabilitado** por padrão (admin não responde — só observa); habilitar só após impersonate (S-11.07)

#### Acceptance Criteria (testáveis)

```gherkin
Given 2 tenants com 5 conversas cada
When platform_admin abre /admin/inbox
Then a lista mostra 10 conversas com <TenantBadge> em cada
And ordenação é por last_message_at desc
```

```gherkin
Given /admin/inbox aberto
When uma nova mensagem chega em qualquer tenant
Then o canal admin-inbox-{platform_admin_id} broadcastes
And a lista atualiza com a nova conversa no topo em <500ms
And o tenant badge correto aparece
```

```gherkin
Given platform_admin clicou numa conversa do tenant Acme
When a thread carrega
Then o header mostra "Tenant: Acme Loja"
And o composer está desabilitado (read-only) com hint "Use Impersonate pra responder"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | rls | Query cross-tenant funciona com platform_admin | DB query como admin → rows de tenants A+B |
| t2 | rls | Mesma query NÃO funciona pra user normal | DB query como user A → só rows de A |
| t3 | realtime | Insert em messages do tenant B atualiza inbox admin | Playwright + INSERT direto |
| t4 | ui | TenantBadge renderiza com nome correto | Playwright snapshot |
| t5 | ux | Composer desabilitado em /admin/inbox/[id] | Playwright: textarea tem `disabled` |
| t6 | perf | TTI inbox cross-tenant < 1.5s p95 | Lighthouse |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/inbox"
  - type: route
    id: "/admin/inbox/[conversationId]"
  - type: react_hook
    id: "useAdminInbox"
  - type: realtime_channel
    id: "admin-inbox-{platform_admin_id}"
    events: ["message.created", "conversation.updated", "conversation.claimed"]
  - type: react_component
    id: "<TenantBadge>"
```

#### Definition of Done
- [ ] ACs passam, regression S-11.01-02 OK
- [ ] Commit `feat(EPIC-11): admin inbox cross-tenant + realtime fanout [wave 3]`

---

### S-11.04 — Page `/admin/tenants` (lista + filtros + busca + criação manual)

**Points**: 4 | **Priority**: P0 | **Deps**: S-11.01 | **FR refs**: Sitemap §4

#### Contexto
Catálogo cross-tenant. Filtros: status (active/suspended/onboarding), plan, has_waha_session, last_active range. Busca por nome/slug/CNPJ. Botão "Novo tenant" abre wizard manual (`/admin/tenants/new`) — usado pra onboarding manual de clientes BPO.

#### Files to create
- `app/admin/tenants/page.tsx` — server component com initial fetch
- `app/admin/tenants/new/page.tsx` — formulário de criação manual
- `components/admin/tenants/TenantsTable.tsx` — DataGrid com colunas (name, slug, plan, status, created_at, last_active, actions)
- `components/admin/tenants/TenantsFilters.tsx` — filtros + search
- `hooks/useAdminTenants.ts` — TanStack query com filters
- `hooks/useCreateTenant.ts` — mutation
- `app/api/v1/admin/tenants/route.ts` — GET (list) + POST (create)

#### Implementation steps (sequential)
1. `GET /api/v1/admin/tenants?status=&plan=&search=&page=` com bypass RLS
2. `<TenantsTable>` renderiza com paginação cursor-based
3. `<TenantsFilters>` com debounced search (300ms)
4. `POST /api/v1/admin/tenants` cria tenant com `status='onboarding'` + audita `tenant.created_by_platform_admin`
5. Wizard manual em `/admin/tenants/new` (campos: name, slug, plan, owner_email)
6. Após criar, redirect pra `/admin/tenants/[id]`

#### Acceptance Criteria

```gherkin
Given 5 tenants no DB
When admin abre /admin/tenants
Then tabela renderiza 5 rows com filtros + busca disponíveis
```

```gherkin
Given admin no /admin/tenants/new
When ele submete name="Test Loja", slug="test", plan="standard"
Then um tenant é criado com status=onboarding
And admin é redirecionado pra /admin/tenants/{novo-id}
And audit log tem entrada "tenant.created_by_platform_admin"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET /api/v1/admin/tenants retorna lista | curl |
| t2 | api | POST cria tenant + audit | curl + check audit_log |
| t3 | ui | Search filtra em <500ms | Playwright type "acm" → vê só Acme |
| t4 | rls | User normal recebe 403 nos endpoints | curl |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/tenants"
  - type: route
    id: "/admin/tenants/new"
  - type: api_route
    id: "GET /api/v1/admin/tenants"
  - type: api_route
    id: "POST /api/v1/admin/tenants"
    request_schema: "{ name, slug, plan, owner_email }"
```

#### Definition of Done
- [ ] ACs passam, commit `feat(EPIC-11): admin tenants list + create [wave 4]`

---

### S-11.05 — Page `/admin/tenants/[id]` (overview + impersonate button + suspend toggle)

**Points**: 3 | **Priority**: P0 | **Deps**: S-11.04 | **FR refs**: Sitemap §4

#### Contexto
Detail page de um tenant. Mostra overview (counts: users, conversations, leads, deals; plan, status, created_at, owner). Botões grandes: "Impersonate" (S-11.07) e "Suspend/Reactivate" (S-11.08). Tabs internas: Overview / Health / Team / Usage (placeholders preenchidos nas próximas stories).

#### Files to create
- `app/admin/tenants/[id]/layout.tsx` — tabs + tenant header
- `app/admin/tenants/[id]/page.tsx` — overview default
- `components/admin/tenants/TenantOverview.tsx` — cards de counts
- `components/admin/tenants/TenantActions.tsx` — botões impersonate + suspend
- `components/admin/tenants/SuspendDialog.tsx` — modal com `reason` textarea
- `hooks/useTenantDetail.ts` — fetch overview

#### Implementation steps (sequential)
1. `GET /api/v1/admin/tenants/[id]` retorna overview + counts
2. `<TenantOverview>` renderiza grid de counts + metadata
3. `<TenantActions>` com 2 botões grandes; suspend abre `<SuspendDialog>` que exige reason
4. Tabs nav: Overview (default) | Health | Team | Usage — placeholders por enquanto
5. Banner amarelo persistente se `tenant.status='suspended'`

#### Acceptance Criteria

```gherkin
Given tenant Acme com 5 users, 100 conversations
When admin abre /admin/tenants/{acme-id}
Then overview mostra "5 users, 100 conversations" + plan + status
And botões "Impersonate" e "Suspend" estão visíveis
```

```gherkin
Given tenant suspended
When admin abre /admin/tenants/{id}
Then banner amarelo "Tenant suspenso desde {data}: {reason}" está sticky no topo
And botão troca pra "Reactivate"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET /api/v1/admin/tenants/[id] retorna overview | curl |
| t2 | ui | Banner suspended renderiza com cor warn | Playwright |
| t3 | ui | SuspendDialog exige reason ≥10 chars | Playwright: type "x" → submit disabled |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/tenants/[id]"
  - type: api_route
    id: "GET /api/v1/admin/tenants/[id]"
  - type: react_component
    id: "<SuspendDialog>"
```

#### Definition of Done
- [ ] ACs passam, commit `feat(EPIC-11): tenant detail + overview [wave 5]`

---

### S-11.06 — Page `/admin/tenants/[id]/health` (WAHA + Nuvemshop + AI + audit lag + realtime)

**Points**: 4 | **Priority**: P0 | **Deps**: S-11.05 | **FR refs**: Sitemap §4, Jornada 2 passo 4

#### Contexto
Health grid de um tenant: status WAHA sessions (working/banned/qr-pending), Nuvemshop OAuth (connected/expired/missing), AI budget consumido (% do mês), audit log lag (segundos atrás do último insert). Realtime via canal `tenant-health-{tenant_id}` recebendo broadcasts de workers que atualizam status.

#### Files to create
- `app/admin/tenants/[id]/health/page.tsx`
- `components/admin/tenants/HealthGrid.tsx`
- `components/admin/tenants/HealthCard.tsx` — card individual com indicador colorido
- `hooks/useTenantHealth.ts` — fetch + realtime
- `app/api/v1/admin/tenants/[id]/health/route.ts` — agrega status

#### Implementation steps (sequential)
1. `GET /api/v1/admin/tenants/[id]/health` agrega: WAHA sessions count + status, Nuvemshop oauth_token expiry, AI tokens consumed/budget, lag = `now() - max(created_at) from audit_log`
2. `useTenantHealth` query + subscribe `tenant-health-{tenant_id}`
3. `<HealthGrid>` renderiza 4 `<HealthCard>` (WAHA, Nuvemshop, AI, Audit)
4. Cores: green (OK), amber (warning), red (critical)
5. Workers (WAHA monitor, Nuvemshop sync) emitem broadcast no canal quando status muda

#### Acceptance Criteria

```gherkin
Given tenant Acme com WAHA session "working"
When admin abre /admin/tenants/{acme-id}/health
Then card WAHA mostra "Working" verde
```

```gherkin
Given health page aberto
When worker emite "waha.banned" no canal tenant-health-{id}
Then card WAHA muda pra "Banned" vermelho em <2s sem reload
And card pulsa com transition (motion language)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET /health retorna 4 fields | curl |
| t2 | realtime | broadcast atualiza card | simular event |
| t3 | ui | Cores corretas por status | Playwright snapshot |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/tenants/[id]/health"
  - type: api_route
    id: "GET /api/v1/admin/tenants/[id]/health"
  - type: realtime_channel
    id: "tenant-health-{tenant_id}"
    events: ["waha.banned", "waha.recovered", "nuvemshop.token_expired", "ai.budget_exceeded", "audit.lag_warning"]
  - type: react_hook
    id: "useTenantHealth"
```

#### Definition of Done
- [ ] ACs + regression OK, commit `feat(EPIC-11): tenant health + realtime [wave 6]`

---

### S-11.07 — API `POST /api/v1/admin/tenants/[id]/impersonate`

**Points**: 4 | **Priority**: P0 | **Deps**: S-11.05 | **FR refs**: Sitemap §4 (impersonate action), Spec 01 audit T-04

#### Contexto
Endpoint que permite ao platform_admin "entrar" em um tenant como se fosse user dele (com flag `acting_as_platform_admin=true` em todos os audit_log subsequentes). Loga `platform_admin.impersonate_started`, seta cookie temporário `impersonate-{tenant_id}` (expiry 1h, signed), retorna URL de redirect pra `/app/inbox` daquele tenant. Endpoint `/end` limpa o cookie.

#### Files to create
- `app/api/v1/admin/tenants/[id]/impersonate/route.ts` — POST start
- `app/api/v1/admin/impersonate/end/route.ts` — POST end
- `lib/impersonate/cookie.ts` — sign/verify HMAC do cookie
- `middleware.ts` (modify) — detectar cookie impersonate, injetar `acting_as_platform_admin=true` em request context
- `components/admin/ImpersonateButton.tsx` — botão + confirm
- `components/admin/ImpersonateBanner.tsx` — banner persistente em `/app/*` durante impersonate, com "Sair do impersonate"

#### Implementation steps (sequential)
1. `POST /api/v1/admin/tenants/[id]/impersonate`: valida `requirePlatformAdmin()`, gera cookie HMAC com `{ tenant_id, platform_admin_id, exp: now+1h }`, escreve `audit_log` com `action='platform_admin.impersonate_started'` e `acting_as_platform_admin=true`, retorna `{ redirect_url: '/app/inbox' }`
2. Middleware detecta cookie em rotas `/app/*`, popula `req.context.impersonating = true` + `req.context.tenant_id_override`
3. Toda Server Action / API que escreve audit_log usa `req.context.impersonating` pra setar `acting_as_platform_admin=true`
4. `<ImpersonateBanner>` em `/app/(app)/layout.tsx` (modify) renderiza condicionalmente quando cookie presente
5. Botão "Sair do impersonate" chama `POST /api/v1/admin/impersonate/end` → limpa cookie + audita `platform_admin.impersonate_ended`
6. Cookie expira automaticamente em 1h; renew exige nova chamada

#### Acceptance Criteria

```gherkin
Given platform_admin no /admin/tenants/{acme-id}
When ele clica "Impersonate" e confirma
Then audit_log tem entrada platform_admin.impersonate_started com acting_as_platform_admin=true
And o admin é redirecionado pra /app/inbox do tenant Acme
And o banner amarelo "Você está atuando como Acme Loja — Sair" aparece sticky
```

```gherkin
Given admin em modo impersonate
When ele envia uma mensagem em /app/inbox
Then audit_log da mensagem tem acting_as_platform_admin=true
```

```gherkin
Given admin em modo impersonate
When ele clica "Sair do impersonate"
Then cookie é limpo, audit log gravado, redirect pra /admin/tenants/{id}
```

```gherkin
Given cookie de impersonate expirou (>1h)
When admin tenta ação em /app
Then cookie é rejeitado, banner some, contexto volta ao normal
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | POST impersonate retorna 200 + cookie | curl + inspect Set-Cookie |
| t2 | audit | Entrada com acting_as_platform_admin=true criada | DB query |
| t3 | middleware | Cookie expirado é rejeitado | Playwright + clock manipulation |
| t4 | rls | Em modo impersonate, queries respeitam tenant_override | DB seed test |
| t5 | ui | Banner persistente em todas /app/* | Playwright snapshot |
| t6 | sec | Cookie é HMAC-signed, tampering rejeitado | curl com cookie alterado → 401 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/admin/tenants/[id]/impersonate"
    request_schema: "{}"
    response_schema: "{ redirect_url: string }"
    side_effects: ["sets cookie impersonate-{tenant_id}", "writes audit_log"]
  - type: api_route
    id: "POST /api/v1/admin/impersonate/end"
  - type: domain_event
    id: "platform_admin.impersonate_started"
    payload: "{ tenant_id, platform_admin_id, started_at }"
  - type: domain_event
    id: "platform_admin.impersonate_ended"
  - type: react_component
    id: "<ImpersonateBanner>"
```

#### Decisões a registrar
- Cookie de impersonate é separado de `sb-deskcomm-auth`, nome `deskcomm-impersonate`, HMAC-SHA256 com `IMPERSONATE_COOKIE_SECRET`, expiry 1h, `httpOnly + secure + sameSite=lax`
- Renovação: nova chamada explícita ao endpoint (não auto-renew, decisão de segurança)

#### Definition of Done
- [ ] ACs passam, commit `feat(EPIC-11): impersonate flow + audit [wave 7]`

---

### S-11.08 — API `POST /admin/tenants/[id]/suspend` + `/reactivate`

**Points**: 3 | **Priority**: P0 | **Deps**: S-11.05 | **FR refs**: Spec 01 audit T-04

#### Contexto
Mutation de tenant status. Suspend exige `reason` (mín 10 chars) — usado em casos de fraude, inadimplência, abuse. Reactivate também exige reason (audit). Side effects: tenant suspenso bloqueia login dos seus users (middleware checa `tenant.status`).

#### Files to create
- `app/api/v1/admin/tenants/[id]/suspend/route.ts`
- `app/api/v1/admin/tenants/[id]/reactivate/route.ts`
- `hooks/useSuspendTenant.ts` + `useReactivateTenant.ts`

#### Files to modify
- `middleware.ts` — checar `tenant.status='suspended'` em login → bloqueia
- `<SuspendDialog>` (S-11.05) — wire ao hook

#### Implementation steps
1. `POST /suspend`: valida admin + reason, UPDATE tenants SET status='suspended', suspended_at=now(), suspended_reason=reason; audita `tenant.suspended`
2. `POST /reactivate`: similar, status='active', cleared
3. Middleware checa em login: se `tenant.status='suspended'`, redireciona pra `/account-suspended` (página informativa)
4. `useSuspendTenant` invalidates `useTenantDetail` + `useAdminTenants`

#### Acceptance Criteria

```gherkin
Given tenant Acme active
When admin chama POST /admin/tenants/{acme-id}/suspend body {reason: "fraude detectada"}
Then tenants.status='suspended' + suspended_reason setado
And audit_log tem entry tenant.suspended
And users do tenant não conseguem mais logar (middleware bloqueia)
```

```gherkin
Given POST /suspend com reason="x" (curto)
Then 422 com error "reason_too_short"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | Suspend válido → 200 | curl |
| t2 | api | Reason curto → 422 | curl |
| t3 | audit | Entry criada | DB |
| t4 | middleware | User de tenant suspenso → /account-suspended | Playwright |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/admin/tenants/[id]/suspend"
    request_schema: "{ reason: string (min 10) }"
  - type: api_route
    id: "POST /api/v1/admin/tenants/[id]/reactivate"
    request_schema: "{ reason: string (min 10) }"
  - type: domain_event
    id: "tenant.suspended"
  - type: domain_event
    id: "tenant.reactivated"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): suspend/reactivate tenant [wave 8]`

---

### S-11.09 — Page `/admin/audit` cross-tenant com filtros ricos

**Points**: 3 | **Priority**: P0 | **Deps**: S-11.01, EPIC-10 | **FR refs**: Sitemap §4

#### Contexto
Cross-tenant audit viewer. Reusa componentes do EPIC-10 mas adiciona filtro por tenant. Filtros: tenant (multi-select), actor (user search), action (multi-select de domain events), date range. Performance: queries indexadas por `(tenant_id, action, created_at)` conforme Jornada 2 nota.

#### Files to create
- `app/admin/audit/page.tsx`
- `app/admin/audit/[entryId]/page.tsx` — detail
- `components/admin/audit/AuditFiltersAdmin.tsx`
- `hooks/useAdminAuditLog.ts`

#### Files to modify
- `components/audit/AuditTable.tsx` (EPIC-10) — aceitar prop `crossTenant` que adiciona coluna tenant

#### Implementation steps
1. `GET /api/v1/admin/audit?tenant_ids[]=&actor_id=&actions[]=&from=&to=&page=`
2. `<AuditFiltersAdmin>` com search async pra tenants e actors
3. Tabela cross-tenant + paginação cursor
4. Detail page com JSON viewer do payload + actor info + tenant info

#### Acceptance Criteria

```gherkin
Given audit cross-tenant aberto
When admin filtra tenant=Acme + action=conversation.resolved + last 7 days
Then resultados retornam <2s p95
And cada row mostra coluna tenant
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET retorna entries cross-tenant | curl |
| t2 | perf | Query <2s com 1M rows | DB seed + benchmark |
| t3 | ui | Filtros funcionam | Playwright |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/audit"
  - type: route
    id: "/admin/audit/[entryId]"
  - type: api_route
    id: "GET /api/v1/admin/audit"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): admin audit cross-tenant [wave 9]`

---

### S-11.10 — Page `/admin/lgpd` cross-tenant LGPD requests

**Points**: 3 | **Priority**: P0 | **Deps**: S-11.01, EPIC-08 | **FR refs**: Sitemap §4, Jornada LGPD nota linha 187-189

#### Contexto
Visão cross-tenant das LGPD requests. Foco em SLA (D+5 escalation, D+7 expiration). Banner top vermelho com "X requests vencendo em <24h". Reuso de componentes do EPIC-08 com tenant badge.

#### Files to create
- `app/admin/lgpd/page.tsx`
- `app/admin/lgpd/requests/page.tsx`
- `app/admin/lgpd/requests/[id]/page.tsx`
- `hooks/useAdminLGPDRequests.ts`

#### Implementation steps
1. `GET /api/v1/admin/lgpd/requests?status=&risk_level=&tenant_id=`
2. Risk level computed: D+5 sem ação = `at_risk`, D+7 = `expired`
3. Banner vermelho se algum request `at_risk` ou `expired`
4. Tabela com tenant badge + countdown timer

#### Acceptance Criteria

```gherkin
Given 3 LGPD requests pendentes em tenants diferentes (1 D+6)
When admin abre /admin/lgpd
Then banner vermelho "1 request vencendo em <24h" aparece
And tabela lista 3 requests com countdown
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET retorna requests cross-tenant | curl |
| t2 | logic | Risk level correto | DB seed + check |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/lgpd"
  - type: route
    id: "/admin/lgpd/requests/[id]"
  - type: api_route
    id: "GET /api/v1/admin/lgpd/requests"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): admin lgpd cross-tenant [wave 10]`

---

### S-11.11 — Page `/admin/incidents` + `useResolveIncident`

**Points**: 4 | **Priority**: P1 | **Deps**: S-11.01, S-11.06 | **FR refs**: Sitemap §4

#### Contexto
Lista de incidents operacionais — banimento WAHA, falhas de webhook (Nuvemshop, WAHA), worker queue overflow, RLS policy violations. Source: tabela `incidents` (criada nesta story se não existir) + `event_log`. Mutation `useResolveIncident` move pra status=resolved + `resolution_note` obrigatória.

#### Files to create
- `app/admin/incidents/page.tsx`
- `app/admin/incidents/[id]/page.tsx` — detail com timeline + payload
- `components/admin/incidents/IncidentsTable.tsx`
- `components/admin/incidents/ResolveIncidentDialog.tsx`
- `hooks/useAdminIncidents.ts`
- `hooks/useResolveIncident.ts`
- `app/api/v1/admin/incidents/route.ts` — GET list
- `app/api/v1/admin/incidents/[id]/route.ts` — GET detail
- `app/api/v1/admin/incidents/[id]/resolve/route.ts` — POST resolve
- `supabase/migrations/00XX_incidents.sql` (modify existing or create) — table `incidents { id, tenant_id, type, severity, payload, status, created_at, resolved_at, resolved_by, resolution_note }` + RLS

#### Implementation steps
1. Migration: tabela `incidents` com policies (platform_admin only)
2. Workers existentes (waha-monitor, nuvemshop-webhook) inserem incidents quando detectam falha
3. `GET /api/v1/admin/incidents?status=&severity=&tenant_id=`
4. `<IncidentsTable>` com colunas (type, tenant, severity, created_at, status)
5. `useResolveIncident({id, resolution_note})` mutation; invalida lista
6. Realtime: incidents também broadcastam em `alerts-platform` (S-11.02)

#### Acceptance Criteria

```gherkin
Given worker WAHA detecta banimento do tenant Acme
When ele insere incident { type: "waha_banned", tenant_id, severity: critical }
Then incident aparece em /admin/incidents
And banner /admin/dashboard alerta
```

```gherkin
Given admin abre incident
When ele clica "Resolver", digita "Sessão restaurada via QR re-scan", confirma
Then incident.status='resolved', resolved_by=admin_id
And event incident.resolved emitido
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Migration aplicou | list_tables |
| t2 | api | GET incidents retorna lista | curl |
| t3 | api | POST resolve sem note → 422 | curl |
| t4 | rls | platform_admin only | curl como user normal → 403 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_table
    id: "incidents"
  - type: route
    id: "/admin/incidents"
  - type: route
    id: "/admin/incidents/[id]"
  - type: api_route
    id: "GET /api/v1/admin/incidents"
  - type: api_route
    id: "POST /api/v1/admin/incidents/[id]/resolve"
    request_schema: "{ resolution_note: string (min 10) }"
  - type: react_hook
    id: "useResolveIncident"
  - type: domain_event
    id: "incident.resolved"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): incidents + resolve mutation [wave 11]`

---

### S-11.12 — Page `/admin/usage` (uso/custo por tenant + gráficos)

**Points**: 3 | **Priority**: P1 | **Deps**: S-11.01 | **FR refs**: Sitemap §4

#### Contexto
Visão de uso/custo por tenant: mensagens enviadas/dia, AI tokens consumidos, storage GB. Gráficos line/bar com `recharts` ou `tremor`. Range selector (7d/30d/90d). Source: agregações de `messages`, `ai_usage`, `storage_objects`.

#### Files to create
- `app/admin/usage/page.tsx`
- `components/admin/usage/UsageChart.tsx`
- `components/admin/usage/UsageTable.tsx`
- `hooks/useAdminUsage.ts`
- `app/api/v1/admin/usage/route.ts`

#### Implementation steps
1. `GET /api/v1/admin/usage?range=30d&tenant_id?` agrega por dia
2. `<UsageChart>` com 3 séries (mensagens, AI tokens, storage)
3. Tabela com totais por tenant ordenada por consumo desc
4. Export CSV (botão)

#### Acceptance Criteria

```gherkin
Given 3 tenants ativos no último mês
When admin abre /admin/usage com range=30d
Then 3 charts renderizam (msgs, AI, storage) com dados agregados
And tabela mostra ranking por consumo
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET usage retorna dados agregados | curl |
| t2 | ui | Charts renderizam sem error | Playwright |
| t3 | export | CSV download funciona | Playwright trigger + verify download |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/usage"
  - type: api_route
    id: "GET /api/v1/admin/usage"
    response_schema: "{ daily: { date, tenant_id, messages, ai_tokens, storage_gb }[] }"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): admin usage charts [wave 12]`

---

### S-11.13 — Page `/admin/users` (lista cross-tenant + filtros)

**Points**: 2 | **Priority**: P1 | **Deps**: S-11.01 | **FR refs**: Sitemap §4

#### Contexto
Lista TODOS users de TODOS tenants. Filtros: tenant, role (viewer/agent/manager/admin), status (active/disabled), last_login range, search por email/nome. Read-only por default — actions de modificação só via tenant admin (não cross-tenant aqui).

#### Files to create
- `app/admin/users/page.tsx`
- `app/admin/users/[id]/page.tsx`
- `components/admin/users/UsersTableAdmin.tsx`
- `hooks/useAdminUsers.ts`
- `app/api/v1/admin/users/route.ts`

#### Implementation steps
1. `GET /api/v1/admin/users?tenant_id=&role=&search=&page=`
2. Tabela com colunas (email, name, tenant, role, last_login, status)
3. Detail page mostra org_memberships (multi-tenant), audit recente, conversations atendidas
4. Sem actions de modificação — só visualização (decisão UX)

#### Acceptance Criteria

```gherkin
Given 50 users em 3 tenants
When admin abre /admin/users
Then tabela paginada renderiza com filtros funcionais
And busca por email funciona em <500ms
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET users cross-tenant | curl |
| t2 | rls | bypass funciona | DB query |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/users"
  - type: route
    id: "/admin/users/[id]"
  - type: api_route
    id: "GET /api/v1/admin/users"
```

#### Definition of Done
- [ ] Commit `feat(EPIC-11): admin users cross-tenant [wave 13]`

---

### S-11.14 — Page `/admin/platform-admins` (read-only)

**Points**: 2 | **Priority**: P2 | **Deps**: S-11.01 | **FR refs**: Spec 01 §3.4 T-04, Sitemap §4

#### Contexto
Última story do epic. Página estritamente read-only que lista platform_admins ativos. **Modificação NÃO via UI** — apenas via DBA com double-confirmation, conforme Spec 01 §3.4 T-04. A página tem aviso destacado: "Adição/remoção de platform_admins é feita exclusivamente pelo DBA via SQL com nota explicativa em `audit_log`. Esta página é informativa."

#### Files to create
- `app/admin/platform-admins/page.tsx`
- `components/admin/platform-admins/PlatformAdminsTable.tsx`
- `components/admin/platform-admins/DBAOnlyNotice.tsx`
- `hooks/useAdminPlatformAdmins.ts`
- `app/api/v1/admin/platform-admins/route.ts` — GET only

#### Implementation steps
1. `GET /api/v1/admin/platform-admins` retorna lista com `granted_by`, `granted_at`, `scope`, `mfa_required`, `revoked_at`
2. `<DBAOnlyNotice>` banner azul claro no topo com texto sobre T-04
3. `<PlatformAdminsTable>` colunas (email, granted_by, granted_at, scope, status)
4. **NENHUM** botão de criar/revogar
5. Documentação: link pra runbook `/runbook/platform-admin-management.md` (placeholder se não existir)

#### Acceptance Criteria

```gherkin
Given 2 platform_admins ativos
When admin abre /admin/platform-admins
Then tabela read-only renderiza com 2 entries
And notice "Modificação somente via DBA" está visível e proeminente
And NÃO existem botões de adicionar/remover/editar
```

```gherkin
Given API GET /admin/platform-admins
When chamado
Then retorna apenas SELECT — POST/PATCH/DELETE retornam 405
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | api | GET retorna lista | curl |
| t2 | api | POST → 405 Method Not Allowed | curl |
| t3 | ui | Sem botões de mutation | Playwright: query buttons → 0 |
| t4 | ui | DBAOnlyNotice visível | Playwright snapshot |

#### Architecture contracts emitted

```yaml
exposes:
  - type: route
    id: "/admin/platform-admins"
  - type: api_route
    id: "GET /api/v1/admin/platform-admins"
    notes: "READ-ONLY — POST/PATCH/DELETE return 405"
```

#### Decisões a registrar
- T-04 enforcement: nenhuma rota API ou UI permite mutation de `platform_admins`. Confirmar policy SQL `for all using (false) with check (false)` na tabela (já existe em migration 0001) — apenas DBA com `service_role` consegue modificar.

#### Definition of Done
- [ ] ACs passam
- [ ] Commit `feat(EPIC-11): platform-admins read-only [wave 14]`
- [ ] Epic full regression suite verde

---

## 6. Regression Suite Cumulativo (esperado ao final)

Ao terminar o epic, a regression suite deve cobrir, no mínimo:

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering (admin layout + 14 pages) | 18 | S-11.01 a S-11.14 |
| API contracts (15+ endpoints) | 22 | idem |
| RLS bypass (fn_is_platform_admin) | 10 | S-11.01, 03, 04, 09, 13, 14 |
| Realtime channels (3) | 8 | S-11.02, 03, 06 |
| Audit log entries (impersonate, suspend, etc) | 6 | S-11.07, 08, 11 |
| Permission negative tests (user non-admin) | 14 | todas |
| Mobile read-only enforcement | 5 | S-11.03, 05, 07 |
| **Total** | **~83** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| RLS bypass mal implementado vaza dados entre tenants | Crítico | Testes RLS dedicados (t3/t4 em quase todas stories); revisão SQL em PR; smoke test cross-tenant em CI |
| Cookie de impersonate roubado/forjado | Alto | HMAC-SHA256 com secret rotacionável; expiry 1h; httpOnly+secure+sameSite; audit em cada start/end |
| Admin esquecer modo impersonate ativo e fazer ações | Médio | Banner sticky persistente impossível de fechar; expiry 1h auto; double-confirm em ações destrutivas |
| Inbox cross-tenant vira gargalo de perf (10k+ conversas) | Médio | Paginação cursor; índice `(last_message_at desc)` global; realtime fanout via edge function |
| Suspend de tenant em produção por engano | Alto | Reason obrigatória ≥10 chars; double-confirm modal; audit imutável; reactivate disponível 24/7 |
| Sub-domínio admin vaza pra crawlers | Baixo | `robots.txt` block + `noindex` meta; Vercel password protection opcional |
| Platform_admin com sessão sem MFA | Crítico | requirePlatformAdmin exige `aal2`; redirect /login/mfa se falha |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-EPIC-11-01**: Sub-domínio dedicado `admin.deskcomm.com` em vez de path `/admin` no host principal. Razão: isolamento de cookies, robots, possível Vercel password protection, separação clara de superfícies.
- **ADR-EPIC-11-02**: Cookie de impersonate é separado do `sb-deskcomm-auth` (HMAC, expiry 1h, no auto-renew). Razão: auditabilidade explícita + fail-safe.
- **ADR-EPIC-11-03**: Mobile no `/admin` é deliberadamente read-only — composer e mutations escondidos < `md`. Razão: cross-tenant action em mobile é alto-risco; obriga uso em desktop.
- **ADR-EPIC-11-04**: 3 canais realtime dedicados (`admin-inbox-{platform_admin_id}`, `tenant-health-{tenant_id}`, `alerts-platform`) em vez de subscribe de N `inbox-{org_id}`. Razão: escala e simplicidade de hooks no front; fanout via edge function server-side.
- **ADR-EPIC-11-05**: `platform_admins` é write-only-via-DBA (T-04 reforçado). Página `/admin/platform-admins` é UI informativa; nenhuma rota API expõe mutation.
- **ADR-EPIC-11-06**: Tabela `incidents` é nova source-of-truth pra falhas operacionais cross-tenant; workers (WAHA monitor, Nuvemshop webhook) escrevem nela; também broadcastam em `alerts-platform`.

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/01-sitemap.md` §4 (rotas /admin/*); `docs/design-system/screen-flow/02-journeys.md` Jornada 2 (super-admin BPO triagem).
- Specs refs: `docs/specs/01-spec-platform-base.md` §3.4 platform_admins, §3.6 RLS policies com bypass `fn_is_platform_admin()`, T-04 (DBA-only mutation).
- Business rules: T-04 (platform_admins DBA-only), AT-XX (audit cross-tenant com `acting_as_platform_admin`).
- Reconciliation: nenhuma pendência cross-spec — epic apenas consome contracts existentes + adiciona camada cross-tenant.
- Decisão UX herdada (mobile read-only): vide Spec 09 §responsive-strategy + design-system `07-responsive-strategy.md`.
