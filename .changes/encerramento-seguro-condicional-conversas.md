---
impacto: capacidade_nova
secao: adicionado
titulo: Encerramento seguro e condicional de conversas via REST e MCP
---

Integrações autorizadas (escopo `conversations:write`) podem encerrar conversas de forma condicional usando `safe_close` e pré-condições (`expected_revision`, `expected_status`, `expected_last_inbound_message_id`, `expected_assigned_to_user_id`, `expected_sector_id`, `reject_human_assigned`, `reject_open_pendencies` e `idempotency_key`) em `POST /api/v1/conversations/[id]/close` e `crm_close_conversation`. A validação e a transição ocorrem atomicamente em `fn_safe_close_conversation` sob `fn_service_lock` + `FOR NO KEY UPDATE`, recusando com `409 Conflict` e motivo estruturado quando há nova mensagem recebida, troca de responsável/setor, assunção humana, pendência aberta ou revisão desatualizada, mantendo 100% de compatibilidade com o encerramento manual.

O botão Fechar da tela e os clientes que já fecham conversas continuam no encerramento de sempre: só `safe_close` ou uma pré-condição ligam o modo condicional. Nada a fazer na atualização. Contribuição de @fcostamil-hub.
