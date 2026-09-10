# Plano de Implementação — Provider RyzeAPI

Este arquivo é o guia canônico de implementação da integração da **Ryze API** no DeskcommCRM (`ryze-channel`).

## Referências
- Rastreabilidade de tarefas: `.specs/features/ryze-channel/tasks.md`
- Especificação de requisitos: `.specs/features/ryze-channel/spec.md`
- Desenho de arquitetura e mitigação P0: `.specs/features/ryze-channel/design.md`
- Manifesto de contexto da feature: `.specs/features/ryze-channel/context-manifest.json`

## Princípios Invariantes
1. **Rota Neutra de Webhook:** Toda entrada de webhook de canal usa a rota canônica neutra `POST /api/v1/webhooks/channel/[token]`. É proibida a criação de rotas exclusivas como `/api/v1/webhooks/ryze`.
2. **Sanitização de Secrets P0:** O token presente em `instanceData.token` deve ser expurgado antes de salvar em `webhook_events_log`.
3. **Isolamento de SSRF:** O campo `instanceData.baseUrl` vindo do body de webhook é ignorado. Chamadas outbound usam exclusivamente a URL base configurada (`https://ryzeapi.cloud`).
4. **Isolamento Multi-tenant:** O `organization_id` é sempre resolvido pela sessão confiável do path token, nunca do body.
