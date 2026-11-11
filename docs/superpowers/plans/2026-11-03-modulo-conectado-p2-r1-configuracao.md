# Fatia 2 (R1) — as rotas de configuração aceitam token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 111 rotas de configuração (158 métodos) passam a aceitar o token `dsk_…` de ponta a ponta, cada
uma filtrando a organização da linha do token, sem mudar nada para quem usa pela tela.

**Architecture:** cada tarefa é um PR de uma área, aplicando a receita comum
(`2026-11-03-modulo-conectado-receita-r.md`) às rotas da tabela no fim deste plano. Token de configuração
exige `config:read`/`config:write` e papel `admin`, como nos precedentes #2194 e #2824.

**Tech Stack:** Next.js 16 route handlers, Vitest, `lib/api/auth-dual.ts`, `lib/auth/public-paths.ts`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, linha R1 e lista de negação da F3.

## Global Constraints

- Tudo da receita comum vale aqui.
- Escopo `config:read` (GET) e `config:write` (escrita), `tokenRole: "admin"` em todo método.
- Ficam de fora (já decidido, não converter): `ai/replies/[id]`, `ai/cases/[id]/reply`, `ai/cases/alerta`,
  `ai/cases/alerta/teste`, `ai/followups/enrollments` POST, `ai/followups/enrollments/[id]/resume`,
  `ai/followups/enrollments/[id]/skip`, `ai/followup-flows/[id]/publish`, `ai/followup-flows/[id]/rollback`,
  `ai/knowledge/chave`, `ai/knowledge/provedor`, `settings/art15`, `team/[user_id]`,
  `team/[user_id]/reactivate`, `team/[user_id]/interface`, `attendants/presence`, e o PATCH de
  `settings/routing/channels` (`fn_set_channel_routing` exige sessão). O motivo de cada um está na tabela.
- Depende da fatia 1 (R0). Não depende de R2 nem de R3.

## Review Focus

Os cinco da receita comum, mais:
1. **`ai/followups/enrollments/[id]/pause|cancel|snooze`** reduzem envio e entram; `resume|skip` aumentam e
   ficam de fora. O teste da área prova que o token leva 401 em `resume` e `skip`.
2. **`ai/knowledge/busca` e `ai/voz/preview`** gastam com o provedor de IA a cada chamada. O teto do token
   (30 por minuto por recurso) é o único freio; o teste do teto é obrigatório nelas.
3. **`ai/knowledge/sources*`** chamam `emit_event` e usam storage: a organização do evento e o prefixo do
   arquivo saem de `authz.organizationId`.

---

## Tarefas (um PR cada)

Cada tarefa segue "O caminho de cada tarefa" da receita, com as rotas das seções indicadas da tabela.

### Task 1: `ai/agents`
### Task 2: `ai/cases`, `ai/inbox`, `ai/routing-results`
### Task 3: `ai/followup-flows`, `ai/followups`
### Task 4: `ai/knowledge`
### Task 5: `ai/memory`, `ai/skills`
### Task 6: `ai (demais)`
### Task 7: `pipelines`
### Task 8: `products`, `tags`
### Task 9: `settings`
### Task 10: `message-templates`, `message-template-groups`
### Task 11: `automation-rules`, `channel-schedules`
### Task 12: `attendants`, `team`

Para cada uma:

- [ ] **Step 1:** medir de novo (receita, passo 1).
- [ ] **Step 2:** escrever `tests/unit/token-por-area/<area>.test.ts` com um caso por linha da tabela e o
  bloco de borda; vermelho.
- [ ] **Step 3:** converter cada método (receita A ou B, conforme a coluna); seguir a coluna "Sinais".
- [ ] **Step 4:** entradas em `PUBLIC_PATHS`.
- [ ] **Step 5:** commit `feat(api): <área> aceita token de integração`, pré-voo, CI do fork, sabotagem (a) e
  (b) da receita com "N de M" previsto, fragmento, texto do PR para o Paulo ler.

---

## Tabela por área (medida em `fe7a11457`)

A coluna **Papel hoje** é o que a rota exige da sessão; a conversão passa o mesmo valor a
`resolveAuthDual`. **Receita**: A (`requireRole`) ou B (outro portão). **Sinais**: o que pede atenção
naquela rota (rpc, storage, consulta com menos filtros de organização do que chamadas `.from`, `lib`
que usa sessão).

## ai/agents — 8 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/agents/[id]/duplicate` | POST | admin | A | — |
| `ai/agents/[id]/pause` | POST | admin | A | — |
| `ai/agents/[id]/proposals/[pid]/apply` | POST | admin | A | — |
| `ai/agents/[id]/proposals` | GET | agent | A | — |
| `ai/agents/[id]/reconcile` | POST | admin | A | — |
| `ai/agents/[id]/runs` | GET | manager | A | — |
| `ai/agents/[id]/tool-usage` | GET | manager | A | rpc fn_agent_tool_usage, fn_agent_tool_usage_por_termo |
| `ai/agents/assignable` | GET | agent | A | — |

## ai (demais) — 15 rotas, 23 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/automatico-ativo` | GET | agent | A | — |
| `ai/budget` | GET | manager | A | — |
| `ai/budget` | PATCH | admin | A | — |
| `ai/evolution` | GET | manager | A | — |
| `ai/guardrail-layers` | GET | manager | A | — |
| `ai/guardrail-layers` | PUT | admin | A | — |
| `ai/jev` | GET | manager | A | — |
| `ai/jev` | PATCH | admin | A | — |
| `ai/mapas` | GET | manager | A | — |
| `ai/mapas` | PUT | admin | A | — |
| `ai/mapas` | DELETE | admin | A | — |
| `ai/mapas/testar` | POST | admin | A | — |
| `ai/operator-metrics` | GET | manager | A | — |
| `ai/pacing` | GET | agent | A | — |
| `ai/pacing` | PUT | manager | A | — |
| `ai/runs` | GET | manager | A | — |
| `ai/style-adjustments` | GET | manager | A | — |
| `ai/style-adjustments` | PUT | admin | A | — |
| `ai/turn-traces` | GET | manager | A | — |
| `ai/usage` | GET | manager | A | rpc fn_uso_de_ia |
| `ai/voz/preview` | POST | manager | A | — |
| `ai/voz` | GET | manager | A | conferir filtro |
| `ai/voz` | PATCH | admin | A | conferir filtro |

Fica de fora: `ai/replies/[id]` POST (nega: aprova e envia resposta ao cliente (D6))

## ai/cases — 4 rotas, 5 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/cases/[id]/chat` | GET | agent | A | — |
| `ai/cases/[id]/chat` | POST | no handler | A | — |
| `ai/cases/[id]/close` | POST | agent | A | — |
| `ai/cases/[id]` | GET | agent | A | — |
| `ai/cases` | GET | agent | A | — |

Fica de fora: `ai/cases/[id]/reply` POST (nega: pede informação ao cliente ou aciona o handoff (D6)); `ai/cases/alerta` GET (nega: configura e testa o aviso por WhatsApp (D6)); `ai/cases/alerta` PUT (nega: configura e testa o aviso por WhatsApp (D6)); `ai/cases/alerta` DELETE (nega: configura e testa o aviso por WhatsApp (D6)); `ai/cases/alerta/teste` POST (nega: configura e testa o aviso por WhatsApp (D6))

## ai/followup-flows — 6 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/followup-flows/[id]/disable` | POST | manager | A | — |
| `ai/followup-flows/[id]/duplicate` | POST | manager | A | — |
| `ai/followup-flows/[id]/export` | GET | viewer | A | — |
| `ai/followup-flows/[id]` | GET | viewer | A | — |
| `ai/followup-flows/[id]` | PATCH | manager | A | — |
| `ai/followup-flows/[id]` | DELETE | manager | A | — |
| `ai/followup-flows/import` | POST | manager | A | — |
| `ai/followup-flows/modelos-aprovados` | GET | viewer | A | — |

Fica de fora: `ai/followup-flows/[id]/publish` POST (nega: publicar e reverter seguem só na tela (comentário em public-paths.ts, #1875)); `ai/followup-flows/[id]/rollback` POST (nega: publicar e reverter seguem só na tela (comentário em public-paths.ts, #1875))

## ai/followups — 7 rotas, 7 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/followups/enrollments/[id]/cancel` | POST | manager | A | — |
| `ai/followups/enrollments/[id]/pause` | POST | manager | A | — |
| `ai/followups/enrollments/[id]` | GET | viewer | A | — |
| `ai/followups/enrollments/[id]/snooze` | POST | manager | A | — |
| `ai/followups/enrollments` | GET | viewer | A | — |
| `ai/followups/promises/[id]/cancel` | POST | manager | A | — |
| `ai/followups/queue` | GET | viewer | A | — |

Fica de fora: `ai/followups/enrollments/[id]/resume` POST (nega: retoma ou antecipa envio (D6)); `ai/followups/enrollments/[id]/skip` POST (nega: retoma ou antecipa envio (D6)); `ai/followups/enrollments` POST (nega: inscrever contato agenda envio (D6))

## ai/inbox — 3 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/inbox/[id]` | PATCH | PAPEL_MINIMO_DA_CENTRAL | A | — |
| `ai/inbox/resolve-all` | POST | PAPEL_MINIMO_DA_CENTRAL | A | — |
| `ai/inbox` | GET | PAPEL_MINIMO_DA_CENTRAL | A | — |

## ai/knowledge — 8 rotas, 11 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/knowledge/busca` | POST | agent | A | — |
| `ai/knowledge/reindex-all` | POST | manager | A | — |
| `ai/knowledge/sources/[id]/conteudo` | GET | manager | A | lib ai/knowledge/conteudo-do-material |
| `ai/knowledge/sources/[id]/reindex` | POST | manager | A | rpc emit_event |
| `ai/knowledge/sources/[id]` | GET | manager | A | rpc emit_event |
| `ai/knowledge/sources/[id]` | PATCH | manager | A | rpc emit_event |
| `ai/knowledge/sources/[id]` | DELETE | manager | A | rpc emit_event |
| `ai/knowledge/sources/[id]/trechos` | GET | manager | A | — |
| `ai/knowledge/sources` | GET | membro (B) | B | rpc emit_event; storage |
| `ai/knowledge/sources` | POST | manager | A | rpc emit_event; storage |
| `ai/knowledge/sources/upload` | POST | manager | A | rpc emit_event; storage |

Fica de fora: `ai/knowledge/chave` GET (nega: chave e provedor de IA); `ai/knowledge/provedor` PUT (nega: chave e provedor de IA)

## ai/memory — 4 rotas, 5 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/memory/entries/[id]` | PATCH | manager | A | — |
| `ai/memory/entries` | POST | manager | A | — |
| `ai/memory` | GET | agent | A | — |
| `ai/memory` | POST | admin | A | — |
| `ai/memory/versions/[id]` | GET | agent | A | — |

## ai/routing-results — 2 rotas, 2 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/routing-results/[id]` | PATCH | admin | A | — |
| `ai/routing-results` | GET | manager | A | — |

## ai/skills — 6 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ai/skills/[name]/install` | POST | manager | A | — |
| `ai/skills/[name]/restore` | POST | manager | A | — |
| `ai/skills/[name]` | GET | agent | A | — |
| `ai/skills/[name]` | PUT | manager | A | — |
| `ai/skills/[name]` | DELETE | manager | A | — |
| `ai/skills/[name]/versions` | GET | agent | A | — |
| `ai/skills/import` | POST | manager | A | — |
| `ai/skills` | GET | agent | A | — |

## attendants — 5 rotas, 7 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `attendants/availability/[user_id]` | PATCH | agent | A | — |
| `attendants/availability` | GET | agent | A | — |
| `attendants/sector/[user_id]` | PUT | manager | A | — |
| `attendants/sectors/[id]` | PATCH | manager | A | — |
| `attendants/sectors/[id]` | DELETE | manager | A | — |
| `attendants/sectors` | GET | viewer | A | — |
| `attendants/sectors` | POST | manager | A | — |

Fica de fora: `attendants/presence` POST (sessao: o sujeito é a própria pessoa logada)

## automation-rules — 4 rotas, 6 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `automation-rules/[id]` | PATCH | manager | A | conferir filtro |
| `automation-rules/[id]` | DELETE | manager | A | conferir filtro |
| `automation-rules/[id]/runs` | GET | manager | A | — |
| `automation-rules` | GET | manager | A | — |
| `automation-rules` | POST | manager | A | — |
| `automation-rules/runs` | GET | manager | A | — |

## channel-schedules — 2 rotas, 4 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `channel-schedules/[id]` | PATCH | admin | A | — |
| `channel-schedules/[id]` | DELETE | admin | A | — |
| `channel-schedules` | POST | admin | A | — |
| `channel-schedules` | GET | admin | A | — |

## message-template-groups — 3 rotas, 5 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `message-template-groups/[id]/ordem` | PUT | manager | A | — |
| `message-template-groups/[id]` | PATCH | manager | A | — |
| `message-template-groups/[id]` | DELETE | manager | A | — |
| `message-template-groups` | GET | agent | A | — |
| `message-template-groups` | POST | manager | A | — |

## message-templates — 5 rotas, 7 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `message-templates/[id]/midias/[indice]` | GET | agent | A | storage |
| `message-templates/[id]/midias` | POST | agent | A | storage |
| `message-templates/[id]/ordem` | PUT | agent | A | — |
| `message-templates/[id]` | PATCH | agent | A | lib templates/grupo-da-resposta |
| `message-templates/[id]` | DELETE | agent | A | lib templates/grupo-da-resposta |
| `message-templates` | GET | agent | A | lib templates/grupo-da-resposta |
| `message-templates` | POST | agent | A | lib templates/grupo-da-resposta |

## pipelines — 10 rotas, 15 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `pipelines/[id]/agent-mapping` | GET | manager | A | — |
| `pipelines/[id]/agent-mapping` | PUT | manager | A | — |
| `pipelines/[id]/board` | GET | membro (B) | B | — |
| `pipelines/[id]/forecast` | GET | agent | A | — |
| `pipelines/[id]/leads` | GET | viewer | A | — |
| `pipelines/[id]` | PATCH | manager | A | — |
| `pipelines/[id]` | DELETE | manager | A | — |
| `pipelines/[id]/stages/[stageId]` | PATCH | manager | A | — |
| `pipelines/[id]/stages/[stageId]` | DELETE | manager | A | — |
| `pipelines/[id]/stages` | GET | manager | A | — |
| `pipelines/[id]/stages` | POST | manager | A | — |
| `pipelines/[id]/stages/win-rates` | GET | manager | A | — |
| `pipelines/default` | GET | agent | A | conferir filtro |
| `pipelines` | GET | manager | A | — |
| `pipelines` | POST | manager | A | — |

## products — 4 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `products/[id]/fotos` | POST | manager | A | storage |
| `products/[id]/fotos` | PUT | manager | A | storage |
| `products/[id]` | PATCH | manager | A | — |
| `products/[id]` | DELETE | manager | A | — |
| `products/import` | POST | manager | A | — |
| `products/import` | GET | manager | A | — |
| `products` | GET | viewer | A | — |
| `products` | POST | manager | A | — |

## settings — 11 rotas, 21 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `settings/agenda-apresentacao` | PATCH | manager | A | conferir filtro |
| `settings/campanhas` | GET | manager | A | conferir filtro |
| `settings/campanhas` | PATCH | manager | A | conferir filtro |
| `settings/proposal-templates/[slug]` | GET | viewer | A | — |
| `settings/proposal-templates/[slug]` | PATCH | manager | A | — |
| `settings/proposal-templates/[slug]` | DELETE | manager | A | — |
| `settings/proposal-templates/importar` | POST | manager | A | — |
| `settings/proposal-templates` | GET | viewer | A | — |
| `settings/proposal-templates` | POST | manager | A | — |
| `settings/proposals` | GET | viewer | A | conferir filtro |
| `settings/proposals` | PATCH | manager | A | conferir filtro |
| `settings/prospeccao` | GET | manager | A | conferir filtro |
| `settings/prospeccao` | PATCH | manager | A | conferir filtro |
| `settings/routing/channels` | GET | manager | A | rpc fn_set_channel_routing |
| `settings/routing` | GET | manager | A | conferir filtro |
| `settings/routing` | PATCH | manager | A | conferir filtro |
| `settings/sons` | GET | viewer | A | storage; conferir filtro |
| `settings/sons` | POST | manager | A | storage; conferir filtro |
| `settings/sons` | DELETE | manager | A | storage; conferir filtro |
| `settings/task-plans` | GET | viewer | A | conferir filtro |
| `settings/task-plans` | PATCH | manager | A | conferir filtro |

Fica de fora: `settings/art15` PATCH (nega: LGPD (art. 15)); `settings/routing/channels` PATCH (funcao: fn_set_channel_routing exige auth.uid())

## tags — 2 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `tags/cores` | GET | viewer | A | conferir filtro |
| `tags/vocabulario` | GET | manager | A | rpc fn_vocabulario_de_tags_pagina, fn_vocabulario_de_tags, fn_vocabulario_de_tags_operar |
| `tags/vocabulario` | POST | manager | A | rpc fn_vocabulario_de_tags_pagina, fn_vocabulario_de_tags, fn_vocabulario_de_tags_operar |

## team — 2 rotas, 2 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `team/assignable` | GET | agent | A | — |
| `team` | GET | manager | A | — |

Fica de fora: `team/[user_id]/interface` PATCH (nega: acesso e perfil de pessoa da equipe); `team/[user_id]/reactivate` POST (nega: acesso e perfil de pessoa da equipe); `team/[user_id]` PATCH (nega: acesso e perfil de pessoa da equipe)
