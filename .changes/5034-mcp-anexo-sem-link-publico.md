---
impacto: capacidade_nova
secao: adicionado
titulo: Pelo MCP, a mensagem de WhatsApp pode levar um arquivo já enviado ao CRM, sem link público
---

A ferramenta `crm_send_whatsapp_message` aceita `media_storage_path` (o caminho que
`POST /api/v1/conversations/{id}/media` devolve) e `media_filename`. Assim um contrato ou um
laudo vai para o cliente sem precisar ser publicado na internet. O arquivo precisa ser da
própria conversa: o envio confere isso, como no Inbox. A `crm_start_conversation_and_send`
continua só com `media_url`.

Contribuição de @yunshu0909, a partir da issue #5034.
