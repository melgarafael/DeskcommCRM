# Funcionalidades — Análise

O que há aqui: desempenho, relatórios, faturamento e trilhas.
Extraído do CHANGELOG até a 1.79.0 e conferido contra o menu e o código em 2026-10-10.
O menu e o código mandam sobre este arquivo; para ver o que mudou depois, use
`bash scripts/buscar.sh <palavra>` (a pasta é a da skill).

### Análise → Atividades

- **Aba Por etiqueta** — Relatórios ganham aba com conversas, espera média e fatia por etiqueta no período. (API desde a 1.63.0). Onde: Análise → Atividades → Por etiqueta. _(desde 1.63.0)_
- **Relatório de atividades** — Atividades separa equipe, IA e automático em barras, rankings e lista. _(desde 1.15.0)_

### Análise → Audit Log

- **Poda de retenção conta os lotes e falha sozinha** — Poda interrompida no meio leva as contagens dos lotes que já passaram (o relatório e a auditoria deixam de registrar zero para o que já foi apagado); poda que falha não pula a anonimização do dia nem some com as contagens das outras — cada uma falha sozinha e é nomeada no relatório, e a retomada da LGPD roda de qualquer jeito. Onde: Análise → Audit Log (rodada do `data-retention`). _(desde 1.79.0)_
- **Auditoria mostra antes e depois** — O log passa a trazer valor anterior e novo de valor, moeda, responsável e data. _(desde 1.73.0)_
- **Auditoria que não apaga** — Todo feito fica registrado com retenção de cinco anos. _(desde 1.0.0)_

### Análise → Desempenho

- **Quadro Por canal** — Métricas ganham linha por número com conversas, primeira resposta humana e sem resposta. _(desde 1.77.0)_
- **Número da automação** — Atrito separa mensagens do agente das enviadas por automação com nome próprio. Onde: Análise → Desempenho → atrito. _(desde 1.36.0)_
- **Índice de Atrito** — Desempenho mede o propósito do sistema com régua própria. Onde: Análise → Desempenho → atrito. _(desde 1.2.0)_
- **Perdas silenciosas contam** — Abandono, repergunta e espera calada passam a ser medidos. Onde: Análise → Desempenho → atrito. _(desde 1.2.0)_
- **Números por atendente** — Desempenho separa o feito de cada pessoa sem misturar. _(desde 1.0.0)_

### Análise → Faturamento

- **Lançar fora da comanda** — Dá para lançar entrada ou saída, pagar depois; pago só se desfaz ao contrário. Onde: Análise → Faturamento → lançar. _(desde 1.41.0)_
- **Relatório de faturamento** — Faturamento responde entradas, saldo, ticket e comissão por pessoa e período. _(desde 1.41.0)_
- **Faturamento por serviço** — Listas mostram os dez serviços e clientes que sustentam a casa. Onde: Análise → Faturamento → listas. _(desde 1.41.0)_

### Análise → Honorários

- **Módulo de Honorários** — Tela registra contrato e parcelas; a IA responde sobre cobrança e pagamento. _(desde 1.61.0)_

### Análise → Hub "Ver tudo em Análise"

- **Hub Ver tudo em Análise** — Visão geral lista as cinco com frase; menu fica com três semanais. _(desde 1.15.0)_

### Análise → Meta Ads

- **Meta Ads no CRM** — Tela lê campanhas com custo e alcance ao clicar Atualizar, sem guardar nada. (coluna Connect rate na 1.34.0). _(desde 1.15.0)_
