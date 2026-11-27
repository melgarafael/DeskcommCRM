---
impacto: capacidade_nova
secao: adicionado
titulo: Mensagens institucionais por token e MCP sem efeitos colaterais no atendimento
---

Integrações via API REST (`POST /api/v1/messages`) e MCP (`crm_send_whatsapp_message`) podem classificar avisos operacionais, lembretes ou comunicados com `dispatch_mode: "institutional"` usando o escopo dedicado `messages:institutional`. A mensagem exige `conversation_id` explícito de uma conversa não encerrada, respeita janela, anti-ban, bloqueios, histórico (`sent_via = "system"`) e auditoria, sem alterar `last_outbound_at`, `awaiting_since`, `unread_count_for_assignee`, `bot_silenced_until`, prévia, `contacts.last_activity_at` ou atribuição.
