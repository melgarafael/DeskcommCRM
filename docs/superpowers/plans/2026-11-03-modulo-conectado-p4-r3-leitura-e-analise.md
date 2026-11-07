# Fatia 4 (R3) — as rotas de leitura e análise aceitam token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 28 rotas de leitura e análise (31 métodos) — métricas, relatórios, anúncios, auditoria,
importações, leitura dos canais e das chamadas, mídia de mensagem — passam a aceitar o token `dsk_…` de
ponta a ponta, sem mudar nada para quem usa pela tela.

**Architecture:** cada tarefa é um PR de uma área, aplicando a receita comum
(`2026-11-03-modulo-conectado-receita-r.md`) às rotas da tabela no fim deste plano.

**Tech Stack:** Next.js 16 route handlers, Vitest, `lib/api/auth-dual.ts`, `lib/auth/public-paths.ts`.

**Spec:** `docs/specs/33-spec-modulo-conectado.md`, linha R3 e lista de negação da F3.

## Global Constraints

- Tudo da receita comum vale aqui.
- Escopo `mcp:read` (GET) e `mcp:write` (escrita: `messages/[id]/hide`, `metrics/atrito` PATCH, `imports`
  POST).
- Ficam de fora (já decidido, não converter): toda escrita em `channel-sessions/*`, mais
  `channel-sessions/[id]/qr` e `pairing-code` (conexão e pareamento do canal); `voice/*`, exceto
  `voice/calls/history`, `voice/opt-in` GET e `voice/sessions/status`; `audit/export`; `modulos` e
  `modulos/instalar` (administração de extensões). `anuncios/google/[org]`, `anuncios/meta/[org]` e
  `rastreio/[id]` já são públicas por desenho e não entram.
- Depende da fatia 1 (R0). Não depende de R1 nem de R2.

## Review Focus

Os cinco da receita comum, mais:
1. **`metrics/*` e `reports/*`** somam dados da organização inteira: o caso "token de B" confere que a
   soma de B não inclui nenhuma linha de A, com linhas das duas organizações no falso.
2. **`messages/[id]/media`** serve arquivo do bucket `whatsapp-media`: o caminho do objeto sai de uma linha
   de `messages` filtrada pela organização do token, nunca do path.
3. **`channel-sessions` GET** devolve a coluna `metadata` (`app/api/v1/channel-sessions/route.ts:29-30`).
   O PR lista as chaves que ela guarda hoje. Se alguma for credencial ou endereço de webhook, a resposta pelo
   token sai sem essa chave, e um caso do teste confere.
4. **`audit` GET** devolve a auditoria da organização: confere que a consulta filtra organização mesmo
   para o papel `manager`, e que o token não vê ações da plataforma (`organization_id` nulo).

---

## Tarefas (um PR cada)

Cada tarefa segue "O caminho de cada tarefa" da receita, com as rotas das seções indicadas da tabela.

### Task 1: `metrics`, `reports`
### Task 2: `ads`, `audit`, `imports`
### Task 3: `channel-sessions` (só leitura), `voice` (só leitura)
### Task 4: `messages`, `modulos/[modulo]/[objeto]`

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
naquela rota.

## ads — 2 rotas, 2 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `ads/meta/accounts` | GET | manager | A | — |
| `ads/meta/campaigns` | GET | manager | A | — |

## anuncios — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `anuncios/google/[org]` GET (publica: já pública, sem sessão nem token, por desenho); `anuncios/meta/[org]` GET (publica: já pública, sem sessão nem token, por desenho)

## audit — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `audit` | GET | manager | A | — |

Fica de fora: `audit/export` GET (nega: exportação de dado pessoal ou de auditoria)

## channel-sessions — 7 rotas, 7 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `channel-sessions/[id]/acervo` | GET | admin | A | — |
| `channel-sessions/[id]/ai-access` | GET | admin | A | rpc fn_configurar_pre_go_live_canal |
| `channel-sessions/[id]/disabled` | GET | admin | A | rpc fn_definir_canal_desativado |
| `channel-sessions/[id]/groups` | GET | manager | A | — |
| `channel-sessions/[id]/historico` | GET | admin | A | — |
| `channel-sessions/[id]` | GET | membro (B) | B | — |
| `channel-sessions` | GET | membro (B) | B | — |

Fica de fora: `channel-sessions/[id]/acervo` PATCH (nega: conexão e configuração do canal); `channel-sessions/[id]/ai-access` PATCH (nega: conexão e configuração do canal); `channel-sessions/[id]/disabled` PATCH (nega: conexão e configuração do canal); `channel-sessions/[id]/groups` PUT (nega: conexão e configuração do canal); `channel-sessions/[id]/historico` POST (nega: conexão e configuração do canal); `channel-sessions/[id]/name` PATCH (nega: conexão e configuração do canal); `channel-sessions/[id]/pairing-code` POST (nega: pareamento do canal); `channel-sessions/[id]/qr` GET (nega: pareamento do canal); `channel-sessions/[id]/reconnect` POST (nega: conexão e configuração do canal); `channel-sessions/[id]` DELETE (nega: conexão e configuração do canal); `channel-sessions/disabled` PATCH (nega: conexão e configuração do canal); `channel-sessions` POST (nega: conexão e configuração do canal)

## imports — 2 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `imports/[id]` | GET | viewer | A | — |
| `imports` | GET | viewer | A | — |
| `imports` | POST | manager | A | — |

## messages — 2 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `messages/[id]/hide` | POST | manager | A | — |
| `messages/[id]/hide` | DELETE | manager | A | — |
| `messages/[id]/media` | GET | membro (B) | B | storage; conferir filtro |

## metrics — 7 rotas, 8 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `metrics/atrito` | GET | agent | A | rpc fn_atrito_metrics; conferir filtro |
| `metrics/atrito` | PATCH | manager | A | rpc fn_atrito_metrics; conferir filtro |
| `metrics/attendants` | GET | agent | A | rpc fn_attendant_metrics |
| `metrics/channels` | GET | agent | A | rpc fn_channel_metrics |
| `metrics/funil` | GET | agent | A | rpc fn_atrito_metrics |
| `metrics/lost` | GET | manager | A | — |
| `metrics/metas` | GET | agent | A | — |
| `metrics/serie` | GET | agent | A | conferir filtro |

## modulos — 1 rotas, 1 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `modulos/[modulo]/[objeto]` | GET | viewer | A | — |

Fica de fora: `modulos/instalar` POST (nega: administração de extensões (requireExtensionPlatform)); `modulos` GET (nega: administração de extensões (requireExtensionPlatform))

## rastreio — 0 rotas, 0 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|

Fica de fora: `rastreio/[id]` GET (publica: já pública, sem sessão nem token, por desenho)

## reports — 3 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `reports/activities` | GET | viewer | A | rpc fn_activity_report |
| `reports/financeiro` | GET | viewer | A | rpc fn_relatorio_financeiro |
| `reports/tags` | GET | viewer | A | rpc fn_tags_de_conversa_em_uso |

## voice — 3 rotas, 3 métodos a converter

| Rota | Método | Papel hoje | Receita | Sinais |
|---|---|---|---|---|
| `voice/calls/history` | GET | agent | A | — |
| `voice/opt-in` | GET | manager | A | — |
| `voice/sessions/status` | GET | membro (B) | B | — |

Fica de fora: `voice/calls/[id]/accept` POST (nega: chamada de voz em tempo real e pareamento); `voice/calls/[id]/reject` POST (nega: chamada de voz em tempo real e pareamento); `voice/calls/[id]` DELETE (nega: chamada de voz em tempo real e pareamento); `voice/calls/[id]/webrtc` POST (nega: chamada de voz em tempo real e pareamento); `voice/calls` POST (nega: chamada de voz em tempo real e pareamento); `voice/events` GET (nega: chamada de voz em tempo real e pareamento); `voice/opt-in` PUT (nega: consentimento de chamada de voz); `voice/sessions/pair` POST (nega: chamada de voz em tempo real e pareamento); `voice/sessions` DELETE (nega: chamada de voz em tempo real e pareamento)
