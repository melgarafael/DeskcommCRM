---
impacto: nada_mudou
secao: corrigido
titulo: O custo estimado do Haiku 5.5 passa a aplicar o preço 5x acima de 100 mil tokens
---

A tela de uso de IA calculava o custo estimado com a mesma taxa para qualquer
tamanho de chamada. No Haiku 5.5, a chamada que passa de 100 mil tokens de
entrada custa 5 vezes mais, na chamada inteira, e o estimado ficava bem abaixo
do que o provedor cobra. Agora o estimado aplica esse degrau, e a tela aponta o
agente cujas chamadas passam do limite com frequência.

Os outros modelos e as chamadas até 100 mil tokens continuam com o mesmo
cálculo. O catálogo de preços no banco não muda.
