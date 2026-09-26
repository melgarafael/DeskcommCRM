---
impacto: capacidade_nova
secao: adicionado
titulo: Motivos de perda com categoria, filtro por motivo e relatório de perdas
---

Em **Configurações › Funis**, cada motivo de perda ganha uma categoria (Cliente, Concorrência, Mérito, Nós, Ausência). No quadro, com a aba **Perdidos**, aparecem os filtros **Motivo** e **Categoria**, que viram link (`?motivo=`, `?categoria=`). Em **Métricas**, quem é gerente ou admin vê o relatório **Perdas**: por motivo, por categoria e pela etapa de onde o negócio saiu, com o valor separado por moeda (moedas nunca são somadas). Transferência entre funis não conta como perda. A tool MCP `crm_list_leads` aceita `lost_reason` e `lost_reason_category`.

A coluna nova `crm_leads.lost_from_stage_id` passa a ser gravada a partir desta versão. Perdas anteriores aparecem como "Etapa desconhecida", porque não há como saber a etapa delas sem inventar.

Não há ação para quem opera a VPS: funis com motivos só de texto continuam funcionando como antes e nenhum dado existente é reescrito.

Contribuição de @webtecnica (#1715).
