---
impacto: nada_mudou
secao: corrigido
titulo: O agente escreve a mensagem, a busca e o caso no idioma da conversa, não em português fixo
---

Três ferramentas do agente diziam ao modelo para escrever "em pt-br": o corpo da
mensagem ao cliente, a busca na base de conhecimento e o resumo do caso aberto
para a equipe. Numa operação em outro idioma, isso aparecia quando não havia
mensagem do cliente para ancorar o idioma — por exemplo, um caso aberto durante
um follow-up saía inteiro em português — e a busca procurava em português num
material escrito em espanhol. Agora as três pedem o idioma da conversa com o
cliente.
