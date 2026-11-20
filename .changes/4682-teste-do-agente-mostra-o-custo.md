---
impacto: nada_mudou
secao: corrigido
titulo: O teste do agente passa a registrar os tokens e o custo que ele gastou
---

Ao testar um agente pelo botão Testar, a execução ficava registrada com zero tokens e custo zero, embora as chamadas ao modelo tivessem custado de verdade. Agora a execução de teste fecha com a soma das chamadas daquele teste, tanto quando dá certo quanto quando falha. Dois testes do mesmo agente feitos ao mesmo tempo não misturam os custos. As conferências internas do turno (por exemplo, o checkpoint) ainda não entram nessa soma. Nenhuma ação é necessária na atualização.

Crédito: @webtecnica.
