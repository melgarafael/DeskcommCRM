---
impacto: capacidade_nova
secao: adicionado
titulo: A rota de envio aceita telefone, e o conector do DeskVoice passa a falar com o CRM
---

`POST /api/v1/messages` passa a aceitar `phone_number` quando `conversation_id` não vem. O contato é
achado pelas grafias do número (ou criado) e a conversa 1:1 é aberta pelo mesmo caminho que o botão
"iniciar conversa" e a tool MCP `crm_start_conversation_and_send` já usam — não há segunda regra de
abertura de conversa. Com isso, o conector `deskcomm` do DeskVoice deixa de ser um webhook sem
contrato: ele manda telefone, recebe 201 e usa `Idempotency-Key` para o reenvio não duplicar mensagem.

Os dois identificadores no mesmo corpo são recusados com 422 `ambiguous_target` (não há regra que diga
qual vence, e escolher por conta própria é enviar para o destino que ninguém pediu); sem nenhum dos dois,
422 `validation_error`. Quem já manda `conversation_id` não muda de comportamento — mesmo corpo, mesmo
`Idempotency-Key`, mesmo recibo.
