---
impacto: capacidade_nova
secao: corrigido
titulo: A prospecção passa a abordar empresas de fora do Brasil quando o telefone já vem com o código do país
---
Uma busca fora do Brasil encontrava as empresas e não conseguia abordar nenhuma: o telefone que o Google devolve com o código do país escrito nele (por exemplo `+351 912 345 678`) era descartado na entrada da busca, e toda empresa ficava como "Não abordado" por não ter telefone válido — a busca é paga e não produzia abordagem nenhuma. Agora esse telefone é aceito como veio, com o `+` na frente, e a empresa entra na fila normalmente. Números brasileiros continuam exatamente como antes, com ou sem o código do país, e continua não havendo adivinhação: número sem `+` e fora dos tamanhos brasileiros segue sem telefone válido, para nunca transformar um número local no número de outro país. Nada a fazer na atualização.
