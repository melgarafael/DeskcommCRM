---
impacto: capacidade_nova
secao: adicionado
titulo: A comanda ganhou as rotas que faltavam
---

As tabelas da comanda e as funções que movem dinheiro já existiam, e nada as
chamava: o módulo estava inteiro no banco, sem porta.

Agora `/api/v1/financeiro/comandas` abre, lista, recebe item, dá desconto,
cancela, finaliza e estorna. A comissão de cada item é resolvida na entrada, com
a precedência combinada (pessoa e serviço vence pessoa, que vence serviço), e
fica congelada na linha: mudar a regra amanhã não mexe no que já foi feito.

A tela do balcão ainda não existe; por enquanto o caminho é a API.
