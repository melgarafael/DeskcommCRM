---
impacto: nada_mudou
secao: corrigido
titulo: O custo do Claude Haiku 5.5 deixa de cobrar 5× um turno que nunca passou de 100 mil por requisição
---

O **Claude Haiku 5.5** cobra 5× quando UMA requisição passa de 100 mil tokens de entrada. O custo gravado em **Uso e orçamento** somava os passos do turno antes de olhar esse limite: um turno de 3 requisições de 40 mil tokens (120 mil no total, nenhuma acima do limite) era gravado a 5×. Agora cada passo é avaliado pela própria entrada, então esse turno volta a 1×, e só um passo que realmente passe de 100 mil paga a faixa: 40 mil + 70 mil (110 mil no total) continua a 1×, e 40 mil + 100.001 cobra 5× apenas no passo maior. Um turno com um único passo continua igual, e os outros modelos não mudam. Nada a fazer na atualização.

A partir da issue #5239 de @hudson-souza-mkt, resto do conserto da #5017.
