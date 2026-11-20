---
impacto: nada_mudou
secao: corrigido
titulo: Quando a IA não consegue responder nem depois da correção automática, a Central avisa mesmo com os casos desligados
---

Quando o turno termina sem mensagem nenhuma ao cliente e a correção automática também falha (a resposta foi barrada de novo pelas regras de segurança, veio cortada no limite de tamanho ou gastou todas as etapas sem responder), a equipe ficava sabendo só se os casos estivessem ligados no agente. Com os casos desligados, que é o padrão, o único rastro era o log de erro do turno: o cliente ficava sem resposta e ninguém na Central sabia.

Agora, com os casos desligados, a Central abre um aviso crítico apontando para a conversa, com o mesmo texto que o caso teria: o que aconteceu com o cliente e por que a IA travou. É um aviso aberto por conversa e por causa, então turnos repetidos não empilham avisos. Com os casos ligados nada muda: o caso abre como antes e nenhum aviso a mais aparece.

Crédito: @shu-chen-dot-ca (#4665).
