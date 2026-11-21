---
impacto: exige_acao
secao: corrigido
titulo: Na véspera e no dia do feriado nacional, o agente volta a marcar nos horários livres da Agenda
---

O aviso de feriado nacional que o agente recebe dizia "nem marque compromisso lá" na
véspera, mesmo com a opção "Não atender em feriado nacional" desligada e com horários
livres publicados na Agenda para o dia. Com a opção desligada (o padrão), o aviso
continua informando o feriado, mas manda seguir os horários livres da Agenda: horário
que aparece livre pode ser oferecido. Com a opção ligada, nada muda.

Contribuição de @yunshu0909, a partir da issue #5039.

## Requer atenção

Desde a v1.100.0, o agente recusava marcar compromisso na véspera e no dia do feriado
nacional. A partir desta versão, com a opção "Não atender em feriado nacional" desligada
(o padrão), ele passa a oferecer os horários que aparecem livres na Agenda nesse dia. Se
a sua empresa fecha em feriado nacional, antes de atualizar ligue essa opção no agente,
junto de "Só atender em horário de funcionamento", ou bloqueie o dia na Agenda.
