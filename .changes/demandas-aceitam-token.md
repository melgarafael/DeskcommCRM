---
impacto: capacidade_nova
secao: adicionado
titulo: Rotas de demandas aceitam token de integração
---
A rota de detalhe e gestão de demandas (`demandas/[id]`) passa a aceitar o token `dsk_…` de servidor. Integrações podem consultar dados da demanda (`mcp:read`, papel `agent`) e atualizar próximo passo ou encerrar a demanda (`mcp:write`, papel `agent`). A organização é isolada estritamente pela linha do token, impedindo acesso a demandas de outros tenants.
