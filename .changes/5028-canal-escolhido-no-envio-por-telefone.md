---
impacto: capacidade_nova
secao: adicionado
titulo: Envio por telefone aceita escolher de qual número a mensagem sai (channel_session_id opcional)
---

O `POST /api/v1/messages` com `phone_number` passa a aceitar um campo opcional `channel_session_id`: com mais de um número conectado, quem chama escolhe por qual sessão a mensagem sai. Sem o campo nada muda, nem no envio por telefone nem no envio por `conversation_id` — a escolha automática continua sendo a de sempre.

A sessão pedida precisa ser da mesma organização que a autenticação resolveu (o corpo não traz organização) e precisa estar conectada. Quando ela não serve, a resposta é uma só: `422` `validation_error` com `details.campo` = `channel_session_id`, tanto para sessão inexistente quanto para sessão desligada ou fora do ar. A resposta não diz se a sessão existe em outra organização — é por isso que ela não é mais `404` nem `409` nesse caso; esses dois números continuam valendo quando nenhum canal foi escolhido.

Com `conversation_id`, o canal já está fixado pela conversa: nesse caminho o campo é inerte e o envio é idêntico ao de sempre. (#5028)
