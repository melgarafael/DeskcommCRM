---
impacto: nada_mudou
secao: corrigido
titulo: Empresas paradas deixam de virar uma lista de ids na URL que crescia sem teto (5 varreduras)
---

Até aqui, cinco varreduras (a rodada de campanhas, o lembrete de agenda, o lote de conversas da base de conhecimento, o worker de prospecção e o relógio/executar) buscavam a lista de ids de todas as empresas não operantes e montavam um `not(organization_id, in, (...))` na URL do PostgREST. Num revendedor com muitas empresas paradas a URL crescia sem limite e, acima de `max_rows = 1000`, a lista voltava cortada sem aviso — as empresas além do corte voltavam a disparar campanha, prospecção, lembrete e embedding.

Agora o corte sai no banco, antes do `limit`: as varreduras embutem o status da organização com `!inner` e filtram `organizations.status` na própria consulta (o `ehOperante` segue linha a linha como cinto), a promoção de campanhas agendadas escolhe os ids antes de promover, e o worker de prospecção usa a régua SQL `fn_org_operante`. Com isso as linhas de uma empresa parada também deixam de ocupar a janela das empresas ativas. Nenhuma query monta mais a lista de ids de paradas na URL, e mais de 1.000 empresas paradas não escapam mais do filtro. Nenhuma configuração ou ação é necessária.

Refs #2015.

Contribuição de @webtecnica (#2022).