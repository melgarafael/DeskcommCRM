# W4 — Organizar a operação (pacote `organizar`)

**Worktree:** `/Users/rafaelmelgaco/SonghaiCRM-ia360-w4-organizar` (branch `feat/ia-360-w4-organizar`, base `d25cd1c`)
**Pacote alvo:** `organizar` — hoje com **1 capacidade** (marcadores). Webhooks e automações: **zero**.

---

## CONTEXTO

Leia **antes de tudo**, nesta ordem:

1. `docs/handoffs/BRIEFING-ia-360.md` — o contrato inteiro. Não é opcional.
2. `docs/doctrine/sistema-vivo.md` — a lei de arquitetura.
3. `HANDOFF-ia-360.md` — a linha de base medida.

### Por que esta wave existe

O sistema tem uma máquina inteira de **entrada e saída automática** que o agente não alcança:

- `webhook_sources` + `webhook_events_log` — como o mundo externo entra no CRM
  (`app/api/v1/webhook-sources/`, `app/api/v1/webhooks/in/[token]/`)
- `automation_rules` + `automation_rule_runs` — o que dispara sozinho quando algo acontece
  (`app/api/v1/automation-rules/`, `lib/automation/engine.ts`)
- `crm_pipelines` + `crm_stages` — a forma do funil (`app/api/v1/pipelines/[id]/stages/`)
- `message_templates` — as respostas prontas (`app/api/v1/message-templates/`)
- `user_organizations` — quem é o time (`app/api/v1/team/`)

Medição na linha de base (`687716a`): o agente tem **zero** capacidades sobre webhooks e
automações, e **não consegue criar nem uma etapa de funil**. Ele opera dentro de uma estrutura que
não pode ajustar e não consegue nem explicar.

Isso é o pilar 1 pela metade: a IA atende, mas não organiza a casa onde atende.

## FUNÇÃO

Você entrega ao agente a capacidade de manter a operação em ordem — e ao humano, a visibilidade do
que a automação está fazendo.

## DIRECIONAMENTO

### O que já existe e você REUSA (Decisão 4: a tool é fachada fina)

Rotas com a regra já implementada:

- `app/api/v1/webhook-sources/`, `.../[id]/`, `.../[id]/events/`
- `app/api/v1/automation-rules/`, `.../[id]/`, `.../[id]/runs/`, `.../runs/`, `.../runs/[runId]/resend/`
- `app/api/v1/pipelines/`, `.../[id]/stages/`, `.../[id]/stages/[stageId]`, `.../[id]/agent-mapping/`
- `app/api/v1/message-templates/`, `.../[id]/`
- `app/api/v1/team/`, `.../assignable/`, `.../[user_id]/role/`
- `app/api/v1/conversation-tags/`

Libs: `lib/automation/` (engine, conditions, template, throttle, outbound-url),
`lib/webhooks/inbound.ts`, `lib/webhooks/secrets.ts`, `lib/leads/stage-editing.ts`.

**Nunca duplique o SQL.** Regra dentro do `route.ts` → extraia para `lib/<dominio>/operations.ts` e
o route passa a chamar. O teste da rota é a rede de segurança.

### Capacidades a entregar

Declare em `lib/mcp/tools/catalogo/operacao.ts` (arquivo **novo**, seu) e os handlers em
`lib/mcp/tools/operacao.ts`. Registre no agregador com **uma linha de import e uma de spread**.

Cobertura esperada:

- **Funis e etapas:** listar, criar, renomear, reordenar, arquivar etapa. `position_in_stage` é
  `numeric` com indexação fracionária (`midpoint()`) — **nunca `int`**; leia o `CLAUDE.md`.
- **Marcadores:** listar os existentes e criar novo (hoje só há aplicar/remover).
- **Respostas prontas:** listar e usar um modelo de mensagem.
- **Avisos automáticos de entrada** (`webhook_sources`): listar as origens ativas, ver o que chegou
  por elas, criar e desativar.
- **Regras automáticas** (`automation_rules`): listar, ver o que cada uma dispara, ver as execuções
  recentes e o que falhou, ligar/desligar.
- **Time:** listar quem trabalha aqui e o papel de cada um (leitura). **Não** mexa em papel/RBAC.

### Atenção especial ao risco

Esta wave é a que mais toca capacidade **`critico`** (briefing §4). Classifique com honestidade:

- Criar/desativar uma origem de aviso automático e ligar/desligar uma regra que roda sozinha são
  `critico` — mudam o comportamento do sistema **quando ninguém está olhando**.
- Arquivar etapa de funil é `critico` — mexe em onde os negócios estão parados.
- Listar qualquer coisa é `seguro`.

O gate `tests/unit/catalogo-tools-leigo-friendly.test.ts` verifica a coerência entre categoria
técnica e risco anunciado, mas **não sabe distinguir `atencao` de `critico`** — essa é sua
responsabilidade de julgamento. Errar para baixo aqui é dar ao agente poder que o humano não sabe
que concedeu.

Rótulos em português de gente. **"webhook", "pipeline", "stage" e "tag" estão na lista de jargão
proibido** do gate: use **aviso automático**, **funil**, **etapa**, **marcador**.

### O gate do sistema vivo (por capacidade)

As 7 respostas do checklist (briefing §5), com foco no que é seu:

- **Emite atividade visível.** Mudar a estrutura da operação é evento auditável: `audit()` de
  `lib/audit/` para `api_audit_log`. Se a mudança afeta um lead, também
  `crm_lead_activities` via `lib/leads/activity-emitter.ts` com a constante compartilhada de
  `lib/leads/activity-vocabulary.ts` — **nunca string literal**.
- **Aparece na tela.** As telas existem (`/app/webhooks`, `/app/pipelines`, `/app/templates`,
  `/app/team`). Uma mudança feita pelo agente tem que ser visível lá, com **quem fez** — o humano
  precisa distinguir o que ele mesmo mudou do que o agente mudou. Se não distingue, é ilha.
- **Nenhum efeito externo sem registro.** Disparo de aviso para fora do sistema é irreversível.

## OBJETIVO

Que o agente consiga manter a casa em ordem sozinho, e que o humano sempre saiba o que a automação
fez enquanto ele não estava olhando.

## RESULTADO ESPERADO

- `pnpm typecheck` limpo, `pnpm lint` sem erros novos, `pnpm test:unit` verde.
- `pnpm test:db` verde — você toca schema/automação; `test:unit` **não** inclui `tests/invariants/**`.
- **E2E em tela com Playwright**: o agente cria uma etapa, ela aparece no funil; o agente liga uma
  regra automática, ela aparece na tela com autoria dele. Evidência visual salva.
- **Efeito externo provado com receiver real.** Se testar disparo de aviso para fora, suba um
  receiver HTTP de verdade e prove o que chegou (ou que foi barrado). Mock não estressa o egress
  real — anti-SSRF, projeção de payload, https em produção.
- Mudança de schema (se houver): migration versionada + apêndice idempotente no `baseline.sql` +
  linha no `MANIFEST.md`. Os três, sempre juntos.
- `HANDOFF-ia-360.md` alimentado a cada marco, com SHA.

**Sabote antes de confiar.** Quebre a propriedade de propósito, confirme que reprova, desfaça.

## LIMITES

- Não toque em `lib/mcp/tools/catalogo/` além do **seu** arquivo + as 2 linhas no agregador.
- Não renomeie `name` de tool existente (contrato de wire).
- **Não mexa em RBAC** — listar o time é leitura; mudar papel de alguém está fora de escopo.
- Não mexa no engine de envio / anti-ban.
- Bug encontrado é para consertar na causa raiz.
