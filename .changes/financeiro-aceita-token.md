---
impacto: capacidade_nova
secao: adicionado
titulo: Financeiro e honorários aceitam token de integração nas rotas de leitura e de operação comum
---

As rotas de comandas, itens, fila de faturamento, fidelidade, lançamentos (extrato e pagamento), catálogo financeiro e contratos de honorários agora aceitam o token de integração (`Authorization: Bearer dsk_…`), com a mesma organização do token e o mesmo papel que a tela já exige. A leitura pede a permissão `mcp:read` e a escrita pede `mcp:write`; um token sem a permissão recebe 403. No catálogo, criar, editar e inativar pede papel `manager`; no extrato, pagar ou excluir lançamento pede `agent`; em fidelidade, pontuar ou resgatar pede `agent`.

Continuam só de sessão, e recusam o token: cancelar e estornar comanda, finalizar comanda, faturar em lote e pagar parcela de honorário. Essas operações dependem de funções do banco que exigem a sessão da pessoa logada (`auth.uid()`).

Cada chamada com token conta no teto de escrita da organização e do token: passou do limite, a resposta é 429 com `Retry-After`.
