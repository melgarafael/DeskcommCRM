---
type: current-state
project: SonghaiCRM
status: draft
last_updated: 2026-08-30
generated_by: auditoria documental (Claude Code) — leitura de código, HANDOFFs, plan/, loop/, CI
confidence: média-alta (métricas de código são CONFIRMADO; estado de épico vem dos HANDOFFs, que são auto-relatados)
audited_against: main @ 87ea9f8 (2026-08-30) — checkout raso, ver §8
---

# Estado atual — SonghaiCRM

> # ⚠️ ESTE DOCUMENTO É UM RETRATO, NÃO O ESTADO DE HOJE
>
> **Ele descreve `main` no commit `87ea9f8` (2026-08-30).** Os números, contagens e
> vereditos abaixo conferem **contra aquele commit** — não contra o que está na `main`
> agora. O retrato anterior (contra `789dfa6`, 2026-07-29) ficou 1.014 commits atrasado em
> menos de 3 semanas; não há razão para esperar que este envelheça mais devagar.
>
> **Nada aqui é mantido.** É deliberado, e é a alternativa honesta: um retrato datado nunca
> mente, enquanto um documento atualizado uma vez volta a mentir na semana seguinte — e sem
> aviso, porque a atualização recente faz o leitor confiar mais.
>
> **Antes de agir sobre qualquer linha, remeça.** Os comandos usados para gerar cada número
> estão descritos nas seções abaixo — reproduza-os antes de citar.

Este documento existe porque "o que está pronto" estava espalhado em HANDOFFs na raiz,
`docs/handoffs/`, `plan/progress.md`, `loop/checkpoints/`, `tasks/todo.md` e o roadmap do
README — sem lugar único. Um agente novo (ou o dono, depois de uma semana) não conseguia
responder "posso subir isso?" sem ler ~1500 linhas.

**Aviso de método:** o estado de épico abaixo vem em boa parte dos HANDOFFs, que são
*auto-relatados pelas sessões que fizeram o trabalho*. Métricas de código, contagem de
arquivos, conteúdo de CI e presença de doutrina no repo **foram** verificados diretamente
nesta rodada (leitura de código, grep, `git show --stat`, `gh api`). Nenhuma suíte de teste
foi executada — é auditoria estática, não prova de que os testes passam hoje.

**Nota factual (2026-09-04):** a integração Nuvemshop foi removida (código, env vars,
docs dedicados). Onde este retrato ainda cita Nuvemshop como algo presente ou planejado,
está desatualizado nesse ponto específico — confira `git log --grep=nuvemshop -i` antes de
citar qualquer linha sobre e-commerce.

---

## 0. Achado estrutural que a auditoria anterior não podia ver

**Existe uma branch local não mergeada com trabalho substancial: `feat/evolution-api-channel`**
(20 commits, diverge de `main` em `4592b8f`, HEAD em `4c17636`, 19/ago). Os commits de `main`
que mencionam "Evolution API" (`4592b8f`, `c19995b`) são só planejamento — mas na branch
separada há **implementação completa e não integrada**: `ChannelAdapter` inteiro, parser de
webhook, ingestão com testes, cliente REST, seletor de provider na UI, migration de schema.
Confirmado que não está em `main`: `lib/evolution/` não existe na árvore de `main`, e
`ChannelProvider` em `main` só lista `waha`, `meta_cloud`, `zernio`.

**Colisão de numeração de migration entre as duas branches**: `main` usa `0161` para
`moeda_padrao_mzn` (timestamp `20260821120000`) e `0162` para `pagamentos_paysuite`
(`20260822090000`); `feat/evolution-api-channel` também usa `0161` (timestamp
`20260818120000`) para `evolution_channel`. Um merge direto exige renumerar — dois arquivos
`0161` em disco com timestamps diferentes é uma colisão garantida assim que as branches se
encontrarem, e a doutrina de migrations exige número sequencial único.

**`origin/main` (fork `mutambe/DeskcommCRM`) está 6 commits atrás do HEAD local** — branding
Songhai, PaySuite, MZN e catálogo CSV ainda não foram empurrados para o fork remoto no
momento da auditoria.

---

## 1. Números do repositório — CONFIRMADO

| Métrica | Valor medido agora (87ea9f8) | Valor de 29/jul (789dfa6) |
|---|---|---|
| Arquivos TS/TSX em `app`+`lib`+`components`+`workers` | 1.322 | 987 |
| Route handlers (`app/api/**/route.ts`) | 207 | 169 |
| Migrations em `supabase/migrations/` | 153 arquivos (até `0162_pagamentos_paysuite`; mais um `0161` só na branch `feat/evolution-api-channel`, não mergeado) | 81 (até 0092) |
| Testes unitários (arquivos `*.test.ts(x)`, fora de `tests/invariants/`) | 438 | 221 |
| Invariantes de banco (`tests/invariants/*.test.ts`) | 107 | 56 |
| Specs E2E (`tests/e2e/*.spec.ts` em disco / invocadas pelo `e2e.yml`) | 49 em disco / 48 invocadas | 19 |
| Documentos `.md` em `docs/` | 171 | 119 |
| `console.log` fora de `lib/logger.ts` | 2 (não confirmado se são código real ou comentário/string — ver §6) | 0 |
| `: any` / `as any` | 13 | 7 |
| `node_modules` deste checkout | 69 pacotes, **inclui `typescript`** (a auditoria anterior registrava ausência) | 70 pacotes, sem typescript |

**Divergência de versão, nova nesta rodada:** `package.json` declara `"version": "0.1.0"`,
mas `CHANGELOG.md` já documenta `[1.3.0] — 2026-08-13` como release lançado, e não há
nenhuma tag git (`git tag -l` vazio) para arbitrar qual é a verdade. Quem automatizar release
a partir de `package.json` vai publicar o número errado.

---

## 2. O que está entregue

### CONFIRMADO por código + migration + teste

- **Moeda padrão MZN** — `supabase/migrations/20260821120000_0161_moeda_padrao_mzn.sql`:
  `crm_leads.currency` DEFAULT `'MZN'`, `lib/money.ts` migrado
  (`formatCentsBRL`→`formatCentsMZN`), call sites trocados. Sem backfill de linhas
  existentes — decisão DIRC correta (não duplica estado que a coluna já resolve).
- **PaySuite (M-Pesa, e-Mola, cartão)** —
  `supabase/migrations/20260822090000_0162_pagamentos_paysuite.sql`: 2 tabelas novas
  (`payment_credentials` com RLS zero-policy + revoke total; `payments` com policy de SELECT
  escopada), rotas reais (`app/api/v1/integrations/paysuite/route.ts`,
  `app/api/v1/webhooks/payments/paysuite/[token]/route.ts`,
  `app/api/v1/leads/[id]/charge/route.ts`), UI em `app/app/integrations/paysuite/`, porta na
  navegação (`lib/navigation/registry.ts:377`), testes de rota e de client. Doutrina de
  RLS/revoke e idempotência (nosso lado + lado do provedor) seguida.
- **Catálogo de produtos via CSV** — `lib/ai/rag/ingest/catalog-csv.ts` (8 casos de teste),
  reaproveita o pipeline de FAQ existente (chunking/embedding/indexação), **sem migration
  nova** — decisão DIRC correta.
- **Rebranding Songhai/Moçambique** — commit único (`659e294`), >200 arquivos, identidade
  legal + contato + base legal LGPD trocada para Lei n.º 3/2017; identificadores técnicos
  (nome de pacote npm, paths de skill) preservados.
- **Rate limit de autenticação — melhorou de verdade desde 29/jul.** `lib/auth/rate-limit.ts`
  (não existia na auditoria anterior) agora protege `signUp`, `signInWithPassword`,
  `requestPasswordReset` e `team/accept-invite/[token]` — os 4 pontos mais citados como
  abertos no item 4.3 do retrato anterior. Ainda não cobre `/api/internal/*`, `/api/mcp`,
  crons, e não foi confirmado exaustivamente para webhooks WAHA.
- **`.env.example` reconciliado com `lib/env.ts`** — diff de conjuntos deu vazio (toda
  variável do schema Zod tem par no template). Variáveis extra no template sem par em
  `env.ts` (`META_*`, `ZERNIO_*`) são as envs dos adapters `meta_cloud`/`zernio`, lidas fora
  do Zod central — mesmo padrão já registrado antes para `FLYWHEEL_*`/`WATCHDOG_*`, não é
  resíduo.
- **`docs/architecture/`** cresceu de 1 diagrama para 13 arquivos — mapa vivo bem mais
  robusto do que o retrato anterior registrava (lá, item "não pôde ser confirmado").
- **Doutrina viva confirmada como real, não só citada**: `docs/doctrine/packaging.md`,
  `docs/doctrine/sistema-vivo.md`, `tests/invariants/hardening-definer-varredura.test.ts` e
  o script `test:shell` existem de fato no repo.
- **`imagens-ok` publica 3 imagens reais** (`deskcommcrm`, `deskcomm-worker`,
  `deskcomm-scheduler`) — a correção do bug crítico "worker nunca atualizava" (item 4.0 do
  retrato anterior) continua de pé.

### INFERIDO (HANDOFFs — não re-verificado por execução)

A maioria dos HANDOFFs na raiz e em `docs/handoffs/` tem a última entrada de conteúdo real
em **~21–24 de julho**, apesar de um mês de trabalho real ter passado no repositório (a
única edição posterior foi o rebrand trocando strings de texto, não progresso). Duas
leituras possíveis, não distinguidas nesta auditoria: (a) os épicos fecharam e o rastro
passou a viver só em commits/migrations sem handoff dedicado — é o que sugerem PaySuite/MZN/
catálogo, que chegaram sem HANDOFF próprio —, ou (b) os épicos pendentes simplesmente
pararam há um mês.

- **Casos Humanos**: `docs/handoffs/HANDOFF-casos-humanos.md` — W0–W6 `[x]`, **W7 (prova E2E
  do loop completo) ainda `[ ]`**, mesmo estado do retrato anterior.
- **Inbox multimodal**: `docs/handoffs/HANDOFF-inbox-multimodal.md` para no que parece Onda
  3.1 + fixes de composer (23/jul), sem seção formal de "ondas 4-6". `lib/agent-engine/agent/
  media-parts.ts` existe e é citado como provado em produção — a funcionalidade central
  parece estar de pé independente do handoff estar parado.
- **Follow-up**: `HANDOFF.md` (raiz) para na "Onda 4" (22/jul), mas o README já lista
  "Follow-up vivo" inteiro como entregue, e existem sucessores
  (`HANDOFF-followup-vivo.md`, `HANDOFF-fv-w1-fila.md`) com trabalho posterior (migration
  0145, dedup de enrollment). O `HANDOFF.md` original está obsoleto e foi sucedido — sintoma
  do próprio problema que este documento existe para mitigar, agora dentro do mecanismo de
  handoff em si.

O README (`README.md:434-439`) **não menciona PaySuite, MZN, catálogo CSV nem Evolution
API** em "Entregue" ou "Próximo" — os 4 marcos mais recentes do repositório não estão
refletidos no documento que a doutrina trata como fonte de roadmap público.

---

## 3. O que está incompleto — por épico

| Épico | Estado apurado agora | Delta vs. 29/jul |
|---|---|---|
| **Evolution API (4º canal WhatsApp)** | Implementação completa em `feat/evolution-api-channel` (20 commits), **não mergeada** | Épico novo — nasceu e avançou bastante, mas parado num branch, invisível olhando só `main` |
| **Follow-up inteligente** | HANDOFF principal parado em 22/jul; sucessores (`HANDOFF-followup-vivo.md` etc.) mostram trabalho posterior; README já promete pronto | Avançou, mas o rastro de "1 handoff por feature" fragmentou |
| **Casos Humanos** | W7 (prova E2E) segue `[ ]` | Sem mudança |
| **Inbox multimodal** | Sem atualização de handoff desde 23/jul; núcleo (`media-parts.ts`) parece em produção | Estagnado ou absorvido silenciosamente — não dá para afirmar sem mais investigação |
| **PaySuite / MZN / Catálogo CSV** | Entregues e reais (migration+teste+UI onde aplicável) | Novo desde 29/jul |
| **Rebranding Songhai** | Entregue | Novo desde 29/jul |
| **Fase FG / Vendaval** | Sem sinal em commits recentes nem no README | Continua fora de escopo |

---

## 4. O que está quebrado ou frágil — CONFIRMADO

1. **Colisão de numeração de migration `0161`** entre `main` e `feat/evolution-api-channel`
   (detalhe em §0) — vai quebrar um merge ingênuo; precisa renumerar um dos dois lados antes
   de integrar.
2. **`package.json` (`0.1.0`) diverge do `CHANGELOG.md` (`1.3.0` lançado)**, sem tag git para
   arbitrar.
3. **`origin/main` (fork `mutambe/DeskcommCRM`, que é o `origin` deste checkout) não tem
   branch protection configurada** — `gh api repos/mutambe/DeskcommCRM/branches/main/
   protection` devolveu `404` com mensagem explícita de ausência. Os 5 checks obrigatórios
   que a doutrina descreve (`verify, build-and-size, invariants, e2e, imagens-ok`) só
   valeriam, se valessem, no repo upstream `melgarafael/DeskcommCRM`.
4. **Branch protection do upstream continua não confirmável** — `gh api repos/
   melgarafael/DeskcommCRM/branches/main/protection` devolve `404 Not Found` puro, resposta
   que o GitHub usa tanto para "não existe" quanto para "token sem permissão de leitura em
   repo de terceiro". Motivo mais preciso do que a rodada anterior registrou (lá, suspeitava-
   se erro de owner; aqui, confirmado que é limitação do token atual, que só enxerga o
   próprio fork).
5. **`console.log` fora do logger: 2 ocorrências** — não confirmado se são chamadas reais ou
   comentário/string; não tratar como violação da doutrina até reler os 2 pontos.
6. **HANDOFFs na raiz desatualizados há ~1 mês de conteúdo real** — o mecanismo de handoff
   vivo, que a doutrina do repo prescreve, parece ter parado de ser seguido à risca nas
   frentes mais antigas.

### Itens de 29/jul reconferidos

| Item | Estado agora |
|---|---|
| Worker sem `image:` (bug crítico, então já corrigido) | Continua resolvido — 3 imagens publicadas, `imagens-ok` existe |
| E2E fora do CI | Mesmo estado relatado: 48/49 specs invocadas, `vps-fresh-onboarding` continua fora |
| `gov:verify` não cobre `test:db`/`test:e2e` | Confirmado, sem mudança |
| Rate limit quase inexistente | Melhorou de forma real: de 2 para 5 arquivos cobertos, incluindo login/signup/reset/convite; ainda falta `/api/mcp`, `/api/internal/*`, crons |
| `node_modules` incompleto | Parece resolvido (`typescript` presente) — não confirmado por execução de `pnpm typecheck` |
| `.env.example` incompleto | Resolvido — reconciliado com `lib/env.ts` |
| `ARCHITECTURE.md` com afirmações falsas | Não reconferido nesta rodada |
| Sem gitleaks/husky | Confirmado, sem mudança — `.husky`/`.pre-commit-config.yaml` continuam ausentes |
| HANDOFF citando migration antiga quando repo já avançou | Mesmo padrão, em escala maior: repo tem 153 migrations agora, HANDOFFs antigos citam números de 3 dígitos baixos |

---

## 5. Riscos técnicos abertos

1. **123 dos 207 handlers usam `createAdminClient`** (59%, proporção quase idêntica aos 53%
   de 29/jul). Sem enforcement automático na escrita — só revisão humana + os 107 arquivos
   de invariante.
2. **`lib/agent-engine/agent/inbound-turn.ts` cresceu de 1.789 para 2.638 linhas** (+47%),
   ampliando a distância para o segundo maior arquivo de lógica (`AgentForm.tsx`, 960 linhas
   — também cresceu). Continua o hot path do produto.
3. **Nenhum `vercel.json` neste repo** — risco de cron dormente na Vercel citado antes
   continua idêntico; a superfície cresceu (16 rotas em `app/api/v1/cron/`).
4. **Migration `0161` duplicada entre branches** (novo, §0) — decisão de merge pendente.
5. **Divergência de versão declarada vs. changelog** (item 4.2 acima).
6. **Fallback in-memory do rate limit** (`lib/ai/dispatcher/rate-limit.ts`) — não reconferido
   nesta rodada; se o comportamento não mudou, o risco de 29/jul persiste (sem Upstash
   configurado, limite vira por processo, silenciosamente).

---

## 6. O que não pôde ser confirmado

- Se `pnpm typecheck`/`lint`/`test:unit`/`test:db`/`test:e2e` passam hoje — nenhuma suíte foi
  executada (auditoria read-only).
- Branch protection do repositório upstream `melgarafael/DeskcommCRM` — token sem
  permissão sobre repo de terceiro.
- Se os 2 `console.log` fora do logger são violação real ou falso-positivo de grep.
- Se as 3 secrets críticas nomeadas na auditoria anterior
  (`IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY`) estão em
  `.env.example` por nome exato — confirmado só o diff agregado de conjuntos.
- Estado real de Inbox Multimodal ondas 4-6: absorvido por outro épico ou simplesmente
  parado.
- Cobertura de teste (%) — nenhum relatório de coverage foi gerado.
- Se `rate-limit.ts` cobre `/api/mcp`, `/api/internal/*`, webhooks WAHA — grep não
  exaustivo.

---

## 7. Deltas que valem destaque vs. 29/jul (`789dfa6`)

- Migrations: 81 → 153 (quase dobrou).
- Testes unit (arquivos): 221 → 438 (+98%).
- Invariantes: 56 → 107 (quase dobrou).
- E2E: 19 → 49 specs em disco, CI já invoca 48.
- Route handlers: 169 → 207 (+22%).
- Docs: 119 → 171 (+44%).
- Rate limit de autenticação: de 2 para 5 pontos cobertos, fechando a lacuna mais citada do
  retrato anterior.
- `.env.example` reconciliado com `lib/env.ts` (resolvido).
- `node_modules` aparentemente corrigido (não confirmado por execução).
- Épico novo e real, integrado: PaySuite + MZN + catálogo CSV.
- Épico novo, real, **não integrado**: Evolution API como 4º canal, parado em branch.
- `inbound-turn.ts` piorou: +47% de linhas.
- Mecanismo de HANDOFF vivo parou de ser confiável nas frentes mais antigas: a maioria não
  tem conteúdo novo desde ~24/jul apesar de um mês de trabalho real ter passado.

---

## 8. Nota de método

Este checkout é um **clone raso** (`git rev-parse --is-shallow-repository` → `true`,
histórico cortado no merge do PR #259) — não foi possível calcular a distância exata em
commits até `789dfa6`, só comparar métricas ponto-a-ponto. Qualquer auditoria futura que
precise de histórico completo deve rodar `git fetch --unshallow` antes de comparar contra um
SHA antigo, ou vai repetir o erro que a nota de método da versão anterior já descreveu
(auditar contra checkout desatualizado).

A auditoria anterior (a de 29/jul) também alertava: **este arquivo apodrece rápido.** Trate
a data do frontmatter como prazo de validade, não como enfeite — e prefira reconferir os
números com os comandos descritos acima a confiar nesta tabela.
