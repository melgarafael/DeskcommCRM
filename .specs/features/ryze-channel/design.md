# Design: Provider RyzeAPI (`ryze-channel`)

## 1. Outbound Flow Diagram
```
CRM messages API
  ↓
ChannelAdapter (lib/channels/index.ts)
  ↓
ryzeAdapter (lib/channels/adapters/ryze.ts)
  ↓
credential resolver (organization_id + ryze_instance_name)
  ↓
POST https://ryzeapi.cloud/api/message/text/:instance (Header token: TokenInstance)
  ↓
data.messageId
  ↓
messages.external_id
```

## 2. Inbound Flow Diagram
```
Ryze Webhook
  ↓
POST /api/v1/webhooks/channel/[token] (Header Authorization: Bearer <secret>)
  ↓
trusted channel_session (via path token)
  ↓
sanitize body FOR ARCHIVE (remove instanceData.token, sanitize Authorization)
  ↓
archive without secrets (webhook_events_log)
  ↓
handleInboundWebhook(original raw body in memory)
  ↓
verify Authorization in constant time
  ↓
validate Ryze contract (message.exchange)
  ↓
direction gate (direction === "incoming" -> inbound / direction === "outgoing" -> reconcile echo)
  ↓
canonical ingest/reconcile pipeline
```

## 3. Trust Boundaries & Threat Model
- **Boundary 1: External Webhook Body:** Todo payload vindo da Ryze API é considerado **não confiável**. O `organization_id` ou tenant NUNCA é lido do body; a organização é sempre derivada da `channel_session` resolvida com segurança pelo `token` da URL.
- **Boundary 2: Secret Sanitization (P0):** O envelope de evento da Ryze contém `instanceData.token`. A rota de webhook utilizará a função neutra `sanitizeInboundWebhookForArchive(provider, rawBody)` para expurgar o token antes de salvar em `webhook_events_log`.
- **Boundary 3: SSRF Prevention:** O campo `instanceData.baseUrl` do body de webhook é completamente ignorado para requisições de saída. As chamadas outbound utilizarão estritamente a URL base configurada (`https://ryzeapi.cloud`).

## 4. Event & Error Matrix

### Matriz de Eventos Inbound
| Evento | Direção / Filtro | Ação no CRM |
|---|---|---|
| `message.exchange` | `direction === "incoming"` | Cria contato, conversa, mensagem inbound e aciona pipeline/IA. |
| `message.exchange` | `direction === "outgoing"` | Reconcilia eco/external_id. NUNCA dispara IA ou novo turno. |
| `message.status` | Qualquer | Atualiza status de entrega/leitura (`delivered`, `read`). Não cria mensagem. |
| Outros eventos | Qualquer | Responde `200 ignored`. Evita retries desnecessários. |

### Matriz de Erros Outbound
| Código HTTP | Causa | Tratamento |
|---|---|---|
| 400 | Payload / Número inválido | Retorna `ryze_send_failed`. |
| 401 | Token inválido | Retorna `ryze_auth_failed`. |
| 403 | Instância sem permissão | Retorna `ryze_permission_denied`. |
| 404 | Instância não encontrada | Retorna `ryze_instance_not_found`. |
| 429 | Rate limit atingido | Retorna `ryze_rate_limited`. |
| 500 / 503 | Instância desconectada / Erro Ryze | Retorna `ryze_instance_disconnected`. |

## 5. Decisões Rejeitadas
- **Rejeitado:** Criar a rota `app/api/v1/webhooks/ryze/route.ts`. **Motivo:** Viola a arquitetura de rotas neutras do DeskcommCRM (`/api/v1/webhooks/channel/[token]`).
- **Rejeitado:** Usar `isFromMe` para filtrar `message.exchange`. **Motivo:** O contrato canônico da Ryze utiliza `direction === "incoming"` para mensagens do cliente.
