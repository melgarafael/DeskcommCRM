---
impacto: capacidade_nova
secao: corrigido
titulo: A tela da Nuvemshop diz que o catálogo vai para Agente de IA › Conhecimento e mostra o estado dele
---

A integração com a Nuvemshop dizia que sincronizava "pedidos, produtos e
clientes", e quem conectava a loja ia procurar os produtos em CRM › Produtos,
onde eles nunca aparecem. O catálogo sempre foi para o acervo do agente, na
fonte "Catálogo de produtos". Agora a tela da integração e o `docs/SETUP.md`
dizem isso, e a tela ganhou um cartão com o estado da fonte (trechos, último
preparo e erro), com o botão "Preparar de novo" para administradores e
gerentes. Nenhuma rota, tabela ou migration nova. Contribuição de @webtecnica
(#4357).
