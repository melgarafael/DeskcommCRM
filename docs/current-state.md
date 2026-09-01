---
type: current-state
project: SonghaiCRM
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code) — leitura de código, HANDOFFs, plan/, loop/, CI
confidence: média-alta (métricas de código são CONFIRMADO; estado de épico vem dos HANDOFFs, que são auto-relatados)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-29)
---

# Estado atual — SonghaiCRM

> # ⚠️ ESTE DOCUMENTO É UM RETRATO, NÃO O ESTADO DE HOJE
>
> **Ele descreve `origin/main` no commit `789dfa6` (v1.0.0, 2026-07-29).** Os números,
> contagens e vereditos abaixo conferem **contra aquele commit** — não contra o que está na
> `main` agora. Entre um e outro há **1.014 commits e 71 migrations** (medido em 2026-08-14).
>
> **Nada aqui é mantido.** É deliberado, e é a alternativa honesta: um retrato datado nunca
> mente, enquanto um documento atualizado uma vez volta a mentir na semana seguinte — e sem
> aviso, porque a atualização recente faz o leitor confiar mais.
>
> **Antes de agir sobre qualquer linha, remeça.** Uma auditoria de 2026-08-14 encontrou
> 40 afirmações desatualizadas só neste arquivo — várias dizendo que falta algo que já foi
> feito. Os comandos de medição de cada uma estão em
> [`audits/2026-08-14-afirmacoes-de-estado.md`](audits/2026-08-14-afirmacoes-de-estado.md).
>
> Precisa do estado de agora? Meça na fonte. Para o que este documento mais cita:
>
> ```bash
> gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
>   --jq '.required_status_checks.contexts'      # os checks obrigatórios
> pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell
> ```



Este documento existe porque "o que está pronto" estava espalhado em 5 `HANDOFF-*.md`
na raiz, `plan/progress.md`, `loop/checkpoints/`, `tasks/todo.md` e o roadmap do README —
sem lugar único. Um agente novo (ou o dono, depois de uma semana) não conseguia responder
"posso subir isso?" sem ler ~1500 linhas.

**Aviso de método:** o estado de épico abaixo vem dos HANDOFFs, que são *auto-relatados
pelas sessões que fizeram o trabalho*. Estão densos em evidência (outputs de teste,
screenshots), o que é bom sinal, mas nada aqui foi re-verificado por execução nesta
auditoria — a auditoria é read-only por instrução. Métricas de código, contagem de
arquivos, conteúdo de CI e cobertura de padrão **foram** verificados diretamente.

**Revisão de manutenção (2026-07-30, `origin/main` @ `b190bbf`):** as contagens da §1 e as
versões de biblioteca do `AGENTS.md` foram remedidas por um mantenedor na revisão do PR #60.
Onde a régua divergiu, ela passou a ser declarada junto do número. O estado de épico (§2–§3)
**não** foi re-verificado nesta revisão — segue valendo o aviso acima.

---

## 1. Números do repositório — CONFIRMADO

**Versão:** `1.0.0`, marcada em 2026-07-27 (`CHANGELOG.md`). Primeira release versionada;
o projeto vinha sendo desenvolvido publicamente desde abril de 2026 sem tags.

| Métrica | Valor |
|---|---|
| Arquivos TS/TSX em `app`+`lib`+`components`+`workers` | 987 |
| Route handlers (`app/api/**/route.ts`) | 169 |
| Migrations em `supabase/migrations/` | 81 arquivos, até `0092_stage_names_acentos` |
| Testes unitários (`*.test.ts(x)`) | 221 arquivos |
| Invariantes de banco (`tests/invariants/`) | 56 arquivos |
| Specs E2E (`tests/e2e/`) | 19 |
| Documentos `.md` em `docs/` | 119 (em 23 subpastas) |
| Import cycles | **0** (graphify, medido em árvore anterior) |
| `console.log` fora de `lib/logger.ts` | **0** |
| `: any` / `as any` | 7 |

**Higiene de código é boa.** Zero ciclos de import, logger centralizado respeitado,
quase nenhum `any`. Os god nodes do grafo (`fail` 325 arestas, `createAdminClient` 323,
`ok` 305, `audit` 290, `requireRole` 230) são *helpers canônicos* — indicam convenção
sendo aplicada, não acoplamento acidental.

**Doutrina de migrations está sendo cumprida** — CONFIRMADO: o apêndice idempotente de
`baseline.sql` cobre até `migration 0092`, que é a última em `supabase/migrations/`. Os
artefatos de schema andam juntos como a doutrina exige — o kit self-host recebe as
mudanças. Esse é o invariante mais fácil de quebrar num projeto open-source e ele está de pé.

---

## 2. O que está entregue

Conforme o roadmap do README (INFERIDO como fiel — cada item tem código e testes
correspondentes localizados no repo):

- **Fundação & plataforma** — auth com MFA para admin, multi-tenancy com RLS + teste de
  isolamento, RBAC de 4 papéis, audit log append-only, onboarding de tenant.
- **Atendimento WhatsApp** — inbox de 3 painéis em tempo real, conexões WAHA multi-número,
  mídia via Storage, anti-banimento (throttle + jitter + janela de horário), STOP detection.
- **CRM & pedidos** — kanban com vocabulário configurável por nicho (fractional indexing),
  customer 360, contatos, tags, Nuvemshop.
- **IA nativa** — agentes com RAG por tenant (pgvector), sentiment, handoff IA→humano,
  budget por org, MCP server interno.
- **LGPD** — export e redact via workers, anonimização em cascata, consentimento auditado.
- **Self-host** — `self-host-kit`, `baseline.sql` auto-curativo, runbook de produção.
- **Webhooks & automação** — captação + regras QUANDO/SE/ENTÃO + gatilhos externos.
- **Operação visível** — transparência do motivo de retenção anti-ban, central de avisos,
  knobs de proteção de envio, propostas do flywheel com gate humano.

### Épico de Governança de Atendimento (G1–G6) — COMPLETO

CONFIRMADO em `plan/features.json` (31/31 features com `passes: true`) e
`loop/checkpoints/` (relatórios G1–G6 + os 6 arquivos `.approved`).
Guiado por 100+ invariantes de banco. Fechou em 2026-07-18.

Entregou: RBAC server-side em toda a API, atribuição e transferência auditadas
(IA como assignee de primeira classe), visibilidade por papel via RLS, métricas por
atendente, roteamento automático com fila e painel de gestão, e `docs/specs/14` —
o contrato de governança para agentes de IA externos.

---

## 3. O que está incompleto — por épico

| Épico | Estado relatado | O que falta |
|---|---|---|
| **Follow-up inteligente** (`HANDOFF.md`) | Ondas 1–7 ✅; Onda 8 **em andamento** (8.1 gatilho de silêncio ✅, 8.3 jornada E2E ✅) | gatilho `stage_change`, flywheel, e o fechamento do checklist DoD/PRD da 8.3 |
| **Evolução do harness** (`HANDOFF-harness-evolution.md`) | **ÉPICO COMPLETO** — Fases 0–4 fecharam, a última (Painel de Evolução) em 2026-07-27. Mais duas continuações entregues: mapeamento de funil do agente (27/jul) e gerenciar etapas do funil (28/jul) | **uma prova em aberto, e é do dono:** ninguém mandou uma mensagem real de WhatsApp fechando o ciclo completo. Receita de 1 min no fim do HANDOFF |
| **Operação visível** (`HANDOFF-operacao-visivel.md`) | F1, F2(i), F2(ii), F3 ✅ localhost com evidência Playwright | prova na VPS após publicar (cada feature exige prova dupla: localhost **e** VPS) |
| **Casos humanos** (`docs/handoffs/HANDOFF-casos-humanos.md`) | Waves 1–6 ✅ e revisadas; Wave 7 (prova E2E) relatada PARCIAL — interrompida por limite de API, não por bug | **A CONFIRMAR** se fechou: o HANDOFF saiu da raiz para `docs/handoffs/`, o que normalmente sinaliza épico encerrado |
| **Inbox multimodal** (`docs/handoffs/HANDOFF-inbox-multimodal.md`) | Ondas 0–3.1 ✅ com prova real (WhatsApp real, mídia real) | **A CONFIRMAR** o estado das ondas 4–6. **Bloqueios externos que valem revalidar:** chave Google era de gateway (gemini real inacessível) e credencial Anthropic era placeholder (`last4 1234`) — o agente multimodal foi provado só em OpenAI/gpt-4o |
| **Fase FG / Vendaval** | Não iniciada | O gatilho era a aprovação de G6, que existe (`G6.approved`). O README **não lista mais** a Fase FG em "Próximo" — **A CONFIRMAR** se saiu de escopo ou foi absorvida |

### Próximo no roadmap (não iniciado — CONFIRMADO no README)

MCP público · flywheel de auto-aprimoramento · templates por nicho (clínica,
imobiliária, infoproduto, serviços) · VTEX e Shopify via adapter · identity probabilística.

### Dois achados de produto registrados e não endereçados

Vêm do `HANDOFF-harness-evolution.md`, anotados como "não são desta feature":
**transbordo de layout a 390px em qualquer tela** e **não existe caminho de criação de
funil** (só de etapas). O primeiro é bug de primeira impressão em mobile.

---

## 4. O que está quebrado ou frágil — CONFIRMADO

Estes são achados de código/config verificados nesta auditoria, não relatos.

### 4.0 O agente de IA nunca recebia atualização 🔴 — RESOLVIDO em 2026-08-13

Fica no topo por gravidade e porque é o tipo de defeito que este documento existe para
tornar visível: durou dois meses, atingia **toda** instalação, e nada na tela, no log ou no
CI dizia isso.

O serviço `worker` do `docker-compose.prod.yml` — o runtime do agente de IA, e o único
consumidor de `ai_agent.dispatch_requested` — não tinha `image:`, só `build:`. Serviço
`build:`-only é pulado por `docker compose pull` ("Skipped — No image to be pulled") e imune
a `up -d` sem `--build`. Consequência: ele era compilado na VPS do cliente no dia da
instalação e **nenhum `update.sh` jamais o reconstruiu**. Correções do agente não chegavam a
lugar nenhum. Enquanto isso, `CLAUDE.md` afirmava que "o caminho normal não constrói nada na
VPS" — verdade para o app, falso para o produto.

Resolvido publicando `deskcomm-worker` e `deskcomm-scheduler` como imagens, com gate em
`tests/unit/packaging-artefato-do-cliente.test.ts`. Lei em
[`doctrine/packaging.md`](doctrine/packaging.md); decisões em
[`adr/0001-packaging-e-distribuicao.md`](adr/0001-packaging-e-distribuicao.md).

**O que continua aberto:** não existe ensaio *automatizado* de atualização numa VPS real — o
caso U6 de [`testing/user-journey-map.md`](testing/user-journey-map.md), que foi executado à
mão em 2026-08-13. *(O `imagens-ok` estava listado aqui como pendente; entrou na branch
protection em 2026-08-13 e saiu desta lista em 2026-08-14.)*

### 4.1 Os E2E quase não rodam no CI 🟠 — parcialmente resolvido em 2026-07-30

> **Atualização (2026-08-14 @ `741c4ec8`):** `e2e.yml` roda **45 das 46 specs**, e o `e2e` **é
> check obrigatório** na branch protection desde 2026-08-08 (junto com `verify`,
> `build-and-size`, `invariants` e `imagens-ok` — **cinco**). A única spec fora é
> `vps-fresh-onboarding`. O parágrafo abaixo é o registro de 2026-08-05, mantido pelo histórico
> que ele conta; os números dele estão superados por este bloco.
>
> **Registro de 2026-08-05 (issue #63):** `e2e.yml` roda **28 das 32 specs** contra Supabase
> local com o `baseline.sql` aplicado. Não-obrigatório ainda. A primeira execução real já
> pagou o job: achou a página `/500`, que `public-paths.ts` declarava pública e **nunca havia
> sido criada**. A rodada de 2026-08-05 pagou de novo: as 12 specs do épico IA 360 nunca
> tinham entrado no gate, e ao rodá-las apareceu um defeito de produto real
> (`capacidades-do-agente` — o teto de 20 capacidades desabilita a crítica que o desenho manda
> marcar à mão). As 4 restantes seguem sem gate — o texto abaixo continua valendo para elas.

O gate de isolamento RLS **roda** — `ci.yml` tem o job `invariants` chamando `pnpm test:db`,
que sobe `pgvector/pgvector:pg17`, aplica `baseline.sql` em modo install e update, e roda os
56 arquivos de `tests/invariants/`. Esse buraco está fechado.

O que continua fora (2026-08-14): **1 das 46 specs Playwright**. A
`vps-webhook-outbound-ssrf.spec.ts`, única prova automatizada do guard de SSRF, **passou a
rodar** no `e2e.yml`. Mas a `vps-fresh-onboarding.spec.ts` — a jornada que a doutrina de QA
Visual classifica como o caminho mais crítico do produto — continua fora, porque exige WAHA +
Redis + Resend + Nuvemshop no runner. Regressão nela passa sem detecção (issue #63), e é por
isso que **`e2e` verde não prova a instalação fresca**.

O `e2e` **é** check obrigatório desde 2026-08-08; um PR que o quebre não entra na `main`.

`vitest.config.ts:12` exclui `tests/invariants/**` e `tests/e2e/**` do `test:unit`. Para os
invariantes isso é deliberado e correto (o job de CI os pega). Para os E2E, quem os pega é o
`e2e.yml` — hoje 45 de 46, não "metade".

### 4.2 `pnpm gov:verify` não é o comando único que aparenta ser 🟠

`gov:verify` = `typecheck && lint && test:unit`. Omite `test:db` e `test:e2e`. Um agente
que trate `gov:verify` verde como "pronto" vai declarar concluída uma mudança de schema
sem nunca ter testado RLS. O CI pega o `test:db` depois do push, mas o loop local mente —
e o nome do script sugere cobertura total que o conteúdo não entrega.

### 4.3 Rate limit HTTP praticamente inexistente 🔴

`checkRateLimit` (`lib/ai/dispatcher/rate-limit.ts`) é chamado em **2** lugares:
o webhook público de captação e o dispatcher de IA. Sem proteção: `/login`, `/signup`,
`/team/accept-invite/:token`, os crons, `/api/internal/*`, `/api/mcp`, webhooks WAHA
e Nuvemshop. Detalhe e impacto em [`threat-model.md`](threat-model.md).

### 4.4 `node_modules` deste checkout está incompleto 🟠

70 pacotes, sem `typescript` — `pnpm typecheck` falha com `MODULE_NOT_FOUND`. Resolve-se com
`pnpm install` (não executado: a auditoria é read-only). Consequência para esta auditoria:
nenhuma afirmação sobre "os testes passam" pôde ser verificada por execução.

### 4.5 `.env.example` incompleto 🟠

6 variáveis declaradas em `lib/env.ts` e ausentes do template — incluindo **três secrets**:
`IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY`
(mais `LGPD_DPO_EMAIL`, `LGPD_EXPORT_EXPIRES_HOURS`, `NUVEMSHOP_ENABLED`).
Quem instala numa VPS não descobre que precisa delas até algo falhar. Viola o item 9 do DoD.
O template ganhou vars de white-label (`APP_NAME`, `APP_LOGO_URL`) recentemente, então o
arquivo está sendo mantido — só não reconciliado contra `lib/env.ts`.

Inverso, e menos grave: `FLYWHEEL_*` e `WATCHDOG_*` estão no template (comentados) e não em
`lib/env.ts` — lidos direto de `process.env`, portanto sem validação Zod.

### 4.6 `ARCHITECTURE.md` tinha três afirmações falsas 🟡

Corrigidas nesta auditoria: dizia Next.js 15 (é 16.2), "rate limit sliding window"
(é fixed-window, e só em 2 pontos), e "`Idempotency-Key` para POSTs de criação" (existe
em **1** rota). Documentação que promete garantia inexistente é pior que documentação
ausente — um agente confia e não implementa.

### 4.7 Sem proteção automática contra vazamento de secret 🟡

Não há gitleaks/trufflehog no CI, nem pre-commit hook (`.husky`/`.pre-commit-config.yaml`
ausentes). `.gitignore` cobre `.env*` corretamente — a proteção é só essa camada.

### 4.8 ✅ Raiz do repositório — resolvido

Registrado porque a primeira passada desta auditoria apontou 11 PNGs de evidência
commitados na raiz. **Já foram movidos**: hoje há **zero** PNGs rastreados na raiz — a
evidência vive em `evidence/` (85, contando as subpastas), `docs/evidence/` (18) e
`loop/checkpoints/evidence/` (13) — **116** no total.
Dois HANDOFFs também migraram para `docs/handoffs/`. Restam 3 na raiz (`HANDOFF.md`,
`-harness-evolution`, `-operacao-visivel`), o que é consistente com "épico vivo fica visível,
épico encerrado é arquivado".

### 4.9 Divergências de estado nos HANDOFFs 🟡

`HANDOFF.md` afirma "Migration seguinte livre: **0058**" e lista pendência de aplicar `0057`
no dev DB — mas o repo já tem migrations até **0092**. São 34 migrations de deriva. É
consequência natural de trabalho em branches paralelas, mas ilustra a regra:
**HANDOFF não é fonte da verdade de schema** — `supabase/migrations/` e `baseline.sql` são.
**A CONFIRMAR:** se a pendência de dev DB de `0057` ainda existe.

---

## 5. Riscos técnicos abertos

1. **89 dos 169 handlers usam `createAdminClient`** (service role, bypassa RLS). A regra
   "filtre `organization_id` manualmente, nunca do body" não tem *enforcement automático* na
   escrita — é revisão humana. Os 56 arquivos de invariante cobrem isolamento a sério e
   **rodam em CI**, o que mitiga muito; o que falta é o gate que impede um handler novo de
   nascer errado (lint rule ou teste de diff). Erro aqui é vazamento cross-tenant, o pior
   modo de falha do produto.
2. **Fallback in-memory do rate limit** (`rate-limit.ts:23`): sem Upstash configurado — o
   estado normal de um primeiro deploy — o limite passa a ser por processo. Silencioso além
   de um `logger.warn`.
3. ✅ **`ffmpeg` na imagem** — era contingência aberta no HANDOFF; **resolvido**:
   `Dockerfile:55` faz `apk add --no-cache ffmpeg`, com comentário explicando que a derivação
   de vídeo roda no processo do app via o cron `event-log-drain`. Registrado como fechado.
4. **Dependência de credencial de terceiro para provar IA**: se Anthropic segue com credencial
   placeholder e Google com chave de gateway inválida, o caminho multimodal está provado em um
   único provider (OpenAI) apesar de o design ser model-agnostic. **A CONFIRMAR** se ainda vale.
5. **`lib/agent-engine/agent/inbound-turn.ts` com 1789 linhas** — 2,4× o segundo maior arquivo
   de lógica (`AgentForm.tsx`, 746), e é o hot path do produto. Cresceu ~200 linhas desde a
   primeira medição desta auditoria.
6. **NENHUM cron roda no deploy Vercel.** Os 14 crons do produto são agendados exclusivamente
   pelo `crond` do serviço `scheduler` do `docker-compose.prod.yml` — e **não existe
   `vercel.json` neste repo** (medido: `ls vercel.json` → ausente). Como a Vercel é a produção
   real de quem mantém (ver `project_dois_ambientes_de_producao`), tudo que depende de
   agendamento está **dormente lá**: `event-log-drain`, `agent-dispatcher`, `followup-flow-worker`,
   `recover-stuck-messages`, `sync-model-catalog`, `contact-proposals-watcher`, etc. O sintoma
   nunca é um erro — a tela só fica velha, a fila só não anda. Está escrito aqui porque cada
   frente nova repetia a suposição de que "o cron roda"; a decisão (portar para Vercel Cron ou
   assumir que a Vercel é vitrine e a VPS é a operação) é do dono do repo.

---

## 6. Perguntas para o responsável

1. Qual é a prioridade para "iniciar minimamente o sistema": fechar a Onda 8 de Follow-up,
   a prova de WhatsApp real que o épico do harness deixou aberta, ou estabilizar segurança
   (rate limit) antes de tudo?
2. A Fase FG (Vendaval) saiu de escopo? `G6.approved` existe e o README não a lista mais em
   "Próximo". `docs/vendaval-fusion-plan.md` e `docs/vendaval-vps-deploy-comandos.md` ainda valem?
3. Casos Humanos Wave 7 e Inbox Multimodal ondas 4–6 fecharam? Os HANDOFFs foram arquivados
   em `docs/handoffs/`, o que sugere sim, mas o texto interno ainda diz PARCIAL.
4. A credencial Anthropic e a chave direta do Google AI Studio foram providenciadas?
5. Os dois achados de produto registrados e não endereçados — transbordo a 390px e ausência
   de criação de funil — entram em qual momento? O primeiro é bug de primeira impressão mobile.
6. `pnpm gov:verify` deve passar a incluir `test:db` (exige Docker em toda máquina de dev)
   ou fica um `verify:full` separado?
7. As branch protection rules exigem os dois checks do CI verdes para merge? Isso decide se o
   gate de RLS é bloqueante ou decorativo.

---

## 7. Não pôde ser confirmado

- Se `pnpm typecheck` / `lint` / `test:unit` passam **hoje** — o `node_modules` deste checkout
  está incompleto e a auditoria não instala dependências.
- Se o job `invariants` do CI está passando — sabemos que existe, não que está verde.
- Se os E2E passam hoje — exigiriam Docker, banco e app rodando.
- Estado real do banco de dev/produção — nenhuma conexão foi aberta.
- Números de teste citados nos HANDOFFs (533 unit, 236 db, 547 unit em datas diferentes) —
  auto-relatados e não reconciliam entre si. Contei **221 arquivos** de teste unitário e
  **56** de invariante, compatível com mais de mil casos, mas não valida número específico.
- Cobertura de teste (%) — `coverage` está configurado no Vitest, mas nenhum relatório foi gerado.
- Se `docs/architecture/` cumpre o "mapa vivo" exigido pelo item 13 do DoD (contém só o
  diagrama do agent-turn).
- Estado de conclusão real dos épicos arquivados — ver pergunta 3.

---

## 8. Nota de método

A primeira passada desta auditoria rodou contra um checkout **556 commits atrás** da
`origin/main`, e por isso reportou como achado principal um problema (gate de RLS fora do CI)
que já estava corrigido em produção, e descreveu o épico de Evolução do Harness como "Fase 0,
Task 1" quando ele estava completo. Tudo acima foi recontado contra `origin/main @ 789dfa6`.

Duas lições que valem para quem mantiver este documento:

1. **`git fetch` antes de auditar.** A doutrina de higiene de branches do `CLAUDE.md` existe
   por isso; ignorá-la produziu um documento que desinformava com confiança.
2. **Este arquivo apodrece rápido.** O repo moveu 556 commits em poucos dias. Trate as datas
   do frontmatter como prazo de validade, não como enfeite — e prefira reconferir os números
   com os comandos citados a confiar na tabela.
