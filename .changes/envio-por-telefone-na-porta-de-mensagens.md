---
impacto: capacidade_nova
secao: adicionado
titulo: A rota de envio aceita telefone no lugar do id da conversa
---

`POST /api/v1/messages` passa a aceitar `phone_number` quando `conversation_id` não vem. O contato é achado pelas grafias do número (ou criado) e a conversa 1:1 é aberta pelo mesmo caminho que o botão "iniciar conversa" e a tool MCP `crm_start_conversation_and_send` já usam — não há segunda regra de abertura de conversa. É a porta de que o conector `deskcomm` do DeskVoice precisa para falar com o CRM; o conector passa a usá-la quando for atualizado no DeskVoice. Contribuição de @webtecnica (#4513).

Os dois identificadores no mesmo corpo são recusados com 422 `ambiguous_target` (não há regra que diga qual vence, e escolher por conta própria é enviar para o destino que ninguém pediu); sem nenhum dos dois, 422 `validation_error`. Quem já manda `conversation_id` não muda de comportamento — mesmo corpo, mesmo `Idempotency-Key`, mesmo recibo.
