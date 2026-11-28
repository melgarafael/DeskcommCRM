---
impacto: nada_mudou
secao: corrigido
titulo: A regra "Atribuir dono" com conversas leva também a conversa que a passagem para humano deixou sem dono
---

Quando a IA pedia um humano e, segundos depois, a regra `assign_owner` (com a
opção de levar as conversas) escolhia o dono do card, a conversa ficava aberta e
sem dono na Fila, às vezes por horas: a regra só movia conversa que já estava
com outra pessoa. Agora ela também leva a conversa do contato que passou por
handoff, está sem dono e não está com o automático no comando. A atribuição usa
a mesma porta do botão Transferir e não toma conversa que alguém assumiu no meio
do caminho.

Conversa sem dono que nunca passou por handoff continua na Fila, e a conversa
que voltou ao automático depois de uma pausa vencida fica com o automático. O
caso em que a regra roda segundos ANTES do handoff ainda não é coberto por esta
mudança.

Contribuição de @webtecnica, a partir da issue #5328.
