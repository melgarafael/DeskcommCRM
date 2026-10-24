---
impacto: nada_mudou
secao: corrigido
titulo: A importação do catálogo recusa estoque inválido em vez de mudar a quantidade
---

Estoque negativo, fracionado ou com texto passa a gerar um erro na linha da planilha, sem sobrescrever o produto já cadastrado. Antes, por exemplo, `-5` virava 5 unidades e `2,5` virava 25, sem aviso. As outras linhas continuam sendo importadas; estoque vazio continua zero, e milhares bem formados continuam aceitos. Quantidades importadas antes desta correção precisam ser conferidas na planilha de origem. Crédito: @samirhvbr.
