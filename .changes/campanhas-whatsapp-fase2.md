---
impacto: capacidade_nova
secao: adicionado
titulo: Campanhas WhatsApp com fila, pacing e pause/resume
---

O hub do CRM ganhou **Campanhas WhatsApp**: seleção server-side de destinatários (`contacts`), fila persistente, worker com `SKIP LOCKED`, pacing configurável e pause/resume/cancel. O envio reutiliza o mesmo caminho do Inbox (`sendMessageHandler`); não há segundo cliente WAHA.
