---
impacto: capacidade_nova
secao: adicionado
titulo: Financeiro e honorários aceitam token de integração nas rotas de leitura e de operação comum
---

As rotas de comandas, itens, fila de faturamento, fidelidade, lançamentos
(extrato), catálogo financeiro e contratos de honorários agora aceitam o token
de integração (`Authorization: Bearer dsk_…`), com a mesma organização do token
e o mesmo papel que a tela já exige. A leitura pede a permissão `mcp:read` e a
escrita pede `mcp:write`; um token sem a permissão recebe 403.

Continuam só de sessão, e recusam o token: baixar, cancelar e estornar
lançamento, finalizar e estornar comanda, faturar em lote, pagar parcela, gerar
parcela de cobrança e mexer em saldo de fidelidade, conta ou catálogo de
pagamento. Esses caminhos são de dinheiro e exigem a tela.

Cada chamada com token conta no teto de escrita da organização e do token: passou
do limite, a resposta é 429 com `Retry-After`.
