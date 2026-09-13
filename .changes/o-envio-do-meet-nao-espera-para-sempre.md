---
impacto: capacidade_nova
secao: corrigido
titulo: "Enviar link ao cliente" para de travar 30 segundos quando o cliente está sendo atendido
---

Medido numa instalação real: clicar em "Enviar link ao cliente" ficava cerca de **30 segundos** parado e terminava em *"Erro inesperado. Tente novamente."*

O banco não era o problema — chamado do mesmo jeito, ele responde em **19 milésimos de segundo**. O que acontecia é que o pedido entrava numa **fila de espera pelo mesmo cliente**: outras operações do sistema pegam uma trava por contato, e essa trava não tinha prazo. O pedido esperava; o intermediário desistia aos 10 segundos; e a tela tentava de novo sozinha — **pondo mais um na fila**. Três tentativas, meio minuto, e uma frase que não dizia nada.

Agora a espera tem teto de **3 segundos**. Passou disso, a tela diz o que está acontecendo — *"este cliente está sendo atendido neste instante, espere alguns segundos e tente de novo"* — e **não repete sozinha**.

É o mesmo tipo de problema que fazia a atualização apagar regras de acesso: disputa por trava com o sistema em uso. Lá o sintoma era tela vazia; aqui era "erro inesperado".
