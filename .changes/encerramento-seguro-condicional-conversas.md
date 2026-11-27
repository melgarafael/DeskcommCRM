---
impacto: capacidade_nova
secao: adicionado
titulo: Encerramento seguro e condicional de conversas via REST e MCP
---

Integrações autorizadas (escopo `conversations:write`) podem encerrar conversas de forma condicional em `POST /api/v1/conversations/[id]/close` e `crm_close_conversation`, com `safe_close: true` ou uma pré-condição (`expected_status`, `expected_last_inbound_message_id`, `expected_last_inbound_at`, `expected_assigned_to_user_id`, `expected_sector_id`). No modo condicional, `expected_revision` e `expected_last_inbound_message_id` (ou `expected_last_inbound_at`) são obrigatórios, a recusa por humano atribuído e por pendência aberta é sempre aplicada (`reject_human_assigned`/`reject_open_pendencies: false` recebem 422) e `idempotency_key` faz o replay da mesma chamada. `expected_last_inbound_at` e os `reject_*` existem só na REST. A validação e a transição ocorrem atomicamente em `fn_safe_close_conversation` sob `fn_service_lock` + `FOR NO KEY UPDATE`, recusando com `409 Conflict` e motivo estruturado quando há nova mensagem recebida, troca de responsável/setor, assunção humana, pendência aberta ou revisão desatualizada, mantendo 100% de compatibilidade com o encerramento manual.

O botão Fechar da tela e os clientes que já fecham conversas continuam no encerramento de sempre: só `safe_close` ou uma pré-condição ligam o modo condicional. Nada a fazer na atualização. Contribuição de @fcostamil-hub.
