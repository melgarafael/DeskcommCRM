---
impacto: nada_mudou
secao: corrigido
titulo: Quando o agente responde em várias mensagens, elas chegam na ordem em que ele escreveu
---

O agente às vezes responde em mais de uma mensagem seguida. Até aqui, essas
mensagens podiam chegar ao cliente fora de ordem: a que abria a resposta (por
exemplo, "Boa pergunta! Pelo nome, acho que você quis dizer Enterprise") era
justamente a que esperava a pausa que imita alguém digitando, e as outras
passavam na frente.

Agora cada mensagem espera a anterior sair antes de ser enviada, e a conversa
chega na ordem em que o agente escreveu. As conferências feitas antes do envio
continuam rodando ao mesmo tempo, então a resposta não fica mais lenta. Nada a
configurar. Crédito: @maclevison.
