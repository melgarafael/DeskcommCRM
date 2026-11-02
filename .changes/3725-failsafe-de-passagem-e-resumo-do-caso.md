---
impacto: nada_mudou
secao: corrigido
titulo: Fail-safe de passagem não abre caso em resposta curta, o resumo vem da conversa e a frase do aviso é do agente
---

Quando o guardrail barrava uma mensagem em que a IA dizia que a equipe responderia depois, o fail-safe abria um caso humano — e o cliente, que só havia respondido «Não» a uma pergunta de horário, recebia o aviso de passagem como se tivesse pedido um atendente. Agora o caso só é aberto quando o cliente pediu uma pessoa com todas as letras («quero falar com um atendente», «me passa para alguém») ou quando a IA prometeu, de fato, envolver alguém naquele momento. A promessa de retomada continua sendo barrada sem destino, e o modelo é ensinado a marcar o retorno.

O resumo do caso deixou de ser a última fala da IA: ele traz as últimas mensagens da conversa, com o papel de cada lado, e o motivo do caso no fim — quem abre a Central vê o que o cliente disse, não uma frase solta do robô.

A frase do aviso de passagem também mudou. Saiu a «Prefiro não arriscar aqui: passei seu pedido para um atendente humano»: o padrão agora é curto e humano, e quem quiser o próprio tom escreve a frase em `ai_agents.config.aviso_de_handoff` (sem migration). Frase vazia ou fora do tamanho de uma mensagem é ignorada e o padrão continua valendo.

Contribuição de @webtecnica (#3725).
