---
impacto: capacidade_nova
secao: corrigido
titulo: O atendimento para de se desligar sozinho 15 minutos depois de ser ligado
---

Em Equipe › Atendimento, ligar a chave de um atendente durava
**cerca de quinze minutos**. Passado esse tempo, o sistema desligava a chave
sozinho e nada a religava — a pessoa aparecia como offline, deixava de receber conversas novas e
sumia dos horários oferecidos na Agenda, sem ter feito nada. Quem percebia
religava, e quinze minutos depois acontecia de novo.

A causa: uma rotina automática desligava quem não desse "sinal de vida", e esse
sinal **nunca foi implementado em lugar nenhum do sistema**. Como ninguém o
emitia, todo atendente era considerado ausente logo depois de se declarar
disponível — em toda instalação, sempre.

A rotina foi removida, e a disponibilidade passou a ser calculada na hora:

- chave **desligada** → indisponível, e ninguém religa por você
- chave **ligada, sem jornada publicada** → disponível 24 horas por dia
- chave **ligada, com jornada publicada** → disponível dentro dela, indisponível
  fora — e **volta sozinho** no início do próximo horário

Essa última linha é a que não existia: a jornada só sabia restringir, nunca
reativar. Agora a chave é a sua decisão ("eu atendo") e a jornada diz quando —
sem ninguém precisar ligar nada todo dia.

A coluna "Status" da tela passa a mostrar três estados em vez de dois:
**De plantão**, **Fora do horário** e **Desligado**. Antes, quem estava com a chave
ligada às 22h aparecia igual a quem tinha desligado — e ia procurar defeito onde
só havia uma jornada que terminou.

Você não precisa fazer nada para adotar. Se alguém da sua equipe estava
aparecendo como offline sem explicação, volta ao normal nesta versão.
