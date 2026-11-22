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
de atendente lista, abre e altera apenas as tarefas atribuídas a si, as que ele mesmo
criou e as que ainda não têm responsável — na tela e na API, inclusive quando a lista é
pedida direto, sem passar pela tela. Pedir a tarefa de outro atendente é recusado com uma
mensagem que diz isso, em vez de devolver uma lista vazia. A tarefa que ele criou e
entregou a um colega continua ao alcance dele, porque é o mesmo par que o banco já usava
para liberar a linha: responsável ou criador. Gerente e administrador continuam vendo as
tarefas de todos: é assim que distribuem o trabalho.

Desligada, esta opção não recorta nada por si. Isso não quer dizer que o atendente veja a
equipe inteira: quem decide o que ele enxerga é "O que cada atendente enxerga", em
Configurações › Atendimento, junto da opção "Atendentes podem mexer na agenda dos
colegas". Com esta última ligada — o padrão — ele vê a equipe inteira. Desligada, valem
os modos de visibilidade: em "Todos veem tudo", ele vê tudo; em "Os seus, mais os que
ainda não têm dono", vê as próprias, as que criou e as sem responsável; em "Só os seus",
vê as próprias e as que criou.
