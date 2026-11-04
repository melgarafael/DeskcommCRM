---
impacto: nada_mudou
secao: corrigido
titulo: No celular, o cabeçalho dos cartões de Provedores de IA usa a largura toda e o título não quebra mais palavra por palavra
---

Em Provedores de IA, com a tela a 375 px, o título e a descrição de cada ponto de
IA ficavam espremidos numa coluna estreita — o título quebrava palavra por
palavra, e a descrição virava uma tira de texto. A tela não rolava para o lado,
então não parecia um defeito de largura: o culpado era o cabeçalho do cartão, que
reservava a linha inteira para o modelo e a origem e deixava o resto para o
texto.

Agora, abaixo de `md`, o título e a descrição ocupam a largura do cartão e o
modelo, a origem e os selos descem para a linha de baixo, alinhados à esquerda.
No computador nada muda: as duas colunas continuam dividindo a linha, como antes.
Vale para todos os pontos, incluindo os do turno do agente, do operador e os de
proposta. O seletor de modelo não foi tocado.
