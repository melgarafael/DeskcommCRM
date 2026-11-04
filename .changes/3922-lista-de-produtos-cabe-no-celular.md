---
impacto: nada_mudou
secao: corrigido
titulo: A lista de produtos cabe no celular — o nome do produto e o botão Desativar aparecem
---

No celular, a linha de cada produto em Produtos era mais larga que a tela: o
preço e os três botões de ação não encolhem, e a coluna do nome — a única que
podia ceder — encolhia até zero. O nome do produto não aparecia e o botão
«Desativar» saía cortado pela borda, sem que a página rolasse para o lado (quem
transbordava era a linha, não a tela).

Agora, abaixo de `md` a linha quebra em duas: nome e preço em cima, as ações
embaixo, alinhadas à direita e com quebra própria se ainda faltar espaço. O
nome volta a aparecer, encurtado com reticências quando é longo. No computador
nada muda: o conserto inteiro está sob `max-md:`, e a lista de lá para cima é
exatamente a mesma de antes.

Contribuição de @webtecnica (#3922).
