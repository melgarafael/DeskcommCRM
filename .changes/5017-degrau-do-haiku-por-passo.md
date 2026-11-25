---
impacto: nada_mudou
secao: corrigido
titulo: O custo do Claude Haiku 5.5 passa a contar o preço acima de 100 mil tokens em cada passo do agente
---

Quando uma requisição ao **Claude Haiku 5.5** passa de 100 mil tokens de entrada (contando leitura e escrita de cache), a Anthropic cobra aquela requisição a 5× a tarifa. O custo gravado em **Uso e orçamento** ignorava essa faixa e ficava abaixo da fatura. Agora cada passo do laço de ferramentas do agente é cobrado pela sua própria entrada: só o passo que passou de 100 mil sai a 5×, e um turno de vários passos curtos continua a 1×, mesmo que a soma passe de 100 mil. Os outros modelos não mudam.

Relatado em #5017 por @hudson-souza-mkt.
