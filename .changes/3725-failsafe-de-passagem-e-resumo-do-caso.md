---
impacto: capacidade_nova
secao: corrigido
titulo: Fail-safe de passagem só abre caso com sinal de pessoa, o resumo abre pela última fala do cliente e a frase do aviso tem campo na tela
---

Quando o guardrail barrava uma mensagem em que a IA dizia que a equipe responderia depois, o fail-safe abria um caso humano — e o cliente, que só havia respondido «Não» a uma pergunta de horário, recebia o aviso de passagem como se tivesse pedido um atendente. Agora o caso só deixa de abrir quando NENHUMA mensagem do cliente naquela conversa tem sinal de pessoa; uma basta, inclusive nas palavras do dia a dia («preciso de um humano», «quero falar com o gerente», «atendente», «pessoa real»). Do lado da IA, «vai te atender», «vai assumir» e «vai entrar em contato» passaram a contar como passagem de verdade, e não como promessa de retorno. A promessa de retorno da equipe continua sendo barrada sem destino, e o modelo é ensinado a marcar o retorno — inclusive com os casos desligados, em que «nossa equipe vai te responder em breve» saía sem nada agendado.

O resumo do caso deixou de ser a última fala da IA e também deixou de começar pela mensagem mais antiga: ele abre pela última fala do cliente, com o motivo da abertura em seguida, e o extrato da conversa vem depois, com o papel de cada lado — quem abre a Central vê o que o cliente disse, e o aviso que chega no WhatsApp da equipe não perde mais o pedido mais recente no corte da mensagem.

A frase do aviso de passagem também mudou. Saiu a «Prefiro não arriscar aqui: passei seu pedido para um atendente humano»: o padrão agora é curto e humano, e a frase própria tem campo na tela do agente, gravada em `ai_agents.config.aviso_de_handoff` (sem migration). Deixar o campo vazio volta ao padrão; frase fora do tamanho de uma mensagem é recusada antes de salvar.

Contribuição de @webtecnica (#3725).
