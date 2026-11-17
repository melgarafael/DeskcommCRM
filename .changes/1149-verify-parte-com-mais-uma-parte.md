---
impacto: nada_mudou
secao: corrigido
titulo: CI tem mais uma parte de verificação, e nenhuma parte estoura mais o orçamento de 12 minutos
---

A verificação de cada PR é dividida em partes paralelas, e cada parte tem um
orçamento de 12 minutos. A primeira parte passou a levar 13 minutos em cima de
uma `main` sem nenhum teste quebrado: a suíte unitária cresceu, e essa parte
carregava sozinha o typecheck (191 s) e a fatia mais pesada dos testes (591 s).

O conserto é o que o próprio CI prescreve: mais uma parte, em vez de subir o
orçamento. Agora são sete partes de testes unitários (eram seis) e o typecheck
saiu da primeira para a parte do kit pesado, que tinha folga. Nenhum teste saiu
de lugar e nenhum passo ficou sem dono — a suíte continua inteira, e o detector
de crescimento segue em 12 minutos por parte.

Quem contribui não precisa fazer nada: a mudança é do CI, e a atualização não
exige nenhuma ação além do normal.

Contribuição de @webtecnica, a partir da issue #1149.
