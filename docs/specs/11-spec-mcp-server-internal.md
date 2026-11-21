---
title: Spec Técnica 11 — Internal MCP Server (Tool Catalog)
parent: docs/research/pre-development/ai-agent-framework-deskcomm-whatsapp/09-handoff.md
depends_on: 01-spec-platform-base.md, 02-spec-customer-360.md, 03-spec-whatsapp-waha.md, 04-spec-pipeline-attendance.md, 10-spec-ai-agents-runtime.md
related: 12-spec-ai-agents-ui.md
version: 0.1
status: draft (pre-implementation)
date: 2026-05-05
owner: Rafael Melgaço
---

# Spec 11 — Internal MCP Server (Tool Catalog)

> Servidor MCP interno que expõe **as operações já existentes do CRM** como tools consumíveis por agentes (Spec 10) e, futuramente, por clientes externos MCP (Cursor, Claude Desktop). Este spec descreve **somente as tools que mapeiam endpoints já existentes em `app/api/v1/`** — não cria CRUD novo, apenas reembala.

---

## 1. Visão Geral

### 1.1 Propósito

- **Para agentes internos (Spec 10)**: ToolLoopAgent consome via `createMCPClient` HTTP/SSE, executa tools no loop conforme system prompt instrui.
- **Para clientes externos (futuro)**: lojista pode plugar Cursor/Claude Desktop ao próprio CRM via API key. Out of MVP, mas o design não fecha porta.

### 1.2 Stack

- `@modelcontextprotocol/sdk` server (TypeScript)
- Hospedado em `app/api/mcp/route.ts` (Next.js Route Handler com Streamable HTTP transport)
- Auth: Bearer token (`dsk_...`) — mesma API key do REST `/api/v1/` (Spec 01 §api-tokens). Tabela `api_tokens` reutilizada
- RLS: tools executam via Supabase client autenticado, **mesma policy** do REST. Zero código de autorização ad-hoc dentro das tools

### 1.3 Princípios

1. **Cada tool = 1 endpoint REST existente**. Nada de tool que faça query SQL custom — sempre via mesmo handler/RPC do REST. Garante que regras (audit, rate limit, RLS) já testadas se aplicam.
2. **Zod schemas são o contrato.** Mesmas schemas usadas no REST. DRY.
3. **Mutações registram audit log idêntico ao REST**. `actor_type='ai_agent'`, `actor_id=run.id` em vez do user.
4. **Idempotência nas criações**: clientes MCP externos podem enviar `Idempotency-Key`; o runtime interno deriva a chave de `sourceJobId` e do hash do input validado. A escrita usa o recibo compartilhado do handler, sem usar `claim` como identidade da operação.
5. **Handoff é uma tool nativa (não um endpoint REST)** — única exceção: `crm_request_human_handoff` é específica de runtime de agente, não tem espelho REST.

---

## 2. Transport & Auth

### Execução no turno interno

`lib/ai/runtime/tools.ts` monta a ponte em processo usada pelo atendimento e pelo
Operador. Dentro de cada montagem, escritas que recebem `lead_id` e
`crm_manage_tags` com `target_kind='lead'` aguardam a conclusão do handler
anterior para o mesmo par organização/negócio, incluindo suas atividades e
eventos. A chave usa o negócio efetivo após a tradução do contato do turno.
Leituras e negócios diferentes continuam em paralelo. Papel, escopo, auditoria
e o filtro otimista de `moveLeadHandler` continuam nativos.
Ao começar um handler de escrita, a ponte revalida a fronteira de atendimento
com `guardServiceEffect`, depois de qualquer espera na fila. A autoridade que
valia quando a chamada chegou não é reutilizada como permissão para executá-la.

A fila é local ao turno: não ordena requisições HTTP/MCP externas, turnos
distintos, ações humanas nem ferramentas que resolvem o negócio indiretamente
pela agenda. Não substitui proteção no banco e não repete conflitos. Um handler
que assenta com falha libera a próxima chamada, conservando a recusa e sua
auditoria para o modelo.
Uma chamada da fila tem teto de retorno igual à janela padrão do token MCP
(`EPHEMERAL_TOKEN_TTL_SEC`, atualmente 300 segundos), contado da entrada na
fila, incluindo a espera. Não é o prazo restante da credencial. Ao excedê-lo,
o modelo recebe `lead_write_outcome_unknown` e `resultado_incerto`, com
orientação para não confirmar nem repetir a escrita e pedir conferência humana.
A recusa continua em `mcp.tool_called` e no log estruturado da ponte.

Esse teto **não cancela** o handler nem libera o próximo: a chave fica recusada
na montagem vencida. Um registro compartilhado em processo impede novas
montagens/turnos de iniciar escrita nesse par organização/negócio até todos os
handlers vencidos assentarem realmente; a liquidação retira esse impedimento
automaticamente. Outros negócios, organizações e leituras continuam livres.
Um efeito já iniciado pode completar tarde. O registro não coordena processos
distintos ou escritas fora da ponte; um handler que nunca assenta conserva o
impedimento até a recuperação/reinício do processo. Não há retry automático.
Regressão: `tests/unit/escritas-do-negocio-no-turno.test.ts` reproduz a colisão
com handlers nativos e adaptador em memória, sem banco ou modelo externo.

### 2.1 Endpoint

```
POST /api/mcp                          (Streamable HTTP / SSE)
GET  /api/mcp                          (SSE stream initiation; AI SDK MCP client default)
```

Transport conforme MCP spec 2025-06: Streamable HTTP recomendado, fallback SSE legacy.

### 2.2 Auth

```
Authorization: Bearer dsk_xxxxxxxxxxxxxxxxxxxx
```

- Token plain prefix `dsk_`. Validado via SHA256 hash em `api_tokens` (Spec 01).
- Token resolve `organization_id` + `role` + `actor_type` (`user` ou `system`).
- Para agentes (Spec 10), o runner mints um token efêmero (TTL 5min) escopado: `actor_type='ai_agent'`, `agent_run_id=run.id`. Não aparece na UI; é interno.
- Token escopo: tools podem checar `tok.role >= manager` para mutations sensíveis (mesmas regras do REST).

#### 2.2.1 OAuth 2.1 para clientes que não aceitam cabeçalho (migration 9390)

O ChatGPT (e outros clientes de MCP) só oferece OAuth ou "sem autenticação" — não há onde colar o
`dsk_`. O CRM é o servidor de autorização do próprio recurso, conforme a especificação de
autorização do MCP:

| Passo | Endereço | Norma |
|---|---|---|
| 401 do `/api/mcp` leva `WWW-Authenticate: Bearer resource_metadata="…"` | `app/api/mcp/route.ts` | RFC 9728 §5.1 |
| Metadados do recurso | `GET /.well-known/oauth-protected-resource` (e `…/api/mcp`) | RFC 9728 |
| Metadados do servidor | `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| Registro dinâmico | `POST /api/mcp/oauth/register` | RFC 7591 |
| Autorização (ponte → `/oauth/mcp/consentir`) | `GET /api/mcp/oauth/authorize` | OAuth 2.1 + PKCE S256 + `resource` (RFC 8707) |
| Token e renovação (rotação) | `POST /api/mcp/oauth/token` | OAuth 2.1 §4.1.3 / §4.3 |
| Revogação | `POST /api/mcp/oauth/revoke` | RFC 7009 |

- **O access token é um `dsk_` de `api_tokens`.** O `/api/mcp` valida pelo caminho de sempre: mesmo
  ator (`api_token`), escopos `mcp:read` / `mcp:write` + `role:admin`, mesma auditoria e isolamento.
  A marca `aud:mcp` prende o token ao `/api/mcp`: no `/api/v1` ele recebe 403 (`resolveApiToken`).
  Uma conexão = uma linha de `api_tokens` (nome `<cliente> (OAuth)`); a renovação troca o hash na
  mesma linha. Revogar na tela API Tokens desliga a conexão na renovação seguinte.
- Só **admin** da organização escolhida autoriza (a régua de quem emite token na tela). A renovação
  (a cada hora) re-confere que a pessoa segue admin; se não, revoga.
- Prazos: código 5 min, access 1 h, refresh 60 dias (renovado a cada uso; cada refresh vale uma vez, e
  reapresentar um já rotacionado desliga a conexão — a pessoa reconecta). Origem anunciada =
  `NEXT_PUBLIC_APP_URL`, nunca o `Host`.
- Mapa: `docs/architecture/mcp-oauth-servidor.architecture.json`. Prova de banco:
  `tests/invariants/mcp-oauth-servidor.test.ts`.

### 2.3 Erros

MCP error codes mapeados:

| HTTP / scenario | MCP error code |
|---|---|
| 401 invalid token | `-32001` Unauthorized |
| 403 insufficient role | `-32002` Forbidden |
| 404 not found | `-32003` Not Found |
| 422 validation | `-32602` Invalid Params |
| 429 rate limit | `-32004` Rate Limited |
| 500 | `-32603` Internal Error |

---

## 3. Catálogo de Tools (MVP)

Apenas tools que mapeiam endpoints existentes em `app/api/v1/`. Verificado contra `app/api/v1/` em 2026-05-05.

### 3.1 Read tools (sempre seguras)

#### `crm_search_contacts`
**Maps to**: `GET /api/v1/contacts?query=...&limit=...`

```ts
inputSchema: z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional()
})

outputSchema: z.object({
  contacts: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    tags: z.array(z.string()),
    created_at: z.string()
  })),
  has_more: z.boolean()
})
```

#### `crm_get_contact`
**Maps to**: `GET /api/v1/contacts/:id`

```ts
inputSchema: z.object({ contact_id: z.string().uuid() })
outputSchema: ContactDetail (full schema)
```

#### `crm_list_conversations`
**Maps to**: `GET /api/v1/conversations?contact_id=...&status=...`

```ts
inputSchema: z.object({
  contact_id: z.string().uuid().optional(),
  status: z.enum(['open', 'pending', 'closed']).optional(),
  limit: z.number().int().min(1).max(50).default(10)
})
```

#### `crm_get_conversation`
**Maps to**: `GET /api/v1/conversations/:id`

```ts
inputSchema: z.object({ conversation_id: z.string().uuid() })
outputSchema: ConversationDetail (with last_message_at, contact, channel_session)
```

#### `crm_get_conversation_history`
**Maps to**: `GET /api/v1/messages?conversation_id=...&limit=...`

```ts
inputSchema: z.object({
  conversation_id: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional()
})

outputSchema: z.object({
  messages: z.array(z.object({
    id, role: z.enum(['inbound', 'outbound']),
    body: z.string(),
    sent_by: z.enum(['contact', 'agent_user', 'ai_agent', 'system']),
    sent_at: z.string()
  }))
})
```

> **Importante**: agente carrega histórico via esta tool, NÃO via parâmetro do system prompt. Mantém o system prompt enxuto e cobra apenas tokens de histórico relevante quando necessário.

#### `crm_list_leads`
**Maps to**: `GET /api/v1/leads?contact_id=...&pipeline_id=...&stage_id=...`

```ts
inputSchema: z.object({
  contact_id: z.string().uuid().optional(),
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10)
})
```

#### `crm_count_leads`
**Maps to**: `countLeadsHandler` (`app/api/v1/leads/_handler.ts`) — sem rota REST própria.

Conta negócios **sem listá-los**. Existe porque `crm_list_leads` só pagina por cursor e não informa o total: quem precisa de "quantos?" acabava paginando a lista inteira e levando todos os negócios ao modelo. Devolve só números — nenhum nome, contato ou id.

```ts
inputSchema: z.object({
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional()
})
outputSchema: z.object({
  total: z.number().int(),
  by_status: z.object({ open: z.number(), won: z.number(), lost: z.number() }).optional() // só sem filtro de status
})
```

Mesma régua de visibilidade da listagem: `organization_id` na primeira cláusula (client service-role), negócio de contato pessoal não conta e, em conversa de atendimento, conta apenas os negócios do contato do turno. Contagem feita no banco (`head: true`, `count: 'exact'`).

#### `crm_get_lead`
**Maps to**: `GET /api/v1/leads/:id`

#### `crm_list_pipelines`
**Maps to**: `GET /api/v1/pipelines`

```ts
inputSchema: z.object({ include_archived: z.boolean().optional() })
outputSchema: z.object({
  pipelines: z.array(z.object({
    id, name, slug, description, is_default, is_archived, position,
    vocabulary: z.record(z.string()),
    // #4667: as DEFINIÇÕES dos campos personalizados, nunca valor de negócio.
    campos: z.array(z.object({
      key, label, type, escopo,
      options: z.array(z.object({ value, label })).optional(),
    })),
  }))
})
```

As etapas não vêm aqui: saem de `crm_list_stages`. A forma que vale é a do `map` em
`lib/mcp/tools/pipelines.ts`; em dúvida, leia lá. Desde a #4667, `crm_update_lead` e
`crm_create_lead` chamados pelo agente de IA recusam, em `custom_fields`, a chave que o funil
não declara (`lib/mcp/conferencia-de-campos.ts`).

### 3.2 Write tools (mutations, role >= manager)

#### `crm_send_whatsapp_message`
**Maps to**: `POST /api/v1/messages` (envio outbound) — handler já existente

```ts
inputSchema: z.object({
  conversation_id: z.string().uuid(),
  body: z.string().min(1).max(4096).optional(),
  type: z.enum(['text', 'image', 'audio', 'document', 'sticker', 'video', 'location', 'contact']).default('text'),
  media_url: z.string().url().optional(),
  media_storage_path: z.string().optional(),   // #5034
  media_filename: z.string().optional(),       // #5034 (caminho e nome ficam fora da auditoria)
  media_mime: z.string().optional()
})
// Precisa de body, media_url ou media_storage_path.
```

**Arquivo sem link público (#5034)**: suba o arquivo com `POST /api/v1/conversations/{id}/media`
(multipart, campo `file`; sessão do navegador ou token de integração com escrita — o token OAuth do MCP
não serve para a rota REST). A resposta (`data`) traz `storage_path`, `kind`, `media_mime` e `media_filename` (o nome original). Envie com:

```ts
{ conversation_id, type: kind /* 'image' | 'video' | 'audio' | 'document' */,
  media_storage_path: storage_path, media_mime, body /* legenda, opcional */,
  ...(media_filename ? { media_filename } : {}) /* o nome da resposta do upload; null não é aceito, então fica de fora */ }
```

O envio confere que o arquivo é da organização E desta conversa; caminho de outra conversa é recusado.

```ts

outputSchema: z.object({
  message_id: z.string().uuid(),
  status: z.enum(['sending', 'sent', 'failed']),
  external_id: z.string().nullable()
})
```

**Nota**: agente NÃO chama esta tool no fluxo normal — o runner Spec 10 §6 já envia o `result.text` final via `sendWAHA`. Esta tool existe para casos onde o agente precisa enviar **mais de uma mensagem** (ex: lista de produtos em mensagens separadas).

#### `crm_create_lead`
**Maps to**: `POST /api/v1/leads`

```ts
inputSchema: z.object({
  pipeline_id: z.string().uuid(),
  stage_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  title: z.string(),
  value_cents: z.number().int().nonnegative().optional(),
  custom_fields: z.record(z.unknown()).optional()
})
```

#### `crm_update_lead`
**Maps to**: `PATCH /api/v1/leads/:id`

```ts
inputSchema: z.object({
  lead_id: z.string().uuid(),
  stage_id: z.string().uuid().optional(),
  title: z.string().optional(),
  value_cents: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional()
})
```

#### `crm_move_lead_stage`
**Maps to**: `PATCH /api/v1/leads/:id` (atalho semanticamente claro)

```ts
inputSchema: z.object({
  lead_id: z.string().uuid(),
  to_stage_id: z.string().uuid(),
  reason: z.string().max(500).optional()
})
```

Audit log entry com `change.from_stage_id`, `change.to_stage_id`, `reason`.

### 3.3 Tool especial (sem espelho REST)

#### `crm_request_human_handoff`
**No REST mirror** — específica de runtime.

```ts
inputSchema: z.object({
  reason: z.string().min(1).max(500),
  urgency: z.enum(['low', 'normal', 'high']).default('normal'),
  suggested_assignee_role: z.enum(['agent', 'manager']).default('agent')
})

outputSchema: z.object({
  handoff_recorded: z.literal(true),
  conversation_id: z.string().uuid(),
  next_action: z.string()  // texto para o agente compor a mensagem final
})
```

**Side effects**:
1. Update `conversations.assigned_user_id` para o atendente disponível (round-robin entre users com role >= `suggested_assignee_role` e `presence='online'`)
2. Insert `crm_lead_activities` com `type='handoff'`, `metadata: { reason, urgency, source: 'ai_agent', run_id }`
3. Insert `event_log` `ai_agent.handoff_triggered`
4. Audit log entry `conversation.handoff` com `actor_type='ai_agent'`
5. **Marcar o run com `status='handoff'`** (em vez de 'completed') — runtime do Spec 10 §6.2 detecta e finaliza apropriadamente
6. Resposta `next_action` é uma string sugerindo ao agente o que dizer ao usuário ("Vou conectar você com um atendente humano agora") — agente integra na resposta final

---

### 3.4 Editar os assistentes de IA (só admin, por aplicativo conectado)

Para o dono corrigir pelo ChatGPT como o assistente responde. Todas pedem papel `admin`, são
`apenasHumano` (o turno do agente não as monta) e ficam fora dos pacotes do seletor do assistente
(`lib/mcp/tools/ferramentas-do-administrador.ts`). As regras são as da tela, em
`lib/ai/agents/edicao.ts` e `lib/ai/agents/teste-da-versao.ts`.

| Tool | Escopo | O que faz |
|---|---|---|
| `crm_list_ai_agents` | `mcp:read` | assistentes, canal, versão publicada e rascunho |
| `crm_get_ai_agent_version` | `mcp:read` | instruções e configuração de uma versão (`publicada`, `rascunho` ou número) |
| `crm_get_ai_agent_turn` | `mcp:read` | últimos turnos de uma conversa: versão usada, ferramentas, interrupção, mensagens |
| `crm_save_ai_agent_draft` | `mcp:write` | correção como RASCUNHO, por troca exata / anexar / texto inteiro, em 1–5 assistentes |
| `crm_test_ai_agent_version` | `mcp:write` | prévia (`is_dry_run`), nada é enviado |
| `crm_publish_ai_agent_version` | `mcp:write` | `critico` → `destructiveHint`; número explícito, devolve o anterior |
| `crm_rollback_ai_agent` | `mcp:write` | `critico`; clona uma versão antiga e publica |

O servidor manda a cada cliente as dicas do protocolo (`annotations`) a partir do risco do
catálogo: `readOnlyHint` para leitura, `destructiveHint` para `critico` (`dicasDaFerramenta`,
`lib/mcp/server.ts`). O limite do texto de instruções é o da tela (20.000 caracteres).

## 4. Tool selection (per agent)

A versão do agente armazena `tool_ids text[]` (Spec 10 §3.2). Validação no publish:

```ts
const VALID_TOOL_IDS = [
  'crm_search_contacts', 'crm_get_contact',
  'crm_list_conversations', 'crm_get_conversation', 'crm_get_conversation_history',
  'crm_list_leads', 'crm_count_leads', 'crm_get_lead', 'crm_list_pipelines',
  'crm_send_whatsapp_message', 'crm_create_lead', 'crm_update_lead', 'crm_move_lead_stage',
  'crm_request_human_handoff'
]

validateToolIds(version.tool_ids).forEach(t => {
  if (!VALID_TOOL_IDS.includes(t)) throw new ValidationError(`Unknown tool: ${t}`)
})
```

Endpoint `GET /api/v1/mcp/tools` (admin+) retorna o catálogo completo com schemas para a UI Spec 12 §3 popular o checklist.

No runtime interno dos agentes, `ai_agent_versions.followup.callback_enabled=false`
remove `crm_schedule_followup` depois da seleção por `tool_ids`, para o
Conversador e para o Operador. O filtro mantém `crm_list_followups`,
`crm_cancel_followup`, `crm_enroll_followup_flow` e ferramentas de agendamento
de compromisso. A superfície pública genérica `/api/mcp` não recebe política
por-agente: ela continua obedecendo ao token e às permissões do seu chamador.

---

## 5. Implementação (esqueleto)

### 5.1 Estrutura de arquivos

```
app/api/mcp/
  route.ts                  # MCP server entrypoint (Streamable HTTP)
lib/mcp/
  server.ts                 # createServer com tools registradas
  auth.ts                   # validateBearerToken → { organization_id, role, actor }
  tools/
    index.ts                # exports + VALID_TOOL_IDS array
    contacts.ts             # crm_search_contacts, crm_get_contact
    conversations.ts        # 3 tools
    messages.ts             # crm_send_whatsapp_message
    leads.ts                # 4 tools
    pipelines.ts            # crm_list_pipelines
    handoff.ts              # crm_request_human_handoff
  schemas.ts                # Zod shared schemas (importadas dos handlers REST)
```

### 5.2 Tool wiring exemplo

```ts
// lib/mcp/tools/contacts.ts
import { z } from 'zod'
import type { McpToolHandler } from '../types'
import { listContactsHandler } from '@/app/api/v1/contacts/_handler'  // refactor: extrair handler core

export const crmSearchContacts: McpToolHandler = {
  name: 'crm_search_contacts',
  description: 'Search contacts by name, phone, or email. Returns up to 50 matches.',
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(10)
  }),
  handler: async (input, ctx) => {
    // ctx.organization_id, ctx.role, ctx.actor injetados pelo server core
    const result = await listContactsHandler({
      organization_id: ctx.organization_id,
      query: input.query,
      limit: input.limit
    })
    return {
      contacts: result.contacts,
      has_more: result.has_more
    }
  }
}
```

**Refactor exigido**: extrair handler core de cada Route Handler `app/api/v1/<resource>/route.ts` para `app/api/v1/<resource>/_handler.ts` para que (a) Route Handler chame e (b) MCP tool chame. Mantém audit, RLS, validação centralizados. Já é boa prática que estava por fazer.

### 5.3 Server core (`lib/mcp/server.ts`)

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'
import { allTools } from './tools'

export function createMcpServer() {
  const server = new McpServer({
    name: 'deskcomm-crm',
    version: '0.1.0'
  })

  for (const t of allTools) {
    server.tool(t.name, t.description, t.inputSchema.shape, async (args, extra) => {
      const ctx = await resolveContext(extra)        // organization_id, role, actor from auth
      try {
        const result = await t.handler(args, ctx)
        await auditLog(t.name, args, result, ctx)    // mesmo audit do REST
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] }
      }
    })
  }

  return server
}
```

### 5.4 Route handler

```ts
// app/api/mcp/route.ts
import { createMcpServer } from '@/lib/mcp/server'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const auth = await validateBearerToken(req.headers.get('authorization'))
  if (!auth) return new Response('Unauthorized', { status: 401 })

  const transport = new StreamableHTTPServerTransport({ /* config */ })
  const server = createMcpServer()
  await server.connect(transport)
  return transport.handleRequest(req, auth)
}

export const GET = POST   // SSE stream initiation
```

---

## 6. Audit log

Cada tool call (success ou failure) gera entrada em `api_audit_log`:

```sql
insert into api_audit_log (
  organization_id, actor_type, actor_id,
  action, resource_type, resource_id,
  request_payload, response_status,
  duration_ms
) values (
  $org, 'ai_agent', $run_id,
  'mcp.tool_called', 'mcp_tool', $tool_name,
  jsonb_build_object('args', $args, 'result_summary', $summary),
  $status, $duration
)
```

`actor_type='ai_agent'` permite filtrar audit por origem (humana vs automática) — útil pra LGPD e investigações.

---

## 7. Rate limiting (per token)

- Per token: 60 calls/min (sliding window Upstash)
- Per organization: 600 calls/min agregado
- Por tool: write tools (`*_create*`, `*_update*`, `*_send*`) limitadas a 30/min per token

Excedeu → MCP error `-32004` Rate Limited. Agente pode tentar continuar com tools restantes ou abortar.

---

## 8. Observability

Métrica adicional em `ai_agent_runs.tool_calls` jsonb (Spec 10 §3.4):

```jsonb
[
  {
    "step": 1,
    "tool_name": "crm_search_contacts",
    "args": { "query": "joao" },
    "result_summary": "3 contacts matched",
    "started_at": "...",
    "ended_at": "...",
    "duration_ms": 142,
    "tokens_in": 0,
    "error": null
  }
]
```

Sentry breadcrumbs: 1 por tool call, com `tool_name`, `duration_ms`, `error_code` (sem args completos para evitar leak de PII).

---

## 9. Testes

- Unit por tool: input validation, output shape, RLS escope (org A vê só de org A)
- Integration: bearer token inválido → 401; role insuficiente → 403; rate limit → 429
- Concurrent calls: 10 calls paralelas mesma tool, mesma org → todas passam, audit registra 10
- Adversarial: tool tenta acessar `organization_id` do body em vez de ctx → teste fail garante uso do ctx

---

## 10. Definition of Done

1. `app/api/mcp/route.ts` deployado, GET+POST handlers funcionando
2. 13 tools registradas (10 que mapeiam REST + 3 utilitários: handoff, list_pipelines, get_conversation_history)
3. Endpoint `GET /api/v1/mcp/tools` retornando catálogo com schemas
4. Refactor: cada Route Handler `/api/v1/<resource>/route.ts` tem `_handler.ts` extraído
5. Audit log entries `mcp.tool_called` aparecendo
6. Rate limit aplicado (Upstash)
7. Token mint efêmero para `actor_type='ai_agent'` implementado
8. Bearer plaintext nunca em log/Sentry (smoke test no CI)
9. Documentação tenant-facing: como conectar Cursor/Claude Desktop ao MCP (preview-only, no MVP exposto apenas internamente)
10. Cliente MCP do Spec 10 conecta com sucesso e lista tools

---

## 11. Cross-references

- Spec 10 — runtime que consome este MCP via `createMCPClient`
- Spec 01 — `api_tokens` table reusada para auth bearer
- Spec 02/03/04 — handlers REST que as tools encapsulam
- Spec 12 — UI mostra catálogo de tools para tenant escolher por agente
