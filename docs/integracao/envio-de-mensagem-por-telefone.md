# Enviar mensagem por telefone — o contrato do conector

> **Para quem é:** quem escreve o conector que manda aviso para o CRM — hoje o
> `deskcomm` do DeskVoice, e qualquer integração servidor-a-servidor que só
> conhece o **telefone** do cliente, não o id interno da conversa.
> **O que responde:** como pedir o envio por telefone, o que o CRM resolve
> sozinho, quando ele recusa e com qual código, e o que a chave de idempotência
> cobre. **Fonte da verdade no código:** `app/api/v1/messages/route.ts` (a porta)
> e `lib/schemas/messaging.ts` (`sendMessagePorTelefoneSchema`). Este guia é
> conferido contra os dois por
> `tests/unit/envio-por-telefone-do-conector-documentado.test.ts`.

---

## 1. Autenticação — o token é da organização

```
POST /api/v1/messages
Authorization: Bearer dsk_…
Content-Type: application/json
Idempotency-Key: <uuid>
```

Aceita **token de servidor** (`dsk_…`) com o escopo **`mcp:write`**, e também a
sessão de navegador do CRM. O token é da **organização**: a organização vem da
linha do token, nunca do corpo. Um `organization_id` no corpo é ignorado — não
existe campo para ele no contrato, e não existe caminho em que o corpo escolha
de quem é a mensagem.

## 2. O corpo — um dos dois identificadores, nunca os dois

| Campo | Obrigatório | O que é |
|---|---|---|
| `conversation_id` | um dos dois | uuid da conversa. O caminho de sempre. |
| `phone_number` | um dos dois | o número do destinatário, E.164 com `+` ou só dígitos. |
| `body` | sim¹ | texto da mensagem, 1 a 4096 caracteres. |
| `type` | não | `text` (padrão), `template`, `image`, `audio`… — o mesmo vocabulário da rota. |
| `metadata` | não | objeto livre, gravado com a mensagem. |

¹ ou mídia (`media_url` / `media_storage_path`), ou cartão de contato — a
mensagem precisa levar alguma coisa.

```json
{ "phone_number": "+5532984793302", "body": "Ligação perdida — posso te ajudar?" }
```

```json
{ "conversation_id": "44444444-4444-4444-8444-444444444444", "body": "Oi!" }
```

**Os dois juntos são recusa, não prioridade.** `422 ambiguous_target`: quem manda
os dois está dizendo duas coisas diferentes, e a que perder vira engano
silencioso — a mensagem sai para um destino que ninguém pediu. A recusa acontece
**antes** de qualquer efeito: nada é enviado, nenhuma conversa é aberta, nenhum
recibo de idempotência é gravado. Corrija o corpo e retente com a **mesma**
chave.

**Nenhum dos dois** → `422 validation_error`, com `details` apontando o campo.

## 3. Como o telefone vira conversa

O telefone não é convertido pela rota, e sim pelo **mesmo caminho** que o botão
"iniciar conversa" do inbox e a tool MCP `crm_start_conversation_and_send` usam:

1. `parseDialablePhone` valida que é um número discável; `canonicalPhoneBR`
   canoniza. `invalid_phone` → `422 validation_error` (`details.campo:
   "phone_number"`).
2. `encontrarContatoPorTelefone` procura a ficha **da organização do token**,
   pelas grafias do número (com e sem o nono dígito) e também nos telefones
   extras da ficha.
3. Não achou? `fn_upsert_wa_contact` cria o contato **nesta** organização. É o
   mesmo upsert das outras portas de entrada.
4. `openSharedContactConversation` (o mesmo ponto único do botão e da tool MCP)
   abre a conversa 1:1 — ou **reaproveita** a que já existe, inclusive reabrindo
   uma fechada — na sessão de canal escolhida por `escolherSessaoParaEnvio` com
   `preferirTelefone`: canal que disca número, degradando para qualquer um não
   arquivado.

Uma conversa por contato: repetir o pedido não abre uma segunda.

## 4. Idempotência — a mesma chave devolve o mesmo recibo

`Idempotency-Key` é **UUID** (chave malformada é `400 validation_error`, não
recibo) e vale **24 h**. O hash sai do **corpo que chegou**, validado — nunca do
`conversation_id` resolvido.

| Situação | Resposta |
|---|---|
| mesma chave, mesmo corpo | `201` com o recibo gravado; **nada é reenviado**, nenhuma conversa é aberta de novo |
| mesma chave, corpo diferente | `409 idempotency_conflict` |
| mesma chave, primeira execução ainda em curso | `409 idempotency_in_progress` — a chave está certa; retentar resolve |
| mesma chave, um corpo por telefone e outro por conversa | `409 idempotency_conflict`: são dois jeitos de pedir, não um pedido |

A chave cobre o **par** abrir-conversa + enviar: o replay não cria contato nem
conversa duplicados.

## 5. Recusas

| Status | `error.code` | Quando |
|---|---|---|
| 401 | `unauthenticated` | token ausente, inválido, revogado ou expirado |
| 403 | `forbidden` / `forbidden_role` | token sem `mcp:write`; `on_behalf_of_user_id` sem o escopo `messages:on_behalf`; contato marcado como pessoal; papel abaixo de atendente |
| 404 | `not_found` | não há sessão de canal que possa enviar |
| 409 | `state_conflict` | canal desligado ou fora do ar (`session_unavailable`) — retentar depois |
| 409 | `idempotency_conflict` | ver a §4 |
| 409 | `idempotency_in_progress` | ver a §4 |
| 422 | `ambiguous_target` | `conversation_id` **e** `phone_number` no mesmo corpo |
| 422 | `validation_error` | corpo inválido, telefone inválido, nenhum identificador |
| 429 | `rate_limited` | teto por token ou por organização; `details.retry_after_seconds` |
| 500 | `internal_error` | falha ao abrir a conversa deste telefone |

Todo erro vem em `{ "error": { "code", "message", "details"? } }`; toda resposta
traz `X-Request-Id`, que é o que se manda no suporte.

## 6. O que o conector do DeskVoice muda

O conector de hoje manda `{ "to", "text", "callId" }`. A tradução é:

| DeskVoice | CRM |
|---|---|
| `to` | `phone_number` |
| `text` | `body` |
| `callId` | `metadata.call_id` — **não** existe `callId` no topo; campo desconhecido no corpo é descartado, e o id da ligação se perderia em silêncio |
| — | `Idempotency-Key: <id do aviso>`, para o reenvio do DeskVoice (3 tentativas) não duplicar a mensagem |

A resposta é `201` com `{ "data": { …mensagem } }`, o mesmo envelope e o mesmo
corpo nos dois modos de envio — telefone e `conversation_id` entregam o mesmo
recibo. O id que o conector guarda é `data.id`; o da conversa é
`data.conversation_id`.

## 7. O que este contrato NÃO faz

- **Não aceita canal explícito.** Este guia documenta o que existe: a sessão é
  escolhida pelo CRM (canal que disca número primeiro). Exigir
  `channel_session_id` no corpo é decisão de produto em aberto na issue #4513,
  e quem precisar disso hoje usa
  `POST /api/v1/conversations/open-with-contact`, que já aceita o campo.
- **Não recusa número que é ficha de OUTRA organização.** A busca só olha a
  organização do token; o número de outra organização **não é alcançado** (nada
  dela é lido nem usado), e a ficha nasce nesta organização pelo upsert. Recusar
  em vez de criar é decisão do mantenedor: "número novo" e "número de outra
  organização" são indistinguíveis sem consultar as outras organizações.
- **Não muda o conector do DeskVoice.** Ele vive em outro repositório
  (`packages/tools/src/connectors/deskcomm.ts`); este lado entrega a porta.

## 8. Uma nota de operação

Por telefone, o freio anti-ban entra **depois** de resolver a conversa — ele
pergunta a sessão pela conversa, que só existe depois. Um envio segurado pelo
teto diário pode deixar a conversa do contato aberta e vazia: o mesmo estado que
"iniciar conversa" deixa no inbox, e não uma conversa órfã de contato que não
existe.
