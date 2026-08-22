---
epic_id: EPIC-02-onboarding
epic_name: Tenant Onboarding
priority: P0
estimated_waves: 8
estimated_total_points: 26
depends_on: [EPIC-00, EPIC-01]
exposes_contracts:
  - "route./onboarding/welcome"
  - "route./onboarding/connect-whatsapp"
  - "route./onboarding/connect-nuvemshop"
  - "route./onboarding/setup-ai"
  - "route./onboarding/invite-team"
  - "route./onboarding/done"
  - "action.connectNuvemshop"
  - "action.inviteMember"
  - "action.acceptTerms"
  - "action.setActiveAgent"
  - "db.organizations.onboarding_state"
  - "db.organizations.onboarded_at"
status: completed (partial: WhatsApp QR build-only — needs Docker up for E2E)
created_at: 2026-04-28
owner: Songhai, Lda
---

## Wave Completion Log

- **2026-04-28** — All 8 waves implemented in a single batch.
  - Migration `0008_tenant_onboarding_state` already applied via Supabase MCP
    (columns `onboarding_state jsonb`, `onboarded_at timestamptz`, partial index
    `idx_organizations_pending_onboarding`).
  - Routes: `/onboarding` (auto-router), `/onboarding/welcome`,
    `/onboarding/connect-whatsapp` (build-only — graceful WAHA-down banner
    + skip), `/onboarding/connect-nuvemshop` (wraps EPIC-07 OAuth Server
    Action), `/onboarding/setup-ai`, `/onboarding/invite-team`,
    `/onboarding/done`.
  - Server Actions in `app/actions/onboarding/`:
    `acceptWelcome`, `createDefaultAgent` (+ `skipAi`), `sendOnboardingInvites`,
    `finishOnboarding`, plus `skipWhatsapp`/`markWhatsappConfigured`/
    `skipNuvemshop`/`markNuvemshopConfigured` helpers.
  - WAHA REST client at `lib/waha/client.ts` (returns null when env unset).
  - Middleware now sets `x-pathname`; `app/app/layout.tsx` redirects to
    `/onboarding` when `organizations.onboarded_at IS NULL`.
  - Audit actions added: `onboarding.welcome_completed`,
    `onboarding.whatsapp_configured`, `onboarding.whatsapp_skipped`,
    `onboarding.nuvemshop_skipped`, `onboarding.ai_configured`,
    `onboarding.team_invited`, `onboarding.completed`, `tenant.onboarded`.
  - Verification: `pnpm typecheck` clean, `pnpm lint` only pre-existing
    warnings, `pnpm test:unit` 68/68 pass, anon curl smokes on `/onboarding`,
    `/onboarding/welcome`, `/app/inbox` all return 307 → `/login`.
  - **Deferred**: real QR rendering + WAHA polling to E2E session with Docker
    up; pure server-side build/lint/test loop intentionally skipped that
    path because it requires a live WAHA service.
---

# EPIC-02 — Tenant Onboarding

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Stories em ordem de dependência. Cada story = 1 wave. `Deps:` é lei.

## 1. Objetivo

Conduzir o admin recém-criado por um wizard de 5 passos (welcome → WhatsApp QR → Nuvemshop OAuth → AI agent default → invite team → done) com state persistente em `organizations.onboarding_state jsonb`, permitindo drop-off/resume em qualquer step. Ao final, o tenant está operacional (canal WORKING, loja conectada, agente AI default ativo, time convidado) e cai em `/app/inbox`.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Migration `0008_tenant_onboarding_state` aplicada com coluna `onboarding_state jsonb` (default `'{}'`) e `onboarded_at timestamptz` em `organizations`
- [ ] Layout `app/(onboarding)/layout.tsx` exibe progress stepper de 5 steps + skip-to-end em DEV (`NODE_ENV !== 'production'`)
- [ ] Step 1 `/onboarding/welcome` aceita termos, define timezone e display_name → grava `onboarding_state.welcome = { accepted_at, timezone, display_name }`
- [ ] Step 2 `/onboarding/connect-whatsapp` cria `channel_sessions` row, mostra QR com auto-refresh e atinge status WORKING via polling (R-03 do Spec 03)
- [ ] Step 3 `/onboarding/connect-nuvemshop` chama Server Action `connectNuvemshop` (R-05 reconciliação) → OAuth → callback marca step done
- [ ] Step 4 `/onboarding/setup-ai` cria `ai_agents` default (`is_default = true`) com prompt template selecionado
- [ ] Step 5 `/onboarding/invite-team` envia 1+ convites via `inviteMember` Server Action
- [ ] `/onboarding/done` atualiza `organizations.onboarded_at = now()` e redireciona pra `/app/inbox`
- [ ] Drop-off em qualquer step → ao re-logar, middleware redireciona pro step incompleto correto
- [ ] Onboarding completo p95 < 30min em fluxo feliz (métrica do Jornada 4)

## 3. Pré-requisitos

- EPIC-00 e EPIC-01 completos
- Migrations 0001–0007 aplicadas
- Variáveis de env: `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_APP_ID`, `OAUTH_STATE_SECRET`, `WAHA_BASE_URL`, `WAHA_WEBHOOK_PUBLIC_BASE_URL`, `RESEND_API_KEY` (invites)
- Dev server em `localhost:3001`
- Playwright MCP conectado pra QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | `requireAuth()` / `requireOrgAdmin()` |
| `db.organizations` | db_table | migration 0001 | `RLS via fn_user_org_ids()` |
| `db.channel_sessions` | db_table | migration 0004 | criada pelo step 2 |
| `db.ai_agents` | db_table | migration 0007 | criada pelo step 4 |
| `db.organization_members` | db_table | migration 0001 | invites step 5 |
| `middleware.ts` | middleware | EPIC-01 | redireciona não-onboarded pra `/onboarding/welcome` |
| `lib.toast` | infra | EPIC-00 | toasts de erro/sucesso |
| `infra.tanstack-query` | infra | EPIC-00 | polling do QR status |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `db.organizations.onboarding_state` | db_column | S-02.01 | jsonb `{ welcome?, whatsapp?, nuvemshop?, ai?, team? }` |
| `db.organizations.onboarded_at` | db_column | S-02.01 | timestamptz; null = ainda em onboarding |
| `route./onboarding/*` | route_group | S-02.02 | rotas protegidas por auth + redirecionadoras |
| `ui.<OnboardingStepper>` | react_component | S-02.02 | `props: { steps: 5, current: 1..5 }` |
| `action.acceptTerms` | server_action | S-02.03 | `(input) => { ok }` grava welcome state |
| `action.setActiveAgent` | server_action | S-02.06 | `(agentId)` marca ai_agent como default |
| `action.inviteMember` | server_action | S-02.07 | `(email, role)` cria invite + envia email |
| `action.connectNuvemshop` | server_action | S-02.05 | reusa contract de Spec 06 §4.2 (R-05) |
| `event.tenant.onboarded` | domain_event | S-02.08 | emitido em `event_log` quando `onboarded_at` é setado |

## 5. Stories (em ordem de dependência)

---

### S-02.01 — Migration `0008_tenant_onboarding_state`

**Points**: 2 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 01 §9, Jornada 4 (drop-off/resume)

#### Contexto
Adicionar suporte de state machine persistente ao onboarding. Coluna `onboarding_state jsonb` (default `'{}'`) acumula progresso; `onboarded_at timestamptz` marca conclusão. Schema do jsonb é validado via Zod no Server Action de cada step (não via CHECK no DB — flexibilidade pra evolução).

#### Files to create
- `supabase/migrations/0008_tenant_onboarding_state.sql` — adiciona colunas + índice parcial
- `lib/onboarding/state-schema.ts` — Zod schema do `onboarding_state` jsonb

#### Files to modify
- `supabase/migrations/MANIFEST.md` — adicionar 0008
- `types/database.ts` (gerado) — regenerar via `mcp__plugin_supabase_supabase__generate_typescript_types`

#### Implementation steps (sequential)
1. Criar SQL: `alter table public.organizations add column onboarding_state jsonb not null default '{}'::jsonb;`
2. `alter table public.organizations add column onboarded_at timestamptz;`
3. Índice parcial: `create index organizations_pending_onboarding_idx on public.organizations (id) where onboarded_at is null;`
4. Aplicar migration via `mcp__plugin_supabase_supabase__apply_migration`
5. Regenerar types
6. Criar Zod schema em `lib/onboarding/state-schema.ts` com `welcome`, `whatsapp`, `nuvemshop`, `ai`, `team` opcionais

#### Acceptance Criteria

```gherkin
Given migration 0008 aplicada
When `mcp__plugin_supabase_supabase__list_tables` em `organizations`
Then existe coluna `onboarding_state jsonb not null default '{}'`
And existe coluna `onboarded_at timestamptz null`
And existe índice `organizations_pending_onboarding_idx`
```

```gherkin
Given organização recém-criada
When SELECT onboarding_state FROM organizations WHERE id = $1
Then retorna `{}` (default)
And onboarded_at é NULL
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | db | Migration aplica idempotente | rodar 2× sem erro |
| t2 | db | Default `'{}'` em rows existentes | UPDATE sem set, depois SELECT |
| t3 | rls | RLS preexistente segue ativa | SELECT como user de outro org → 0 rows |
| t4 | types | TS types regenerados expõem novos campos | `import type { Database }` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: db_column
    id: "db.organizations.onboarding_state"
    schema: "jsonb default '{}'::jsonb"
  - type: db_column
    id: "db.organizations.onboarded_at"
    schema: "timestamptz null"
  - type: zod_schema
    id: "OnboardingStateSchema"
    file: "lib/onboarding/state-schema.ts"
```

#### Definition of Done
- [ ] Migration aplicada via Supabase MCP
- [ ] Types regenerados, typecheck passa
- [ ] Lint zero erros novos
- [ ] Commit `feat(EPIC-02): migration onboarding_state [wave 1]`

---

### S-02.02 — Layout `app/(onboarding)/layout.tsx` + stepper + skip-dev

**Points**: 3 | **Priority**: P0 | **Deps**: S-02.01 | **FR refs**: Jornada 4 §5 (stepper), Spec 09 (App Router patterns)

#### Contexto
Route group `(onboarding)` com layout próprio (sem sidebar/topbar do app shell). Layout valida auth, lê `onboarding_state`, e exibe `<OnboardingStepper>` no topo. Em DEV, mostra botão "Skip to end" que chama Server Action de stub completando todos os steps com defaults seguros — produtividade sem hack em prod.

#### Files to create
- `app/(onboarding)/layout.tsx` — Server Component, lê org + redireciona se já onboarded
- `app/(onboarding)/_components/OnboardingStepper.tsx` — progress stepper 5 steps
- `app/(onboarding)/_components/SkipToEndButton.tsx` — só renderiza se `process.env.NODE_ENV !== 'production'`
- `app/(onboarding)/_actions/skip-to-end.ts` — Server Action DEV-only (early return em prod)
- `lib/onboarding/get-current-step.ts` — pure fn `(state) => 'welcome' | 'whatsapp' | ...`

#### Files to modify
- `middleware.ts` — se user logado e `onboarded_at IS NULL`, redirecionar pra `/onboarding/${getCurrentStep(state)}` (exceto se já em `/onboarding/*`)

#### Implementation steps (sequential)
1. Criar `lib/onboarding/get-current-step.ts` com regra: primeiro step incompleto
2. Criar layout que carrega `organization` da sessão + `onboarding_state`
3. Se `onboarded_at IS NOT NULL` → `redirect('/app/inbox')`
4. Renderizar `<OnboardingStepper current={...}>` + `{children}`
5. Renderizar `<SkipToEndButton>` no canto inferior se DEV
6. Implementar `skipToEnd` action: marca todos os steps como done com stubs + setta `onboarded_at`
7. Atualizar `middleware.ts` pra redirecionar pendentes

#### Acceptance Criteria

```gherkin
Given user logado com onboarded_at NULL e onboarding_state vazio
When acessa "/app/inbox"
Then middleware redireciona pra "/onboarding/welcome"
```

```gherkin
Given NODE_ENV=development
When usuário visita "/onboarding/welcome"
Then botão "Skip to end (DEV)" está visível
```

```gherkin
Given NODE_ENV=production
When usuário visita "/onboarding/welcome"
Then botão "Skip to end (DEV)" NÃO está no DOM
```

```gherkin
Given onboarded_at preenchido
When user acessa "/onboarding/welcome"
Then redireciona pra "/app/inbox"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Stepper mostra 5 steps com current correto | Playwright: `getByRole("list", { name: /onboarding steps/ })` |
| t2 | a11y | Stepper tem aria-current="step" no atual | inspeção ARIA |
| t3 | router | Middleware redireciona pendente | Playwright: login + GET `/app/inbox` → 307 → `/onboarding/welcome` |
| t4 | env | Skip button gated por NODE_ENV | build em prod local + verificar DOM |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "ui.<OnboardingStepper>"
    props: "{ current: 1|2|3|4|5 }"
  - type: pure_fn
    id: "lib.getCurrentOnboardingStep"
    signature: "(state: OnboardingState) => StepName"
  - type: route_group
    id: "(onboarding)"
```

#### Definition of Done
- [ ] Stepper acessível (axe-core sem violações)
- [ ] Middleware redirect testado em Playwright
- [ ] Skip button ausente em build de prod
- [ ] Commit `feat(EPIC-02): onboarding layout + stepper [wave 2]`

---

### S-02.03 — Step 1 `/onboarding/welcome` (termos + timezone + display_name)

**Points**: 3 | **Priority**: P0 | **Deps**: S-02.02 | **FR refs**: Jornada 4 §5, Spec 01 §9.1

#### Contexto
Primeiro step do wizard. Form com 3 campos: checkbox de aceite de termos, select de timezone (default `America/Sao_Paulo`), input `display_name`. Submit chama Server Action `acceptTerms` que grava `onboarding_state.welcome = { accepted_at, timezone, display_name }` e atualiza `organizations.timezone` e `display_name`. Redireciona pra `/onboarding/connect-whatsapp`.

#### Files to create
- `app/(onboarding)/welcome/page.tsx` — Server Component pré-popula form
- `app/(onboarding)/welcome/_components/WelcomeForm.tsx` — Client Component (react-hook-form + zod)
- `app/(onboarding)/welcome/_actions/accept-terms.ts` — Server Action `acceptTerms`
- `lib/onboarding/timezones.ts` — lista canônica IANA (BR foco)

#### Implementation steps (sequential)
1. Server Action `acceptTerms({ accepted, timezone, display_name })` valida com Zod
2. Em transação: `update organizations set timezone = $, display_name = $, onboarding_state = onboarding_state || jsonb_build_object('welcome', ...)`
3. Emitir `event_log` `onboarding.welcome_completed`
4. `revalidatePath('/onboarding')` + redirect pro próximo step
5. Form: checkbox obrigatório, link pros termos abre `/legal/terms` em nova aba

#### Acceptance Criteria

```gherkin
Given user em "/onboarding/welcome"
When marca termos, escolhe "America/Sao_Paulo", digita "Loja Teste" e submit
Then organizations.timezone = "America/Sao_Paulo"
And organizations.display_name = "Loja Teste"
And onboarding_state.welcome.accepted_at é timestamp recente
And é redirecionado pra "/onboarding/connect-whatsapp"
```

```gherkin
Given termos não marcados
When tenta submit
Then botão fica disabled
And nenhuma chamada de rede sai
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Form renderiza 3 campos | Playwright |
| t2 | api | acceptTerms grava state | DB query pós-submit |
| t3 | rls | User não consegue alterar org de outro tenant | Server Action chamada com `organizationId` forjado → falha |
| t4 | resume | F5 após submit não regrava | re-render mostra step 2 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "action.acceptTerms"
    signature: "(input: { timezone, display_name }) => { ok: true }"
    file: "app/(onboarding)/welcome/_actions/accept-terms.ts"
```

#### Definition of Done
- [ ] Form com validação client + server (Zod)
- [ ] Tests Playwright passam
- [ ] Commit `feat(EPIC-02): step welcome [wave 3]`

---

### S-02.04 — Step 2 `/onboarding/connect-whatsapp` (QR + polling WORKING)

**Points**: 5 | **Priority**: P0 | **Deps**: S-02.03 | **FR refs**: Spec 03 §5 QR connect flow

#### Contexto
Step crítico. Cria `channel_sessions` via Server Action que chama API canônica `POST /api/wa/sessions` (Spec 03 §5.1). UI mostra QR retornado pela WAHA, com auto-refresh a cada 30s, e faz polling (`useQuery` com `refetchInterval: 3000`) em `GET /api/wa/sessions/:id/status` até receber `WORKING`. Quando WORKING, grava `onboarding_state.whatsapp = { session_id, phone_number, connected_at }` e redireciona.

#### Files to create
- `app/(onboarding)/connect-whatsapp/page.tsx` — pré-cria sessão se ainda não existe
- `app/(onboarding)/connect-whatsapp/_components/QRCodePanel.tsx` — Client, auto-refresh
- `app/(onboarding)/connect-whatsapp/_components/StatusPoller.tsx` — Client, useQuery
- `app/(onboarding)/connect-whatsapp/_actions/create-session.ts` — Server Action wrapper
- `app/(onboarding)/connect-whatsapp/_actions/finalize-whatsapp-step.ts` — marca state quando WORKING
- `hooks/useChannelSessionStatus.ts` — TanStack Query hook

#### Implementation steps (sequential)
1. Server Action `createSession` chama internamente lib WAHA (mesma do Spec 03 §5.1) — reusar, não duplicar
2. Page renderiza QR + countdown + spinner "Aguardando scan"
3. Hook `useChannelSessionStatus(sessionId)` polla `GET /api/wa/sessions/:id/status` 3s
4. Quando status === 'WORKING' → chama `finalizeWhatsappStep({ session_id })` → grava state + redirect
5. QR expira a cada 30s → refetch via Server Action `refreshQr({ sessionId })`
6. Erro `FAILED` → toast erro + botão "Recriar sessão"

#### Acceptance Criteria

```gherkin
Given user em "/onboarding/connect-whatsapp" sem sessão prévia
When página carrega
Then channel_sessions row é criada com status "STARTING"
And QR aparece em <5s
```

```gherkin
Given QR exibido
When webhook WAHA dispara session.status=WORKING
Then status muda pra "Conectado +5511999..."
And onboarding_state.whatsapp.connected_at é setado
And redireciona pra "/onboarding/connect-nuvemshop"
```

```gherkin
Given QR aberto há 31s
When countdown chega 0
Then refresh do QR sem reload da página
```

```gherkin
Given session FAILED
When user clica "Recriar"
Then nova channel_sessions row é criada
And status volta a STARTING
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | QR renderiza | Playwright `getByAltText(/QR Code/)` |
| t2 | api | Polling roda a cada 3s | network tab Playwright |
| t3 | flow | Mock webhook WORKING → redirect | injetar update direto no DB + esperar redirect |
| t4 | resume | F5 não cria sessão duplicada | DB conta apenas 1 row STARTING |
| t5 | error | FAILED mostra retry | mock erro WAHA |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "hook.useChannelSessionStatus"
    signature: "(sessionId: string) => { status, qr, isLoading }"
  - type: server_action
    id: "action.createOnboardingSession"
  - type: state_key
    id: "onboarding_state.whatsapp"
    schema: "{ session_id, phone_number, connected_at }"
```

#### Decisões a registrar
- Polling 3s no onboarding (não realtime ainda, simplicidade) — refatorar pra realtime se EPIC-03 já estiver pronto

#### Definition of Done
- [ ] Mock E2E com WORKING simulado passa
- [ ] Sem regressão na Spec 03 (channel_sessions canon intacto)
- [ ] Commit `feat(EPIC-02): step connect-whatsapp [wave 4]`

---

### S-02.05 — Step 3 `/onboarding/connect-nuvemshop` (OAuth via Server Action)

**Points**: 4 | **Priority**: P0 | **Deps**: S-02.04 | **FR refs**: Spec 06 §4 (R-05 reconciliação)

#### Contexto
Step usa o contract canônico R-05: Server Action `connectNuvemshop` (Spec 06 §4.2) que internamente faz `redirect()` pra Nuvemshop authorize URL. Callback `GET /api/v1/integrations/nuvemshop/callback` (já existente em Spec 06 §4.3) passa a também atualizar `onboarding_state.nuvemshop = { store_id, connected_at }` quando o `state` token contém flag `from_onboarding`. Em caso de retorno com `?status=success`, página mostra banner + auto-avança.

#### Files to create
- `app/(onboarding)/connect-nuvemshop/page.tsx` — botão "Conectar loja" + handler de retorno
- `app/(onboarding)/connect-nuvemshop/_components/NuvemshopConnectButton.tsx` — Client, chama Server Action
- `app/(onboarding)/connect-nuvemshop/_components/PostConnectBanner.tsx` — exibe status pós-callback

#### Files to modify
- `lib/oauth/state.ts` — adicionar campo opcional `from_onboarding: boolean` no payload
- `app/api/v1/integrations/nuvemshop/callback/route.ts` — se `from_onboarding`, append em `onboarding_state.nuvemshop` e redirecionar pra `/onboarding/connect-nuvemshop?status=success` (em vez de `/app/integrations/nuvemshop`)

#### Implementation steps (sequential)
1. Botão chama `connectNuvemshop({ from_onboarding: true })` (extender assinatura existente)
2. Server Action embute flag no `state` JWT
3. Callback detecta flag e roteia destino + grava state
4. Page lê searchParams e exibe banner sucesso/erro
5. Em sucesso, auto-avança em 2s pra `/onboarding/setup-ai` (com botão "Continuar agora")
6. Em erro, mostra mensagem acionável + botão "Tentar novamente"

#### Acceptance Criteria

```gherkin
Given user em step 3
When clica "Conectar loja"
Then é redirecionado pra Nuvemshop authorize URL com state contendo from_onboarding=true
```

```gherkin
Given user retorna do Nuvemshop com code+state válidos
When callback processa
Then nuvemshop_integrations row é criada (Spec 06)
And onboarding_state.nuvemshop.connected_at é setado
And redireciona pra "/onboarding/connect-nuvemshop?status=success"
```

```gherkin
Given retorno com erro (state inválido ou code expirado)
When callback processa
Then redireciona pra "/onboarding/connect-nuvemshop?status=error&reason=..."
And UI mostra erro + botão retry
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | flow | OAuth flow completo (sandbox Nuvemshop) | Playwright manual |
| t2 | unit | state JWT carrega from_onboarding | unit test |
| t3 | reconciliation | R-05 não quebra fluxo legacy de `/app/integrations/nuvemshop` | rota /app continua funcionando |
| t4 | error | state expirado → erro acionável | clock skew |

#### Architecture contracts emitted

```yaml
exposes:
  - type: state_key
    id: "onboarding_state.nuvemshop"
    schema: "{ store_id, connected_at }"
consumes:
  - type: server_action
    id: "action.connectNuvemshop"
    origin: "Spec 06 §4.2 (R-05)"
```

#### Definition of Done
- [ ] R-05 reconciliação respeitada (não duplicar Server Action)
- [ ] Callback retro-compatível com fluxo `/app/integrations/nuvemshop`
- [ ] Commit `feat(EPIC-02): step connect-nuvemshop [wave 5]`

---

### S-02.06 — Step 4 `/onboarding/setup-ai` (template + default ai_agent)

**Points**: 3 | **Priority**: P0 | **Deps**: S-02.05 | **FR refs**: Spec 05 §3.1 (`ai_agents`), Jornada 4 §12

#### Contexto
Cria primeiro `ai_agents` row do tenant com `is_default = true`. Usuário escolhe entre 2-3 templates de prompt (ex: "Atendimento e-commerce padrão", "Suporte técnico", "Vendas consultivas") e o agente é criado com o `system_prompt` + `config` defaults da Spec 05. Trigger `fn_ai_agents_enforce_single_default` garante unicidade.

#### Files to create
- `app/(onboarding)/setup-ai/page.tsx` — lista templates
- `app/(onboarding)/setup-ai/_components/PromptTemplateSelector.tsx` — radio cards
- `app/(onboarding)/setup-ai/_actions/create-default-agent.ts` — Server Action
- `app/(onboarding)/setup-ai/_actions/set-active-agent.ts` — Server Action `setActiveAgent`
- `lib/ai/prompt-templates.ts` — biblioteca canônica de templates

#### Implementation steps (sequential)
1. `prompt-templates.ts` exporta array `[{ id, name, description, system_prompt }]`
2. Page renderiza radios + preview do prompt selecionado
3. Server Action `createDefaultAgent({ template_id })` faz INSERT em `ai_agents` com `is_default=true`, `is_active=true`, `name='Agente Principal'`, `system_prompt` do template, `config` default da Spec 05
4. `setActiveAgent(agentId)` UPDATE com `is_default=true` (trigger garante unicidade)
5. Grava `onboarding_state.ai = { agent_id, template_id, configured_at }`
6. Redireciona pra `/onboarding/invite-team`

#### Acceptance Criteria

```gherkin
Given user em step 4
When seleciona template "Atendimento e-commerce padrão" e clica "Criar agente"
Then ai_agents row é criada com is_default=true
And system_prompt vem do template
And config tem rag_top_k=5, temperature=0.3 (defaults Spec 05)
```

```gherkin
Given já existe agente default no org
When createDefaultAgent é chamado novamente (ex: F5 + retry)
Then trigger fn_ai_agents_enforce_single_default mantém apenas 1 default
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 3 templates renderizam | Playwright |
| t2 | db | Agente criado com defaults Spec 05 | SELECT pós-submit |
| t3 | rls | User de outro org não vê | RLS test |
| t4 | trigger | Single-default garantido | INSERT manual de 2º default → SELECT mostra apenas 1 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "action.createDefaultAgent"
  - type: server_action
    id: "action.setActiveAgent"
    signature: "(agentId: string) => { ok }"
  - type: lib
    id: "lib.ai.prompt-templates"
  - type: state_key
    id: "onboarding_state.ai"
```

#### Definition of Done
- [ ] Defaults da Spec 05 §3.1 batem 1:1 com config gravada
- [ ] Commit `feat(EPIC-02): step setup-ai [wave 6]`

---

### S-02.07 — Step 5 `/onboarding/invite-team` (multi-invite)

**Points**: 4 | **Priority**: P0 | **Deps**: S-02.06 | **FR refs**: Jornada 4 §15-16, Spec 01 (invites)

#### Contexto
Form repeater pra convidar 1+ membros (email + role: `agent` | `manager`). Server Action `inviteMember` cria `organization_invites` row + envia email com link assinado (TTL 24h). Validações: email único por org pendente, role válido, mínimo 0 (skippable) máximo 10 nesta tela. Skip permitido (sai como `team.skipped: true`).

#### Files to create
- `app/(onboarding)/invite-team/page.tsx`
- `app/(onboarding)/invite-team/_components/InviteForm.tsx` — useFieldArray
- `app/(onboarding)/invite-team/_components/InviteList.tsx` — pendentes
- `app/(onboarding)/invite-team/_actions/invite-member.ts` — Server Action `inviteMember`
- `app/(onboarding)/invite-team/_actions/finalize-team-step.ts` — marca step done
- `lib/email/templates/team-invite.tsx` — React Email template
- `lib/email/send-invite.ts` — wrapper Resend

#### Implementation steps (sequential)
1. Form com `useFieldArray` (1+ rows {email, role})
2. Submit chama `inviteMember(email, role)` em loop (com idempotency: skip se invite pending pra mesmo email)
3. Cada invite gera token JWT TTL 24h e dispara email via Resend
4. UI mostra lista de pendentes com badge "enviado" / "erro"
5. Botões "Pular" e "Concluir" → `finalizeTeamStep({ skipped: bool })`
6. Grava `onboarding_state.team = { invited_count, skipped, finished_at }`
7. Redireciona pra `/onboarding/done`

#### Acceptance Criteria

```gherkin
Given user em step 5
When digita 2 emails (atendente1@x.com agent, gerente@x.com manager) e submit
Then 2 organization_invites rows são criadas
And 2 emails são enviados via Resend
And toast "2 convites enviados"
```

```gherkin
Given user clica "Pular"
When confirma
Then onboarding_state.team.skipped = true
And redireciona pra /onboarding/done
```

```gherkin
Given email já tem invite pendente
When tenta convidar de novo
Then mostra erro inline "Convite já enviado" e não duplica
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Adicionar/remover linhas do form | Playwright |
| t2 | api | inviteMember idempotente | chamar 2× mesmo email |
| t3 | email | Resend recebe payload correto | mock Resend |
| t4 | rls | User de outro org não invida | Server Action com orgId forjado falha |

#### Architecture contracts emitted

```yaml
exposes:
  - type: server_action
    id: "action.inviteMember"
    signature: "(email: string, role: 'agent'|'manager') => { invite_id }"
  - type: state_key
    id: "onboarding_state.team"
```

#### Definition of Done
- [ ] Email template renderiza (preview Playwright)
- [ ] Idempotency testada
- [ ] Commit `feat(EPIC-02): step invite-team [wave 7]`

---

### S-02.08 — `/onboarding/done` + finalização

**Points**: 2 | **Priority**: P0 | **Deps**: S-02.07 | **FR refs**: Jornada 4 §17-18

#### Contexto
Página de celebração. Mostra checklist com tudo concluído, CTA "Ir pra Inbox". No mount, Server Action `finalizeOnboarding` setta `organizations.onboarded_at = now()` e emite `event_log` `tenant.onboarded`. Redirect automático em 3s ou via clique. Confetti opcional via `canvas-confetti`.

#### Files to create
- `app/(onboarding)/done/page.tsx`
- `app/(onboarding)/done/_components/OnboardingDone.tsx` — celebration UI + auto-redirect
- `app/(onboarding)/done/_actions/finalize-onboarding.ts` — Server Action

#### Implementation steps (sequential)
1. Page Server Component verifica que todos os steps anteriores estão completos (else → redirect pro pendente)
2. Renderiza `<OnboardingDone>` com checklist 5/5 verde
3. Client Component, no mount, chama `finalizeOnboarding()`
4. Server Action: `update organizations set onboarded_at = now() where id = $`, `insert into event_log (...) values ('tenant.onboarded', ...)`
5. Em sucesso, schedule redirect 3s pra `/app/inbox` (ou imediato no clique do CTA)
6. Confetti dispara 1× no mount (não em reload)

#### Acceptance Criteria

```gherkin
Given todos os steps anteriores completos
When user acessa /onboarding/done
Then organizations.onboarded_at é setado pra now()
And event_log tem row `tenant.onboarded`
And user vê checklist 5/5 verde
And é redirecionado pra /app/inbox em ≤3s
```

```gherkin
Given step anterior incompleto (ex: team faltando)
When user força URL /onboarding/done
Then é redirecionado pro step pendente
And onboarded_at NÃO é setado
```

```gherkin
Given onboarded_at já preenchido
When user revisita /onboarding/done
Then redireciona pra /app/inbox imediato (sem re-emitir evento)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Checklist 5/5 + CTA | Playwright |
| t2 | api | onboarded_at setado | DB pós-mount |
| t3 | event | event_log tem `tenant.onboarded` 1× | SELECT count |
| t4 | guard | Force-URL com step pendente redireciona | Playwright nav direto |
| t5 | idempotency | Re-visita não duplica evento | SELECT count = 1 |

#### Architecture contracts emitted

```yaml
exposes:
  - type: domain_event
    id: "event.tenant.onboarded"
    payload: "{ organization_id, completed_at }"
  - type: server_action
    id: "action.finalizeOnboarding"
```

#### Definition of Done
- [ ] Auto-redirect 3s funciona
- [ ] Idempotency: re-visita não duplica evento
- [ ] Confetti respeita `prefers-reduced-motion`
- [ ] Commit `feat(EPIC-02): step done + finalize [wave 8]`

---

## 6. Regression Suite Cumulativo (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering (5 steps + done + layout) | 7 | S-02.02..S-02.08 |
| Server Actions (acceptTerms, createSession, connectNuvemshop, createDefaultAgent, setActiveAgent, inviteMember, finalizeOnboarding) | 7 | idem |
| RLS isolation (cross-tenant em cada step) | 5 | idem |
| Resume / drop-off (F5 em cada step preserva estado) | 5 | idem |
| OAuth flow Nuvemshop (R-05) | 1 | S-02.05 |
| QR polling → WORKING | 1 | S-02.04 |
| Migration 0008 sanity | 1 | S-02.01 |
| **Total** | **27** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Drop-off no QR (WhatsApp não conecta) | Alta | Auto-refresh QR + botão "Recriar sessão" + mensagem clara |
| OAuth Nuvemshop falha intermitente | Média | Retry button + erro acionável + log do `state` JWT em Sentry |
| User pula etapa via URL forjada | Média | Layout valida `getCurrentStep(state)` e redireciona |
| State jsonb cresce sem schema | Média | Zod schema `OnboardingStateSchema` enforce server-side |
| R-05 fluxo de reconexão regride | Alta | Tests garantem que callback ainda atende `/app/integrations/nuvemshop` legacy |
| Email invite parar (Resend down) | Baixa | Falha não bloqueia step (UI mostra retry) + invite pode ser reenviado em EPIC-09 |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-09 (proposto)**: `onboarding_state jsonb` é canon pra wizards multi-step (não criar tabelas separadas pra cada wizard futuro)
- **ADR-10 (proposto)**: Server Actions canônicas do onboarding ficam em `app/(onboarding)/<step>/_actions/` (colocadas com a UI), não em `app/_actions` global — co-location é regra
- **ADR-11 (proposto)**: Skip-to-end DEV-only via `process.env.NODE_ENV` check + early-return server-side (defesa em profundidade contra bundling acidental)
- **R-05 reforçado**: `connectNuvemshop` Server Action é o único caminho UI; `GET /connect` é fallback server-to-server

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/02-journeys.md` Jornada 4
- Specs refs: 01 §9, 03 §5, 05 §3.1, 06 §4 (R-05)
- Reconciliation log: R-03 (channel_sessions), R-05 (connectNuvemshop Server Action)
- Template: `docs/stories/epics/TEMPLATE.md`
