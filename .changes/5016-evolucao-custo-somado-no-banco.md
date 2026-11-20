---
impacto: nada_mudou
secao: corrigido
titulo: O custo da IA no Painel de Evolução conta o período inteiro, e o painel avisa quando um número é só uma parte
---

O card "Custo da IA no período" somava só as primeiras 1.000 chamadas do período (o
limite de linhas por leitura), então quem tem mais chamadas via o custo dos dias mais
antigos. Agora o custo é somado no banco, pela mesma conta da tela Uso de IA. E quando
outro bloco do painel bate nesse limite, ou não pôde ser lido, uma faixa no topo diz
quais números estão incompletos, em vez de mostrá-los como se fossem exatos; nesse caso
"O que está travando" também deixa de dizer que nada está travando.

Contribuição de @yunshu0909, a partir da issue #5016.
