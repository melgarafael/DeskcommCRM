---
impacto: capacidade_nova
secao: adicionado
titulo: A conversa na fila é distribuída quando o horário do atendente (ou da fila) abre
---

A conversa que não encontrava ninguém elegível voltava para a fila do roteamento e esperava um evento novo para ser redistribuída. Só que a abertura do horário não gera evento nenhum: a jornada do atendente é calculada na hora da consulta, e ninguém avisava o roteamento de que ela tinha virado. Na prática, o atendente entrava de plantão, a fila tinha gente disponível, e a conversa continuava parada até alguém mexer nela.

Agora, a cada minuto, o sistema verifica se a jornada de algum atendente — ou o horário de funcionamento de alguma fila — começou naquele minuto e, se começou, reabre a distribuição daquela empresa: as conversas sem dono voltam para o rodízio na mesma batida. Isso vale para o horário individual e para o horário da fila, cada um no fuso em que foi configurado, e vale tanto para a abertura do dia quanto para a volta do intervalo.

Continua valendo o que já era: conversa com dono não é tocada, fila fechada não distribui, e quem está fora do horário não recebe. A diferença é que a conversa não fica mais esperando um evento que ninguém ia emitir — ela sai na abertura.

Contribuição de @webtecnica, a partir da issue #3916.
