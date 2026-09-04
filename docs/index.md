---
type: index
project: SonghaiCRM
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code)
confidence: alta (inventário de arquivos é CONFIRMADO; agrupamento temático é INFERIDO)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)
---

# Índice da documentação — SonghaiCRM

Mapa dos **154** arquivos `.md` de `docs/`, espalhados por **20** subpastas — medido em
2026-08-14, com as réguas ao lado: `git ls-files 'docs/**/*.md' | wc -l` e
`git ls-files 'docs/**/*.md' | sed 's|^docs/||;s|/.*||' | sort -u | wc -l`. Os dois números
estavam errados (149 e 24) e a segunda régua nem existia — é a mesma classe que
[`audits/2026-08-14-afirmacoes-de-estado.md`](audits/2026-08-14-afirmacoes-de-estado.md)
cataloga. Existe porque a documentação cresceu sem ponto
de entrada: sem este índice, humano e agente não acham o que já foi decidido e
reescrevem por cima.

**Regra de precedência quando dois docs discordam:**
`CLAUDE.md` (doutrina) > `docs/specs/` (contrato técnico) > `docs/prd/` (intenção) >
`HANDOFF-*.md` (estado de sessão) > README. Se achou divergência, corrija a fonte
de menor precedência e registre.

---

## 1. Comece por aqui

| Doc | Para quê |
|---|---|
| [`README.md`](../README.md) | O que é, quickstart de 5 min, stack, roadmap. Também em [EN](../README.en.md) |
| [`VISION.md`](../VISION.md) | Posicionamento, por que self-host, para quem |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Arquitetura em 1 página |
| [`AGENTS.md`](../AGENTS.md) | Contrato para agentes de código (qualquer ferramenta) |
| [`CLAUDE.md`](../CLAUDE.md) | **Doutrina não-negociável.** Convenções, anti-patterns, Definition of Done |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Como contribuir |
| [`CHANGELOG.md`](../CHANGELOG.md) | Mudanças por versão (SemVer). **Quem roda VPS lê antes de `update.sh`** — mudança que exige ação manual aparece sob "⚠️ Requer atenção" |
| [`docs/current-state.md`](current-state.md) | **O que está pronto, incompleto e quebrado hoje** |

## 2. Produto e intenção

| Doc | Conteúdo |
|---|---|
| [`prd/00-prd-master.md`](prd/00-prd-master.md) | PRD mestre — visão, escopo MVP, KPIs, restrições |
| [`prd/01-prd-platform-base.md`](prd/01-prd-platform-base.md) | Auth, tenancy, RBAC, framework LGPD |
| [`prd/02-prd-customer-360.md`](prd/02-prd-customer-360.md) | Customer 360 + identity resolution determinística |
| [`prd/03-prd-whatsapp-waha.md`](prd/03-prd-whatsapp-waha.md) | Canal WhatsApp, anti-banimento, janela 24h |
| [`prd/04-prd-pipeline-attendance.md`](prd/04-prd-pipeline-attendance.md) | Kanban, atendimento, tickets, handoff |
| [`prd/05-prd-ai-rag-handoff.md`](prd/05-prd-ai-rag-handoff.md) | IA conversacional, RAG por tenant, sentiment |
| [`business-rules/00-business-rules-catalog.md`](business-rules/00-business-rules-catalog.md) | **Catálogo de regras de negócio** — fonte da verdade fora do código |
| [`presentation/pitch-deck.md`](presentation/pitch-deck.md) | Pitch |

## 3. Contrato técnico (specs)

Detalham schema SQL e payloads exatos. **Consulte antes de modelar qualquer coisa.**

| Spec | Domínio |
|---|---|
| [`specs/01`](specs/01-spec-platform-base.md) | Plataforma base — tenancy, RLS, RBAC, API, audit |
| [`specs/02`](specs/02-spec-customer-360.md) | Customer 360 |
| [`specs/03`](specs/03-spec-whatsapp-waha.md) | WAHA — fila outbound, warm-up, spinning, crons |
| [`specs/04`](specs/04-spec-pipeline-attendance.md) | Pipeline e atendimento |
| [`specs/05`](specs/05-spec-ai-rag-handoff.md) | IA, RAG, gatilhos de handoff |
| [`specs/07`](specs/07-spec-events-workers.md) | **`event_log`, workers, claim atômico, backoff/DLQ** |
| [`specs/08`](specs/08-spec-deploy-observability.md) | Deploy e observabilidade |
| [`specs/09`](specs/09-spec-frontend-backend-integration.md) | Integração front/back |
| [`specs/10`](specs/10-spec-ai-agents-runtime.md) | Runtime dos AI Agents |
| [`specs/11`](specs/11-spec-mcp-server-internal.md) | MCP server interno + catálogo de tools |
| [`specs/12`](specs/12-spec-ai-agents-ui.md) | UI dos AI Agents |
| [`specs/13`](specs/13-spec-governanca-atendimento.md) | Governança de atendimento (épico G1–G6) |
| [`specs/14`](specs/14-contrato-governanca-agentes-externos.md) | Contrato para agentes de IA externos |
| [`specs/15`](specs/15-spec-casos-humanos.md) | Casos humanos (IA delega a humano) |
| [`specs/16`](specs/16-spec-tres-papeis-do-agente.md) | **Três papéis do agente** — Conversador / Operador / Segurança |
| [`specs/17`](specs/17-spec-conversa-vira-lead.md) | **A conversa vira lead** — o elo entre atendimento e CRM |
| [`specs/17`](specs/17-spec-indice-de-atrito.md) | **Índice de Atrito** — medir o propósito (menor atrito p/ os dois lados), não a atividade |
| [`specs/RECONCILIATION-LOG.md`](specs/RECONCILIATION-LOG.md) | Log de reconciliação entre specs |

## 4. Doutrina e arquitetura

| Doc | Conteúdo |
|---|---|
| [`doctrine/sistema-vivo.md`](doctrine/sistema-vivo.md) | **Doutrina do Sistema Vivo — a LEI.** 7 invariantes + regra do tempo + Living System Checklist (item 13 do DoD) |
| [`doctrine/sistema-vivo/`](doctrine/sistema-vivo/README.md) | **Manual do Sistema Vivo** — 8 capítulos plugáveis (princípio universal + aplicação de referência). O *porquê* de cada invariante, e como adotar a doutrina em outro sistema |
| [`doctrine/restricao-de-canal.md`](doctrine/restricao-de-canal.md) | Auto-restrição × hetero-restrição de canais externos; contrato de parâmetros derivado |
| [`doctrine/separacao-fala-e-operacao.md`](doctrine/separacao-fala-e-operacao.md) | Vocabulário interno nunca vaza para o cliente |
| [`doctrine/packaging.md`](doctrine/packaging.md) | **Doutrina de Packaging — a LEI.** 7 invariantes + política de canais + checklist de release (item 15 do DoD) |
| [`adr/0001-packaging-e-distribuicao.md`](adr/0001-packaging-e-distribuicao.md) | ADR do packaging: namespace, os 3 packages, e o que foi recusado |
| [`architecture/agent-turn.html`](architecture/agent-turn.html) | Diagrama do turno do agente (inbound → guardrails → outbound) |
| [`architecture/teto-de-orcamento.architecture.json`](architecture/teto-de-orcamento.architecture.json) | **Mapa vivo do teto de gasto com IA** — quem alimenta o gate, o que a parada NÃO desfaz sozinha, e o laço de retorno (invariante 7) |
| [`release/teto-de-orcamento.md`](release/teto-de-orcamento.md) | **Nota de release para quem opera uma VPS** — o que muda, o que fazer (nada), a troca de rótulo de R$ para US$ e como ligar a proteção |
| [`research/architecture-diagrams.md`](research/architecture-diagrams.md) | Diagramas de arquitetura |
| [`research/reference-synthesis.md`](research/reference-synthesis.md) | Arquitetura herdada da referência WAHA |
| [`research/followup-reference-mining.md`](research/followup-reference-mining.md) | Pesquisa do motor de follow-up |
| [`threat-model.md`](threat-model.md) | **Superfície de ataque real do self-host** |
| [`alertas-de-seguranca-triados.md`](alertas-de-seguranca-triados.md) | Razão de cada alerta **descartado** no painel do GitHub, e o que a varredura por classe achou que o scanner não vê |

## 5. Design system

[`design-system/README.md`](design-system/README.md) é o ponto de entrada (v2.0, 5 escolhas
visuais lockadas: paleta verde-WhatsApp, Atkinson Hyperlegible, densidade aerada, Phosphor duotone,
IBM Plex Mono). Numerados `00`–`09`: overview, tokens, paleta, tipografia, densidade,
iconografia, componentes, motion, voice & tone, **anti-patterns**.
Fluxo de tela em `design-system/screen-flow/` (jornadas, clickflows, máquinas de estado,
acessibilidade).

## 6. Operar e instalar

| Doc | Conteúdo |
|---|---|
| [`SETUP.md`](SETUP.md) | Guia completo de env vars e setup local |
| [`deploy-selfhost/README.md`](deploy-selfhost/README.md) | Self-host em VPS (`install.sh`, `backup.sh`, `reset-mfa.sh`) |
| [`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md) | Checklist de deploy |
| [`ATUALIZANDO.md`](ATUALIZANDO.md) | `update.sh`, `restore.sh`, `healthcheck.sh` |
| [`runbooks/deploy.md`](runbooks/deploy.md) | **Deploy em produção — os dois `-f` do compose, verificação pós-deploy** |
| [`runbooks/remediar-worker-congelado.md`](runbooks/remediar-worker-congelado.md) | **Incidente: o worker congelado** — diagnóstico (`diagnostico.sh`), impacto medido e as duas rotas de remediação. **Ainda não ensaiado** |
| [`runbooks/ativar-packaging.md`](runbooks/ativar-packaging.md) | **Ativação da doutrina de packaging** — os 3 passos que não cabem num PR (pacote público, check obrigatório, primeira release) |
| [`runbooks/custo-e-cota-do-supabase.md`](runbooks/custo-e-cota-do-supabase.md) | **“Meu Supabase estourou a cota”** — como medir a origem do consumo, os dois intervalos da fila e as duas tabelas que só crescem |
| [`runbooks/waha-vps.md`](runbooks/waha-vps.md) | Runbook do WAHA em produção |
| [`runbooks/ai-credentials-rotation.md`](runbooks/ai-credentials-rotation.md) | Rotação de credenciais de IA |
| [`../SECURITY.md`](../SECURITY.md) | Política de reporte de vulnerabilidade |

## 7. Testes e QA

| Doc | Conteúdo |
|---|---|
| [`testing/user-journey-map.md`](testing/user-journey-map.md) | **Mapa de jornadas vivo** — casos, prioridade `[P0]`, achados. Atualizar sempre |
| [`testing/HANDOFF-vps-qa.md`](testing/HANDOFF-vps-qa.md) | Receita do ambiente fresco estilo VPS |
| [`harness-audit.md`](harness-audit.md) | **Auditoria do harness** — 20 itens + nível de maturidade |
| [`audits/2026-08-14-afirmacoes-de-estado.md`](audits/2026-08-14-afirmacoes-de-estado.md) | **393 afirmações de estado medidas contra a fonte**, cada uma com o comando que a responde. É o retrato datado que sustenta as correções de doutrina desta data — releia a data antes de citar qualquer número dele |
| [`audits/2026-08-14-alinhamento-stable-v1.3.0.md`](audits/2026-08-14-alinhamento-stable-v1.3.0.md) | O que a tag `v1.3.0` — que é o kit que roda na VPS, e não a `main` — de fato contém |
| [`../tests/e2e/README.md`](../tests/e2e/README.md) | Como rodar os E2E |

## 8. Execução — planos, épicos, handoffs

Documentação de *processo*. Alta rotatividade; trate como estado, não como contrato.

**Convenção observada:** épico **vivo** mantém o HANDOFF na **raiz** do repo; épico
**encerrado** é arquivado em [`handoffs/`](handoffs/). Use isso para saber o que está em voo.

- **Raiz (em voo):** `HANDOFF.md` (follow-up), `HANDOFF-harness-evolution.md`, `HANDOFF-operacao-visivel.md`
- [`handoffs/`](handoffs/) — arquivados: casos humanos, inbox multimodal, CRM vivo, LGPD, wave1-devvivo, contrato wave5, briefing CRM vivo
- [`stories/`](stories/) — épicos e stories (`epics/MASTER.md` = plano por epic/wave)
- [`superpowers/`](superpowers/) — `plans/` e `specs/` datados por onda, mais `handoffs/`
- [`growth/`](growth/) — material de crescimento · [`brand/`](brand/) — marca · [`white-label.md`](white-label.md) — instalação com marca própria, também em [en](white-label.en.md) (tradução selada pelo hash do original; ver `scripts/selar-traducao.ts`)
- [`../plan/`](../plan/) — backlog do gov-loop (`features.json` 31/31, `phases.md`, `progress.md`)
- [`../loop/`](../loop/) — máquina do gov-loop (`LOOP.md`, `CHECKPOINT.md`, `checkpoints/G1..G6-report.md` + `.approved`)
- [`../tasks/todo.md`](../tasks/todo.md) — workflow de construção original (Fase 0 → PRD → specs)

## 9. Grafo de conhecimento

`graphify-out/` — grafo do repositório (7310 nós, 17705 arestas, 538 comunidades na última
geração). Consulte via skill `graphify` antes de varrer código bruto. `GRAPH_REPORT.md` traz
god nodes, hyperedges e comunidades. **Gerado — não editar.** ⚠️ Foi gerado contra uma árvore
anterior à v1.0.0; regenere (`/graphify .`) antes de confiar em detalhe fino.

---

## Lacunas conhecidas deste índice

- `docs/vendaval-fusion-plan.md` e `docs/vendaval-vps-deploy-comandos.md` referem-se a uma
  integração ("Vendaval") cujo status é **A CONFIRMAR** — o README **não a lista mais** em
  "Próximo", apesar de o gatilho (`loop/checkpoints/G6.approved`) existir.
- `docs/diagrams/` não tem `.md` e não foi inventariado. `docs/evidence/` é evidência visual
  (18 PNGs), não documentação de leitura.
- `docs/architecture/` tem **13 entradas** — 10 `*.architecture.json`, 1 `*.workflow.json`, 1
  `.html` e o `README.md` (medido em 2026-08-15: `ls docs/architecture/ | wc -l` = 13,
  `ls docs/architecture/*.architecture.json | wc -l` = 10). A frase anterior deste índice dizia
  "só o diagrama do agent-turn"
  e envelheceu. Só dois deles estão listados na tabela acima; os demais entraram com as features
  que descrevem. A doutrina (`CLAUDE.md`, DoD item 13) pede que o "mapa vivo" reflita toda peça
  nova com ≥2 arestas, e `tests/unit/mapas-de-arquitetura.test.ts` cobra a forma de TODOS —
  o que continua **NÃO IDENTIFICADO** é se toda feature entregue tem o seu.
- `docs/growth/` (3 docs) e `docs/brand/` (1) não foram lidos em detalhe — classificados por
  nome de pasta, portanto **INFERIDO**.
