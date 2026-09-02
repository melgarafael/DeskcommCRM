---
impacto: nada_mudou
secao: corrigido
titulo: Fechar um negócio parou de avisar duas vezes, e o card não some mais numa coluna arquivada
---

Toda vez que alguém marcava um negócio como ganho ou perdido, o sistema
registrava o acontecimento **duas vezes**: uma pelo banco, que já fazia isso
sozinho, e outra pelo aplicativo, que não sabia que o banco já tinha feito.
Enquanto ninguém escutava esse registro, a duplicata era só ruído guardado. Ela
deixou de ser inofensiva quando as notificações no navegador passaram a escutar
exatamente esse aviso — daí em diante, um único negócio fechado tocava duas
vezes no celular de quem estava acompanhando.

Junto vinham duas coisas menores e do mesmo tipo, do jeito silencioso que
incomoda mais do que erro barulhento:

- Um funil cujo estágio de fechamento tinha sido **arquivado** continuava sendo
  usado. O negócio era fechado numa coluna que ninguém mais vê, sem aviso
  nenhum. Agora o sistema recusa e diz que falta um estágio de fechamento no
  funil, que é o que de fato está acontecendo.
- O card fechado caía em **posição aleatória** na coluna final, em vez de ir para
  o fim dela. Quem trabalha olhando o quadro perdia o negócio de vista.

Para quem opera, nada muda no dia a dia: nenhuma configuração nova, nenhum passo
de atualização, nenhum dado a corrigir. O que muda é que o aviso passa a sair uma
vez, e que fechar num funil mal configurado avisa em vez de sumir.

O achado é de @prevprocesso-maker, que instalou o sistema para um cliente e
percebeu a emissão em dobro lendo o próprio código.
