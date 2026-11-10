---
impacto: nada_mudou
secao: corrigido
titulo: Quadro do funil deixa de cortar em mil negócios sem avisar
---

O quadro do funil lia os negócios numa consulta só, e o banco corta toda resposta em mil linhas sem erro: um funil maior chegava incompleto e a tela o apresentava como inteiro. A leitura agora é paginada, filtra pela organização (o que também faz o banco usar o índice certo) e pede só as colunas que o quadro mostra. Nada muda para funis pequenos.

Crédito: @webtecnica.
