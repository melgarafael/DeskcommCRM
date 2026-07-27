# Waves 1 e 2 — DevVivo · 2026-07-24

> Wave 1 (CORE 1 — a IA é dona do negócio) abaixo; **Wave 2 (o slot) no fim do arquivo.**

# Wave 1 — CORE 1: a IA é dona do negócio · 2026-07-24 · implementação concluída

> Bloco do **@DevVivo** para o `HANDOFF-crm-vivo.md` (quem escreve o handoff oficial é o
> orquestrador — §10). Prova visual oficial dos cenários 1-4: **@QAVivo**.

## O que entrou

**Schema (os 3 artefatos, obrigatórios juntos)**
- `supabase/migrations/20260725000000_0070_crm_lead_owner_kind.sql` — `crm_leads.owner_kind ('user'|'ai')` + `owner_agent_id uuid references ai_agents(id) on delete set null`, no padrão da 0032: backfill **antes** da constraint, CHECK `crm_leads_owner_kind_coherence` em forma de implicação (drop+add, re-aplicável), índice parcial `idx_crm_leads_owner_agent`.
- `supabase/baseline.sql` — apêndice idempotente `-- ---- crm_leads owner_kind/owner_agent_id (migration 0070) ----`.
- `supabase/migrations/MANIFEST.md` — linha da 0070. Numeração conferida com `git ls-tree` em **todas** as branches (0068/0069 tomados por `feat/harness-*`).
- `fn_emit_event_on_lead_change()` re-assentada (`create or replace`, corpo da 0043 + ramo do agente): `lead.assigned` passa a disparar quando `owner_agent_id` muda, com `from_agent_id`/`to_agent_id`/`owner_kind`.

**Código**
- `lib/types/leads.ts` — `OwnerKind` + `owner_kind`/`owner_agent_id` no `Lead`.
- `lib/database.types.ts` — colunas em Row/Insert/Update + FK `crm_leads_owner_agent_id_fkey → ai_agents`.
- `lib/schemas/leads.ts` — `owner_agent_id` no `updateLeadSchema`. **`owner_kind` não é aceito do cliente.**
- `app/api/v1/leads/_handler.ts` — `updateLeadHandler` deriva `owner_kind`, zera o outro dono (exclusividade), 422 se vierem os dois, e valida que o agente é **da mesma org** (a FK garante existência, não tenancy).
- `app/api/v1/ai/agents/assignable/route.ts` *(nova)* — agentes atribuíveis, role `agent`+, RLS-scoped. Devolve `is_active` e a **versão publicada resolvida na leitura**.
- `hooks/kanban/useAssignableAgents.ts` *(nova)*.
- `lib/kanban/owner.ts` + `owner.test.ts` *(novas)* — `resolveLeadOwner()`, função pura e única de "quem é o dono".
- `components/kanban/OwnerBadge.tsx` + teste — agente = círculo vazado com anel, iniciais em mono, **mesmo 24px e mesmo peso** do humano; rótulo/tooltip `Nome · vN`.
- `KanbanCard` / `StageColumn` / `KanbanBoard` — passam o dono resolvido.
- `KanbanCardActions` — transferir humano↔agente; submenu só para quem pode escrever (`usePermission("pipeline.move_card")`).
- `lib/kanban/filters.ts` + `FilterBar` — `LeadFilters.ownerUserId` → `owner`, aceitando `agent:<uuid>`; agentes na **mesma** lista dos humanos; "Sem responsável" agora exige ausência dos **dois** donos.

## Checklist sistema-vivo (as 7 respostas)

1. **Quem me alimenta:** `PATCH /api/v1/leads/[id]` (cookie de sessão; org do JWT, nunca do body) e, nas próximas waves, o próprio agente ao assumir o negócio. O nome/versão do dono vem de `ai_agents`/`ai_agent_versions` por join na leitura.
2. **Quem eu alimento:** `event_log` (`lead.assigned` com `to_agent_id`), o board (`GET /api/v1/pipelines/[id]/board`), o filtro de responsável e o índice parcial que serve às métricas por agente. Wave 3 pendura a timeline nesse mesmo evento.
3. **Log que emito:** `event_log` via trigger + `api_audit_log` via `audit({action:"lead.updated"})` com `fields`.
4. **Onde apareço na tela:** no card (avatar + nome + tooltip `Nome · vN`), no seletor "Responsável" e no menu de transferência. Provado em screenshot.
5. **Anti-morte:** o dono agente é o que permite a Wave 5 cobrar próxima ação de um negócio que nenhum humano está olhando — hoje, um lead de bot fica sem dono e ninguém é cobrado. Nesta wave o mecanismo ainda é o do humano (o lead nunca fica sem `owner_kind` coerente; a constraint impede estado ambíguo).
6. **Continuidade IA↔humano:** transferir agente→humano e humano→agente pelo mesmo menu, com o evento `lead.assigned` carregando **de quem para quem** — o próximo dono sabe que houve troca. O resumo contextual (o que o agente já sabia) entra na Wave 3, quando a timeline existir.
7. **Mapa vivo:** *não aplicável nesta base* — `docs/architecture/` nesta branch tem só `agent-turn.workflow.json`/`.html`; o mapa do sistema (`deskcomm-system.architecture.json`) **não existe em `origin/main`**, é arquivo ainda não commitado da branch `feat/operacao-visivel`. Não há o que re-renderizar aqui. Quando os dois se encontrarem, as peças a acrescentar estão listadas abaixo.

## Verificação visual (prova do @DevVivo; a oficial é do @QAVivo)

Instância própria do Playwright (o browser MCP estava com o QA), dev server da entrega na **3020**, login real como `e2e-manager`, tudo pela UI.

| # | Cenário | Resultado | Evidência |
|---|---|---|---|
| A | Atribuir lead a agente pelo menu do card | Card passa de "Sem responsável" para `LA · Lia — AgendaPlus` | `wave-1-devvivo-dono-agente.png`, `wave-1-devvivo-card-agente.png` |
| B | Agente é par do humano | avatar **24×24px** (igual ao humano), `font-family: IBM Plex Mono`, `background: rgba(0,0,0,0)` (vazado), `border 1px` + ring; sem emoji, sem badge "AI" | medido por `getComputedStyle`, não a olho |
| C | Tooltip nome · versão | `Lia — AgendaPlus · v24` (versão **publicada hoje**, resolvida por join) | log da prova |
| D | Transferência de volta | Volta a "Sem responsável" e persiste | `wave-1-devvivo-revertido.png` |
| E | Board inteiro | Humanos (`EM`, `EA` preenchidos) e agentes (`LA`, `BE` vazados) lado a lado | `wave-1-devvivo-dono-agente.png` |

Screenshots em `/private/tmp/claude-501/-Users-rafaelmelgaco-DeskcommCRM/9579c957-fb23-4342-9df1-c208137c2c03/scratchpad/` (não escrevi em `evidence/`, que é do QA — copiar para lá se quiser referenciar no handoff oficial).

Qualidade: `pnpm typecheck` **0**, `pnpm lint` **0 errors** (151 warnings pré-existentes do repo), `npm run test:unit` **807/807** (113 arquivos), incluindo 16 testes novos/atualizados de `OwnerBadge` e `resolveLeadOwner`. Exit codes lidos **sem** `| tail`.

## Bugs encontrados

| Sintoma | Causa raiz | Correção | Re-testado |
|---|---|---|---|
| Card com dono agente aparecia como `?` + rótulo genérico "Agente" (lead do Caio Ribeiro) | A rota `assignable` filtrava `is_active=true`. Ela serve a **dois** propósitos que eu tratei como um: lista de *destinos* (picker) e dicionário de *resolução de nome* (exibição) | **1ª tentativa (minha, substituída):** relaxar o filtro da rota `assignable` e devolver `is_active`. **Correção final (decisão do orquestrador):** ver abaixo | Sim — mas a 1ª correção foi revertida |

### Correção definitiva — o dado de exibição viaja com o lead

**Registro antes de mexer.** O orquestrador achou o mesmo sintoma de forma independente e vetou a
minha correção com razão: relaxar o filtro do `assignable` conserta o sintoma **no lugar errado** —
a rota é um *picker*, e os filtros dela estão certos. Minha versão ainda deixava o agente
**arquivado** anônimo (eu tinha registrado isso como débito aceito; ele não aceitou, e está certo:
"peça que perde a identidade do dono é peça que morre sem ninguém ver").

Decisão implementada:
- `GET /api/v1/pipelines/[id]/board` passa a devolver, para cada lead com dono agente, o **nome e a
  versão publicada** — join server-side em `ai_agents`/`ai_agent_versions` **sem** filtro de
  `is_active`/`archived_at`, com `organization_id` filtrado explicitamente (da org do pipeline
  validado por RLS, nunca do body).
- `GET /api/v1/ai/agents/assignable` **volta ao estado de picker**: `is_active = true` e
  `archived_at is null`. O campo `is_active` sai do payload e os filtros locais na UI saem junto.
- `resolveLeadOwner` deixa de depender de um mapa de agentes: lê o dono direto do lead. A cadeia
  `KanbanBoard → StageColumn` perde a prop `agentsById`.
- Fixture de regressão preservada: o lead de agente **inativo** do seed fica como está (não mexi no
  seed) e o teste `lead de agente inativo continua exibindo nome` fixa o comportamento.

### Gaps de propagação — três escritores de dono fora da regra (achado do orquestrador)

**Registro antes de mexer.** O PATCH estava certo, mas ele não era o único a escrever dono:

| # | Escritor | Defeito | Efeito |
|---|---|---|---|
| 1 | `createLeadHandler` (`_handler.ts`) | INSERT grava `owner_user_id` e não grava `owner_kind`/`owner_agent_id` | Lead nasce **com dono e sem `owner_kind`** — o CHECK aceita (3º ramo), então é **drift silencioso**: filtro e métricas por `owner_kind` não enxergam o lead |
| 2 | `bulk` `case "assign"` | patch só com `owner_user_id` + `assigned_at` | (a) atribuir humano em massa a lead de dono agente → **23514 derruba o lote inteiro**; (b) sem dono anterior → mesmo drift do gap 1, em lote |
| 3 | MCP (`lib/mcp/tools/leads.ts`) | `crm_create_lead` herda o gap 1 | **A IA corrompendo o próprio registro de posse** — é a superfície pela qual o agente mexe no CRM |

Correção: **um helper puro compartilhado**, `resolveOwnerPatch()` em `lib/leads/owner-patch.ts`, que
devolve sempre o trio coerente `{owner_user_id, owner_agent_id, owner_kind}` ou recusa "dois donos".
Create, patch, bulk e MCP passam por ele. Guarda na função compartilhada, não em cada chamador — é o
único que cobre o escritor que ainda não foi escrito.

Verificado na leitura: `crm_update_lead` (MCP) **não** monta patch próprio, chama o
`updateLeadHandler` — então herda a regra de graça. O gap real do MCP era só o create.

**Prova dos gaps corrigidos**

| Caminho | Como provei | Resultado |
|---|---|---|
| create com dono humano | `POST /api/v1/leads` com a sessão do usuário logado (a UI **não** expõe responsável no "Novo Lead" — não há tela para isto) | 201, `owner_kind='user'` (antes: `null` = drift) |
| create com dono agente | idem | 201, `owner_kind='ai'`, humano zerado |
| create com os dois donos | idem | **422** com mensagem explicável (não 500 do banco) |
| create sem dono | idem | 201, trio todo `null` |
| **bulk assign sobre lead de dono AGENTE** | **pela UI**: criei um lead próprio, atribuí ao agente pelo menu, selecionei e usei "Atribuir a… → Eu" | Card foi de `LA · Lia — AgendaPlus` para `EM · E2E Manager`, **zero erro na tela** (antes: 23514 derrubava o lote) |
| estado no banco após o bulk | `psql` no lead da prova | `owner_kind='user'`, humano preenchido, **agente zerado**, `assigned_at` setado |
| constraint + helper contra Postgres real | `pnpm test:db` (container efêmero, baseline aplicado) | `tests/invariants/lead-owner-kind.test.ts` — 6 casos, incluindo os 3 estados que o banco **recusa** |

Os leads de prova foram apagados ao final (board de volta a 11 leads); nenhuma fixture do QA foi tocada.

`pnpm test:db` também revalidou o **apêndice do baseline**: `install` (banco novo, `ON_ERROR_STOP=1`)
e `update` (re-aplicação) verdes — o gate do item 7 da doutrina de migrations.

## O que ficou para trás (e por quê)

- **Mapa vivo não atualizado porque não existe nesta branch** (só `agent-turn.workflow.json`). Quando o `deskcomm-system.architecture.json` chegar aqui, precisam entrar com grau ≥2: `resolveLeadOwner` (board → resolve → card), a rota `ai/agents/assignable` (UI → rota → `ai_agents`/`ai_agent_versions`) e a aresta `crm_leads → ai_agents` via `owner_agent_id`.
- **E2E de regressão (`kanban-owner-filter`, `rbac-roles`, `risk-radar`) não rodados por mim** — exigem `next build` + `next start` em porta própria e o QA está com o ambiente. Risco concentrado no `kanban-owner-filter` (renomeei `LeadFilters.ownerUserId → owner`; o **param de URL `?owner=` não mudou**).
- **`createLeadSchema` não ganhou `owner_agent_id`** — criar um lead já nascendo de um agente não está no contrato da wave; hoje se cria e depois se atribui.
- **Tooltip é `title` nativo**, não o `Tooltip` do design system. Motivo: não há `TooltipProvider` global e montar um por card no board é custo sem retorno agora. **Upgrade:** trocar por Radix quando o dossiê (Wave 6) já trouxer o provider.
- **Agente ARQUIVADO que ainda seja dono** cai no rótulo genérico. Mesma degradação que já existe para dono humano fora da lista de membros.
- **Seed com dono agente** é do @QAVivo (`scripts/seed-*`) — já vi cards com agente no board, então parece coberto.

## Débito / risco introduzido

- **RLS não conhece o dono agente.** `fn_can_view_lead(organization_id, owner_user_id)` trata lead de dono agente como "não atribuído" no modo `own_and_unassigned`. Ninguém perde acesso (é mais permissivo, não menos), mas quando existir política "só meus leads", lead de agente vai vazar para todo mundo desse modo. **Dói** quando a Wave 8 ligar o funil do agente ao Kanban com times grandes.
- **`lead.assigned` cresceu de payload.** Nenhum consumidor lê hoje (grepado), então é seguro — mas quem for consumir precisa tratar `to_user_id` e `to_agent_id`, nunca só o primeiro.
- **`is_active` no payload da rota assignable** é informação de configuração exposta a `agent`. É um booleano sem PII; se incomodar, dá para devolver só para manager+ e resolver nome por outro caminho.

## Decisões tomadas no caminho

- **`owner_kind` é derivado no servidor**, nunca aceito do body. Alternativa descartada: aceitar os três campos e confiar na constraint — funciona, mas transforma erro de cliente em 500 do banco em vez de 422 explicável.
- **Estendi o trigger `lead.assigned` para o agente** (além do contrato). Alternativa descartada: deixar para a Wave 3 — mas aí a coluna nasceria ilha e atribuir a um agente seria mutação silenciosa, exatamente a doença que esta entrega cura.
- **Rota nova em vez de reusar `GET /api/v1/ai/agents`** (manager+). Alternativa descartada: baixar o RBAC daquela rota — ela expõe `system_prompt`, `guardrails` e `config`; um vendedor não precisa disso para saber de quem é o card.
- **Filtro por agente reusa o param `?owner=`** com prefixo `agent:`. Alternativa descartada: um segundo seletor "Agente" na FilterBar — dois controles para a mesma pergunta ("de quem é isto?") é o começo do card inflado que a §5 proíbe.

---

# Wave 2 — o slot: card em 3 faixas, altura constante · 2026-07-24 · implementação concluída

## O que entrou

- **`lib/kanban/card-state.ts`** *(novo)* — `CardInput` (o card **não** recebe `Lead`),
  `resolveCardState()` com a precedência estrita **aguardando > esfriando > normal**, e
  `buildCardInput()`, o único lugar onde a linha do banco encosta no card. Testes em
  `card-state.test.ts` (13 casos, incluindo "nunca acumula" e a precedência do cenário 24).
- **`lib/leads/risk-radar.ts`** — `resolveStageWindow()` exportada: a janela de esfriamento
  passa a sair de `crm_stages.expected_duration_hours`, com fallback nas constantes atuais e
  a mesma razão crítico/frio (3×). `classifyRisk` aceita `window` — **um classificador só**.
- **`components/kanban/KanbanCard.tsx`** — reconstruído: 3 faixas de altura reservada, título
  em bloco fixo de 2 linhas, valor com linha própria e `—` quando null, faixa do agente
  presente mesmo vazia, rodapé com dono + tempo no estágio. Tags saem do card (ficam no
  hover); **uma** tag canônica vira ponto de 6px ao lado do título.
- **`components/kanban/OwnerBadge.tsx`** — disco do humano agora é **sólido** (`bg-accent` +
  `text-accent-foreground`): a um metro, humano é mancha escura e agente é anel claro, sem
  depender da borda. "Sem responsável" ganhou a mesma geometria (disco tracejado + rótulo),
  para o rodapé não mudar de altura conforme o lead tem dono.
- **`StageColumn` / `KanbanBoard`** — montam o `CardInput`; o board passa `coolingIds`
  (do radar) e `canonicalTags` (de `settings`).

## Checklist sistema-vivo (as 7 respostas)

1. **Quem me alimenta:** o board (`/api/v1/pipelines/[id]/board`) para lead/dono/estágio, e
   **o radar** (`/api/v1/leads/at-risk`) para "esfriando" — a mesma fonte do `/app/radar`.
2. **Quem eu alimento:** o card e, nas waves 4/5/7, os ramos de cima da precedência. A borda
   de estado é o que faz o humano olhar para um card e não para outro.
3. **Log que emito:** nenhum — é camada de apresentação. Quem registra é o handler por trás
   de cada ação (waves 3 e 4).
4. **Onde apareço na tela:** o card inteiro. Provado por medição, não a olho.
5. **Anti-morte:** o estado *esfriando* nasce ligado — um lead parado além da janela do
   estágio passa a se anunciar no board, não só no radar. Antes, morrer em silêncio era o
   comportamento padrão do Kanban.
6. **Continuidade IA↔humano:** o slot é o lugar reservado para a IA falar com o humano
   (proposta, alerta, score). Nesta wave ele nasce vazio de propósito — as waves 4/5 o
   preenchem sem mexer no layout.
7. **Mapa vivo:** não existe nesta base (ver Wave 1); as peças a acrescentar são
   `resolveCardState` e `resolveStageWindow`.

## Verificação visual — medida por ferramenta

| # | Critério | Antes | Depois |
|---|---|---|---|
| Gate | `Set(alturas).size === 1` | 116–154px (**38px** de variação) | **[144]** — `size = 1`, variação **0px** |
| axe | violações no board | `nested-interactive` + outras | **`[]` — zero violações**, `nested-interactive: 0` |
| Título 120 caracteres | quebrava o layout | crescia o card | 2 linhas fixas, 144px como os demais |
| Valor nulo | some | linha some, card encolhe | linha reservada com `—` |
| 8 tags | 3 tags + "+5" no card | empurrava o rodapé | fora do card, no hover |
| Tag canônica | — | — | ponto de 6px ao lado do título |

Screenshot: `evidence/wave-2-devvivo-board.png` (11 cards, 4 colunas).

**Como o `nested-interactive` morreu:** o handle de arraste do dnd marca o card como
`role="button"`, e o menu de ações é outro botão dentro dele. Troquei o papel do container
para `role="group"` com `aria-label` — o `tabIndex` e os handlers de teclado continuam vindo
do spread do dnd, então arrastar por teclado segue funcionando. **Sem `aria-hidden`, sem
suprimir regra.**

**Contraste:** `text-warning` puro dá 3,7:1 em 12px (reprovado). O slot esfriando usa
`text-warning-fg` — a variante de texto que o `/app/radar` já usava; a cor cheia ficou só na
borda de estado, que é gráfica. O ponto da tag ganhou `role="img"` (um `span` nu não aceita
`aria-label` — era o `aria-prohibited-attr`).

## Bugs encontrados

| Sintoma | Causa raiz | Correção | Re-testado |
|---|---|---|---|
| Board inteiro caiu em "Algo deu errado" ao abrir | Criei `hooks/kanban/useAtRiskLeads.ts` supondo que a rota devolvia array; ela devolve `{items, counts, total}` — `for...of` sobre objeto explodiu no `useMemo`. **E o hook já existia** (`hooks/leads/useAtRiskLeads.ts`, usado pelo `/app/radar`) | Apaguei o meu e passei a consumir o que já existia | Sim, board volta com 11 cards |
| `aria-prohibited-attr` (3 nós) | `aria-label` em `span` sem role | `role="img"` no ponto da tag | axe zerado |
| `color-contrast` (4 nós) | `text-warning` em 12px = 3,7:1 | `text-warning-fg` | axe zerado |

## O que ficou para trás (e por quê)

- **O slot nasce vazio quando não há sinal de IA.** Considerei preenchê-lo com o tempo no
  estágio, mas ⑤ já mostra isso no rodapé e duplicar violaria a Lei B. A altura fica
  reservada, que é o que o gate desta wave exige.
- **"Tempo no estágio" é medido pela última atividade**, não pela entrada no estágio —
  `crm_leads` não tem `stage_entered_at`. Vira exato quando a Wave 3 registrar a mudança de
  estágio como atividade.
- **`resolveStageWindow` ainda não está ligada ao endpoint `/api/v1/leads/at-risk`** (ele usa
  a janela global). Está exportada e integrada ao `classifyRisk`; plugar no endpoint é a
  reconciliação da Wave 7.
- **Densidade "Compacta" não existe no board** — o controle vive no `/app/design`
  (playground de tokens). Não inventei um toggle novo; se o cenário 6 exige o board em modo
  compacto, é feature nova e precisa de decisão.
- **Movimento (pulso, crossfade) não entrou** — é da Wave 3, quando houver evento chegando.

## Débito / risco introduzido

- **Uma chamada a mais no board** (`/api/v1/leads/at-risk`, cache 60s, compartilhada com o
  radar via mesma queryKey). Se o board ficar pesado num tenant grande, o caminho é o
  endpoint aceitar `pipeline_id` em vez de filtrar no cliente.
- **`role="group"` no card** depende de o dnd continuar entregando `tabIndex` pelo spread. Se
  uma atualização do `@hello-pangea/dnd` mudar isso, o card perde foco por teclado — o teste
  de acessibilidade da wave pega, desde que continue rodando.

## Decisões tomadas no caminho

- **O board não reclassifica esfriamento**: consome o radar. Alternativa descartada: chamar
  `classifyRisk` no cliente — teria dado um segundo classificador (rejeição automática de
  review pelo §3.3) e ignoraria o `in_flight`, marcando como abandonado quem já tem
  follow-up agendado.
- **`em_voo` não vira alerta no card.** Se a IA prometeu voltar, não há decisão pendente para
  o humano; alertar ali seria ruído com cara de urgência.
- **`CardInput` em vez de `Lead`**: o card responde quatro perguntas, e receber a linha
  inteira do banco é o convite para a quinta.
