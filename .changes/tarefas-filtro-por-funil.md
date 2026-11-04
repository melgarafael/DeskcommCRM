---
impacto: capacidade_nova
secao: adicionado
titulo: A tela de Tarefas ganha o filtro por funil
---
A tela de Tarefas ganha, ao lado de situação e responsável, o seletor "Funil": "Todos os funis" (como a tela abre) ou um funil da organização, e só as tarefas dos negócios daquele funil aparecem, na lista e no calendário. O filtro é aplicado na consulta (`GET /api/v1/tasks?pipeline_id=`), então vale mesmo com mais de 500 tarefas, e combina com o de responsável. A tarefa herda o funil do negócio a que está presa: tarefa solta, sem negócio, só aparece com "Todos os funis". O seletor só aparece quando a organização tem dois ou mais funis. Crédito: @flaviosiq.
