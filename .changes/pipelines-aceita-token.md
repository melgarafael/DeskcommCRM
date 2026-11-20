---
impacto: capacidade_nova
secao: adicionado
titulo: Funis do CRM aceitam token de integração
---
As rotas de funis (`pipelines`, `pipelines/default`, `pipelines/[id]`, `pipelines/[id]/agent-mapping`, `pipelines/[id]/board`, `pipelines/[id]/forecast`, `pipelines/[id]/leads`, `pipelines/[id]/stages`, `pipelines/[id]/stages/[stageId]` e `pipelines/[id]/stages/win-rates`) passam a aceitar o token `dsk_…` de servidor, desde que ele tenha `config:read` (leitura) ou `config:write` (escrita) e papel admin. Cada consulta filtra a organização da linha do token. Isso inclui a previsão do funil e criar, editar e apagar etapas. Crédito: @paulolimajr77.
