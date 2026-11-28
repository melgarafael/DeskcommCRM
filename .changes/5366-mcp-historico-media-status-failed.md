---
impacto: nada_mudou
secao: corrigido
titulo: MCP crm_get_conversation_history devolve media_status "failed" para mídias cujo download falhou definitivamente
---

Quando o download de uma mídia recebida falha de vez no worker de persistência (`media-persist-worker`), a mensagem fica marcada com `metadata.media_status = "failed"`. O MCP `crm_get_conversation_history` continuava devolvendo essa mensagem como `media_status: "pending"`, induzindo clientes MCP a tentarem indefinidamente. Agora a ferramenta devolve `media_status: "failed"` com `media_signed_url: null`. Conserto de @Yshuro. Corrige a issue #5366.
