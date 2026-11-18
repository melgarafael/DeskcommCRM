---
impacto: capacidade_nova
secao: adicionado
titulo: Financeiro e honorários aceitam token de integração para leitura
---

As rotas de leitura do catálogo financeiro, das comandas (a lista, uma comanda e a fila de faturamento), da fidelidade (saldo e extrato), do extrato de lançamentos e dos contratos e parcelas de honorários agora aceitam o token de integração (`Authorization: Bearer dsk_…`). A leitura pede a permissão `mcp:read` e o mesmo papel que a tela já exige; a organização é a do token, e cada chamada conta no teto do token e da organização: passou do limite, a resposta é 429 com `Retry-After`.

Toda escrita no financeiro e nos honorários continua só pela tela e recusa o token com 401: abrir, alterar e cancelar comanda, lançar e tirar item, finalizar, estornar e faturar em lote, catálogo, fidelidade, lançamentos e contratos e parcelas de honorários. Abrir a escrita por token virá numa fatia própria.

Contribuição de @paulolimajr77 (#4391).
