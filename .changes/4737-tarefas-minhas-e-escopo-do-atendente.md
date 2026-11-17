---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas abre em "Minhas" para atendentes, lembra o filtro e pode restringir cada um às próprias tarefas
---

Quem tem papel de atendente passa a abrir a tela de Tarefas em **Minhas** em vez de
**Todos**, e o último filtro de responsável escolhido volta no próximo carregamento —
também no outro aparelho, porque a escolha é guardada na preferência da pessoa, no
mesmo lugar da camada de datas da Agenda. O endereço `?assigned_to=me`, que o lembrete
de tarefa abre, continua ganhando de tudo.

Em Configurações › Distribuição de atendimento há uma opção nova, desligada de fábrica:
**"Atendente vê só as próprias tarefas (e as sem responsável)"**. Ligada, quem tem papel
de atendente lista, abre e altera apenas as tarefas atribuídas a si e as que ainda não
têm responsável — na tela e na API, inclusive quando a lista é pedida direto, sem passar
pela tela. Pedir ou abrir a tarefa de outro atendente é recusado com uma mensagem que diz
isso, em vez de devolver uma lista vazia. Gerente e administrador continuam vendo as
tarefas de todos: é assim que distribuem o trabalho.

Desligada, nada muda: o atendente vê a equipe inteira como hoje, e filtrar pelo id de um
colega continua funcionando.
