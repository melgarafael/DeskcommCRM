---
impacto: correcao
secao: corrigido
titulo: O nome original de arquivos anexados é preservado no WhatsApp e no download do Inbox
---

Ao anexar um arquivo no Inbox (PDF, XML, planilhas, documentos), o DeskcommCRM gerava um storage path interno com padrão `out-<uuid>.<ext>` e descartava o nome original informado pelo atendente. Como consequência, o destinatário no WhatsApp recebia o documento com nome genérico `out-<uuid>.pdf` e o download no Inbox sugeria o mesmo nome opaco.

Agora, o endpoint de upload (`/api/v1/conversations/[id]/media`) sanitiza e retorna o `media_filename` original. O `sendMessageHandler` propaga o nome para o adaptador do WhatsApp (WAHA) — para que o documento seja entregue ao contato com seu nome legível — e persiste `media_filename` na `metadata` da mensagem. A rota de download (`/api/v1/messages/[id]/media`) e o componente `DocumentCard` utilizam esse nome tanto no cabeçalho `Content-Disposition` quanto no atributo `download`, garantindo a mesma experiência no envio, na entrega e no download interno.
