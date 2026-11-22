---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas abre em "Minhas" para atendentes, lembra o último filtro e mostra o recorte que a empresa já aplica
---

Quem tem papel de atendente passa a abrir a tela de Tarefas em **Minhas** em vez de
**Todos**. O último filtro de responsável escolhido volta no próximo carregamento,
também em outro aparelho, porque a escolha fica guardada na preferência da pessoa, no
mesmo lugar da camada de datas da Agenda. O endereço `?assigned_to=me`, que o lembrete
de tarefa abre, continua ganhando de tudo. Gerente e administrador seguem abrindo em
**Todos**.

Não há opção nova. Quem decide o que o atendente vê em Tarefas continua sendo o que já
existe: "Atendentes podem mexer na agenda dos colegas" e "O que cada atendente enxerga".
Quando essas opções recortam a lista, a tela passa a dizer isso abaixo do título, e o
filtro de responsável deixa de oferecer os colegas, porque a lista de um colega viria só
com as tarefas que a própria pessoa criou para ele. "Todos" continua no filtro e traz
exatamente o que o banco libera. Contribuição de @webtecnica, a partir da issue #4737.
