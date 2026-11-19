---
impacto: capacidade_nova
secao: adicionado
titulo: A conversa na fila é distribuída quando o horário do atendente (ou da fila) abre
---

A conversa que não encontrava ninguém elegível voltava para a fila do roteamento e era tentada de novo de tempos em tempos: a cada minuto nas primeiras tentativas e, passado o limite, a cada 15 minutos (ou no intervalo configurado, se for maior). A abertura do horário não gera evento nenhum, porque a jornada do atendente é calculada na hora da consulta. Por isso, quando o atendente entrava de plantão, a conversa esperava a próxima tentativa, o que podia levar até 15 minutos (até 1 hora com o intervalo máximo).

Agora, no minuto em que a jornada de um atendente ou o horário de uma fila começa, o sistema reabre a distribuição daquela empresa, e as conversas sem dono entram no rodízio na mesma batida. Isso vale para o horário individual e para o horário da fila, cada um no fuso em que foi configurado, na abertura do dia e na volta do intervalo. Isso inclui a conversa que alguém liberou: ela volta ao rodízio na próxima abertura de horário, como já volta hoje quando alguém da equipe muda a própria disponibilidade.

Continua valendo o que já era: conversa com dono não é tocada, fila fechada não distribui, e quem está fora do horário não recebe.

Contribuição de @webtecnica, a partir da issue #3916.
