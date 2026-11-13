---
impacto: capacidade_nova
secao: corrigido
titulo: O anexo enviado pelo Inbox chega ao WhatsApp com o nome original do arquivo
---

Um documento anexado no Inbox chegava ao cliente com um nome interno aleatório (`out-<código>.pdf`) em vez do nome escolhido por quem enviou. Agora o nome original vai ao WhatsApp e também aparece no balão da conversa e no download. Para quem integra: a rota de upload (`POST /api/v1/conversations/{id}/media`) passa a devolver `media_filename`, e o envio (`POST /api/v1/messages`) aceita o campo opcional `media_filename`. Sem ele, o envio continua usando o nome do arquivo guardado, como antes. Contribuição de @webtecnica (#4457).
