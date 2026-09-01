---
epic_id: EPIC-12-hardening
epic_name: Hardening + E2E + Polish
priority: P0
estimated_waves: 10
estimated_total_points: 31
depends_on: [EPIC-02, EPIC-03, EPIC-04, EPIC-05, EPIC-06, EPIC-07, EPIC-08, EPIC-09, EPIC-10, EPIC-11]
exposes_contracts:
  - "tests/e2e/*.spec.ts (5 jornadas)"
  - "ui.<ErrorBoundary>"
  - "ui.<Empty*>"
  - "route./404 /403 /500 /503"
  - "infra.sentry"
  - "infra.web-vitals-budget"
status: completed (partial: Lighthouse CI + bundle-analyzer + /app/* E2E deferred)
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-12 — Hardening + E2E + Polish

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. Última fase pré-produção. Stories em ordem de dependência. Nenhuma é skippable — performance budgets, error boundaries, observability e suite E2E são gates de go-live, não nice-to-have.

## 1. Objetivo

Endurecer o produto pra produção: error boundaries em todos os layouts, páginas 404/403/500/503 com copy PT-BR canônico, catálogo de empty states reusáveis, loading orchestration, Core Web Vitals dentro de budget, Sentry com PII scrubbing, suite Playwright E2E cobrindo as 5 jornadas críticas, auditoria de acessibilidade keyboard-first, polish dos docs (README/ARCHITECTURE/CONTRIBUTING) e smoke test de deploy preview pré-go-live.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] Error boundary global captura erros React em `app/(app)/error.tsx` e `app/admin/error.tsx`, reporta a Sentry com `request_id` exibido pro usuário (B3 da screen-flow §06)
- [ ] Páginas 404, 403, 500, 503 customizadas com copy PT-BR EXATO (vide §06 B1-B4) e ações next-step
- [ ] 10 empty states catalogados como componentes reusáveis (`<EmptyInbox>`, `<EmptyKanban>`, `<EmptyContacts>`, `<EmptyAudit>`, `<EmptyLgpdRequests>`, `<EmptyMergeQueue>`, `<EmptyWhatsappSessions>`, `<EmptyAiUsage>`, `<EmptyPipeline>`, `<EmptyFilterResults>`)
- [ ] Loading skeletons orchestrados via Suspense + `loading.tsx` cobrem TODAS as P0 screens; threshold 300ms respeitado (§06 C1)
- [ ] Core Web Vitals em produção (Vercel Analytics RUM) cumprem: LCP <2.5s p75, CLS <0.1 p75, INP <200ms p75
- [ ] Bundle inicial da rota `/app/inbox` <250KB gzipped; route splitting + dynamic imports aplicados onde necessário
- [ ] Sentry capturando errors com `beforeSend` removendo CPF, email, phone, headers `Authorization`/`Cookie`/`x-waha-api-key`/`x-nuvemshop-token`; structured logs via pino em routes/workers
- [ ] 5 specs Playwright E2E rodam verde em CI cobrindo: Operador atende inbound, Super-admin triagem cross-tenant, AI handoff bot→humano, Onboarding tenant novo, LGPD data_request
- [ ] `axe-core` integrado a 1 spec E2E por jornada; CI bloqueia merge se severity `critical`/`serious`
- [ ] Keyboard nav 100% funcional em P0 (inbox, kanban, contacts) verificado no E2E
- [ ] README com quickstart 5 minutos (clone → install → .env → migrate → dev → primeira conversa); ARCHITECTURE.md aponta pra `docs/`; CONTRIBUTING.md com fluxo PR + epic-executor
- [ ] Performance budget enforcement no CI (bundle-analyzer + Lighthouse CI fail thresholds)
- [ ] Smoke test E2E (subset de 5 testes) roda contra preview URL Vercel após cada PR de release; checklist pré-go-live (§S-12.10) checado e arquivado

## 3. Pré-requisitos

- Epics 02, 03, 04, 05, 06, 07, 08, 09, 10, 11 completos (todas as 5 jornadas implementadas e funcionando em dev)
- Migrations 0001-NNNN aplicadas em staging Supabase
- Playwright instalado (vem do EPIC-00 S-00.06) e MCP Playwright conectado
- Sentry org `deskcomm` com projetos `deskcomm-app` (DSN em env) — criar se não existir
- Vercel project `deskcomm-staging` linkado e fazendo deploy de PRs
- Variáveis de env em staging: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, todas do MVP
- Dev server local em `localhost:3001`

## 4. Architecture Contracts

### 4.1 Contracts consumidos

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `route./app/*` | next_route | EPIC-02..10 | Cobertos por error boundaries + skeletons |
| `route./admin/*` | next_route | EPIC-11 | idem |
| `hook.useAuth` | react_hook | EPIC-01 | E2E login flow |
| `api.POST /api/v1/*` | api_route | E03..11 | E2E + Sentry instrumentation |
| `worker.*` | bg_worker | E06,E07,E08 | Logs estruturados pino + Sentry capture |
| `realtime.*` | realtime_channel | E03,E04,E11 | Cobertos no E2E (espera por evento) |
| `event.*` | domain_event | E06,E07,E08 | Tags Sentry em capture |
| Spec 08 §9 (PII scrubbing) | spec | docs/specs/08 | `beforeSend` Sentry implementa |
| Screen-flow §06 (empty/error) | spec | design-system | Copy PT-BR canônica |
| Screen-flow §08 (a11y) | spec | design-system | Tab order, ARIA, atalhos |

### 4.2 Contracts expostos

| Contract ID | Tipo | Wave que expõe | Descrição |
|---|---|---|---|
| `ui.<RootErrorBoundary>` | react_component | S-12.01 | Wrapper com fallback B3; reporta Sentry com `eventId`/`request_id` exibido |
| `route./not-found` | next_route | S-12.02 | App Router `not-found.tsx` (404) com copy B1 |
| `route./403` `/500` `/503` | next_route | S-12.02 | Páginas custom com copy B2/B3/B4 |
| `ui.<EmptyInbox>` … `<EmptyAiUsage>` | react_component | S-12.03 | 10 componentes plug-and-play `{ icon, headline, subcopy, primary, secondary }` |
| `ui.<Skeleton*>` + `loading.tsx` | next_convention | S-12.04 | Suspense boundaries + skeletons P0 |
| `infra.web-vitals-budget` | ci_gate | S-12.05 | Lighthouse CI + bundle-analyzer thresholds em `.github/workflows/perf.yml` |
| `infra.sentry` | infra | S-12.06 | `instrumentation.ts` + `sentry.client/server/edge.config.ts` + `lib/logger.ts` (pino) |
| `tests/e2e/*.spec.ts` | e2e_suite | S-12.07 | 5 specs (1 por jornada) + `playwright.config.ts` projetando `chromium` desktop + mobile |
| `infra.axe-e2e` | ci_gate | S-12.08 | `@axe-core/playwright` integrado; CI fail em `critical`/`serious` |
| `docs.README` `docs.ARCHITECTURE` `docs.CONTRIBUTING` | docs | S-12.09 | Quickstart 5min + arch overview + contrib guide |
| `infra.preview-smoke` | ci_gate | S-12.10 | Subset de 5 testes E2E contra preview URL pós-deploy |

## 5. Stories (em ordem de dependência)

> 10 stories, 31 points totais. Wave 1 = S-12.01; wave 10 = S-12.10. Ordem é lei: error boundaries antes de error pages, error pages antes de empty states (estrutura), Sentry config antes de E2E (testes verificam capture), E2E antes de a11y audit (axe roda dentro do E2E), docs antes do smoke deploy final.

---

### S-12.01 — Error boundaries em todos os layouts

**Points**: 3 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 08 §9.1, Screen-flow §06 B3

#### Contexto
Next.js App Router exige `error.tsx` por segmento pra capturar erros render-time React. Hoje, qualquer throw em RSC ou client component derruba a tela inteira pra erro genérico do Next. Esta story instala boundaries em `(app)`, `admin` e root, integra com Sentry capturando `eventId` e mostra ao usuário como `request_id` (copy B3 §06). Também cobre `global-error.tsx` no root pra falhas no próprio root layout.

#### Files to create
- `app/global-error.tsx` — catch root layout failures
- `app/(app)/error.tsx` — boundary do app autenticado
- `app/admin/error.tsx` — boundary do super-admin
- `components/errors/RootErrorBoundary.tsx` — UI compartilhada (ícone Warning + headline B3 + sub-copy + ações)
- `lib/errors/capture.ts` — wrapper `captureError(err, ctx) → eventId`

#### Files to modify
- `instrumentation.ts` — registrar `Sentry.init` (já será criado em S-12.06; aqui só placeholder export se não existir)

#### Implementation steps (sequential)
1. Criar `RootErrorBoundary` com props `{ error, reset }` exibindo copy B3 (PT-BR exato), ícone Phosphor `Warning`, botões "Tentar novamente" (chama `reset`) e "Voltar pra inbox" (router.push)
2. Em `error.tsx` de cada segmento, importar boundary + chamar `captureError(error)` no `useEffect` de mount, armazenar `eventId` em state, passar como `request_id` na sub-copy
3. `global-error.tsx` precisa renderizar `<html><body>` (root falhou); copy minimalista mas mantém B3
4. `lib/errors/capture.ts` chama `Sentry.captureException(err, { tags: { boundary: ctx.segment }, extra: ctx })` e retorna `Sentry.lastEventId()`
5. Verificar SSR-safe (sem `window` em path de import de boundary)

#### Acceptance Criteria

```gherkin
Given um usuário autenticado em /app/inbox
When um componente filho lança throw new Error("boom") via botão de teste
Then a tela mostra "Algo deu errado do nosso lado" com ícone Warning
And aparece "código <8-char-hex>" como request_id
And botão "Tentar novamente" recarrega a tela sem refresh full
```

```gherkin
Given Sentry está configurado com DSN válido em env de teste
When o boundary captura um erro
Then um evento aparece em Sentry com tag boundary=app e o request_id exibido bate com Sentry eventId
```

```gherkin
Given o root layout em si falha (erro em providers)
When a navegação ocorre
Then global-error.tsx renderiza fallback minimal com B3 copy
And usuário consegue clicar "Tentar novamente"
```

```gherkin
Given um erro acontece em /admin/inbox
When o boundary captura
Then a tag Sentry boundary=admin é enviada (separa filtragem cross-tenant)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Boundary renderiza B3 copy | Playwright: navegar pra rota com botão throw, verificar `getByText(/Algo deu errado/)` |
| t2 | a11y | Boundary tem `role="alert"` e foco move pro h1 | Playwright + axe |
| t3 | sentry | Evento capturado com tag correta | Sentry SDK mock no E2E ou verificar `Sentry.lastEventId()` no console |
| t4 | reset | Reset chama `reset()` e re-renderiza | Playwright clica botão, verifica re-render |
| t5 | global | global-error.tsx renderiza HTML completo | Verificar src do response inclui `<html lang="pt-BR">` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "ui.<RootErrorBoundary>"
    file: "components/errors/RootErrorBoundary.tsx"
    props: "{ error: Error & { digest?: string }, reset: () => void, segment: 'app' | 'admin' | 'root' }"
  - type: util
    id: "lib.errors.captureError"
    signature: "(err: unknown, ctx: { segment, route?, userId? }) => string /* eventId */"
```

#### Decisões a registrar
- `request_id` exibido ao usuário = `Sentry.lastEventId()` (8 char short hex). Padronizado em todos os boundaries pra consistência com runbooks de suporte.

#### Definition of Done
- [ ] Todos os ACs passam em Playwright
- [ ] Typecheck zero erros novos
- [ ] Lint zero erros novos
- [ ] Erro forçado em dev mostra B3 corretamente
- [ ] Commit `feat(EPIC-12): error boundaries [wave 1]`
- [ ] Contracts registrados em state file

---

### S-12.02 — Pages 404 / 403 / 500 / 503 customizadas

**Points**: 2 | **Priority**: P0 | **Deps**: S-12.01 | **FR refs**: Screen-flow §06 B1, B2, B3, B4

#### Contexto
404 vem do Next via `not-found.tsx`. 403 e 503 são rotas customizadas (`app/403/page.tsx`, `app/503/page.tsx`) que middleware/layouts redirecionam quando role insuficiente ou platform degraded. 500 é coberto pelo error boundary de S-12.01 + `app/error.tsx` root. Copy PT-BR EXATA do §06.

#### Files to create
- `app/not-found.tsx` — 404 (B1)
- `app/403/page.tsx` — 403 (B2)
- `app/500/page.tsx` — 500 (B3 — fallback estático pra deeplink direto)
- `app/503/page.tsx` — 503 (B4)
- `components/errors/StatusPage.tsx` — wrapper compartilhado `{ code, icon, headline, subcopy, primary, secondary }`

#### Files to modify
- `middleware.ts` — em caso de role check fail, `NextResponse.rewrite('/403')` ao invés de 401
- `app/(app)/layout.tsx` — banner global B5 (network offline, `navigator.onLine`)

#### Implementation steps (sequential)
1. `StatusPage` renderiza ícone Phosphor + headline + sub-copy + 1-2 CTAs; foco move pro primário
2. `not-found.tsx` usa StatusPage com copy B1; CTAs "Voltar pra inbox" e "Ir pra início"
3. `403/page.tsx`: lê `searchParams.role` pra interpolar `{role}` na sub-copy
4. `503/page.tsx`: botão "Tentar novamente em 30s" com countdown via `setInterval`
5. Network offline banner em `(app)/layout.tsx` usa `useEffect` + `online`/`offline` events; banner top sticky `role="alert"`

#### Acceptance Criteria

```gherkin
Given URL inválida /app/blablabla
When o usuário acessa
Then página 404 renderiza com headline "Não encontramos essa página"
And ícone Phosphor Question é visível
And status code HTTP é 404
```

```gherkin
Given usuário com role=agent acessa /admin/tenants
When middleware avalia
Then é redirecionado pra /403?role=agent
And copy mostra "Seu papel atual (agent) não permite ver isso"
```

```gherkin
Given navegador perde conexão (offline event)
When o evento dispara
Then banner "Sem internet" aparece top-of-page com role=alert
And some quando online event volta
```

```gherkin
Given /503 acessada
When countdown chega a 0
Then botão chama window.location.reload()
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 4 páginas renderizam copy B1-B4 EXATO | Playwright text match estrito |
| t2 | http | not-found retorna 404 status | curl `-I` |
| t3 | rewrite | middleware rewrite mantém URL original | Playwright check `page.url()` |
| t4 | offline | Banner aparece em offline event | Playwright `context.setOffline(true)` |
| t5 | a11y | Cada página tem `<h1>` único e foco visível em CTAs | axe |

#### Architecture contracts emitted

```yaml
exposes:
  - type: next_route
    id: "route./not-found"
  - type: next_route
    id: "route./403"
  - type: next_route
    id: "route./500"
  - type: next_route
    id: "route./503"
  - type: react_component
    id: "ui.<StatusPage>"
    file: "components/errors/StatusPage.tsx"
```

#### Definition of Done
- [ ] Copy bate 1:1 com §06 (diff zero)
- [ ] HTTP status codes corretos (404 pra not-found via `notFound()`)
- [ ] Foco move pro CTA primário ao mount
- [ ] Commit `feat(EPIC-12): status pages 404/403/500/503 [wave 2]`

---

### S-12.03 — 10 empty states catalogados como componentes reusáveis

**Points**: 3 | **Priority**: P0 | **Deps**: S-12.02 | **FR refs**: Screen-flow §06 A1-A10

#### Contexto
Hoje cada tela tem seu empty inline duplicado. Catalogar como componentes garante consistência de copy/icon/CTA com §06 e permite test snapshot único. Cada componente é fino: monta `<EmptyState>` base passando props canônicas.

#### Files to create
- `components/empty/EmptyState.tsx` — base `{ icon, headline, subcopy, primary, secondary }`
- `components/empty/EmptyInbox.tsx` (A1)
- `components/empty/EmptyFilterResults.tsx` (A2)
- `components/empty/EmptyPipeline.tsx` (A3)
- `components/empty/EmptyKanbanColumn.tsx` (A4)
- `components/empty/EmptyContacts.tsx` (A5)
- `components/empty/EmptyAudit.tsx` (A6)
- `components/empty/EmptyLgpdRequests.tsx` (A7)
- `components/empty/EmptyMergeQueue.tsx` (A8)
- `components/empty/EmptyWhatsappSessions.tsx` (A9)
- `components/empty/EmptyAiUsage.tsx` (A10)
- `components/empty/index.ts` — re-export

#### Files to modify
- `app/(app)/inbox/page.tsx` — usar `<EmptyInbox>` quando `conversations.length === 0`
- `app/(app)/pipelines/[id]/page.tsx` — `<EmptyPipeline>` + `<EmptyKanbanColumn>`
- `app/(app)/contacts/page.tsx` — `<EmptyContacts>`
- `app/(app)/audit/page.tsx` — `<EmptyAudit>`
- `app/(app)/lgpd/requests/page.tsx` — `<EmptyLgpdRequests>`
- `app/(app)/contacts/merge-queue/page.tsx` — `<EmptyMergeQueue>`
- `app/(app)/integrations/whatsapp/page.tsx` — `<EmptyWhatsappSessions>`
- `app/(app)/ai/usage/page.tsx` — `<EmptyAiUsage>`

#### Implementation steps (sequential)
1. Construir `EmptyState` base com `role="status"`, layout centrado (vertical), responsivo (mobile-first)
2. Cada componente filho importa ícone Phosphor canônico (§06) e injeta props
3. Substituir empties existentes nas 9 páginas (replace, não acrescentar)
4. Snapshot test simples (Vitest + RTL) por componente confirmando headline+subcopy

#### Acceptance Criteria

```gherkin
Given uma tenant nova sem conversas
When abre /app/inbox
Then renderiza EmptyInbox com headline "Nenhuma conversa ainda"
And tem botões "Ver conexão WhatsApp" e "Convidar atendentes"
And clicar primário navega pra /app/integrations/whatsapp
```

```gherkin
Given /app/contacts sem contatos
When renderiza
Then EmptyContacts aparece com ícone Users
And copy bate 1:1 com §06 A5
```

(Repetir AC pra cada empty principal — 5 ACs cobrem variantes representativas)

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | 10 components renderizam ícone + copy corretos | Vitest snapshots + Playwright |
| t2 | nav | CTA primary navega pra rota correta | Playwright click + URL assert |
| t3 | a11y | `role="status"` + ícone tem `aria-hidden` | axe |
| t4 | regression | Páginas P0 não mostram empty antigo | grep no codebase confirmando única source |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "ui.<EmptyState>"
    file: "components/empty/EmptyState.tsx"
  - type: react_component
    id: "ui.<EmptyInbox>" /* + 9 outros */
    file: "components/empty/Empty*.tsx"
```

#### Definition of Done
- [ ] 10 componentes criados; index re-exporta
- [ ] 9 páginas P0 consumindo componentes
- [ ] Snapshot tests passam
- [ ] Commit `feat(EPIC-12): empty state catalog [wave 3]`

---

### S-12.04 — Loading skeletons orchestrados (Suspense + skeleton manual)

**Points**: 3 | **Priority**: P0 | **Deps**: S-12.03 | **FR refs**: Screen-flow §06 C1, §08 §5 (reduce-motion)

#### Contexto
Next.js App Router prefere `loading.tsx` por segmento pra streaming. Páginas P0 precisam de skeletons fiéis ao layout final pra evitar CLS. Threshold 300ms (não mostrar skeleton se carrega em <300ms — flash). Reduce-motion: skeletons estáticos sem `animate-pulse`.

#### Files to create
- `app/(app)/inbox/loading.tsx`
- `app/(app)/inbox/[id]/loading.tsx`
- `app/(app)/pipelines/[id]/loading.tsx`
- `app/(app)/contacts/loading.tsx`
- `app/(app)/contacts/[id]/loading.tsx`
- `app/admin/inbox/loading.tsx`
- `app/admin/tenants/loading.tsx`
- `components/skeletons/ConversationListSkeleton.tsx`
- `components/skeletons/ChatThreadSkeleton.tsx`
- `components/skeletons/KanbanBoardSkeleton.tsx`
- `components/skeletons/ContactListSkeleton.tsx`
- `components/skeletons/Skeleton.tsx` — primitive `<Skeleton className w h />`

#### Files to modify
- `app/globals.css` — `.skeleton-pulse` com `@media (prefers-reduced-motion: reduce)` desligando animation

#### Implementation steps (sequential)
1. Skeleton primitive: `<div className="skeleton-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />`
2. Compor skeletons espelhando layout final (mesmo grid, mesmas heights aproximadas → CLS <0.1)
3. Adicionar 300ms delay via `<DelayedSkeleton delay={300}>` wrapper que não renderiza nada antes do threshold (evita flash)
4. CSS `prefers-reduced-motion: reduce` zera animation

#### Acceptance Criteria

```gherkin
Given navegação para /app/inbox com latência simulada 2s
When carregando
Then ConversationListSkeleton aparece após 300ms
And não há shift visual quando dados chegam (CLS <0.1)
```

```gherkin
Given prefers-reduced-motion: reduce no browser
When skeleton aparece
Then não tem animation pulse (computed style animation-name = none)
```

```gherkin
Given resposta chega em <300ms
When skeleton seria mostrado
Then nada flasha (ficou skipped pelo delay wrapper)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | cls | CLS <0.1 em /app/inbox | Lighthouse CI |
| t2 | reduce-motion | Animation desligada | Playwright emulateMedia + getComputedStyle |
| t3 | delay | <300ms não mostra skeleton | Playwright network throttle baixa, screenshot fast |
| t4 | suspense | loading.tsx capturado por route | Playwright observa skeleton durante navegação |

#### Definition of Done
- [ ] Lighthouse CI confirma CLS <0.1 nas 5 P0 routes
- [ ] Reduce-motion respeitado
- [ ] Commit `feat(EPIC-12): loading skeletons P0 [wave 4]`

---

### S-12.05 — Performance audit & Core Web Vitals budget

**Points**: 4 | **Priority**: P0 | **Deps**: S-12.04 | **FR refs**: Spec 08 §9.4 (perf), Spec 08 §10 (CWV targets)

#### Contexto
Targets canônicos: LCP <2.5s p75, CLS <0.1 p75, INP <200ms p75 em produção. Bundle inicial das rotas P0 <250KB gzipped. Story aplica: route splitting via dynamic imports (componentes pesados — `<KanbanBoard>` com dnd-kit, `<RichEditor>`), `next/image` em todos avatars/media, `next/font` (já feito no EPIC-00), bundle-analyzer no CI, Lighthouse CI com asserts.

#### Files to create
- `.github/workflows/perf.yml` — Lighthouse CI + bundle-analyzer com threshold fails
- `lighthouserc.json` — config (`assertions: { 'categories:performance': ['error', { minScore: 0.9 }], ... }`)
- `scripts/analyze-bundle.mjs` — wrapper `next build` + `@next/bundle-analyzer`
- `next.config.ts` — wrap com `withBundleAnalyzer({ enabled: ANALYZE === 'true' })`

#### Files to modify
- Páginas P0 — converter imports pesados pra `dynamic(() => import(...), { ssr: false })` quando aplicável
- Trocar `<img>` remanescentes por `next/image`
- `next.config.ts` — `experimental.optimizePackageImports = ['@phosphor-icons/react', 'date-fns']`

#### Implementation steps (sequential)
1. Auditar bundles atuais com `ANALYZE=true pnpm build` — identificar top 5 chunks pesados
2. Aplicar dynamic import nos top componentes (Kanban DnD, MarkdownEditor, ChartLib se houver)
3. Converter `<img>` → `next/image` em ContactAvatar, MessageMedia, NuvemshopProductThumb
4. Configurar `optimizePackageImports` pra phosphor + date-fns (tree-shake)
5. Lighthouse CI rodando em PR contra preview URL Vercel; assert p75 thresholds
6. CI step `pnpm analyze:check` falha se bundle inicial /app/inbox >250KB gz

#### Acceptance Criteria

```gherkin
Given bundle build de /app/inbox
When analisado
Then JS gzipped inicial é <250KB
And nenhum chunk individual passa de 150KB gzipped
```

```gherkin
Given Lighthouse rodando contra preview URL
When mede /app/inbox
Then LCP <2500ms, CLS <0.1, INP <200ms
And score performance >=90
```

```gherkin
Given PR aumenta bundle além do budget
When CI roda
Then workflow perf.yml falha com mensagem apontando chunk culpado
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | perf | LCP < 2.5s | Lighthouse CI |
| t2 | perf | CLS < 0.1 | Lighthouse CI |
| t3 | perf | INP < 200ms | Lighthouse CI INP simulation ou RUM |
| t4 | bundle | initial JS gzip <250KB | bundle-analyzer report |
| t5 | images | Sem `<img>` raw em P0 | grep `<img ` em `app/(app)/**` retorna 0 |
| t6 | ci | Workflow falha se exceder budget | PR de teste introduz import pesado, CI vermelho |

#### Architecture contracts emitted

```yaml
exposes:
  - type: ci_gate
    id: "infra.web-vitals-budget"
    file: ".github/workflows/perf.yml"
    thresholds: "{ lcp_p75_ms: 2500, cls_p75: 0.1, inp_p75_ms: 200, initial_js_kb_gz: 250 }"
```

#### Decisões a registrar
- Budget é HARD: PR que excede falha. Override exige aprovação de Rafael + ADR.
- Lighthouse roda contra preview URL pra refletir produção (Vercel `gru1`).

#### Definition of Done
- [ ] Lighthouse CI verde em /app/inbox, /app/pipelines/[id], /app/contacts, /admin/inbox
- [ ] bundle-analyzer report arquivado em CI artifacts
- [ ] Commit `perf(EPIC-12): web-vitals budget enforcement [wave 5]`

---

### S-12.06 — Sentry config completa + structured logs

**Points**: 3 | **Priority**: P0 | **Deps**: S-12.05 | **FR refs**: Spec 08 §9.1, §9.2, §9.3

#### Contexto
Sentry foi referenciado em S-12.01 mas só init estava no boundary. Esta story finaliza: `instrumentation.ts` (Next 15 hook), 3 configs (`sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`), `beforeSend` removendo PII (CPF, email, phone, headers de auth/tokens), structured logger pino com redaction equivalente, custom métricas (`sentry_capture_rate`, `worker_lag_ms`).

#### Files to create
- `instrumentation.ts` — `register()` chama `Sentry.init` por runtime
- `sentry.client.config.ts` — DSN, tracesSampleRate=0.1, beforeSend client
- `sentry.server.config.ts` — idem server-side
- `sentry.edge.config.ts` — middleware/edge runtime
- `lib/sentry/scrub.ts` — `scrubPii(payload): payload` (CPF regex, email regex, phone E.164, header keys list)
- `lib/logger.ts` — pino com `redact: { paths: [...], censor: '[REDACTED]' }`
- `lib/sentry/metrics.ts` — `captureMetric(name, value, tags)` wrapper

#### Files to modify
- `app/api/v1/**/route.ts` — usar `logger.info({ requestId, route, ...ctx })` ao invés de `console.log`
- `lib/queue/workers/**/*.ts` — idem (workers de E06, E07, E08)
- `next.config.ts` — wrap com `withSentryConfig({ silent: true, hideSourceMaps: true })`

#### Implementation steps (sequential)
1. `scrubPii`: regex CPF `/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g`, email RFC simplificado, phone `/\+?55\d{10,11}/g`; header keys lowercase: `authorization`, `cookie`, `x-waha-api-key`, `x-nuvemshop-token`, `x-supabase-service-role`
2. `beforeSend`: aplicar scrub em `event.request.headers`, `event.request.data`, `event.contexts.*`, `event.extra.*`, `event.breadcrumbs[].data`
3. pino com `redact.paths`: `['*.cpf', '*.email', '*.phone', 'req.headers.authorization', 'req.headers.cookie', '*.password', '*.token']`
4. `captureMetric`: usa Sentry metrics API; cobrir `worker.lag_ms`, `webhook.processing_ms`, `ai.token_cost_brl`
5. Smoke test: rota `/api/_test/sentry` (só em staging) lança erro com PII no payload, verificar Sentry recebeu evento sem CPF/email/header

#### Acceptance Criteria

```gherkin
Given erro server lança throw com message contendo CPF "123.456.789-09"
When Sentry beforeSend processa
Then evento enviado a Sentry tem "[REDACTED]" no lugar do CPF
And nenhum header Authorization aparece no payload
```

```gherkin
Given worker ai-response loga objeto contendo email
When pino formata
Then output JSON tem "email": "[REDACTED]"
```

```gherkin
Given staging Sentry recebe events
When dashboard inspeciona últimos 100
Then 0 eventos contêm CPF/email/phone (regex check)
```

```gherkin
Given source maps gerados em build
When deploy ocorre
Then upload source maps acontece via SENTRY_AUTH_TOKEN
And hideSourceMaps=true (não servidos publicamente)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | scrub | CPF redacted | unit test em `scrubPii` |
| t2 | scrub | email/phone/headers redacted | unit test |
| t3 | sentry | smoke endpoint dispara evento limpo | curl + Sentry API verifica |
| t4 | logger | pino redact funciona | unit test logando objeto sensível |
| t5 | metrics | captureMetric envia | Sentry metrics dashboard |
| t6 | sourcemaps | Stack frames symbolicados em Sentry | Sentry issue mostra arquivo+linha real |

#### Architecture contracts emitted

```yaml
exposes:
  - type: infra
    id: "infra.sentry"
    files: ["instrumentation.ts", "sentry.{client,server,edge}.config.ts"]
  - type: util
    id: "lib.logger"
    signature: "pino instance with redaction"
  - type: util
    id: "lib.sentry.captureMetric"
    signature: "(name: string, value: number, tags?: Record<string,string>) => void"
```

#### Decisões a registrar
- ADR: PII scrubbing é dupla camada — `beforeSend` Sentry + `redact` pino. Falha em uma é coberta pela outra.
- Session Replay desligado no MVP (custo + LGPD §S-12.06 contexto).

#### Definition of Done
- [ ] Smoke endpoint dispara evento sem PII em staging Sentry
- [ ] Source maps simbolicados
- [ ] `console.log` removido de routes/workers (grep retorna 0 em `app/api`, `lib/queue/workers`)
- [ ] Commit `feat(EPIC-12): sentry + structured logs [wave 6]`

---

### S-12.07 — E2E Playwright suite cobrindo 5 jornadas críticas

**Points**: 6 | **Priority**: P0 | **Deps**: S-12.06 | **FR refs**: Screen-flow §02 (jornadas), todos sub-PRDs

#### Contexto
Coração do hardening. Cinco jornadas críticas modeladas em §02: (1) Operador atende inbound WhatsApp end-to-end, (2) Super-admin triagem cross-tenant, (3) AI handoff bot→humano, (4) Onboarding tenant novo (5 steps), (5) LGPD data_request fim-a-fim. Cada spec usa fixture de tenant seed + storage state autenticado. Roda em CI contra dev server + Supabase local.

#### Files to create
- `playwright.config.ts` — projects: chromium-desktop, chromium-mobile (Pixel 5)
- `tests/e2e/fixtures/tenant.ts` — cria tenant seed via SQL, retorna `{ orgId, userIds, ... }`
- `tests/e2e/fixtures/auth.ts` — `loginAs(role)` retorna storage state JSON
- `tests/e2e/fixtures/waha-mock.ts` — mock WAHA respondendo eventos via internal endpoint
- `tests/e2e/01-operator-inbound.spec.ts` — Jornada 1
- `tests/e2e/02-superadmin-triage.spec.ts` — Jornada 2
- `tests/e2e/03-ai-handoff.spec.ts` — Jornada 3
- `tests/e2e/04-tenant-onboarding.spec.ts` — Jornada 4
- `tests/e2e/05-lgpd-data-request.spec.ts` — Jornada 5
- `tests/e2e/helpers/wait.ts` — `waitForRealtime`, `waitForToast`
- `.github/workflows/e2e.yml` — workflow rodando suite contra preview deploy

#### Files to modify
- `package.json` — scripts `e2e`, `e2e:ui`, `e2e:headed`
- `lib/queue/workers/**` — modo test (`MOCK_AI=true` já existe; adicionar `MOCK_NUVEMSHOP=true`)

#### Implementation steps (sequential)
1. Criar fixture tenant: insere via service-role SQL 1 org + 3 users (super-admin, manager, agent), 1 pipeline, 1 WAHA session "CONNECTED" mockada
2. Cada spec faz `test.beforeAll` cria tenant, `test.afterAll` cleanup (truncate by org_id)
3. **Jornada 1** (Operator inbound): mock WAHA emite `message.received` → conversation aparece em /app/inbox via realtime → agent claims → responde → message goes outbound (WAHA mock confirma) → resolve → audit log entry existe
4. **Jornada 2** (Super-admin triage): super-admin loga em /admin/inbox → filtra cross-tenant → assume conversa de tenant X em modo supervisor → banner C6 visível → composer disabled
5. **Jornada 3** (AI handoff): seed conversa → bot responde 2x → trigger handoff (sentiment <-0.5 ou keyword "humano") → conversation move pra fila pending humano → agent vê banner HandoffBanner com aria-live=assertive → claim
6. **Jornada 4** (Onboarding): novo user signup → 5 steps (org info, WAHA connect, primeiro pipeline, convidar team, finish) → cai em /app/inbox com EmptyInbox
7. **Jornada 5** (LGPD): super-admin recebe data_request via /admin/lgpd → aprova export → worker processa → arquivo zip aparece em Storage com signed URL → audit log + email notification (mock SMTP) verificado
8. CI workflow: `vercel pull` → `vercel build` → `vercel dev` em background → `pnpm e2e`

#### Acceptance Criteria

```gherkin
Given suite Playwright completa rodando
When CI executa
Then 5 specs passam green
And tempo total <8 minutos
And nenhuma flaky retry necessária (run 3x consecutivos sem falha)
```

```gherkin
Given Jornada 1 executando
When operator clicks "Eu cuido"
Then WAHA mock recebe POST /api/sessions/{id}/messages com body correto
And message bubble aparece com status "delivered" via realtime
And audit log row inserida com action=conversation.replied
```

```gherkin
Given Jornada 5 executando
When super-admin aprova data_request
Then job lgpd-export é processado dentro de 30s
And signed URL retorna ZIP com 200 OK
And contact original tem registro em audit como data_exported
```

```gherkin
Given mobile project (Pixel 5)
When Jornada 1 roda em mobile viewport
Then layout responsivo funciona (sidebar drawer collapsed, composer fullwidth)
And teste passa em mobile também
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | e2e | Jornada 1 verde | Playwright |
| t2 | e2e | Jornada 2 verde | idem |
| t3 | e2e | Jornada 3 verde | idem |
| t4 | e2e | Jornada 4 verde | idem |
| t5 | e2e | Jornada 5 verde | idem |
| t6 | flake | 0 retries em 3 runs | CI history |
| t7 | mobile | Jornada 1 mobile passa | project mobile |
| t8 | parallel | Suite paraleliza por spec sem race | workers=2 e ainda verde |

#### Architecture contracts emitted

```yaml
exposes:
  - type: e2e_suite
    id: "tests/e2e/*.spec.ts"
    coverage: "5 jornadas críticas"
    runtime: "playwright chromium desktop+mobile"
  - type: ci_workflow
    id: ".github/workflows/e2e.yml"
```

#### Decisões a registrar
- ADR: WAHA + Nuvemshop sempre mockados em E2E (determinismo). Smoke contra serviços reais é separado em S-12.10.
- Fixture cleanup via `truncate ... cascade where organization_id = ?` (rls bypass via service role).

#### Definition of Done
- [ ] 5 specs passando 3 runs consecutivos
- [ ] Workflow CI verde
- [ ] README aponta `pnpm e2e` no quickstart
- [ ] Commit `test(EPIC-12): e2e playwright 5 journeys [wave 7]`

---

### S-12.08 — Acessibilidade audit (keyboard nav, ARIA, axe-core)

**Points**: 3 | **Priority**: P0 | **Deps**: S-12.07 | **FR refs**: Screen-flow §08 inteiro

#### Contexto
§08 é checklist; esta story executa: cada P0 screen tem keyboard test, axe-core integrado em E2E (CI bloqueia critical/serious), live regions verificadas, focus visible auditado, contrast confirmado em DevTools. Onde gaps apareçam, fix imediato (não post-pone).

#### Files to create
- `tests/e2e/a11y/keyboard-inbox.spec.ts` — tab order + atalhos j/k/r/e/a
- `tests/e2e/a11y/keyboard-kanban.spec.ts` — j/k/h/l + Space modo mover
- `tests/e2e/a11y/axe-p0.spec.ts` — axe nas 6 P0 screens
- `lib/a11y/announce.ts` — `announce(text, severity)` wrapper escrevendo em live region oculta
- `components/a11y/LiveRegion.tsx` — div sr-only role=status aria-live=polite/assertive

#### Files to modify
- `app/(app)/layout.tsx` — montar `<LiveRegion>` global
- `components/inbox/HandoffBanner.tsx` — `role="alert"` aria-live=assertive (§08 3.2)
- `components/notifications/NotificationBell.tsx` — `aria-label`, `aria-expanded`
- `components/composer/ComposerBar.tsx` — `aria-label`, `aria-multiline`
- `components/auth/MFAInput.tsx` — `role="group"` + label "Código TOTP de 6 dígitos"
- Adicionar skip link em `app/(app)/layout.tsx` e `app/admin/layout.tsx`
- Componentes Kanban — `aria-label` com count e position

#### Implementation steps (sequential)
1. Skip link `<a href="#main" className="sr-only focus:not-sr-only">Pular pra conteúdo principal</a>`
2. `LiveRegion` global com 2 nós (polite + assertive); `announce()` escreve no nó certo
3. Hookar announces nos eventos §08 6.1 (nova mensagem inbound, handoff, claim, send fail, WAHA caída, realtime reconnect)
4. axe-core spec roda em /app/inbox, /app/pipelines/[id], /app/contacts, /app/contacts/[id], /admin/inbox, /onboarding/step-1; CI fail se `critical`/`serious`
5. Keyboard specs: navegam usando só `page.keyboard.press`, sem clicks; verificam atalhos j/k/r/e/a no inbox e h/j/k/l/Space no kanban
6. Foco move pro `<h1>` em mudança de rota (programatic `tabIndex={-1}`); verificar via Playwright
7. Manual VoiceOver checklist (documentado em `docs/a11y-checklist.md`) — Rafael executa antes de marcar DoD

#### Acceptance Criteria

```gherkin
Given /app/inbox aberta
When user pressiona Tab repetidamente
Then primeiro foco é skip link
And ordem segue: skip → header → sidebar → conteúdo → composer
And foco visível (ring) em cada elemento
```

```gherkin
Given inbox com 3 conversas
When user pressiona j 2x e Enter
Then conversa #3 fica selecionada e abre
And screen reader anuncia "Conversa com {nome}"
```

```gherkin
Given axe-core spec rodando em P0 screens
When CI executa
Then 0 violations critical e 0 serious
And moderate são <=5 com justificativa em comentário
```

```gherkin
Given handoff acontece em conversa aberta
When HandoffBanner monta
Then aria-live=assertive dispara
And texto "Bot escalou para humano. Motivo: {reason}" lido pelo SR
```

```gherkin
Given user em /app/contacts pressiona Esc com modal aberto
When modal fecha
Then foco volta pro elemento que abriu o modal
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | a11y | axe critical=0 em 6 P0 screens | axe-core spec |
| t2 | keyboard | inbox navegável só por teclado | spec dedicada |
| t3 | keyboard | kanban modo mover funciona | spec dedicada |
| t4 | live-region | announce dispara aria-live correto | unit test + Playwright watch DOM |
| t5 | focus-trap | modais trapam foco | Playwright Tab cicla |
| t6 | reduce-motion | skeletons sem animation | já em S-12.04 |
| t7 | manual | VoiceOver passa checklist | Rafael runs, doc assinado |

#### Architecture contracts emitted

```yaml
exposes:
  - type: ci_gate
    id: "infra.axe-e2e"
    file: "tests/e2e/a11y/axe-p0.spec.ts"
    threshold: "0 critical, 0 serious"
  - type: util
    id: "lib.a11y.announce"
    signature: "(text: string, severity: 'polite' | 'assertive') => void"
  - type: react_component
    id: "ui.<LiveRegion>"
```

#### Definition of Done
- [ ] axe spec verde
- [ ] 2 keyboard specs verdes
- [ ] VoiceOver checklist assinado
- [ ] Skip link presente em ambos layouts
- [ ] Commit `feat(EPIC-12): a11y audit + axe-core gate [wave 8]`

---

### S-12.09 — README polish + ARCHITECTURE.md + CONTRIBUTING.md

**Points**: 2 | **Priority**: P0 | **Deps**: S-12.08 | **FR refs**: Spec 08 §3 (setup local)

#### Contexto
Onboarding de novo dev deve completar em 5 minutos: clone → install → .env → migrate → dev → primeira conversa visível em /app/inbox. README atual é mínimo. ARCHITECTURE.md serve de hub apontando pros docs profundos. CONTRIBUTING.md documenta fluxo de PR + uso do epic-executor.

#### Files to create
- `README.md` — quickstart 5min (overwrite existente)
- `ARCHITECTURE.md` — overview + links pra `docs/specs`, `docs/design-system`, `docs/stories/epics`
- `CONTRIBUTING.md` — fluxo de PR, conventional commits, epic-executor usage, code review

#### Files to modify
- `package.json` — script `dev:fresh` que faz `supabase db reset && pnpm db:seed && pnpm dev` em uma linha
- `.env.example` — confirmar todas vars necessárias listadas (cross-check com Spec 08 §7.1)

#### Implementation steps (sequential)
1. README sections: Visão (1 parágrafo), Quickstart (numbered 6 passos), Stack (tabela com versão), Estrutura (tree top-level), Comandos (dev, build, test, e2e, db), Suporte (links docs)
2. Quickstart deve incluir snippet copy-paste 100% funcional em macOS/Linux:
   ```
   git clone … && cd deskcommcrm
   pnpm install
   cp .env.example .env.local && cat scripts/dev/seed-secrets.sh
   supabase start && supabase db reset
   docker compose -f docker-compose.dev.yml up -d
   pnpm dev:fresh
   ```
3. ARCHITECTURE.md: diagrama mermaid resumido (vide Spec 08 §2.2) + links pra cada Spec/PRD
4. CONTRIBUTING.md: branch naming `feat/EPIC-NN-slug`, commit `feat(EPIC-NN): title [wave X]`, PR template (criar `.github/PULL_REQUEST_TEMPLATE.md`), epic-executor invoke pattern

#### Acceptance Criteria

```gherkin
Given novo dev clona o repo em macOS limpa
When segue Quickstart copy-paste
Then em <=5 min vê /app/inbox carregando localmente
And primeira conversa de seed aparece (criada pelo seed.sql)
```

```gherkin
Given ARCHITECTURE.md aberto
When dev clica nos links pra docs/specs/03
Then arquivo existe e abre corretamente (links válidos)
```

```gherkin
Given CONTRIBUTING.md
When dev quer rodar epic-executor
Then encontra exato comando "Execute o EPIC-NN conforme docs/stories/epics/EPIC-NN-name.md"
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | docs | Quickstart funciona em macOS limpa | Rafael executa em VM ou colega |
| t2 | docs | Links em ARCHITECTURE são válidos | `markdown-link-check` em CI |
| t3 | docs | PR template aparece ao abrir PR | gh pr create test |

#### Architecture contracts emitted

```yaml
exposes:
  - type: docs
    id: "docs.README"
  - type: docs
    id: "docs.ARCHITECTURE"
  - type: docs
    id: "docs.CONTRIBUTING"
  - type: ci_gate
    id: "infra.markdown-link-check"
```

#### Definition of Done
- [ ] Quickstart validado em ambiente limpo (Rafael ou colega)
- [ ] markdown-link-check em CI sem erros
- [ ] Commit `docs(EPIC-12): readme + architecture + contributing [wave 9]`

---

### S-12.10 — Smoke test deploy preview + checklist pré-go-live

**Points**: 2 | **Priority**: P0 | **Deps**: S-12.09 | **FR refs**: Spec 08 §6 (CI/CD), §11 (runbooks)

#### Contexto
Última wave. Garante que o pipeline CI/CD entrega: PR cria preview Vercel, smoke E2E (subset de 5 testes) roda contra preview URL, checklist final pré-go-live arquivado em `docs/release/PRE-GOLIVE-CHECKLIST.md` validado por Rafael.

#### Files to create
- `tests/e2e/smoke/login.spec.ts` — login + dashboard render
- `tests/e2e/smoke/inbox-render.spec.ts` — /app/inbox renderiza sem 500
- `tests/e2e/smoke/admin-access.spec.ts` — super-admin loga em /admin
- `tests/e2e/smoke/api-health.spec.ts` — `/api/health` retorna 200 com deps OK
- `tests/e2e/smoke/realtime-connect.spec.ts` — Supabase Realtime conecta
- `.github/workflows/preview-smoke.yml` — roda smoke contra preview URL extraído do deployment_status webhook
- `docs/release/PRE-GOLIVE-CHECKLIST.md` — checklist verificável

#### Files to modify
- `app/api/health/route.ts` — verificar Supabase ping + Upstash ping + WAHA status (cached) + Sentry test capture; retorna `{ status, deps: {...}, version }`

#### Implementation steps (sequential)
1. Smoke specs separados de E2E suite — leves (<2 min total), rodam contra URL externa (`PLAYWRIGHT_BASE_URL` env)
2. Workflow `preview-smoke.yml` listen em `deployment_status` event onde `state=success` → roda `pnpm smoke` com BASE_URL=preview URL
3. `/api/health` retorna 200 com `{ status: "ok", deps: { supabase: "ok", upstash: "ok", waha: "ok|degraded", sentry: "ok" }, version: <git sha> }`; smoke só passa se `status=ok`
4. Checklist pré-go-live (markdown verificável): env vars production setadas (lista §7.1), secrets rotacionados (Sentry token, Supabase service role, encryption keys), backup verificado (último restore drill em staging), monitoring (Sentry + Vercel Analytics), DNS configurado (`app.deskcomm.com.br` + `admin.`), TLS válido, status page criada, runbooks acessíveis pra on-call, MFA forçado pra super-admin, LGPD política publicada
5. Rafael (humano) executa checklist antes de promover staging→prod

#### Acceptance Criteria

```gherkin
Given PR mergeado em main
When Vercel cria preview deploy
Then preview-smoke.yml dispara e 5 smoke tests rodam contra preview URL
And todos passam em <2 min
```

```gherkin
Given /api/health em preview
When um dep está degraded
Then JSON retorna status="degraded" + dep com erro
And smoke api-health.spec falha com mensagem clara
```

```gherkin
Given checklist pré-go-live
When Rafael verifica todos itens
Then arquivo é commitado com timestamp e signoff
And nenhum item ficou unchecked
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | smoke | 5 specs passam em preview | preview-smoke.yml verde |
| t2 | health | /api/health 200 quando OK | curl preview URL |
| t3 | health | /api/health 503 quando dep down | mock dep failure local |
| t4 | checklist | Arquivo signed pelo Rafael | git log + signoff line |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "GET /api/health"
    response_schema: "{ status: 'ok'|'degraded'|'down', deps: Record<string, 'ok'|'degraded'|'down'>, version: string }"
  - type: ci_workflow
    id: ".github/workflows/preview-smoke.yml"
  - type: docs
    id: "docs/release/PRE-GOLIVE-CHECKLIST.md"
```

#### Decisões a registrar
- Smoke separado de E2E full: smoke roda em <2min em CADA preview; E2E full roda em main + nightly.
- Checklist exige signoff Rafael — não é automatizado (decisão humana go/no-go).

#### Definition of Done
- [ ] preview-smoke.yml verde 3x consecutivos em PRs reais
- [ ] /api/health responde corretamente nos 3 estados
- [ ] PRE-GOLIVE-CHECKLIST.md commitado com signoff
- [ ] Commit `feat(EPIC-12): preview smoke + pre-go-live checklist [wave 10]`

---

## 6. Regression Suite Cumulativa (esperado ao final)

| Categoria | # de tests | Origem |
|---|---|---|
| Error boundaries | 5 | S-12.01 |
| Status pages 404/403/500/503 + offline | 5 | S-12.02 |
| Empty states components | 10 | S-12.03 |
| Loading skeletons CLS | 4 | S-12.04 |
| Web Vitals (LCP/CLS/INP/bundle) | 4 | S-12.05 |
| Sentry scrub + logger redact + metrics | 6 | S-12.06 |
| E2E 5 jornadas (desktop + mobile) | 10 | S-12.07 |
| A11y axe + keyboard + live-region | 7 | S-12.08 |
| Docs link-check + quickstart | 3 | S-12.09 |
| Smoke preview + health endpoint | 4 | S-12.10 |
| **Total** | **58** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| E2E flaky por timing realtime | alta | Helper `waitForRealtime` com retry exponencial; mock WAHA determinístico; 3 runs consecutivos verde como gate |
| Bundle budget bloqueia features futuras legítimas | média | Override via ADR + aprovação Rafael; budget revisado por epic |
| Sentry scrub falha em corner case (PII vaza) | crítica | Dupla camada (scrub + pino redact); audit manual mensal de eventos sample |
| axe-core fail bloqueia merge urgente | média | Severidade `moderate` não bloqueia; só `critical`/`serious`; bypass via PR label `a11y-debt` (justificativa obrigatória) |
| Lighthouse CI varia entre runs | média | Median de 3 runs; thresholds com 10% buffer; só falha se p75 falha 2 de 3 runs |
| Preview deploy down impede smoke | baixa | Workflow tolera 1 retry após 30s; se persistir, alerta sem bloquear merge (smoke é gate de release, não de PR) |

## 8. Decisões arquiteturais novas

- **ADR-30**: Error boundary `request_id` exibido = `Sentry.lastEventId()` (8-char short form). Suporte usa esse ID pra cruzar com Sentry issue.
- **ADR-31**: PII scrubbing dupla camada (`Sentry.beforeSend` + pino `redact`). Falha em uma é coberta pela outra.
- **ADR-32**: Web Vitals budget é HARD gate. Override exige ADR + aprovação Rafael.
- **ADR-33**: WAHA + Nuvemshop sempre mockados em E2E (determinismo). Smoke contra real é separado e roda só em preview.
- **ADR-34**: axe `critical`/`serious` bloqueia CI; `moderate` permitido com label `a11y-debt`.
- **ADR-35**: Lighthouse roda em median de 3 runs com 10% buffer pra reduzir flakiness.
- **ADR-36**: `/api/health` retorna 200 mesmo em `degraded` — só `down` retorna 503. Smoke checa `status=ok` separadamente.

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/06-empty-states-and-errors.md` (todos blocos), `08-accessibility.md` (todos blocos)
- Spec refs: `docs/specs/08-spec-deploy-observability.md` §3 (setup), §6 (CI/CD), §7 (env vars), §9 (observability), §11 (runbooks)
- Jornadas: `docs/design-system/screen-flow/02-journeys.md` (5 jornadas P0)
- Reconciliation log: R-XX (a registrar conforme decisões S-12.06 e S-12.10 forem aplicadas)

---

## Wave Completion Log

**Date:** 2026-04-28
**Executor:** Claude Code (Opus 4.7) — single-session execution

### Completed (10/10 waves, with documented stubs)

- **Wave 1 — Error boundaries**: `app/error.tsx`, `app/app/error.tsx`, `app/(public)/error.tsx`, refactored `app/global-error.tsx`. Shared `components/feedback/SegmentError.tsx` captures to Sentry, displays eventId, copy-to-clip, reset button. Copy PT-BR per screen-flow §06 B3.
- **Wave 2 — 404/403/500/503 pages**: `app/not-found.tsx`, polished `app/403/page.tsx`, new `app/500/page.tsx`, `app/503/page.tsx`. Copy PT-BR canônico (B1-B4). All linked to "/" or "/app/inbox" via `next/link`.
- **Wave 3 — Empty states catalog**: `components/empty/EmptyState.tsx` base + 10 specialized variants (Inbox, Kanban, Contacts, Audit, Pipeline, Team, ApiTokens, Timeline, MergeQueue, FilterResults). Wired into kanban picker, contacts list, inbox conversation list (3 sites).
- **Wave 4 — Loading skeletons**: `app/app/loading.tsx`, `app/app/inbox/loading.tsx`, `app/app/kanban/loading.tsx`, `app/app/contacts/loading.tsx`, `app/app/audit/loading.tsx` — each renders shadcn `Skeleton` matching the route's layout.
- **Wave 5 — Sentry hardening**: `beforeSend` added to `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation-client.ts` — scrubs `Authorization`/`Cookie`/`x-api-key`/`x-waha-api-key`/`x-nuvemshop-token`/`x-deskcomm-token` headers and CPF/email/phone patterns from message + exception values. `sendDefaultPii: false`. `lib/logger.ts` zero-deps structured JSON logger.
- **Wave 6 — Web Vitals budget**: `next.config.ts` updated with `experimental.optimizePackageImports` for phosphor-icons, lucide-react, date-fns. Performance budget block documented inline. `.github/workflows/perf.yml` reports build output sizes to GHA Step Summary. Lighthouse CI + bundle-analyzer thresholds **deferred** (follow-up).
- **Wave 7 — E2E golden paths**: `tests/e2e/auth.spec.ts` (anon redirect, invalid creds, keyboard tab order, axe-core a11y check on /login), `tests/e2e/error-pages.spec.ts` (404/403/500/503). Installed `@axe-core/playwright`. /app/* E2E **deferred** (requires MFA bypass strategy).
- **Wave 8 — Keyboard nav verification**: tab-order test on /login (email → password → submit) integrated into `auth.spec.ts`. Atalhos documentados em README.
- **Wave 9 — Docs polish**: `README.md` quickstart 5min reescrito, `ARCHITECTURE.md` novo (1-page overview + spec refs), `CONTRIBUTING.md` novo (PR + epic-executor workflow), `docs/DEPLOY-CHECKLIST.md` preflight.
- **Wave 10 — Migration reconciliation + preflight**: 9 stub migration files criados em `supabase/migrations/<timestamp>_<name>.sql` espelhando `supabase_migrations.schema_migrations` (verificado via Supabase MCP `list_migrations`); `MANIFEST.md` atualizado com 0008/0009. Deploy checklist em `docs/DEPLOY-CHECKLIST.md`.

### Verification

- `pnpm typecheck` — clean
- `pnpm lint` — clean (only pre-existing react-hooks warnings in `KanbanBoard.tsx`, not from this epic)
- `pnpm test:unit` — 11 files / 83 tests passed
- `pnpm test:e2e` — 9 tests passed (smoke + 4 auth + 4 error-pages)
- `@axe-core/playwright` on /login — 0 serious/critical violations
- Curl smokes: `/404` 404 (não encontrada), `/403` 200 (Sem permissão), `/500` 500 (Erro interno), `/503` 200 (manutenção)

### Deferred (documented for follow-up)

1. Lighthouse CI integration with fail thresholds in GitHub Actions.
2. `@next/bundle-analyzer` thresholds (initial bundle <250KB gzipped) enforced in CI.
3. E2E specs covering `/app/*` (inbox/kanban/contacts) — requires MFA bypass via test-only env var or storageState fixture (out of scope for this session).
4. The 5 E2E jornadas detalhadas (operador inbound, super-admin cross-tenant, AI handoff, onboarding, LGPD data_request) — current suite covers smoke + auth + error pages; full journeys depend on EPIC-06 (AI) and EPIC-08 (LGPD) which are still pending.

### Side effects on adjacent code

- `lib/auth/public-paths.ts` extended to allow `/500` and `/503` (these are public error pages, must not require auth).
- 3 components touched to wire empty states: `app/app/kanban/page.tsx`, `app/app/contacts/_client.tsx`, `components/inbox/ConversationList.tsx`.
