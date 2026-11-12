# Fatia 3 (R2) — as rotas de operação aceitam token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 122 rotas de operação (171 métodos) — contatos, conversas, negócios, agenda, propostas,
campanhas, empresas, financeiro, tarefas — passam a aceitar o token `dsk_…` de ponta a ponta, cada uma
filtrando a organização da linha do token, sem mudar nada para quem usa pela tela.

**Architecture:** cada tarefa é um PR de uma área, aplicando a receita comum
(`2026-11-03-modulo-conectado-receita-r.md`) às rotas da tabela no fim deste plano.

**Tech Stack:** Next.js 16 route handlers, Vitest, `lib/api/auth-dual.ts`, `lib/auth/public-paths.ts`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, linha R2 e lista de negação da F3.

## Global Constraints

- Tudo da receita comum vale aqui.
- Escopo `mcp:read` (GET) e `mcp:write` (escrita). `tokenRole` só quando a tool MCP equivalente exige mais.
- Ficam de fora (já decidido, não converter): `agenda/agendamentos/[id]/google/meet/deliver|resend|retry`,
  `agenda/aviso`, `agenda/aviso/teste`, `agenda/google/connect|callback|desconectar`, `contacts/export`,
  `conversations/[id]/export`, `contacts/[id]/unblock`, `contacts/[id]` DELETE, `proposals/[id]/send`,
  `leads/[id]/conversion/retry`, `conversions/meta-clicks/[id]/retry`, `voip/trunk`, `calls` POST,
  `notifications/push`, `conversations/[id]/claim|release|mark-read`, `prospecting/agents/*`,
  `prospecting/importar` (já justificada na R0), o PATCH de `agenda/configuracao` e
  `financeiro/comandas/[id]/estornar|finalizar`, `financeiro/comandas/faturar-lote`,
  `honorarios/parcelas/[id]/pagar` (funções do banco que exigem sessão). As 3 rotas da R0 já vêm prontas.
- Depende da fatia 1 (R0). Não depende de R1 nem de R3.

## Review Focus

Os cinco da receita comum, mais:
1. **`contacts/[id]` GET e PATCH** passam pelo handler compartilhado `app/api/v1/contacts/_handler.ts`. Ele
   só decifra CPF quando `ctx.actor.type === "user"` (linha 453), então o token nunca recebe CPF decifrado.
   Caso próprio no teste: token com `decrypt_purpose` recebe `cpf_decrypted: null`, e `decrypt_cpf` não é
   chamada.
2. **`conversations/[id]/transfer`, `pause-ai`, `contacts/[id]/personal`, `contacts/merge`** chamam funções
   tolerantes a service role: sem sessão, a função pula a checagem de papel, e o `resolveAuthDual` é a única
   barreira.
3. **`conversations` e `conversations/[id]/messages`** são as leituras de maior volume. O teto do token
   por recurso (30 por minuto) vale nelas; o caso do teto é obrigatório.
4. **`campaign-suppressions/[id]` DELETE** tira um número da lista de exclusão da campanha, mas não desfaz
   opt-out (comentário da rota, linhas 2–6). Entra.
5. **`conversations/[id]/reactivate-bot`** devolve a conversa ao agente, e já existe a tool MCP que faz o
   mesmo. Entra, com o `tokenRole` da tool.

---

## Tarefas (um PR cada)

Cada tarefa segue "O caminho de cada tarefa" da receita, com as rotas das seções indicadas da tabela.

### Task 1: `contacts`, `contact-tags`
### Task 2: `conversations`, `conversation-tags`
### Task 3: `leads`, `lead-captures`
### Task 4: `agenda`
### Task 5: `proposals`
### Task 6: `campaigns`, `campaign-templates`, `campaign-suppressions`
### Task 7: `companies`, `company-people`, `people`, `phone-numbers`
### Task 8: `financeiro`, `honorarios`
### Task 9: `tasks`, `demandas`, `calls`

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
`resolveAuthDual`. "no handler": o papel está no handler compartilhado, e o coder confirma lá.
**Receita**: A (`requireRole`) ou B (outro portão). **Sinais**: o que pede atenção naquela rota.

## agenda — 12 rotas, 16 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `agenda/agendamentos/[id]/google/resolver` | POST | agent | A | — |
| `agenda/agendamentos/[id]/google/retry` | POST | delega a ../resolver/route | A | — |
| `agenda/agendamentos/[id]` | GET | viewer | A | — |
| `agenda/configuracao` | GET | viewer | A | rpc fn_agenda_settings; conferir filtro |
| `agenda/enderecos` | GET | agent | A | — |
| `agenda/enderecos` | POST | agent | A | — |
| `agenda/excecoes` | GET | agent | A | — |
| `agenda/excecoes` | POST | agent | A | — |
| `agenda/excecoes` | DELETE | agent | A | — |
| `agenda/google/calendarios/atualizar` | POST | agent | A | — |
| `agenda/google/calendarios` | GET | agent | A | — |
| `agenda/google/calendarios` | PATCH | agent | A | — |
| `agenda/horarios-livres` | GET | viewer | A | — |
| `agenda/pessoas` | GET | PAPEL_MINIMO_DA_LISTA | A | — |
| `agenda/tipos/reativar` | POST | manager | A | — |
| `agenda/vinculos` | GET | agent | A | — |

Fica de fora: `agenda/agendamentos/[id]/google/meet/deliver` POST (nega: entrega o link da reunião ao cliente (D6)); `agenda/agendamentos/[id]/google/meet/resend` POST (nega: entrega o link da reunião ao cliente (D6)); `agenda/agendamentos/[id]/google/meet/retry` POST (nega: entrega o link da reunião ao cliente (D6)); `agenda/aviso` GET (nega: configura e testa o aviso por WhatsApp (D6)); `agenda/aviso` PUT (nega: configura e testa o aviso por WhatsApp (D6)); `agenda/aviso/teste` POST (nega: configura e testa o aviso por WhatsApp (D6)); `agenda/configuracao` PATCH (funcao: fn_agenda_settings exige auth.uid()); `agenda/google/callback` GET (nega: conexão OAuth da agenda); `agenda/google/connect` GET (nega: conexão OAuth da agenda); `agenda/google/desconectar` DELETE (nega: conexão OAuth da agenda); `agenda/servicos/atualizar` POST (r0: feita na fatia 1 (R0))

## calls — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `calls` | GET | manager | A | conferir filtro |

Fica de fora: `calls` POST (nega: origina ligação ao cliente)

## campaign-suppressions — 2 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `campaign-suppressions/[id]` | DELETE | manager | A | — |
| `campaign-suppressions` | GET | manager | A | lib campanhas/schemas |
| `campaign-suppressions` | POST | manager | A | lib campanhas/schemas |

## campaign-templates — 2 rotas, 4 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `campaign-templates/[id]` | PATCH | manager | A | lib campanhas/schemas |
| `campaign-templates/[id]` | DELETE | manager | A | lib campanhas/schemas |
| `campaign-templates` | GET | manager | A | lib campanhas/schemas |
| `campaign-templates` | POST | manager | A | lib campanhas/schemas |

## campaigns — 6 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `campaigns/[id]/metrics` | GET | manager | A | — |
| `campaigns/[id]/recipients` | GET | manager | A | lib campanhas/schemas |
| `campaigns/[id]` | GET | manager | A | lib campanhas/schemas |
| `campaigns/[id]` | PATCH | manager | A | lib campanhas/schemas |
| `campaigns/modelos` | GET | manager | A | — |
| `campaigns/preview` | POST | manager | A | lib campanhas/schemas |
| `campaigns` | GET | manager | A | lib campanhas/schemas |
| `campaigns` | POST | manager | A | lib campanhas/schemas |

## companies — 4 rotas, 7 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `companies/[id]/enrich` | POST | manager | A | — |
| `companies/[id]` | GET | viewer | A | — |
| `companies/[id]` | PATCH | agent | A | — |
| `companies/[id]` | DELETE | manager | A | — |
| `companies/lookup` | GET | manager | A | — |
| `companies` | GET | viewer | A | — |
| `companies` | POST | manager | A | — |

## company-people — 2 rotas, 2 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `company-people/[id]` | PATCH | agent | A | — |
| `company-people` | POST | manager | A | — |

## contact-tags — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `contact-tags` | GET | viewer | A | rpc fn_vocabulario_de_tags_pagina |

## contacts — 21 rotas, 25 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `contacts/[id]/always-human` | POST | no handler | A | — |
| `contacts/[id]/always-human` | DELETE | manager | A | — |
| `contacts/[id]/carteira` | PATCH | manager | A | rpc fn_definir_carteira_do_cliente |
| `contacts/[id]/carteira` | GET | agent | A | rpc fn_definir_carteira_do_cliente |
| `contacts/[id]/compras` | GET | membro (B) | B | — |
| `contacts/[id]/crm-summary` | GET | membro (B) | B | — |
| `contacts/[id]/hierarquia-do-anuncio` | GET | membro (B) | B | — |
| `contacts/[id]/person` | PATCH | agent | A | — |
| `contacts/[id]/personal` | POST | manager | A | rpc fn_conversation_assign, fn_service_status, fn_contato_pessoal_remove_trechos_do_rag |
| `contacts/[id]/personal` | DELETE | manager | A | rpc fn_conversation_assign, fn_service_status, fn_contato_pessoal_remove_trechos_do_rag |
| `contacts/[id]/proposals/[proposal_id]` | POST | agent | A | — |
| `contacts/[id]/proposals` | GET | viewer | A | — |
| `contacts/[id]/roteiros/[enrollmentId]/negocio` | POST | manager | A | — |
| `contacts/[id]/roteiros` | GET | viewer | A | — |
| `contacts/[id]` | GET | no handler | A | — |
| `contacts/[id]` | PATCH | agent | A | — |
| `contacts/[id]/timeline` | GET | membro (B) | B | conferir filtro; lib leads/timeline-query |
| `contacts/[id]/vinculos` | GET | viewer | A | — |
| `contacts/bulk` | POST | agent | A | — |
| `contacts/compare` | GET | membro (B) | B | — |
| `contacts/duplicates/dismiss` | POST | manager | A | — |
| `contacts/duplicates` | GET | membro (B) | B | — |
| `contacts/import/agenda` | POST | agent | A | — |
| `contacts/import` | POST | agent | A | rpc emit_event |
| `contacts/merge` | POST | manager | A | rpc fn_mesclar_contatos |

Fica de fora: `contacts/[id]` DELETE (nega: remoção irreversível de contato (LGPD, no handler)); `contacts/[id]/unblock` POST (nega: desfaz o descadastro do contato; regra do envio (W-02/W-03)); `contacts/export` GET (nega: exportação de dado pessoal ou de auditoria)

## conversation-tags — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `conversation-tags` | GET | viewer | A | rpc fn_vocabulario_de_tags_pagina, fn_tags_de_conversa_em_uso; conferir filtro |

## conversations — 20 rotas, 28 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `conversations/[id]/aviso-de-mensagem` | GET | viewer | A | — |
| `conversations/[id]/close` | POST | agent | A | rpc fn_service_status |
| `conversations/[id]/draft-reply` | GET | agent | A | — |
| `conversations/[id]/draft-reply` | POST | agent | A | — |
| `conversations/[id]/messages` | GET | no handler | A | — |
| `conversations/[id]/notes/[noteId]/media` | GET | agent | A | storage; conferir filtro |
| `conversations/[id]/notes/[noteId]` | DELETE | agent | A | — |
| `conversations/[id]/notes` | GET | agent | A | rpc emit_event |
| `conversations/[id]/notes` | POST | agent | A | rpc emit_event |
| `conversations/[id]/participants` | GET | membro (B) | B | — |
| `conversations/[id]/participants` | POST | agent | A | — |
| `conversations/[id]/participants` | DELETE | agent | A | — |
| `conversations/[id]/passagens` | GET | agent | A | — |
| `conversations/[id]/pause-ai` | POST | agent | A | rpc fn_conversation_assign |
| `conversations/[id]/reactivate-bot` | POST | agent | A | — |
| `conversations/[id]/retention` | GET | membro (B) | B | conferir filtro |
| `conversations/[id]` | GET | no handler | A | — |
| `conversations/[id]` | PATCH | agent | A | — |
| `conversations/[id]/sector` | PUT | agent | A | rpc fn_request_channel_routing |
| `conversations/[id]/sector` | GET | agent | A | rpc fn_request_channel_routing |
| `conversations/[id]/snooze` | POST | agent | A | — |
| `conversations/[id]/snooze` | DELETE | agent | A | — |
| `conversations/[id]/transfer` | POST | agent | A | rpc fn_conversation_assign, emit_event, fn_numero_da_transferencia |
| `conversations/[id]/transfer` | GET | agent | A | rpc fn_conversation_assign, emit_event, fn_numero_da_transferencia |
| `conversations/[id]/usable-for-rag` | POST | agent | A | rpc fn_conversa_remove_trechos_do_rag |
| `conversations/bulk` | POST | agent | A | — |
| `conversations/counts` | GET | membro (B) | B | — |
| `conversations` | GET | no handler | A | — |

Fica de fora: `conversations/[id]/claim` POST (sessao: o sujeito é a própria pessoa logada); `conversations/[id]/drafts/consume` POST (r0: feita na fatia 1 (R0)); `conversations/[id]/export` GET (nega: exportação de dado pessoal ou de auditoria); `conversations/[id]/mark-read` POST (sessao: o sujeito é a própria pessoa logada); `conversations/[id]/notes/media` POST (r0: feita na fatia 1 (R0)); `conversations/[id]/release` POST (sessao: o sujeito é a própria pessoa logada)

## conversions — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `conversions/meta-clicks/[id]/retry` POST (nega: reenvia conversão à plataforma de anúncio)

## demandas — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `demandas/[id]` | PATCH | agent | A | rpc fn_demanda_encerrar |

## financeiro — 9 rotas, 17 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `financeiro/catalogo/[tipo]` | GET | viewer | A | — |
| `financeiro/catalogo/[tipo]` | POST | manager | A | — |
| `financeiro/catalogo/[tipo]` | PATCH | manager | A | — |
| `financeiro/catalogo/[tipo]` | DELETE | manager | A | — |
| `financeiro/comandas/[id]/itens/[itemId]` | DELETE | agent | A | conferir filtro |
| `financeiro/comandas/[id]/itens` | POST | agent | A | conferir filtro |
| `financeiro/comandas/[id]` | GET | viewer | A | conferir filtro |
| `financeiro/comandas/[id]` | PATCH | agent | A | conferir filtro |
| `financeiro/comandas/pendentes` | GET | agent | A | conferir filtro |
| `financeiro/comandas` | GET | viewer | A | rpc fn_proximo_numero_de_comanda; conferir filtro |
| `financeiro/comandas` | POST | agent | A | rpc fn_proximo_numero_de_comanda; conferir filtro |
| `financeiro/fidelidade` | GET | viewer | A | rpc fn_saldo_de_fidelidade; conferir filtro |
| `financeiro/fidelidade` | POST | agent | A | rpc fn_saldo_de_fidelidade; conferir filtro |
| `financeiro/lancamentos/[id]` | PATCH | agent | A | conferir filtro |
| `financeiro/lancamentos/[id]` | DELETE | agent | A | conferir filtro |
| `financeiro/lancamentos` | GET | viewer | A | conferir filtro |
| `financeiro/lancamentos` | POST | agent | A | conferir filtro |

Fica de fora: `financeiro/comandas/[id]/estornar` POST (funcao: fn_finalizar_comanda / fn_estornar_comanda exigem auth.uid()); `financeiro/comandas/[id]/finalizar` POST (funcao: fn_finalizar_comanda / fn_estornar_comanda exigem auth.uid()); `financeiro/comandas/faturar-lote` POST (funcao: fn_finalizar_comanda / fn_estornar_comanda exigem auth.uid())

## honorarios — 2 rotas, 4 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `honorarios/contratos/[id]/parcelas` | GET | viewer | A | conferir filtro |
| `honorarios/contratos/[id]/parcelas` | POST | manager | A | conferir filtro |
| `honorarios/contratos` | GET | viewer | A | conferir filtro |
| `honorarios/contratos` | POST | manager | A | conferir filtro |

Fica de fora: `honorarios/parcelas/[id]/pagar` POST (funcao: fn_honorarios_parcela_pagar exige auth.uid())

## lead-captures — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `lead-captures` | GET | manager | A | — |

## leads — 20 rotas, 26 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `leads/[id]/attachments/[attachmentId]/media` | GET | viewer | A | storage |
| `leads/[id]/attachments` | GET | viewer | A | storage |
| `leads/[id]/attachments` | POST | agent | A | storage |
| `leads/[id]/attachments` | DELETE | agent | A | storage |
| `leads/[id]/clone` | GET | agent | A | — |
| `leads/[id]/clone` | POST | agent | A | — |
| `leads/[id]/contatos-relacionados` | GET | membro (B) | B | — |
| `leads/[id]/contatos-relacionados` | POST | agent | A | — |
| `leads/[id]/contatos-relacionados` | DELETE | agent | A | — |
| `leads/[id]/eventos` | GET | viewer | A | — |
| `leads/[id]/field-proposals/[pid]` | POST | agent | A | conferir filtro |
| `leads/[id]/field-proposals` | GET | viewer | A | — |
| `leads/[id]/lose` | POST | agent | A | — |
| `leads/[id]/move` | POST | agent | A | rpc emit_event |
| `leads/[id]/next-action` | POST | agent | A | — |
| `leads/[id]/reactivation` | POST | agent | A | conferir filtro |
| `leads/[id]/retomar` | POST | agent | A | — |
| `leads/[id]/timeline` | GET | membro (B) | B | conferir filtro; lib leads/timeline-query |
| `leads/[id]/win` | POST | agent | A | — |
| `leads/at-risk` | GET | agent | A | — |
| `leads/bulk` | POST | agent | A | rpc fn_mover_leads_em_lote, emit_event |
| `leads/import` | POST | agent | A | — |
| `leads/import` | GET | agent | A | — |
| `leads/proposals` | GET | membro (B) | B | — |
| `leads/reactivations` | GET | viewer | A | — |
| `leads` | POST | agent | A | — |

Fica de fora: `leads/[id]/conversion/retry` POST (nega: reenvia conversão à plataforma de anúncio)

## notifications — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `notifications/push` GET (sessao: o sujeito é a própria pessoa logada); `notifications/push` PUT (sessao: o sujeito é a própria pessoa logada); `notifications/push` DELETE (sessao: o sujeito é a própria pessoa logada)

## people — 2 rotas, 4 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `people/[id]` | GET | viewer | A | — |
| `people/[id]` | PATCH | agent | A | — |
| `people` | GET | viewer | A | — |
| `people` | POST | manager | A | — |

## phone-numbers — 2 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `phone-numbers/[id]` | PATCH | manager | A | — |
| `phone-numbers` | GET | manager | A | — |
| `phone-numbers` | POST | manager | A | — |

## proposals — 11 rotas, 15 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `proposals/[id]/assistant/apply` | POST | agent | A | — |
| `proposals/[id]/assistant/disponibilidade` | GET | agent | A | — |
| `proposals/[id]/assistant` | POST | agent | A | — |
| `proposals/[id]/decide` | POST | agent | A | — |
| `proposals/[id]/documento` | GET | viewer | A | — |
| `proposals/[id]/documento` | PATCH | manager | A | — |
| `proposals/[id]/modelo` | PATCH | manager | A | — |
| `proposals/[id]/preencher-com-conversa` | POST | manager | A | — |
| `proposals/[id]/previa` | GET | agent | A | — |
| `proposals/[id]/revise` | POST | manager | A | — |
| `proposals/[id]` | GET | viewer | A | — |
| `proposals/[id]` | PATCH | agent | A | — |
| `proposals/[id]` | DELETE | manager | A | — |
| `proposals` | GET | viewer | A | conferir filtro |
| `proposals` | POST | agent | A | conferir filtro |

Fica de fora: `proposals/[id]/send` POST (nega: envia a proposta ao cliente (D6))

## prospecting — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `prospecting/agents/chat` POST (sessao: o sujeito é a própria pessoa logada); `prospecting/agents/prepare` POST (sessao: o sujeito é a própria pessoa logada); `prospecting/agents` POST (sessao: o sujeito é a própria pessoa logada); `prospecting/agents/session` GET (sessao: o sujeito é a própria pessoa logada); `prospecting/agents/session` PATCH (sessao: o sujeito é a própria pessoa logada); `prospecting/importar` POST (sessao: recusa token por desenho (SO_SESSAO_POR_DESENHO da R0))

## tasks — 2 rotas, 4 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `tasks/[id]` | PATCH | agent | A | — |
| `tasks/[id]` | DELETE | agent | A | — |
| `tasks` | GET | viewer | A | — |
| `tasks` | POST | agent | A | — |

## voip — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `voip/trunk` GET (nega: credencial do tronco SIP); `voip/trunk` PUT (nega: credencial do tronco SIP)
