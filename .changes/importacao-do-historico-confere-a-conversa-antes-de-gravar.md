---
impacto: nada_mudou
secao: corrigido
titulo: A importação do histórico confere a conversa inteira antes de gravar a primeira mensagem dela
---

A importação do histórico passa a ler cada conversa duas vezes: a primeira só confere a regra de quem foi apagado a pedido, do começo ao fim da conversa, e só a segunda grava. Uma conversa barrada pela regra não deixa nenhuma mensagem, contato ou conversa no CRM.

O preço é o dobro de páginas pedidas ao canal; a importação leva mais rodadas para terminar, sem nada a fazer por quem opera.

Quando o canal não responde ao pedido de telefone de um contato identificado só pelo id do WhatsApp, a rodada para em erro, como já parava quando a consulta ao banco falhava, em vez de seguir conferindo pela metade.
