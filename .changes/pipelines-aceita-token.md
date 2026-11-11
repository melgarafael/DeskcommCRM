---
impacto: capacidade_nova
secao: adicionado
titulo: Funis do CRM aceitam token de integração
---
As rotas de funis (`pipelines`, `pipelines/default`, `pipelines/[id]`, `pipelines/[id]/agent-mapping`, `pipelines/[id]/board`, `pipelines/[id]/leads`, `pipelines/[id]/stages` e `pipelines/[id]/stages/win-rates`) passam a aceitar o token `dsk_…` de servidor, desde que ele tenha `config:read` (leitura) ou `config:write` (escrita) e papel admin. Cada consulta filtra a organização da linha do token. A previsão do funil (`pipelines/[id]/forecast`), a criação de etapa e a edição de etapa continuam somente de sessão.
