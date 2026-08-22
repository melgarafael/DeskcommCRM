---
epic_id: EPIC-NN-NAME
epic_name: Nome legível do epic
priority: P0 | P1 | P2
estimated_waves: N
estimated_total_points: NN
depends_on: [EPIC-MM, ...]
exposes_contracts:
  - "<contrato canônico exposto pra outros epics>"
status: pending
created_at: 2026-04-28
owner: Songhai, Lda
---

# EPIC-NN — Nome do Epic

> **Para o epic-executor**: leia este arquivo inteiro antes de qualquer wave. As stories estão em ordem de dependência. Cada story = 1 wave. Não pular ordem mesmo que pareça independente — `Deps:` é lei.

## 1. Objetivo

Em 2-3 frases, o que este epic entrega ao final. **Concreto e mensurável**.

## 2. Resultado esperado (Definition of Done do Epic)

Lista de bullets verificáveis. Ao final do epic:
- [ ] Critério 1 (ex: "Usuário consegue logar com email+senha+MFA e cair em /app/inbox")
- [ ] Critério 2
- [ ] ...

## 3. Pré-requisitos

- Epics anteriores completos: `EPIC-MM`, ...
- Migrations no Supabase: 0001-NNNN aplicadas
- Variáveis de env já configuradas: `LIST`
- Dev server rodando em `localhost:3001`
- Playwright MCP conectado pra QA

## 4. Architecture Contracts

### 4.1 Contracts consumidos (de epics anteriores)

| Contract ID | Tipo | Origem | Como usar |
|---|---|---|---|
| `auth.user-session` | session | EPIC-01 | Via `useAuth()` hook |
| `db.organizations` | db_table | (migration 0001) | RLS via `fn_user_org_ids()` |
| ... | | | |

### 4.2 Contracts expostos (consumíveis por epics futuros)

| Contract ID | Tipo | Wave que expõe | Descrição pra consumidores |
|---|---|---|---|
| `hook.useFoo` | react_hook | S-NN.03 | `useFoo(args): { data, isLoading, error }` |
| `api.POST_/api/v1/foo` | api_route | S-NN.05 | Body `{...}`, returns `Foo` |
| `realtime.foo-{org_id}` | realtime_channel | S-NN.07 | Subscribe pra mudanças em `foo` table |
| `ui.<FooComponent>` | react_component | S-NN.04 | Props `{...}` |
| `event.foo.created` | domain_event | S-NN.08 | Emitido em `event_log`, payload `{...}` |
| ... | | | |

## 5. Stories (em ordem de dependência)

> Cada story abaixo vira UMA wave do epic-executor. Wave 1 = primeira story; wave N = última. Deps internos respeitados pela ordem.

---

### S-NN.01 — Título curto da story

**Points**: 2 | **Priority**: P0 | **Deps**: (none) | **FR refs**: Spec 09 §X.Y, Sub-PRD 0M §A.B

#### Contexto
1-2 parágrafos explicando o que esta story faz e por que é o primeiro passo. Mencione decisões já lockadas relevantes (ex: "TanStack Query é cache layer canônico — ADR-01 da Spec 09").

#### Files to create
- `path/to/new-file.ts` — descrição em 1 linha
- `path/to/another.tsx` — descrição

#### Files to modify
- `existing/file.ts` — o que muda + por quê
- ...

#### Implementation steps (sequential)
1. Step 1 concreto
2. Step 2
3. ...

#### Acceptance Criteria (testáveis)

```gherkin
Given [estado inicial]
When [ação do usuário ou worker]
Then [resultado verificável]
And [outro resultado]
```

```gherkin
Given [outro contexto]
When [ação]
Then [resultado]
```

(3-7 ACs por story, todas convertíveis em Playwright/db query/inspeção visual)

#### QA test cases (pra QA gate subagent)

| ID | Tipo | Descrição | Como testar |
|---|---|---|---|
| t1 | ui | Botão de login renderiza | Playwright: navega a `/login`, verifica `getByRole("button", { name: /Entrar/ })` visível |
| t2 | api | POST `/api/v1/auth/login` com creds válidas retorna 200 + cookie | curl ou Playwright network |
| t3 | rls | Cliente A não vê dado de cliente B | DB query como user A em tabela com `organization_id` de B → conjunto vazio |
| t4 | db | Migration aplicou sem erro | `mcp__plugin_supabase_supabase__list_tables` mostra nova tabela com RLS habilitada |
| ... | | | |

#### Architecture contracts emitted

```yaml
exposes:
  - type: api_route
    id: "POST /api/v1/auth/login"
    request_schema: "{ email, password, mfa_code? }"
    response_schema: "{ data: { user, orgs } }"
    error_codes: [auth_required, mfa_required, mfa_invalid, rate_limited]
  - type: react_hook
    id: "useAuth"
    signature: "() => { user, orgs, signIn, signOut, ... }"
    file: "hooks/useAuth.ts"
```

#### Decisões a registrar
- Decisão arquitetural específica que esta story toma e que outros podem precisar (ex: "Cookie de sessão chama-se `sb-deskcomm-auth` em todos os ambientes")

#### Definition of Done
- [ ] Todos os ACs passam em Playwright
- [ ] Typecheck zero erros novos (`pnpm typecheck`)
- [ ] Lint zero erros novos (`pnpm lint`)
- [ ] Sem warnings no console do browser em dev
- [ ] Commit feito com mensagem `feat(EPIC-NN): [story-title] [wave X]`
- [ ] Architecture contracts registrados no state file
- [ ] Não introduz regressão em waves anteriores (regression suite passa)

---

### S-NN.02 — Próxima story

(repete o formato acima)

---

(... 8-15 stories total ...)

---

## 6. Regression Suite Cumulativo (esperado ao final)

Ao terminar o epic, a regression suite deve cobrir, no mínimo:

| Categoria | # de tests | Origem |
|---|---|---|
| UI rendering | NN | S-NN.01..S-NN.NN |
| API contracts | NN | idem |
| RLS isolation | NN | idem |
| Realtime updates | NN | idem |
| Optimistic UI rollback | NN | idem |
| **Total** | **NN** | |

## 7. Riscos & Mitigações específicos do epic

| Risco | Severidade | Mitigação |
|---|---|---|
| ... | ... | ... |

## 8. Decisões arquiteturais novas que este epic introduz

Lista das decisões que devem virar ADRs ou reconciliações cross-spec após o epic. Ex:
- "ADR-13: Hook naming convention `useEntityQuery`/`useEntityMutation`"

## 9. Anexos

- Screen flow refs: `docs/design-system/screen-flow/03-screen-inventory.md` rotas X, Y, Z
- Specs refs: 01 §A.B, 03 §C.D, 04 §E.F
- Business rules: T-01, AT-02, P-05
- Reconciliation log: R-01 a R-05 já aplicadas
