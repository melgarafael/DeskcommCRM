---
impacto: nada_mudou
secao: corrigido
titulo: A menção em grupo mostra o nome do contato também na lista da Inbox
---

Em conversa de grupo, o texto da mensagem chegava com o identificador de
privacidade do WhatsApp (`@75235009282237`) no lugar do nome de quem foi
mencionado. A bolha da conversa já resolvia isso desde que a lista de menções
passou a ser guardada — mas a linha da LISTA da Inbox continuava mostrando o
código, e a busca por conteúdo da conversa não encontrava o nome mencionado.

Agora a prévia da lista usa a mesma regra da bolha: cada `@<identificador>` cujo
contato está no CRM aparece com o nome dele. Quem não está no CRM continua com o
identificador (não é o telefone), como hoje — nada é apagado nem vira texto
vazio —, e mensagem sem menção sai exatamente igual.

Contribuição de @webtecnica (#3566).
