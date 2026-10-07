---
impacto: nada_mudou
secao: corrigido
titulo: A paleta de comandos (⌘K) volta a caber na tela
---

A busca rápida aberta por **⌘K** encostava no alto da janela e saía cortada: o conteúdo de cima ficava fora da tela, e não havia como rolar até ele.

A causa foi a animação de entrada dos sobrepostos. Ela termina numa posição fixa — o deslocamento que centraliza qualquer caixa de diálogo — e, como animação com `fill-mode` continua valendo depois de terminar, esse valor passava por cima do ancoramento próprio da paleta, que abria presa ao topo. O resultado era a paleta puxada meia altura para cima do ponto onde deveria estar.

Agora a paleta abre **centralizada**, com a sobra de altura repartida nas duas pontas e rolagem interna quando a lista é longa. E a animação passou a respeitar quem ancora diferente, em vez de impor a própria posição — assim um sobreposto que escolha outro ponto de abertura não quebra em silêncio.
