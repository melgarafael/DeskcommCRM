---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de Tarefas filtra por responsável
---

O seletor "Minhas | Todas" da tela de Tarefas virou o seletor "Responsável": Todos, Minhas, cada pessoa da equipe e Sem responsável. Antes dava para ver só as suas ou as de todo mundo; agora dá para ver só as de um colega, ou as que ainda não têm dono. O filtro vale também para a visão de calendário e é aplicado na própria consulta (a lista não perde tarefas por causa do limite de 500). O lembrete continua abrindo a tela em "Minhas", e uma tarefa criada com uma pessoa escolhida no filtro já nasce com ela como responsável. A API `GET /api/v1/tasks` passa a aceitar, em `assigned_to`, além de `me`, o id de um membro ou `ninguem`. Crédito: @flaviosiq.
