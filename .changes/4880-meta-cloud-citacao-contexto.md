---
impacto: capacidade_nova
secao: corrigido
titulo: No canal oficial (Meta Cloud), resposta citada inclui context com message_id
---

No canal oficial da Meta, a resposta que cita uma mensagem anterior agora envia o identificador no campo `context: { message_id }` da Meta Graph API.
Quando a mensagem citada existe no envelope (`replyToExternalId`), o WhatsApp exibe o balão da mensagem original acima da resposta.
Sem citação (`replyToExternalId` ausente ou indefinido), o envio é realizado normalmente sem a chave `context`.
