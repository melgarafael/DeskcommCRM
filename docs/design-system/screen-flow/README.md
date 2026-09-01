---
title: Screen Flow — Mapa de Jornadas e Telas do SonghaiCRM
parent: docs/design-system/00-overview.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
---

# Screen Flow — Índice

> Mapeamento exaustivo de **quem usa**, **que jornadas existem**, **quais telas precisam ser construídas**, **como elas se conectam** e **quais estados cada uma carrega** — antes de qualquer linha de UI real. Esta pasta antecede stories e specs de UI; serve de contrato visual entre PRDs (PT-BR, prioridade MVP-B).

## Ordem de leitura recomendada

| # | Arquivo | O que entrega |
|---|---|---|
| 1 | [`00-personas.md`](./00-personas.md) | 5 personas com JTBD, frustrations e métricas |
| 2 | [`01-sitemap.md`](./01-sitemap.md) | Árvore canônica de rotas Next.js (app + admin) |
| 3 | [`02-journeys.md`](./02-journeys.md) | 5 jornadas críticas passo-a-passo |
| 4 | [`03-screen-inventory.md`](./03-screen-inventory.md) | Tabela exaustiva de ~70 telas com estados |
| 5 | [`04-clickflows.md`](./04-clickflows.md) | Diagramas Mermaid `flowchart` por fluxo |
| 6 | [`05-state-machines.md`](./05-state-machines.md) | Máquinas de estado (`stateDiagram-v2`) |
| 7 | [`06-empty-states-and-errors.md`](./06-empty-states-and-errors.md) | Catálogo de empty states e errors em PT-BR |
| 8 | [`07-responsive-strategy.md`](./07-responsive-strategy.md) | Comportamento por breakpoint |
| 9 | [`08-accessibility.md`](./08-accessibility.md) | Atalhos, ARIA, foco e contraste |

## Princípios que governam todo este pacote

1. **Inbox 3 colunas é a "home" do produto** — pós-login, todo operador BPO e atendente cai em `/app/inbox`. Dashboard é secundário.
2. **Super-admin BPO tem UI separada (`/admin`)** com inbox cross-tenant como default — ele opera atendendo, não monitorando passivamente.
3. **Realtime é invariante visual** — toda surface tem banner de reconexão; nenhuma UI assume canal estável.
4. **Mobile não é foco MVP** mas degrada graciosamente — atendente em deslocamento abre `/chat` e responde.
5. **Vocabulary é injetado via hook** — nenhuma tela hardcoda "Pedido", "Cliente", "Pago"; tudo passa por `usePipelineVocabulary()`.
6. **LGPD é cidadã de primeira classe** — pedido vira tela acionável (`/app/lgpd/requests/[id]`), não fluxo escondido.

## Convenções dos diagramas

- Mermaid `flowchart` pra clickflows (decisões com `{}` e estados com `()`)
- Mermaid `stateDiagram-v2` pra ciclos de vida
- Telas referenciadas pelo path do sitemap (`/app/inbox/[conversationId]`)
- PRDs citados como `Sub-PRD 04 §3.6` (sub-prd + section)
