---
epic_id: EPIC-00-foundation
epic_name: Foundation & Tooling
priority: P0
estimated_waves: 8
estimated_total_points: 21
depends_on: []
exposes_contracts:
  - "infra.tanstack-query — QueryClientProvider configurado em layout raiz com defaults canônicos + DevTools em dev"
  - "lib.phosphor — `@phosphor-icons/react` instalado + mapa canônico de ícones por feature em `lib/ui/icons.ts`"
  - "lib.api.client — `apiClient` com idempotency-key auto, X-Request-Id, retry exponencial 429/503, `ApiError` typed"
  - "hook.useRealtimeChannel — primitivo com cleanup obrigatório + status (`subscribed | channel_error | timed_out | closed`)"
  - "lib.toast + ApiErrorToast — sonner wired global + `showApiError(err)` mapeando `error.code` conforme Spec 09 §8"
  - "ui.ThemeToggle — componente wired ao theme provider, atalho `Cmd+Shift+L`"
  - "infra.test-runner — Playwright configurado com smoke `/` 200 + Vitest configurado com unit `cn()`"
  - "lib.schemas — registry `lib/schemas/index.ts` + helper `validateRequest<T>(schema, request)`"
status: completed
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-00 — Foundation & Tooling

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei. Este é o **epic 0** do MVP-B: tudo que vier depois consome contracts daqui. Errar foundation = bug snowball nos 12 epics seguintes.

## 1. Objetivo

Estabelecer a fundação técnica compartilhada (cache layer, HTTP client, realtime primitive, toast, icons, theme toggle, test infra, schemas registry) **antes** de qualquer tela operacional ou auth. Ao final, qualquer feature subsequente pode codar UI sem reimplementar cross-cutting concerns. Concretiza ADR-01, ADR-04, ADR-05, ADR-12 da Spec 09 §12.

## 2. Resultado esperado (Definition of Done do Epic)

- [ ] `QueryClientProvider` montado em `app/layout.tsx` com defaults canônicos (staleTime 30s, retry custom) e DevTools visíveis em `NODE_ENV=development`
- [ ] `@phosphor-icons/react` instalado; `lib/ui/icons.ts` exporta mapa canônico (≥20 ícones nomeados por feature: inbox, kanban, contacts, ai, settings, etc.)
- [ ] `lib/api/client.ts` exposto com `apiClient.{get,post,patch,delete}` injetando `Idempotency-Key` em mutations, `X-Request-Id`, retry exponencial pra 429/503 e jogando `ApiError` typed
- [ ] `hooks/realtime/useRealtimeChannel.ts` primitivo funcional com cleanup garantido em unmount + reporta `status`
- [ ] `<Toaster />` (sonner) montado global; `components/feedback/ApiErrorToast.tsx` exporta `showApiError(err)` mapeando ≥10 codes da matriz Spec 09 §8
- [ ] `<ThemeToggle>` (Phosphor `Sun`/`Moon`) wired ao theme provider existente; atalho `Cmd+Shift+L` cicla `light → dark → system`
- [ ] `playwright.config.ts` + smoke test `tests/e2e/smoke.spec.ts` (visit `/` → 200 + sem erros de console) passando via `pnpm test:e2e`
- [ ] `vitest.config.ts` + unit test `lib/utils.test.ts` cobrindo `cn()` passando via `pnpm test:unit`
- [ ] `lib/schemas/index.ts` exporta convenção pra registrar schemas + helper `validateRequest<T>(schema, request): Promise<T>` (lança `ApiError 422 validation_error` em falha)
- [ ] `pnpm typecheck` zerado, `pnpm lint` zerado
- [ ] Sem `console.log` em código merged
- [ ] Architecture contracts deste epic registrados em `.epic-executor/EPIC-00-foundation-state.yaml`

## 3. Pré-requisitos

- Repo Next.js 15 App Router já scaffoldado (vide CLAUDE.md "Como rodar local")
- `pnpm install` rodou sem erro
- `.env.local` configurado com `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (mesmo que ainda não usemos auth, supabase client é importado pelo `useRealtimeChannel`)
- Theme provider (next-themes ou equivalente) já existe — confirmar antes da S-00.06
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA das waves
- Migrations 0001–0007 aplicadas (não bloqueia este epic, mas a smoke test não deve quebrar pelo DB)

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

(none — este é o epic 0)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| (n/a) | | | |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `infra.tanstack-query` | provider | S-00.01 | `<Providers>` em `app/layout.tsx` envolvendo `<QueryClientProvider>` + DevTools dev-only. Defaults: `staleTime: 30_000`, `gcTime: 5*60_000`, `retry: (count, err) => err instanceof ApiError && [429,503].includes(err.status) ? count<2 : false`, `refetchOnWindowFocus: false` |
| `lib.phosphor` | lib | S-00.02 | Import via `import { Inbox, Kanban, ... } from '@/lib/ui/icons'` (não direto de `@phosphor-icons/react`) — re-export central permite swap futuro |
| `lib.api.client` | lib | S-00.03 | `apiClient` exportado de `lib/api/client.ts`. Tipos `ApiSuccess<T>`, `ApiErrorBody`, `ApiError` em `lib/api/types.ts`. Comportamento conforme Spec 09 §4.2 |
| `lib.api.ApiError` | type | S-00.03 | Classe pra `instanceof` em error handlers (mutations, error boundaries) |
| `hook.useRealtimeChannel` | react_hook | S-00.04 | Signature: `(opts: { name, table?, filter?, event?, broadcast?, onChange }) => { status }` — cleanup automático em unmount via `useEffect` return |
| `lib.toast` | lib | S-00.05 | `<Toaster />` montado em `app/layout.tsx`; helper `showApiError(err)` em `components/feedback/ApiErrorToast.tsx` |
| `ui.ApiErrorToast` | react_component | S-00.05 | Função `showApiError(err: unknown)` (não componente JSX, mas registrado como contract de UI feedback) |
| `ui.ThemeToggle` | react_component | S-00.06 | `<ThemeToggle />` em `components/theme/theme-toggle.tsx`; usado em `<TopBar>` em EPIC-01 |
| `infra.test-runner` | infra | S-00.07 | `pnpm test:e2e` (Playwright) e `pnpm test:unit` (Vitest) configurados; epics seguintes adicionam specs |
| `lib.schemas.registry` | lib | S-00.08 | `lib/schemas/index.ts` re-exporta schemas por entidade conforme adicionados; convenção: 1 arquivo por entidade em `lib/schemas/<entity>.ts` |
| `lib.schemas.validateRequest` | lib | S-00.08 | `validateRequest<T>(schema: ZodSchema<T>, req: Request): Promise<T>` — usado em todo `route.ts` no boundary (ADR-03) |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = S-00.01; wave 8 = S-00.08. Deps internos respeitados pela ordem.

---

### S-00.01 — Setup TanStack Query (provider + DevTools + defaults)

**Points**: 2 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 09 §12 ADR-01, §13 Tier 0

#### Contexto

TanStack Query é o cache layer **único** do app (ADR-01). Toda query de dados — REST via `apiClient` ou RSC initial + hydrate — passa por aqui. Realtime patches futuros (`qc.setQueryData`) dependem de `QueryClient` acessível. Esta é a primeira coisa porque todo hook subsequente vai consumir.

#### Files to create

- `lib/query/client.ts` — fábrica `makeQueryClient()` com defaults canônicos
- `app/providers.tsx` — Client Component `<Providers>` montando `<QueryClientProvider>` + `<ReactQueryDevtools>` (apenas em dev)

#### Files to modify

- `app/layout.tsx` — envolver `{children}` em `<Providers>` (já existe possivelmente um provider simples; integrar)
- `package.json` — adicionar `@tanstack/react-query` e `@tanstack/react-query-devtools` se não estiverem
- `.env.example` — sem mudança (TanStack não pede env)

#### Implementation steps (sequential)

1. `pnpm add @tanstack/react-query @tanstack/react-query-devtools`
2. Criar `lib/query/client.ts` com `makeQueryClient()` retornando `new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: 5*60_000, refetchOnWindowFocus: false, retry: (count, err) => err instanceof ApiError && [429,503].includes(err.status) ? count < 2 : false }, mutations: { retry: false } } })`. Nota: `ApiError` ainda não existe em S-00.01 — usar `retry: false` puro nesta wave; ajustar em S-00.03
3. Criar `app/providers.tsx` (`'use client'`) com singleton via `useState(() => makeQueryClient())` (per-request no server, persistente no client)
4. Em `app/layout.tsx`, importar `<Providers>` e envolver `{children}`
5. Mount `<ReactQueryDevtools initialIsOpen={false} />` dentro de `<Providers>` apenas se `process.env.NODE_ENV === 'development'`

#### Acceptance Criteria (testáveis)

```gherkin
Given o dev server rodando em localhost:3001
When eu visito /
Then o React Query DevTools aparece como floating button no canto inferior
And clicando abre o painel sem erros
```

```gherkin
Given uma página qualquer renderizando um componente cliente
When o componente faz `const qc = useQueryClient()`
Then qc não é undefined
And tipo `QueryClient`
```

```gherkin
Given build de produção (NODE_ENV=production)
When eu visito a página
Then ReactQueryDevtools NÃO aparece no DOM
```

```gherkin
Given uma query com staleTime default
When o componente desmonta e remonta dentro de 30s
Then não há refetch (cache hit)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | DevTools button visível em dev | Playwright em `localhost:3001`, getByRole/locator no botão flutuante |
| t2 | ui | DevTools ausente em prod build | `pnpm build && pnpm start`, navega `/`, locator não encontra DevTools |
| t3 | unit | `makeQueryClient()` retorna defaults corretos | Vitest: cria client, inspeciona `getDefaultOptions().queries.staleTime === 30000` |
| t4 | typecheck | `pnpm typecheck` zero erros novos | CI |

#### Architecture contracts emitted

```yaml
exposes:
  - type: provider
    id: "infra.tanstack-query"
    file: "app/providers.tsx"
    defaults:
      staleTime: 30000
      gcTime: 300000
      refetchOnWindowFocus: false
      retry: "false (S-00.01); refinado em S-00.03 com ApiError-aware policy"
  - type: lib
    id: "lib.query.makeQueryClient"
    signature: "() => QueryClient"
    file: "lib/query/client.ts"
```

#### Decisões a registrar

- **TanStack Query é o único cache layer.** Não introduzir SWR, Apollo, Zustand-com-cache. (ADR-01)
- **QueryClient via fábrica + `useState` no Providers** (não singleton module-level) — evita compartilhar cache entre requests no SSR.

#### Definition of Done

- [ ] Todos os ACs passam em Playwright
- [ ] `pnpm typecheck` zero erros novos
- [ ] `pnpm lint` zero erros novos
- [ ] Sem warnings no console do browser em dev
- [ ] Commit `feat(EPIC-00): setup tanstack query provider [wave 1]`
- [ ] Architecture contracts registrados no state file
- [ ] Não introduz regressão (n/a — primeira wave)

---

### S-00.02 — Phosphor Icons + mapa canônico

**Points**: 1 | **Priority**: P0 | **Deps**: S-00.01 | **FR refs**: Spec 09 §12 ADR-05, Design System §06

#### Contexto

ADR-05 lockou Phosphor como **único** pacote de ícones. Re-export central em `lib/ui/icons.ts` permite (a) swap futuro sem big-bang refactor, (b) lint custom impedir import direto de `@phosphor-icons/react` em features. Mapa canônico por feature evita "qual ícone uso pra inbox?" virar bikeshed.

#### Files to create

- `lib/ui/icons.ts` — re-export tipado dos ícones canônicos do app
- `docs/design-system/icons-canonical.md` — *(opcional, só listar a tabela; se já existe em 06-components.md basta apontar)*

#### Files to modify

- `package.json` — adicionar `@phosphor-icons/react`
- `.eslintrc.json` (ou `eslint.config.mjs`) — *(stretch; se inviável nesta wave, deixar em backlog)* regra `no-restricted-imports` proibindo `@phosphor-icons/react` direto fora de `lib/ui/icons.ts`

#### Implementation steps (sequential)

1. `pnpm add @phosphor-icons/react`
2. Criar `lib/ui/icons.ts` exportando ≥20 ícones cobrindo: navegação (Inbox, Kanban, Users, Storefront, Robot, ShieldCheck, Gear), ações (PaperPlaneTilt, Check, Checks, X, Plus, Trash, PencilSimple, MagnifyingGlass), feedback (CheckCircle, WarningOctagon, Info, CircleNotch), tema (Sun, Moon, MonitorPlay), conversa (ChatCircle, Phone, Paperclip), status (DotsThree, CaretDown, ArrowRight). Cada export usa o nome canônico do Phosphor.
3. Smoke test rápido: importar 1 ícone numa página existente (ex: home `app/page.tsx` se houver) e verificar render
4. Adicionar regra ESLint `no-restricted-imports` se config permitir; senão criar issue de follow-up

#### Acceptance Criteria

```gherkin
Given lib/ui/icons.ts existe
When um arquivo TS importa { Inbox } de '@/lib/ui/icons'
Then typecheck passa
And o ícone renderiza no DOM como SVG
```

```gherkin
Given a regra ESLint configurada
When um arquivo importa direto de '@phosphor-icons/react'
Then `pnpm lint` reporta erro `no-restricted-imports`
```

```gherkin
Given um ícone canônico
When inspeciono `props` aceitas
Then aceita `size`, `weight`, `color`, `aria-hidden` (passthrough nativo do Phosphor)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Re-export expõe ≥20 ícones nomeados | Vitest snapshot: `Object.keys(icons).length >= 20` |
| t2 | ui | Ícone renderiza como SVG | Playwright: navega à página de teste, locator `svg` |
| t3 | lint | Lint barra import direto | Criar arquivo dummy importando `@phosphor-icons/react`, rodar `pnpm lint`, esperar erro |

#### Architecture contracts emitted

```yaml
exposes:
  - type: lib
    id: "lib.phosphor"
    file: "lib/ui/icons.ts"
    convention: "Toda feature importa de @/lib/ui/icons. Lint barra @phosphor-icons/react direto."
    icons:
      navigation: [Inbox, Kanban, Users, Storefront, Robot, ShieldCheck, Gear]
      actions: [PaperPlaneTilt, Check, Checks, X, Plus, Trash, PencilSimple, MagnifyingGlass]
      feedback: [CheckCircle, WarningOctagon, Info, CircleNotch]
      theme: [Sun, Moon, MonitorPlay]
      conversation: [ChatCircle, Phone, Paperclip]
      misc: [DotsThree, CaretDown, ArrowRight]
```

#### Decisões a registrar

- **Phosphor weight default = `regular`.** Pra ações destacadas (primary buttons), usar `bold` explicitamente.
- **Ícones SEMPRE com `aria-hidden` quando acompanhados de label texto** (acessibilidade)

#### Definition of Done

- [ ] Todos os ACs passam
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] Commit `feat(EPIC-00): wire phosphor icons + canonical map [wave 2]`
- [ ] Contracts registrados
- [ ] Regression suite (S-00.01) ainda passa

---

### S-00.03 — HTTP client wrapper `lib/api/client.ts`

**Points**: 5 | **Priority**: P0 | **Deps**: S-00.01 | **FR refs**: Spec 09 §4 (completo), §12 ADR-12

#### Contexto

Wrapper único que substitui `fetch` direto. Injeta `Idempotency-Key` automático em POST/PATCH/DELETE (ADR-12), `X-Request-Id` em toda request (correlaciona com audit log), retry exponencial pra 429/503 com `Retry-After` honoring, e mapeia error responses pra `ApiError` typed. Cookies via `credentials: 'same-origin'`. Suporta Zod schema opcional pra validação runtime no boundary.

Após esta wave, a policy de retry do `QueryClient` (S-00.01) pode ser refinada pra usar `err instanceof ApiError && [429,503].includes(err.status)`.

#### Files to create

- `lib/api/types.ts` — `ApiSuccess<T>`, `ApiErrorBody`, classe `ApiError`
- `lib/api/client.ts` — `apiClient.{get,post,patch,delete}` + função `request<T>` interna
- `lib/api/client.test.ts` — Vitest cobrindo: idempotency-key auto, X-Request-Id, retry 429 com Retry-After, retry 503 com backoff exponencial, throw ApiError em 4xx/5xx, no-retry em 500, schema parse opcional, timeout 10s default

#### Files to modify

- `lib/query/client.ts` — refinar `retry` pra usar `ApiError`-aware policy (agora possível)
- `package.json` — adicionar `uuid` e `@types/uuid` (peerless; ou usar `crypto.randomUUID()` se Node ≥19 — preferir `crypto.randomUUID()` pra evitar dep extra)
- `.env.example` — sem mudança

#### Implementation steps (sequential)

1. Criar `lib/api/types.ts` exatamente conforme Spec 09 §4.1 (copiar literal — é contract público)
2. Criar `lib/api/client.ts` conforme Spec 09 §4.2 com 1 ajuste: usar `crypto.randomUUID()` no lugar de `uuid()` (Node 20+ tem nativo; evita dep)
3. Adicionar export `apiClient` com 4 métodos
4. Refinar `lib/query/client.ts`: importar `ApiError` e atualizar `retry: (count, err) => err instanceof ApiError && [429,503].includes(err.status) ? count < 2 : false`
5. Escrever `lib/api/client.test.ts` mockando `fetch` (via `vi.stubGlobal('fetch', ...)`) cobrindo todos os comportamentos
6. Documentar em comment header do arquivo: "Toda chamada HTTP do frontend passa por aqui. Não use fetch direto. Vide Spec 09 §4."

#### Acceptance Criteria

```gherkin
Given o cliente faz `apiClient.post('/api/v1/foo', { x: 1 })`
When inspeciono headers da request
Then `Idempotency-Key` é UUID v4
And `X-Request-Id` é UUID v4
And `Content-Type` é `application/json`
And `credentials` é `same-origin`
```

```gherkin
Given o servidor responde 429 com `Retry-After: 2`
When apiClient.get faz a chamada
Then aguarda 2000ms
And refaz a request (attempt 2)
And se 429 de novo, aguarda backoff exponencial (200, 400, 800 + jitter)
And após maxAttempts (3), throw ApiError(429, 'rate_limited', ...)
```

```gherkin
Given o servidor responde 422 com `{ error: { code: 'validation_error', message: '...', details: {...}, request_id: 'abc' } }`
When apiClient.post processa a response
Then throw new ApiError(422, 'validation_error', details, 'abc', message)
And NÃO retenta
```

```gherkin
Given um schema Zod passado em opts.schema
When a response é 200 mas o body não casa com o schema
Then o ZodError propaga (não é convertido em ApiError; é programmer error)
```

```gherkin
Given idempotencyKey custom passado em opts
When mutation é feita
Then o header Idempotency-Key usa o valor custom (não auto-uuid)
```

```gherkin
Given timeoutMs default 10000
When fetch demora mais que 10s
Then AbortController dispara
And a Promise rejeita com erro de abort
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Idempotency-Key auto em POST/PATCH/DELETE, ausente em GET | Vitest mock fetch, inspeciona headers em cada método |
| t2 | unit | X-Request-Id presente sempre | idem |
| t3 | unit | Retry 429 com Retry-After | mock fetch returning 429 then 200 |
| t4 | unit | Retry 503 com backoff exponencial | mock fetch returning 503 503 200 |
| t5 | unit | Sem retry em 500 | mock fetch 500, esperar throw imediato |
| t6 | unit | ApiError typed com status, code, details, requestId | inspeciona instance |
| t7 | unit | Schema Zod parse | mock 200 com body válido + body inválido |
| t8 | unit | Timeout aborta após 10s | usar fake timers Vitest |
| t9 | typecheck | Generics propagam | `apiClient.post<{id:string}>` retorna `Promise<{id:string}>` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: lib
    id: "lib.api.client"
    file: "lib/api/client.ts"
    api:
      get: "<T>(path, opts?) => Promise<T>"
      post: "<T>(path, body, opts?) => Promise<T>"
      patch: "<T>(path, body, opts?) => Promise<T>"
      delete: "<T>(path, opts?) => Promise<T>"
    behavior:
      idempotency_key: "auto-uuid em mutations; override via opts.idempotencyKey"
      x_request_id: "auto-uuid em toda request"
      retry: "exponencial 200/400/800ms + jitter pra 429 e 503; honra Retry-After se >0; max 3 attempts"
      timeout: "10000ms default; override via opts.timeoutMs"
      credentials: "same-origin (cookies vão automaticamente)"
      schema: "Zod opcional via opts.schema"
  - type: type
    id: "lib.api.ApiError"
    file: "lib/api/types.ts"
    fields: "status, code, details?, requestId, message"
  - type: type
    id: "lib.api.ApiSuccess"
    file: "lib/api/types.ts"
    shape: "{ data: T, meta?: { cursor?, has_more?, total?, request_id } }"
```

#### Decisões a registrar

- **`crypto.randomUUID()` em vez de `uuid` package** — Node 20+ nativo, zero dep
- **Sem retry em 500/502/504** — idempotência é responsabilidade server-side, mas retry de 500 pode duplicar side-effect se transação passou em parte (Spec 09 §4.4)
- **`credentials: 'same-origin'`** (não `include`) — frontend e backend são same-origin; `include` exporia a cross-origin desnecessariamente

#### Definition of Done

- [ ] ACs passam (unit tests + smoke manual via DevTools)
- [ ] Coverage do `client.ts` ≥85%
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] `pnpm test:unit` verde
- [ ] Commit `feat(EPIC-00): http client wrapper with idempotency + retry [wave 3]`
- [ ] Contracts registrados
- [ ] Regression S-00.01, S-00.02 passa

---

### S-00.04 — `useRealtimeChannel` primitivo

**Points**: 3 | **Priority**: P0 | **Deps**: S-00.01 | **FR refs**: Spec 09 §6 (completo), §12 ADR-04, ADR-11

#### Contexto

Primitivo único pra subscriptions Supabase Realtime (ADR-04, ADR-11). Lint custom proibirá `supabase.channel(...)` direto fora de `hooks/realtime/`. Cleanup é **obrigatório** — leak de canal é um dos bugs mais comuns em Realtime e custa caro em conexões. Reporta `status` que `<RealtimeHealthProvider>` (futuro EPIC-01) agrega pra mostrar `<OfflineBanner>` quando 1+ canal está caído >30s.

#### Files to create

- `hooks/realtime/useRealtimeChannel.ts` — primitivo
- `hooks/realtime/useRealtimeChannel.test.ts` — Vitest mockando `supabase.channel(...)`

#### Files to modify

- `lib/supabase/browser.ts` — confirmar export `createBrowserClient()` (já existe segundo CLAUDE.md "Paths importantes")
- `.eslintrc.json` ou `eslint.config.mjs` — regra `no-restricted-syntax` proibindo `CallExpression[callee.property.name='channel']` fora de `hooks/realtime/**` *(stretch; backlog se inviável)*

#### Implementation steps (sequential)

1. Criar `hooks/realtime/useRealtimeChannel.ts` exportando `useRealtimeChannel(opts)` com signature:
   ```ts
   export type RealtimeStatus = 'connecting' | 'subscribed' | 'channel_error' | 'timed_out' | 'closed';
   export interface UseRealtimeChannelOpts {
     name: string; // channel name (ex: `org-${orgId}-conversations`)
     postgresChanges?: { event: 'INSERT'|'UPDATE'|'DELETE'|'*'; schema?: 'public'; table: string; filter?: string };
     broadcast?: { event: string };
     onChange: (payload: unknown) => void;
     enabled?: boolean; // default true; permite condicional sem mudar ordem de hooks
   }
   export function useRealtimeChannel(opts: UseRealtimeChannelOpts): { status: RealtimeStatus };
   ```
2. Implementação:
   - `useEffect` que cria `supabase.channel(opts.name)`, registra `.on(...)` conforme `postgresChanges` ou `broadcast`, chama `.subscribe((s) => setStatus(...))`
   - Cleanup: `supabase.removeChannel(channel)` no return do useEffect
   - `enabled: false` → não subscreve; status fica `closed`
3. Lint custom (best-effort): adicionar regra; se inviável esta wave, backlog
4. Tests: mock `createBrowserClient` retornando objeto com `.channel().on().subscribe()` espionável; verificar (a) cleanup chama `removeChannel`, (b) `enabled: false` não chama `subscribe`, (c) status muda corretamente

#### Acceptance Criteria

```gherkin
Given um componente monta useRealtimeChannel({ name: 'test', postgresChanges: {...}, onChange })
When o channel.subscribe callback dispara 'SUBSCRIBED'
Then o hook retorna { status: 'subscribed' }
```

```gherkin
Given o componente desmonta
When o useEffect cleanup roda
Then supabase.removeChannel(channel) é chamado exatamente 1x
And o canal não permanece em supabase._channels
```

```gherkin
Given enabled: false
When o componente monta
Then channel não é criado
And status é 'closed'
```

```gherkin
Given subscribe retorna 'CHANNEL_ERROR'
When 30s se passam
Then status permanece 'channel_error'
And consumer pode renderizar banner (responsabilidade do consumer; aqui só expomos status)
```

```gherkin
Given onChange é uma referência que muda em cada render
When o componente re-renderiza N vezes
Then o channel NÃO é re-criado (use ref interno pra evitar dep instável)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Cleanup chama removeChannel | Vitest, inspeciona spy |
| t2 | unit | enabled:false não subscribe | idem |
| t3 | unit | status reflete callback do .subscribe | idem |
| t4 | unit | onChange ref não causa re-subscribe | re-render N vezes, assert subscribe chamado 1x |
| t5 | typecheck | Generics ok | n/a no MVP — payload é unknown |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_hook
    id: "hook.useRealtimeChannel"
    file: "hooks/realtime/useRealtimeChannel.ts"
    signature: "(opts: UseRealtimeChannelOpts) => { status: RealtimeStatus }"
    cleanup: "obrigatório via useEffect return → supabase.removeChannel"
    statuses: ["connecting", "subscribed", "channel_error", "timed_out", "closed"]
    convention: "Lint barra supabase.channel(...) direto fora de hooks/realtime/. Toda subscription usa este primitivo."
```

#### Decisões a registrar

- **`onChange` via ref interno** pra evitar re-subscribe a cada render (consumer-side ergonomics)
- **`enabled` flag** segue convenção TanStack Query — permite gate sem mudar ordem de hooks
- **Status `connecting` é initial** antes do callback do subscribe disparar

#### Definition of Done

- [ ] ACs passam
- [ ] Coverage ≥80% do hook
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] Commit `feat(EPIC-00): useRealtimeChannel primitive [wave 4]`
- [ ] Contracts registrados
- [ ] Regression S-00.01..S-00.03 passa

---

### S-00.05 — Toast (sonner) global + ApiErrorToast

**Points**: 3 | **Priority**: P0 | **Deps**: S-00.03 | **FR refs**: Spec 09 §8 (completo), Design System 06 "Toast (Sonner)"

#### Contexto

Sonner já está instalado (vide Design System 06). Esta wave (a) garante `<Toaster />` montado globalmente com configuração canônica (top-right, durações por tipo conforme Design System), (b) cria `components/feedback/ApiErrorToast.tsx` com `showApiError(err)` que mapeia `error.code` → toast variant + copy PT-BR conforme Spec 09 §8.

Toda mutation não-otimista vai chamar `showApiError` em `onError`. Mutations otimistas têm tratamento custom (vide Spec 09 §7).

#### Files to create

- `components/feedback/ApiErrorToast.tsx` — `showApiError(err: unknown)` + `useApiErrorHandler()` hook
- `components/feedback/ApiErrorToast.test.tsx` — Vitest

#### Files to modify

- `app/layout.tsx` — adicionar `<Toaster position="top-right" richColors />` (sonner) abaixo de `<Providers>`
- `lib/api/types.ts` — sem mudança (já criado em S-00.03)

#### Implementation steps (sequential)

1. Confirmar sonner instalado (`components/ui/sonner.tsx` deve existir per Design System 06)
2. Em `app/layout.tsx`, montar `<Toaster position="top-right" richColors duration={4000} />`. Configurar `closeButton`. Atalho keyboard de close (Esc) já é nativo do Radix Dismissable.
3. Criar `components/feedback/ApiErrorToast.tsx`:
   - Mapa `COPY: Record<string, { variant: 'error'|'warning'|'info'; msg: string }>` cobrindo ≥10 codes da matriz Spec 09 §8: `body_malformed`, `cursor_malformed`, `auth_required`, `forbidden_role`, `lgpd_anonymization_irreversible`, `tenant_not_found`, `resource_not_found`, `idempotency_conflict`, `conversation_already_claimed`, `validation_error`, `rate_limited`, `internal_error`
   - Função `showApiError(err: unknown)`: se `err instanceof ApiError`, lookup em COPY, fallback `toast.error(err.message, { description: 'ID: ${err.requestId}' })`. Se err não é ApiError, `toast.error('Erro inesperado. Tente novamente.')`
   - Hook `useApiErrorHandler(): (err: unknown) => void` retornando `showApiError` (signature compatível com `onError` do TanStack Mutation)
3. Tests: render `<Toaster />` em test setup, chamar `showApiError(new ApiError(401, 'auth_required', ...))`, assertar toast aparece com texto correto. Repetir pra ≥3 codes diferentes + fallback.

#### Acceptance Criteria

```gherkin
Given <Toaster /> montado em layout raiz
When uma mutation chama showApiError(new ApiError(409, 'conversation_already_claimed', ...))
Then um toast aparece no top-right
And com texto "Outro atendente já assumiu."
And com description contendo "ID: <requestId>"
And cor variant error
```

```gherkin
Given showApiError recebe um Error genérico (não ApiError)
When chamado
Then toast.error é chamado com "Erro inesperado. Tente novamente."
```

```gherkin
Given showApiError recebe ApiError com code não mapeado
When chamado
Then fallback toast.error com err.message + description requestId
```

```gherkin
Given duração default 4s
When toast aparece
Then desaparece após 4000ms (success/info) ou 6000ms (error per Design System 06)
```

```gherkin
Given useApiErrorHandler()
When uso o retorno em useMutation({ onError: useApiErrorHandler() })
Then typecheck passa
And erros de mutation viram toast automaticamente
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Map cobre ≥10 codes | snapshot `Object.keys(COPY).length >= 10` |
| t2 | unit | ApiError mapeado vira toast correto | RTL + sonner test |
| t3 | unit | Fallback pra ApiError code desconhecido | idem |
| t4 | unit | Fallback pra error genérico | idem |
| t5 | ui | Toaster montado em raiz | Playwright: trigger toast via console, locator `[data-sonner-toaster]` |
| t6 | a11y | Toast tem role="status" ou similar | snapshot do DOM |

#### Architecture contracts emitted

```yaml
exposes:
  - type: lib
    id: "lib.toast"
    description: "<Toaster /> sonner montado em app/layout.tsx, top-right"
  - type: lib
    id: "ui.ApiErrorToast"
    file: "components/feedback/ApiErrorToast.tsx"
    api:
      showApiError: "(err: unknown) => void"
      useApiErrorHandler: "() => (err: unknown) => void"
    coverage: "≥10 codes da matriz Spec 09 §8; fallback genérico pra unknown"
```

#### Decisões a registrar

- **Position top-right** (Design System 06)
- **Duração 4s default, 6s pra error** (Design System 06)
- **`richColors`** habilitado pra usar palette semantic do app via CSS vars sonner

#### Definition of Done

- [ ] ACs passam
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] `pnpm test:unit` verde
- [ ] Commit `feat(EPIC-00): toast global + ApiErrorToast helper [wave 5]`
- [ ] Contracts registrados
- [ ] Regression S-00.01..S-00.04 passa

---

### S-00.06 — `<ThemeToggle>` + atalho `Cmd+Shift+L`

**Points**: 2 | **Priority**: P0 | **Deps**: S-00.02 (icons) | **FR refs**: Design System 06, Spec 09 §13 Tier 0 (`useTheme`)

#### Contexto

Theme provider (next-themes ou equivalente) já existe no projeto (assumption confirmada em pre-flight). Esta wave (a) cria `<ThemeToggle>` usando ícones Phosphor `Sun`/`Moon`/`MonitorPlay`, (b) adiciona atalho `Cmd+Shift+L` (Ctrl+Shift+L em non-Mac) que cicla `light → dark → system → light`. `react-hotkeys-hook` (ADR-06) é usado pro atalho.

Pre-flight check: se theme provider NÃO existe, esta story bloqueia até alguém criar — não improvisar provider novo aqui (escopo fora).

#### Files to create

- `components/theme/theme-toggle.tsx` — componente cliente
- `components/theme/theme-toggle.test.tsx` — RTL test

#### Files to modify

- `package.json` — adicionar `react-hotkeys-hook` se ausente (ADR-06; provavelmente já)
- (nenhum layout muda nesta wave — o ThemeToggle será embedado em `<TopBar>` em EPIC-01; aqui só criamos o componente standalone testável)

#### Implementation steps (sequential)

1. Pre-flight: confirmar `useTheme` (next-themes) disponível. Se não, halt e avisar Rafael.
2. `pnpm add react-hotkeys-hook` se ausente
3. Criar `components/theme/theme-toggle.tsx`:
   ```tsx
   'use client';
   import { useTheme } from 'next-themes';
   import { useHotkeys } from 'react-hotkeys-hook';
   import { Sun, Moon, MonitorPlay } from '@/lib/ui/icons';
   import { Button } from '@/components/ui/button';
   
   export function ThemeToggle() {
     const { theme, setTheme } = useTheme();
     const cycle = () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light');
     useHotkeys('mod+shift+l', cycle, { preventDefault: true });
     const Icon = theme === 'dark' ? Moon : theme === 'system' ? MonitorPlay : Sun;
     return (
       <Button variant="ghost" size="icon" onClick={cycle} aria-label={`Tema: ${theme}. Cmd+Shift+L pra alternar.`}>
         <Icon size={16} aria-hidden />
       </Button>
     );
   }
   ```
4. Test: render, click cicla, atalho dispara cycle (simular keypress via `userEvent.keyboard('{Meta>}{Shift>}l{/Shift}{/Meta}')`)
5. Documentar em comment: "Atalho `Cmd+Shift+L` (Mac) / `Ctrl+Shift+L` (Linux/Win) — react-hotkeys-hook trata `mod` automaticamente"

#### Acceptance Criteria

```gherkin
Given theme atual é 'light'
When clico no botão
Then theme passa pra 'dark'
And ícone muda pra Moon
And HTML root tem class 'dark'
```

```gherkin
Given theme atual é 'dark'
When pressiono Cmd+Shift+L (Mac) ou Ctrl+Shift+L (outros)
Then theme passa pra 'system'
And ícone muda pra MonitorPlay
```

```gherkin
Given theme atual é 'system'
When clico de novo
Then theme passa pra 'light'
And o ciclo é fechado
```

```gherkin
Given o botão renderiza
When inspeciono aria-label
Then contém "Cmd+Shift+L" (descobribilidade do atalho)
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Click cicla theme | RTL + next-themes test wrapper |
| t2 | unit | Atalho dispara cycle | userEvent.keyboard |
| t3 | ui | HTML class muda em prod | Playwright: navega à página com toggle, click, assert document.documentElement.className contém 'dark' |
| t4 | a11y | aria-label informa atalho | snapshot |

#### Architecture contracts emitted

```yaml
exposes:
  - type: react_component
    id: "ui.ThemeToggle"
    file: "components/theme/theme-toggle.tsx"
    props: "() — sem props; consome useTheme do provider raiz"
    keyboard: "Cmd/Ctrl + Shift + L cicla light → dark → system"
```

#### Decisões a registrar

- **Ciclo é light→dark→system** (não light↔dark binário) — usuário pode preferir matchar OS
- **Atalho `Cmd+Shift+L`** — não conflita com atalhos comuns (Cmd+L é address bar no browser; +Shift evita)

#### Definition of Done

- [ ] ACs passam
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] Commit `feat(EPIC-00): theme toggle component + Cmd+Shift+L [wave 6]`
- [ ] Contracts registrados
- [ ] Regression passa

---

### S-00.07 — Test infra: Playwright + Vitest + smoke + unit

**Points**: 3 | **Priority**: P0 | **Deps**: S-00.01..S-00.06 | **FR refs**: CLAUDE.md "Testes", Definition of Done

#### Contexto

Sem test runner configurado, epics seguintes não têm como provar ACs. Esta wave configura **ambos**: Playwright pra E2E (smoke `/` 200) e Vitest pra unit (`cn()` de `lib/utils.ts`). Coverage threshold opcional nesta wave; configurar em EPIC-12.

#### Files to create

- `playwright.config.ts` — config base (baseURL `http://localhost:3001`, projects: `chromium`)
- `tests/e2e/smoke.spec.ts` — smoke `visit /, expect status 200, no console errors`
- `vitest.config.ts` — config base (env: jsdom pra hooks; node pra lib pure)
- `tests/setup/vitest.setup.ts` — setup global (jest-dom matchers se usar)
- `lib/utils.test.ts` — unit test `cn()` (cobre 4 casos: strings, conditional, arrays, undefined)

#### Files to modify

- `package.json` — scripts `test:e2e`, `test:unit`, `test:unit:watch`. Devdeps: `@playwright/test`, `vitest`, `@vitest/coverage-v8`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`
- `.gitignore` — `playwright-report/`, `test-results/`, `coverage/`
- `tsconfig.json` — incluir `tests/**/*.ts` no `include`

#### Implementation steps (sequential)

1. `pnpm add -D @playwright/test vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`
2. `pnpm exec playwright install chromium` (idempotente)
3. Criar `playwright.config.ts`:
   ```ts
   import { defineConfig } from '@playwright/test';
   export default defineConfig({
     testDir: './tests/e2e',
     timeout: 30_000,
     use: { baseURL: 'http://localhost:3001', trace: 'on-first-retry' },
     webServer: { command: 'pnpm dev', url: 'http://localhost:3001', reuseExistingServer: true, timeout: 120_000 },
     projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
   });
   ```
4. Criar `tests/e2e/smoke.spec.ts`:
   ```ts
   import { test, expect } from '@playwright/test';
   test('home returns 200 and no console errors', async ({ page }) => {
     const errors: string[] = [];
     page.on('pageerror', (e) => errors.push(e.message));
     page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
     const res = await page.goto('/');
     expect(res?.status()).toBe(200);
     expect(errors).toEqual([]);
   });
   ```
5. Criar `vitest.config.ts`:
   ```ts
   import { defineConfig } from 'vitest/config';
   import path from 'node:path';
   export default defineConfig({
     test: {
       environment: 'jsdom',
       setupFiles: ['./tests/setup/vitest.setup.ts'],
       globals: true,
       coverage: { provider: 'v8', reporter: ['text', 'html'] },
     },
     resolve: { alias: { '@': path.resolve(__dirname, '.') } },
   });
   ```
6. Criar `tests/setup/vitest.setup.ts` com `import '@testing-library/jest-dom/vitest';`
7. Criar `lib/utils.test.ts` cobrindo `cn()` (existe em `lib/utils.ts` por shadcn): ≥4 cases
8. Atualizar `package.json` scripts:
   ```json
   "test:e2e": "playwright test",
   "test:unit": "vitest run",
   "test:unit:watch": "vitest"
   ```
9. Rodar `pnpm test:unit` e `pnpm test:e2e` — ambos verdes

#### Acceptance Criteria

```gherkin
Given config Playwright + dev server rodando
When rodo `pnpm test:e2e`
Then smoke test passa
And exit code 0
```

```gherkin
Given config Vitest
When rodo `pnpm test:unit`
Then unit test de cn() passa
And exit code 0
```

```gherkin
Given smoke test
When o servidor responde 500 em /
Then o teste falha com mensagem clara
```

```gherkin
Given um console.error é disparado em /
When o smoke test roda
Then o teste falha (zero tolerância pra console errors em smoke)
```

```gherkin
Given coverage v8 configurado
When rodo `pnpm test:unit -- --coverage`
Then um report HTML é gerado em coverage/
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | infra | `pnpm test:e2e` exit 0 | CI step |
| t2 | infra | `pnpm test:unit` exit 0 | CI step |
| t3 | infra | Playwright instala chromium | `pnpm exec playwright install --with-deps chromium` |
| t4 | infra | Vitest resolve alias `@/...` | unit test importa `@/lib/utils` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: infra
    id: "infra.test-runner"
    e2e:
      runner: "Playwright"
      config: "playwright.config.ts"
      script: "pnpm test:e2e"
      baseURL: "http://localhost:3001"
    unit:
      runner: "Vitest"
      config: "vitest.config.ts"
      script: "pnpm test:unit"
      env: "jsdom"
      setup: "tests/setup/vitest.setup.ts"
      alias: "@/* → repo root"
    convention: "E2E em tests/e2e/. Unit colocado próximo do código (foo.ts + foo.test.ts)."
```

#### Decisões a registrar

- **Unit tests co-localizados** (`foo.ts` + `foo.test.ts` no mesmo dir) — facilita refactor + visibilidade. E2E em `tests/e2e/` separado.
- **Smoke test com zero tolerância pra console errors** — qualquer warn/error em prod vira regression
- **`reuseExistingServer: true`** no Playwright — desenvolvedor não precisa restart manual

#### Definition of Done

- [ ] ACs passam
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] `pnpm test:unit` verde
- [ ] `pnpm test:e2e` verde
- [ ] Commit `feat(EPIC-00): playwright + vitest infra + smoke + unit [wave 7]`
- [ ] Contracts registrados
- [ ] Regression S-00.01..S-00.06 passa (re-run smoke + cn unit)

---

### S-00.08 — Zod schemas registry + `validateRequest<T>`

**Points**: 2 | **Priority**: P0 | **Deps**: S-00.03 (ApiError) | **FR refs**: Spec 09 §5 (Type Safety Boundary), §12 ADR-03, CLAUDE.md "Validação"

#### Contexto

ADR-03 lockou: **Zod no boundary de TODA API route**. Esta wave estabelece a convenção:
- 1 arquivo por entidade em `lib/schemas/<entity>.ts`
- `lib/schemas/index.ts` re-exporta tudo
- `validateRequest<T>(schema, request)` helper que faz `schema.safeParse(await request.json())` e lança `ApiError(422, 'validation_error', { fieldErrors })` em falha — usado em todo `route.ts`

Schemas concretos por entidade vão ser adicionados nos epics seguintes (leads, conversations, etc.). Aqui só estabelecemos o registry + helper + 1 schema exemplo (`pingSchema` pra healthcheck) pra exercitar a infra.

#### Files to create

- `lib/schemas/index.ts` — re-export central
- `lib/schemas/_validate.ts` — `validateRequest<T>(schema, request): Promise<T>` + `validateBody<T>(schema, body)`
- `lib/schemas/_validate.test.ts` — Vitest
- `lib/schemas/health.ts` — schema exemplo (`pingSchema = z.object({ ping: z.literal('pong') })`)

#### Files to modify

- `package.json` — `zod` deve já existir (se não, `pnpm add zod`)
- (não modifica route.ts existentes — refactor pra usar `validateRequest` é responsabilidade dos epics que ownam cada route)

#### Implementation steps (sequential)

1. Confirmar `zod` instalado
2. Criar `lib/schemas/_validate.ts`:
   ```ts
   import type { ZodSchema, ZodError } from 'zod';
   import { ApiError } from '@/lib/api/types';
   
   function toFieldErrors(err: ZodError): Record<string, string[]> {
     return err.flatten().fieldErrors as Record<string, string[]>;
   }
   
   export async function validateRequest<T>(schema: ZodSchema<T>, request: Request): Promise<T> {
     let body: unknown;
     try { body = await request.json(); } catch {
       throw new ApiError(400, 'body_malformed', undefined, crypto.randomUUID(), 'Body must be valid JSON');
     }
     const parsed = schema.safeParse(body);
     if (!parsed.success) {
       throw new ApiError(422, 'validation_error', { fieldErrors: toFieldErrors(parsed.error) }, crypto.randomUUID(), 'Validation failed');
     }
     return parsed.data;
   }
   
   export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
     const parsed = schema.safeParse(body);
     if (!parsed.success) {
       throw new ApiError(422, 'validation_error', { fieldErrors: toFieldErrors(parsed.error) }, crypto.randomUUID(), 'Validation failed');
     }
     return parsed.data;
   }
   ```
3. Criar `lib/schemas/health.ts` com `pingSchema`
4. Criar `lib/schemas/index.ts` re-exportando `validateRequest`, `validateBody`, e `pingSchema`. Comentar convenção:
   ```ts
   /**
    * Schemas registry. Add new entities as `lib/schemas/<entity>.ts` and re-export here.
    * ADR-03: Zod no boundary de TODA API route (Spec 09 §12).
    * Convention:
    *   import { createLeadSchema, validateRequest } from '@/lib/schemas';
    *   const input = await validateRequest(createLeadSchema, req);
    */
   export * from './_validate';
   export * from './health';
   ```
5. Tests: Vitest cobrindo (a) body válido retorna parsed, (b) body inválido lança ApiError(422, 'validation_error', { fieldErrors }), (c) body não-JSON lança ApiError(400, 'body_malformed'), (d) request_id presente em ambos errors

#### Acceptance Criteria

```gherkin
Given pingSchema = z.object({ ping: z.literal('pong') })
When request body é { ping: 'pong' }
Then validateRequest retorna { ping: 'pong' }
```

```gherkin
Given request body é { ping: 'wrong' }
When validateRequest é chamado
Then lança ApiError
And status === 422
And code === 'validation_error'
And details.fieldErrors.ping inclui mensagem zod
```

```gherkin
Given request body é a string "not json"
When validateRequest é chamado
Then lança ApiError(400, 'body_malformed', ...)
```

```gherkin
Given lib/schemas/index.ts
When grep por exports
Then validateRequest, validateBody, pingSchema estão listados
```

```gherkin
Given uma futura route handler usa validateRequest
When passa request com body inválido
Then ApiError propaga e (em conjunto com wrapper de error global) vira jsonError(422, 'validation_error', details) — confirmação dessa propagação fica em EPIC-01 ou no primeiro consumidor
```

#### QA test cases

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | unit | Body válido retorna parsed | Vitest |
| t2 | unit | Body inválido lança ApiError 422 com fieldErrors | Vitest |
| t3 | unit | Body não-JSON lança ApiError 400 body_malformed | Vitest |
| t4 | unit | request_id em todos os errors | inspeciona ApiError.requestId |
| t5 | typecheck | Generic infere type de schema | `validateRequest(z.object({a: z.string()}), req)` retorna `Promise<{a: string}>` |

#### Architecture contracts emitted

```yaml
exposes:
  - type: lib
    id: "lib.schemas.registry"
    file: "lib/schemas/index.ts"
    convention: "1 arquivo por entidade em lib/schemas/<entity>.ts; re-export central"
  - type: lib
    id: "lib.schemas.validateRequest"
    file: "lib/schemas/_validate.ts"
    api:
      validateRequest: "<T>(schema: ZodSchema<T>, request: Request) => Promise<T>"
      validateBody: "<T>(schema: ZodSchema<T>, body: unknown) => T"
    behavior:
      invalid_json: "throws ApiError(400, 'body_malformed')"
      validation_failure: "throws ApiError(422, 'validation_error', { fieldErrors })"
```

#### Decisões a registrar

- **`fieldErrors` shape via `error.flatten().fieldErrors`** — formato canônico que ApiErrorToast já mapeia em §8 (`details.fieldErrors`)
- **Schemas co-localizados em `lib/schemas/<entity>.ts`** (não dentro de cada route) — permite reuso entre `route.ts`, hooks (TanStack), e forms (`react-hook-form` via ADR-08)
- **`validateRequest` faz `await request.json()` internamente** — chamadores não duplicam parse

#### Definition of Done

- [ ] ACs passam
- [ ] Coverage de `_validate.ts` 100%
- [ ] `pnpm typecheck` zerado
- [ ] `pnpm lint` zerado
- [ ] `pnpm test:unit` verde
- [ ] Commit `feat(EPIC-00): zod schemas registry + validateRequest helper [wave 8]`
- [ ] Contracts registrados
- [ ] Regression S-00.01..S-00.07 passa
- [ ] State file `.epic-executor/EPIC-00-foundation-state.yaml` marca epic como `complete`

---

## 6. Regression Suite Cumulativo (esperado ao final)

Ao terminar EPIC-00, a regression suite deve cobrir:

| Categoria | # de tests | Origem |
|---|---|---|
| E2E smoke | 1 | S-00.07 (`/` 200 + zero console errors) |
| Unit — utils | 1 | S-00.07 (`cn()`) |
| Unit — http client | 9 | S-00.03 (idempotency, request-id, retry 429/503, no-retry 500, ApiError, schema parse, timeout, generics) |
| Unit — useRealtimeChannel | 4 | S-00.04 (cleanup, enabled, status, ref-stability) |
| Unit — ApiErrorToast | 6 | S-00.05 (map, fallbacks, hook, render) |
| Unit — ThemeToggle | 4 | S-00.06 (click cycle, hotkey, aria, prod class) |
| Unit — validateRequest | 5 | S-00.08 (valid, invalid, body_malformed, request_id, generics) |
| Unit — icons re-export | 1 | S-00.02 (count + named exports) |
| Unit — query client defaults | 1 | S-00.01 |
| **Total** | **32** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| Theme provider não existe ainda no repo | Alta (S-00.06 bloqueia) | Pre-flight check na S-00.06; halt+escalate ao Rafael se ausente. Não improvisar provider novo |
| `crypto.randomUUID()` não disponível em runtime edge antigo | Baixa | Next 15 + Node 20 cobre; se algum runtime edge falhar, fallback `uuid` package em PR emergencial |
| Dev server em :3001 (não :3000 default Next) | Baixa | Playwright config aponta pra 3001; documentado em CLAUDE.md "Como rodar local" |
| Lint custom (`no-restricted-imports` pra phosphor; `no-restricted-syntax` pra supabase.channel) pode atrasar wave | Média | Best-effort. Se inviável, criar issue de follow-up; não bloquear wave |
| Sonner pode estar com versão desatualizada | Baixa | Confirmar versão; upgrade se quebrar API `richColors`/`closeButton` |
| Schemas `_validate.ts` usa `crypto.randomUUID()` em request_id mock — em produção request_id real vem do header injetado pelo middleware (futuro EPIC-01) | Baixa | Aceito por agora; refactor em EPIC-01 quando middleware injeta header `x-request-id` na request |

## 8. Decisões arquiteturais novas que este epic introduz

- **ADR-12 reforçado**: `crypto.randomUUID()` (nativo Node 20+) substitui pacote `uuid` no `apiClient`. Zero dep adicional.
- **Convenção schemas**: 1 arquivo por entidade em `lib/schemas/<entity>.ts`, re-export em `lib/schemas/index.ts`. Lock pra futuros epics — não permitir schemas inline em route.ts.
- **Convenção tests**: unit tests co-localizados (`foo.ts` + `foo.test.ts`); E2E em `tests/e2e/`. Lock pra futuros epics.
- **Convenção icons**: imports só de `@/lib/ui/icons`. Lint barra direto. Lock pra futuros epics.
- **Convenção realtime**: subscriptions só via `useRealtimeChannel` em `hooks/realtime/`. Lock pra futuros epics (ADR-11 reforçado).

## 9. Anexos

- Specs refs: 09 §4 (HTTP client), §5 (Type Safety), §6 (Realtime), §8 (Error→UI), §12 (ADR-01..12), §13 Tier 0
- Design System refs: 06 (Toast section), 06 (icons usage)
- CLAUDE.md refs: "Convenções críticas", "Testes", "Definition of Done"
- Reconciliation log: n/a (epic 0 introduz convenções, não reconcilia)
- Master Plan refs: §6 "Após EPIC-00" (lista de contracts esperados — esta spec implementa todos)

---

## ✅ Wave Completion Log

Concluído em 2026-04-28 (sessão 1).

| Wave | Story | Commit |
|------|-------|--------|
| 1 | S-00.01 TanStack Query provider | `9682515` |
| 2 | S-00.02 Phosphor icons (Tray as Inbox) | `4730f6d` + `e5d9be6` |
| 3 | S-00.03 HTTP client wrapper | `fdda8fe` |
| 4 | S-00.04 useRealtimeChannel | `076fe24` |
| 5 | S-00.05 Toast + ApiErrorToast | `567ec67` |
| 6 | S-00.06 ThemeToggle + Cmd+Shift+L | `79703a1` |
| 7 | S-00.07 Playwright + Vitest infra | `7590568` |
| 8 | S-00.08 Schemas registry + validateRequest | `da9db6c` |

22 unit tests + 1 e2e smoke. Pre-existing typecheck errors fixed (`80f3eaf`).
Phosphor v2 não exporta `Inbox` → aliased pra `Tray` em `lib/ui/icons.ts`.
