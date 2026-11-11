---
impacto: capacidade_nova
secao: adicionado
titulo: A IA responde numa conversa com dono sem tirar a conversa de quem atende
---
Um controle no cabeçalho da conversa liga a IA numa conversa que ja tem atendente, e o dono continua o mesmo: fila, carteira, contadores e visibilidade nao mudam, e a IA deixa de ser vetada pelo fato de haver um dono humano. Quando a IA passa a conversa para uma pessoa nesse modo, ela volta para o mesmo atendente — sem `release`, sem rodizio. O modo mora em `conversations.metadata.ai_com_dono`, e desligar remove a chave. Ligar nao chama `fn_conversation_assign`: nenhuma atribuicao e reescrita. Recusa 409 em conversa encerrada, sem dono ou com contato que pediu para a IA nao responder. Missao com instrucao, escolha de agente e modo de contexto ficam para a fatia seguinte.
