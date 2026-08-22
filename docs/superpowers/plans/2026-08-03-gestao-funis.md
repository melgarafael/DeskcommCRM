# Gestão de Funis — plano de implementação

> Spec: `docs/superpowers/specs/2026-08-03-gestao-funis-design.md`.
> Execução **inline** nesta sessão (TDD, commit por tarefa). Branch `feat/gestao-funis`,
> worktree `~/SonghaiCRM-funis`, base `origin/main@5a8f4a7`.

**Goal:** dar ao usuário criar, renomear, reordenar, eleger padrão e arquivar funis
pela tela do Kanban — e fazer essa tela mostrar só a organização ativa.

**Arquitetura:** núcleo puro testado → rotas REST manager+ com audit → hooks de
mutação → UI. Simetria com a gestão de etapas, reusando `slugDeNome`, a chave de
nome que dobra acento e o `midpoint` do fractional indexing. Sem migration.

**Stack:** Next.js 16 App Router · Zod · Supabase (RLS) · TanStack Query · Vitest · Playwright.

## Global Constraints

- `organization_id` vem **sempre** do JWT (`requireRole`), nunca do body.
- Toda rota de mutação: `requireRole("manager")` + Zod + `audit()` + releitura do banco.
- Recusa em português citando o **nome** do funil; texto de Postgres só em `details`.
- Nenhuma migration: `position`, `is_archived`, `is_default`, `description` já existem.
- Nenhuma rota de leitura nova (o `GET` existente é manager+; a tela lê via Server Component).
- Sem `console.log`. `pnpm typecheck` e `pnpm lint` zerados antes de cada commit.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/pipelines/pipeline-editing.ts` **(criar)** | as regras, sem banco: nome, arquivamento, exclusão, troca de padrão, etapas iniciais |
| `lib/pipelines/pipeline-editing.test.ts` **(criar)** | unit do núcleo puro |
| `lib/leads/stage-editing.ts` **(modificar)** | `slugDeNome` ganha raiz de fallback parametrizável |
| `app/api/v1/pipelines/_funis.ts` **(criar)** | leitura compartilhada pelas 3 rotas + tradução de conflito do banco |
| `app/api/v1/pipelines/route.ts` **(modificar)** | ganha `POST` |
| `app/api/v1/pipelines/[id]/route.ts` **(criar)** | `PATCH` e `DELETE` |
| `lib/audit/actions.ts` **(modificar)** | 4 ações novas |
| `hooks/pipelines/usePipelines.ts` **(criar)** | mutações + `router.refresh()` |
| `app/app/kanban/page.tsx` **(modificar)** | escopo por org ativa + papel |
| `app/app/kanban/_client.tsx` **(criar)** | a lista gerenciável |
| `tests/e2e/pipelines-gestao.spec.ts` **(criar)** | jornada pela tela |

---

### Task 1 — Núcleo puro das regras

**Files:** criar `lib/pipelines/pipeline-editing.ts` + `.test.ts`; modificar `lib/leads/stage-editing.ts`.

**Produces** (o que as tarefas seguintes consomem):

```ts
export interface FunilEditavel {
  id: string; name: string; slug: string;
  position: number; is_default: boolean; is_archived: boolean;
}
/** O que amarra o funil ao resto do sistema, contado ANTES de arquivar/excluir. */
export interface DependenciasDoFunil {
  negocios: number;          // crm_leads apontando para o funil
  fontesDeWebhook: string[]; // nomes das webhook_sources com este destino padrão
  regrasAtivas: string[];    // nomes das automation_rules ativas que movem card para cá
}
export type Resultado = { ok: true } | { ok: false; erro: string };

export function validarNomeDeFunil(nome: string, funis: FunilEditavel[], funilId: string | null): Resultado;
export function validarArquivamento(funis: FunilEditavel[], funilId: string, deps: DependenciasDoFunil): Resultado;
export function podeExcluirDeVez(funis: FunilEditavel[], funilId: string, deps: DependenciasDoFunil): Resultado;

export interface UpdateDePadrao { pipelineId: string; patch: { is_default: boolean } }
/** Libera o padrão anterior ANTES de marcar o novo (índice único imediato). */
export function updatesDePadrao(funis: FunilEditavel[], novoId: string): UpdateDePadrao[];

/** Regras cujo `actions[].config.pipeline_id` cita o funil — o jsonb não tem FK. */
export interface RegraDeAutomacao { name: string; is_active: boolean; actions: unknown }
export function regrasQueApontamPara(regras: RegraDeAutomacao[], pipelineId: string): string[];

/** Um funil sem etapa é quadro morto; sem etapa de ganho, `/win` responde 422. */
export const ETAPAS_INICIAIS: ReadonlyArray<{ name: string; slug: string; is_won: boolean; is_lost: boolean }>;
```

Em `stage-editing.ts`, `slugDeNome` passa a aceitar a raiz de fallback:
`slugDeNome(nome, slugsExistentes = [], raizPadrao = "etapa")` — retrocompatível,
e evita que um funil chamado "🎉" vire o slug `etapa`.

- [ ] **1.1** Escrever `pipeline-editing.test.ts` cobrindo: nome duplicado dobrando acento
      ("Pos venda" ≡ "Pós-venda"); renomear para o próprio nome é aceito; recusa do último
      funil ativo; recusa do funil padrão; recusa por fonte de webhook (nomeando-a); recusa
      por regra ativa (nomeando-a); regra **inativa** não barra; arquivar com negócios é
      permitido; `podeExcluirDeVez` só com tudo zerado; `updatesDePadrao` emite a liberação
      antes da marcação; `regrasQueApontamPara` ignora action de outro tipo e jsonb malformado.
- [ ] **1.2** Rodar: `pnpm vitest run lib/pipelines` → FALHA (módulo não existe).
- [ ] **1.3** Implementar `pipeline-editing.ts` e o parâmetro novo de `slugDeNome`.
- [ ] **1.4** Rodar de novo → PASSA. Rodar `pnpm vitest run lib/leads` (não regrediu).
- [ ] **1.5** `pnpm typecheck && pnpm lint` → zerados. Commit.

---

### Task 2 — Rotas REST

**Files:** criar `app/api/v1/pipelines/_funis.ts` e `app/api/v1/pipelines/[id]/route.ts`;
modificar `app/api/v1/pipelines/route.ts` e `lib/audit/actions.ts`;
criar `app/api/v1/pipelines/route.test.ts` e `app/api/v1/pipelines/[id]/route.test.ts`.

**Consumes:** tudo de Task 1.
**Produces:** os 3 endpoints do spec.

`_funis.ts` expõe:
```ts
lerFunis(supabase, orgId): Promise<FunilEditavel[]>           // inclui arquivados (slug é único global)
lerDependencias(supabase, orgId, pipelineId): Promise<DependenciasDoFunil>
corpo(funis): { pipelines: Array<{id,name,slug,description,position,is_default}> }  // só ativos
conflitoDoBanco(erro, nomeDoFunil, requestId)                // 23505/23514 → 409 em português
```

`lib/audit/actions.ts` ganha `"pipeline.created" | "pipeline.updated" | "pipeline.archived" | "pipeline.deleted"`.

- [ ] **2.1** Testes das rotas no padrão dos vizinhos (`stages/route.test.ts`): 403 sem
      manager; 422 nas recusas do núcleo; 201 no POST com as 4 etapas criadas; **compensação**
      (falha no insert de etapas → funil apagado, resposta de erro); PATCH de `depois_de`
      recalcula `position`; PATCH de `is_default` libera o anterior primeiro; DELETE arquiva;
      `?definitivo=1` só passa com dependências zeradas; audit emitido em cada caso.
- [ ] **2.2** Rodar → FALHA.
- [ ] **2.3** Implementar `_funis.ts`, `POST`, `PATCH`, `DELETE` e as ações de audit.
- [ ] **2.4** Rodar → PASSA.
- [ ] **2.5** `pnpm typecheck && pnpm lint`. Commit.

---

### Task 3 — A tela

**Files:** modificar `app/app/kanban/page.tsx`; criar `app/app/kanban/_client.tsx` e
`hooks/pipelines/usePipelines.ts`.

**Consumes:** os endpoints de Task 2.

`page.tsx`: `requireAuth` + `resolveActiveOrg` (redirect `/app` sem org), filtro
`.eq("organization_id", activeOrg.orgId)`, e `podeGerenciar = is_platform_admin ||
ROLE_RANK[role] >= ROLE_RANK.manager` passado ao client.

`_client.tsx`: lista com setas ↑↓ (`vizinhoAoMover` na direção: subir = `funis[i-2]?.id ?? null`),
renome inline, menu com "tornar padrão" e "arquivar", diálogo de confirmação que mostra a
recusa explicada, e estado vazio com botão que cria o primeiro funil. `data-testid` em tudo
que o e2e dirige. Controles de escrita só quando `podeGerenciar`.

- [ ] **3.1** Reescrever `page.tsx` com escopo por org + papel.
- [ ] **3.2** Criar o hook (mutations com `router.refresh()` no `onSettled`).
- [ ] **3.3** Criar `_client.tsx`.
- [ ] **3.4** `pnpm typecheck && pnpm lint`. Commit.

---

### Task 4 — Prova pela tela (DoD 12)

**Files:** criar `tests/e2e/pipelines-gestao.spec.ts`.

Ambiente fresco estilo VPS: `baseline.sql` + `bootstrap-owner.ts`, `next build && next start`
(nunca `next dev`), worktree com `node_modules` real.

- [ ] **4.1** Spec: login → `/app/kanban` → **a lista mostra só a org ativa** (o bug do print)
      → criar "Clínica" → abrir o board e ver as 4 colunas → renomear → subir/descer →
      tornar padrão → arquivar (some da lista) → tentar arquivar o último (recusa explicada).
- [ ] **4.2** Rodar o e2e. Screenshots em `.superpowers/evidence/`.
- [ ] **4.3** Commit com a evidência.

---

### Task 5 — Fechamento

- [ ] **5.1** Mapa vivo: `docs/architecture/deskcomm-system.architecture.json` ganha a peça
      com ≥2 arestas (tela → rotas → `crm_pipelines`).
- [ ] **5.2** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:db` — os quatro
      verdes, sem `| tail` (mascara exit code).
- [ ] **5.3** Atualizar `docs/testing/user-journey-map.md` com a jornada nova.
- [ ] **5.4** Commit final e relatório ao Rafael.

## Self-review do plano

- **Cobertura do spec:** criar (T2/T3) · renomear (T2/T3) · reordenar (T2/T3) · padrão
  (T1/T2/T3) · arquivar (T1/T2/T3) · excluir definitivo (T1/T2) · escopo por org (T3/T4) ·
  4 etapas iniciais (T1/T2) · compensação (T2) · audit (T2) · Living System (T5). Sem lacuna.
- **Tipos:** `FunilEditavel`, `DependenciasDoFunil`, `Resultado`, `UpdateDePadrao` e
  `ETAPAS_INICIAIS` são definidos em T1 e citados com o mesmo nome em T2/T3.
- **Sem placeholder:** todo passo nomeia arquivo e comando reais.
