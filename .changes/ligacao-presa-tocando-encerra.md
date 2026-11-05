---
impacto: nada_mudou
secao: corrigido
titulo: Ligação que ficou "tocando" sem ninguém ligar é encerrada sozinha
---

Quando o fim de uma ligação se perdia (a ligação caía antes de ser atendida e o
aviso de encerramento não chegava), ela ficava registrada como "tocando" para
sempre, e o painel de voz mostrava o banner de ligação chegando a quem abria o
CRM, sem ninguém do outro lado. Agora uma rotina a cada 5 minutos encerra toda
ligação que está tocando há mais de 5 minutos. Ligações em andamento não são
tocadas. Crédito: @lzandonadi.
