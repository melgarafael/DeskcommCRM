---
impacto: capacidade_nova
secao: alterado
titulo: Campanhas WhatsApp — hardening de envio e estados incertos
---

O worker de campanha agora recupera claims presos, agrega stats numa consulta, e marca destinatários como **Incerto** quando o WAHA pode ter aceitado sem confirmação (timeout). Isso evita reenvio cego e mostra o caso na tela da campanha.
