---
impacto: capacidade_nova
secao: adicionado
titulo: Falta sem retorno depois da régua de recuperação vira aviso na Central
---

Quando um cliente falta a um compromisso e a equipe confirma a falta, o sistema já matricula
esse contato num fluxo de recuperação — as mensagens de reengajamento que tentam remarcar. Até
agora, se a régua inteira era enviada e o cliente **nunca respondia**, o fluxo simplesmente
terminava: o card ficava parado na mesma etapa e ninguém era avisado de que a recuperação tinha
esgotado.

Agora, quando isso acontece, abre um aviso na Central de avisos apontando para o compromisso —
"Cliente faltou e não respondeu à recuperação" —, para alguém decidir o próximo passo e mover o
card no funil. É um aviso por falta (o mesmo compromisso remarcado gera uma falta nova, e um
aviso novo); reprocessar não duplica.

O construtor de fluxo não move etapa por conta própria de propósito — faltar a uma visita não é
o negócio esfriando, e quem decide isso continua sendo uma pessoa.
