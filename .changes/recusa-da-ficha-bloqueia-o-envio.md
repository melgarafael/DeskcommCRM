---
impacto: nada_mudou
secao: corrigido
titulo: Uma recusa registrada pela API da ficha do contato passa a bloquear os envios
---

Quando o consentimento de marketing de um contato era retirado pela API da ficha dele
(`PATCH /api/v1/contacts/{id}`, no formato `{ "granted": false }`), essa recusa não era lida na
hora de enviar: as automações (WhatsApp, mensagem escrita pela IA, e-mail), as campanhas e a
prospecção continuavam escrevendo para ele. Só a recusa recebida por um formulário era levada em
conta.

Agora a recusa é lida nos dois formatos, o dos formulários e o da ficha, e bloqueia esses envios.
Você não precisa fazer nada.
