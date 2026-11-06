---
impacto: capacidade_nova
secao: corrigido
titulo: Abrir a conversa de quem acabou de ser cadastrado só acontece no canal que pode enviar
---

O botão **Salvar e iniciar conversa** do cadastro de contato e de negócio abre a
conversa pela mesma porta do Inbox (`open-with-contact`), que é o caminho único
de criação. Faltava o servidor honrar o canal que a tela escolheu: um
`channel_session_id` de canal **desligado** pelo operador ou **fora do ar**
passava pela checagem e criava a conversa vazia num número que não envia —
exatamente a conversa que o pedido manda não existir. Agora a recusa acontece
antes de criar, com o motivo dito na tela.

Quando a lista de canais ainda não chegou e o corpo vai sem canal escolhido, a
abertura de um contato **com telefone** passa a preferir o canal que disca o
número, e não a sessão mais antiga da empresa — que numa organização que pareou
Instagram antes do WhatsApp é a social, e não alcança telefone nenhum. O
cadastro salvo deixava de ter para onde mandar a primeira mensagem.

Se a sua integração chama `POST /api/v1/conversations/open-with-contact` com
`channel_session_id`, ela passa a receber também `409` com
`error.code = "state_conflict"` quando o canal está desligado ou fora do ar.
Antes, a conversa era criada mesmo assim. A ferramenta MCP
`start_conversation_and_send` segue a mesma regra: com um canal escolhido
desligado ou que não está conectado, ela agora responde com o erro
`session_unavailable` em vez de abrir a conversa e deixar a mensagem na fila
(ou falhar no canal desligado).
