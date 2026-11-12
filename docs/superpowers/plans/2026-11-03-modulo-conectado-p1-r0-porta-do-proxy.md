# Fatia 1 (R0) — toda rota com token tem porta no proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nenhuma rota de `app/api/v1` aceita token no handler e fica recusada pelo proxy; as 3 rotas que
estão assim hoje passam a aceitar o token de ponta a ponta, e a Spec 33 entra no mesmo PR.

**Architecture:** uma cerca viva em `tests/unit/` varre toda `route.ts` que chama `resolveAuthDual(` e
exige entrada em `PUBLIC_PATHS` ou uma justificativa escrita numa lista. Três entradas novas, ancoradas e
com o id em forma de UUID, entram em `lib/auth/public-paths.ts`. Cada uma das 3 rotas ganha teste de
handler com token, no molde de `app/api/v1/conversations/[id]/media/route.test.ts`.

**Tech Stack:** Next.js 16 route handlers, Vitest, `lib/api/auth-dual.ts`, `lib/auth/public-paths.ts`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, seções "O que foi medido" (as 4 rotas) e "R — Converter
as rotas, por área" (linha R0 e os itens 1 a 6 de "Cada rota convertida").

## Global Constraints

- Medido em `origin/main` `fe7a11457`. Antes de começar, refazer a medição da Task 1, passo 1; se o número
  mudou, parar e avisar.
- Nada roda nesta máquina: nem teste, nem typecheck, nem lint. O veredito é o CI do fork.
- Segmento dinâmico em `PUBLIC_PATHS` é **forma de UUID**
  (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`, flag `i`), nunca `[^/]+`; toda entrada
  termina com `$`. Cada entrada nova ganha comentário dizendo quem autentica e por que o padrão é estreito,
  como as vizinhas.
- `prospecting/importar` **continua só de sessão**: recusa token por desenho (comentário na própria rota,
  linhas 29–31). Entra na lista de justificativas, não em `PUBLIC_PATHS`.
- Nenhum arquivo fora dos listados nas tasks. Nada de schema.

## Review Focus

1. **Irmão literal de carona:** `/api/v1/conversations/<uuid>/notes` (rota só de sessão) e
   `/api/v1/conversations/<uuid>/drafts` (já pública) não podem mudar de estado por causa das entradas
   novas. Coberto na Task 2.
2. **Sub-path futuro:** `/api/v1/agenda/servicos/atualizar/qualquer` deve continuar fora. Task 2.
3. **Id fora da forma de UUID:** `/api/v1/conversations/abc/drafts/consume` deve continuar fora. Task 2.
4. **Token de outra organização:** a conversa de A, pedida com o token de B, tem de responder 404 sem
   efeito, e a consulta tem de filtrar `organization_id` pelo valor da linha do token. Task 3.
5. **Acompanhamento de suporte com token:** `requireSupportWrite()` sem cookie devolve `null`
   (`lib/impersonate/support.ts:34-35`), e a escrita segue. Task 3 prova que o token não é recusado por isso.

---

### Task 1: A cerca "rota com token tem porta no proxy"

**Files:**
- Create: `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts`

**Interfaces:**
- Consumes: `isPublicPath(pathname: string): boolean` de `@/lib/auth/public-paths`.
- Produces: `SO_SESSAO_POR_DESENHO: Record<string, string>` (caminho do arquivo → motivo), exportado
  dentro do próprio teste; a fatia 2 em diante acrescenta entradas só com motivo.

- [ ] **Step 1: Medir a população antes de escrever**

Run: `git grep -l 'resolveAuthDual(' origin/main -- 'app/api/v1/**/route.ts' | wc -l`
Expected: o número de rotas com token hoje. Anotar no commit. As 4 sem porta são
`agenda/servicos/atualizar`, `conversations/[id]/drafts/consume`, `conversations/[id]/notes/media` e
`prospecting/importar`.

- [ ] **Step 2: Escrever o teste**

A varredura copia a forma de `tests/unit/rotas-bearer-aplicam-teto-de-escrita.test.ts` (mesmo `RAIZ`,
`BASE`, `readdirSync(..., { recursive: true })`, filtro por `"resolveAuthDual("`). Para cada rota, monta o
caminho trocando cada segmento `[x]` por `"00000000-0000-4000-8000-000000000000"`.

```ts
const SO_SESSAO_POR_DESENHO: Record<string, string> = {
  "app/api/v1/prospecting/importar/route.ts":
    "recusa token de propósito (403), como reanalisar_site; ver o comentário da rota",
};
```

Casos:
- `"a varredura acha as rotas (controle de vacuidade)"`: `expect(rotas.length).toBeGreaterThanOrEqual(20)`.
- `it.each(rotas fora da lista)("%s tem porta no proxy")`: `expect(isPublicPath(caminho), mensagem).toBe(true)`,
  com a mensagem dizendo "acrescente a entrada ancorada em lib/auth/public-paths.ts ou justifique em
  SO_SESSAO_POR_DESENHO".
- `it.each(entradas da lista)("%s segue só de sessão por desenho")`: a rota ainda chama `resolveAuthDual(`
  (senão: "tire da lista") **e** `isPublicPath(caminho)` é `false` (senão: "a justificativa mente").

- [ ] **Step 3: Commit (o teste fica vermelho nas 3 rotas até a Task 2)**

```bash
git add tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts
git commit -m "test(auth): rota com resolveAuthDual precisa de porta no proxy"
```

### Task 2: As 3 portas em `PUBLIC_PATHS`

**Files:**
- Modify: `lib/auth/public-paths.ts` (bloco das entradas server-to-server, logo depois de
  `/^\/api\/v1\/agenda\/servicos$/` e de `/^\/api\/v1\/conversations\/[^/]+\/media$/`)
- Modify: `app/api/v1/conversations/[id]/drafts/consume/route.ts:43-45` e
  `app/api/v1/conversations/[id]/notes/media/route.ts:59-62` (o comentário "Fora de PUBLIC_PATHS hoje"
  passa a dizer que a rota está na lista e que o teto vale)
- Test: `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts` (bloco novo de borda)

**Interfaces:**
- Consumes: a cerca da Task 1.
- Produces: três entradas, exatamente:
  `/^\/api\/v1\/agenda\/servicos\/atualizar$/`,
  `/^\/api\/v1\/conversations\/<UUID>\/drafts\/consume$/i`,
  `/^\/api\/v1\/conversations\/<UUID>\/notes\/media$/i`.

- [ ] **Step 1: Escrever o bloco de borda (vermelho)**

`describe("PUBLIC_PATHS — as portas da R0")`, no molde de `app/api/v1/contacts/[id]/avatar/route.test.ts:337-350`:
- `true`: `/api/v1/agenda/servicos/atualizar`, `/api/v1/conversations/${UUID}/drafts/consume`,
  `/api/v1/conversations/${UUID}/notes/media`.
- `false`: `/api/v1/agenda/servicos/atualizar/x`, `/api/v1/conversations/abc/drafts/consume`,
  `/api/v1/conversations/${UUID}/drafts/consume/x`, `/api/v1/conversations/${UUID}/notes`,
  `/api/v1/conversations/abc/notes/media`, `/api/v1/conversations/${UUID}/notes/media/x`.
- Sem mudança: `/api/v1/agenda/servicos` e `/api/v1/conversations/${UUID}/drafts` seguem `true`.

- [ ] **Step 2: Acrescentar as 3 entradas e atualizar os 2 comentários das rotas**

- [ ] **Step 3: Commit**

```bash
git add lib/auth/public-paths.ts "app/api/v1/conversations/[id]/drafts/consume/route.ts" "app/api/v1/conversations/[id]/notes/media/route.ts" tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts
git commit -m "fix(auth): três rotas que aceitam token deixam de ser barradas no proxy"
```

### Task 3: Cliente falso por organização e teste de handler com token nas 3 rotas

**Files:**
- Create: `tests/unit/helpers/cliente-admin-falso.ts`
- Create: `tests/unit/helpers/cliente-admin-falso.test.ts`
- Create: `app/api/v1/agenda/servicos/atualizar/route.test.ts`
- Create: `app/api/v1/conversations/[id]/drafts/consume/route.test.ts`
- Create: `app/api/v1/conversations/[id]/notes/media/route.test.ts`

**Interfaces:**
- Consumes: os mocks de `app/api/v1/conversations/[id]/media/route.test.ts:1-68` (`validateBearerToken`
  mockado por `vi.importActual`, `createAdminClient`, `checkRateLimit`, `requireSupportWrite`).
- Produces (usado pelas fatias R1, R2 e R3): `criarClienteAdminFalso`, `cadeiasForaDaOrganizacao` e
  `rpcsForaDaOrganizacao`, com os tipos exatos de "O cliente falso" em
  `2026-11-03-modulo-conectado-receita-r.md`.

- [ ] **Step 1: Escrever o teste do próprio falso**

`cliente-admin-falso.test.ts`: `select` com `eq("organization_id", A)` devolve só as linhas de A; sem o
filtro devolve `[]` e `cadeiasForaDaOrganizacao(…, A)` acusa a cadeia; `insert` sem `organization_id`
é acusado; `rpc("x", { p_org: B })` é acusado por `rpcsForaDaOrganizacao(…, A)`; método desconhecido lança
`método X não suportado pelo cliente falso`.

- [ ] **Step 2: Implementar o falso** com o comportamento da receita comum.

- [ ] **Step 3: Escrever os casos das 3 rotas, usando o falso**

- `"token com mcp:write chega ao handler"`: token da organização A → a resposta não é 401 nem 403.
- `"token de B não alcança recurso de A"`: com as linhas de A no falso e o token de B → 404 (conversa ou
  serviço não encontrado), nenhuma escrita registrada, e `cadeiasForaDaOrganizacao(cadeias, ORG_B)` e
  `rpcsForaDaOrganizacao(rpcs, ORG_B)` vazios.
- `"token sem mcp:write é recusado"`: escopo `["mcp:read"]` → 403.
- `"token viewer é recusado"`: `role: "viewer"` → 403.
- `"acima do teto do token → 429"`: `checkRateLimit` com `{ allowed: false }` → 429 e nenhuma consulta.
- `"acompanhamento de suporte não barra o token"`: `requireSupportWrite` real seria `null` sem cookie; o
  mock devolve `null` e o handler segue.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/helpers/cliente-admin-falso.ts tests/unit/helpers/cliente-admin-falso.test.ts "app/api/v1/agenda/servicos/atualizar/route.test.ts" "app/api/v1/conversations/[id]/drafts/consume/route.test.ts" "app/api/v1/conversations/[id]/notes/media/route.test.ts"
git commit -m "test(api): as três rotas da R0 com token, inclusive token de outra organização"
```

### Task 4: Spec 33, fragmento e PR

**Files:**
- Add: `docs/specs/33-spec-modulo-conectado.md` (já escrita; só entra no commit)
- Create: `.changes/tres-rotas-aceitam-token.md`

- [ ] **Step 1: Fragmento**

```markdown
---
impacto: capacidade_nova
secao: corrigido
titulo: Três rotas que já aceitavam token de integração deixam de ser recusadas antes de chegar a ela
---
Atualizar as fontes de um serviço da agenda, consumir um rascunho sugerido e anexar arquivo a uma nota
agora funcionam com o token de integração (`dsk_…`), como as rotas irmãs. Antes, a borda do sistema
recusava o token com 401, embora a rota estivesse pronta para ele. Crédito: @paulolimajr77.
```

- [ ] **Step 2: Commit e pré-voo**

```bash
git add docs/specs/33-spec-modulo-conectado.md .changes/tres-rotas-aceitam-token.md
git commit -m "docs(spec): Spec 33, módulo conectado (ADR-0005, onda O2)"
bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh
pnpm release:conferir
```
Expected: pré-voo sem bloqueador; `release:conferir` aceita o fragmento.

- [ ] **Step 3: CI do fork**

`git push fork <branch>`; PR interno `--repo paulolimajr77/ThothCRM --base base/main-do-rafael`.
Expected: `verify` verde, com os testes das Tasks 1 a 3 no `test:unit`.

- [ ] **Step 4: Sabotagem pelo CI** (branch descartável, um commit cada, previsto antes de rodar)

| Sabotagem | Previsto |
|---|---|
| tirar a entrada de `drafts/consume` de `PUBLIC_PATHS` | 2 vermelhos: a cerca na rota e o caso `true` da borda |
| trocar o UUID da entrada de `notes/media` por `[^/]+` | 1 vermelho: o caso `/api/v1/conversations/abc/notes/media` → `false` da borda |
| tirar o `.eq("organization_id", …)` da consulta em `drafts/consume` | 1 vermelho: "token de B não alcança recurso de A" dessa rota |
| tirar `prospecting/importar` da lista de justificativas | 1 vermelho: a cerca na rota |

- [ ] **Step 5: Texto do PR ao `melgarafael/DeskcommCRM`**, lido pelo Paulo antes de abrir

O que muda para quem usa; a Spec 33 dentro, com as 9 decisões e o convite a trocá-las na revisão; o que
foi medido (saída do CI, as 4 sabotagens com "N de M"); bloco **"O que NÃO medi"**: a chamada real por
token pela borda, com `proxy.ts` rodando, que nenhum teste unitário alcança; o isolamento com Postgres
real, que nestas rotas está coberto só pelo teste do filtro; assinatura `— Paulo Lima Jr`. Não cita
assistente nem cliente. O consumidor privado só entra se o Paulo autorizar (pergunta 3 da spec privada).

---

## Self-review

- **Cobertura da spec:** linha R0 (Tasks 1 e 2); itens 1, 2 e 6 de "Cada rota convertida" (Tasks 2 e 3);
  item 3 (filtro de organização) na Task 3; item 4 (teto e suporte) na Task 3; item 5
  (`…_by_user_id`): as 3 rotas gravam o ator por `actor.type === "user" ? … : null`
  (`agenda/servicos/atualizar/route.ts:27`); nas outras duas, o coder confere o mesmo padrão e, se faltar,
  para e avisa, sem consertar fora do plano.
- **Proporção:** quatro tasks, três arquivos de teste, uma mudança de produção de 3 linhas mais
  comentários.
