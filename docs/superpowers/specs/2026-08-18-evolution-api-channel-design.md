# Evolution API como quarto canal — design

> Status: aprovado em conversa (2026-08-18), pendente de plano de implementação.

## Contexto

O DeskcommCRM hoje fala WhatsApp por três providers atrás do seam `lib/channels/`
(`ChannelAdapter`): **WAHA** (não-oficial, engine Baileys, QR code, `banRisk: true`),
**Meta Cloud** (BSP oficial da Meta) e **Zernio** (intermediário que fala com a mesma
WABA da Meta). WAHA Plus — a versão exigida hoje pelo `CLAUDE.md` — é uma licença paga;
**Evolution API** é o equivalente open-source (Apache 2.0), também engine Baileys, também
QR code. O dono do produto já roda uma instância própria do Evolution API, separada deste
repositório, e quer que o CRM converse com ela.

Este design cobre a integração como um **quarto `ChannelProvider`**, seguindo o padrão
já estabelecido pelas migrations 0131/0132 (que adicionaram o Zernio) e pelo adapter WAHA
(o par mais próximo em características de canal).

## Fora de escopo (decidido em conversa)

- **Não** sobe container do Evolution API em nenhum compose/stack deste repo — a instância
  é externa, já operada pelo dono do produto. Configuração é só URL + API key, no mesmo
  molde do `WAHA_API_BASE_URL`/`WAHA_API_KEY` hoje.
- **Não** entra tradução para Docker Swarm (`docker-stack.yml`) — descartado depois que a
  instância externa tornou isso desnecessário para esta feature.
- **Não** entra foto de perfil (`fetchProfilePictureUrl`) nem resolução de LID
  (`resolvePhoneForIdentity`) na v1 — são métodos opcionais na interface `ChannelAdapter`;
  ficam para follow-up.
- **Não** entra gestão de templates (`templates`, `sendTemplate`) — Evolution API, como o
  WAHA, não tem WABA por trás; não há definição aprovada para gerir.

## Arquitetura

### Capabilities

Evolution API tem o mesmo perfil do WAHA: sem WABA, sem janela de 24h imposta pela
plataforma, com risco real de banimento por volume/padrão.

```ts
evolution: {
  freeformOutsideWindow: true,
  requiresTemplates: false,
  canManageTemplates: false,
  banRisk: true,
  minIntervalMs: null,
  voiceNote: "server-convert", // a confirmar contra a API real na implementação — ver "Riscos"
  groups: "full",
  costPerMessage: false,
},
```

`DEFAULT_CHANNEL_PROVIDER` continua `"waha"` — não muda.

### Novos arquivos (mirror de `lib/waha/`)

| Arquivo | Responsabilidade |
|---|---|
| `lib/evolution/client.ts` | Fetch wrapper autenticado (`EVOLUTION_API_BASE_URL` + `EVOLUTION_API_KEY`): criar instância, buscar QR, enviar texto/mídia, checar status, deletar instância |
| `lib/evolution/send.ts` | Resolve `RecipientInput` → endereço do Evolution API (`<numero>@s.whatsapp.net` individual, `<id>@g.us` grupo) |
| `lib/evolution/message-id.ts` | Parse do id de mensagem (envio e webhook) — Evolution API usa `key.id`, formato distinto do WAHA |
| `lib/evolution/ingest.ts` | Tradução do payload de webhook (evento `messages.upsert`, `connection.update`, etc.) para o formato interno de evento inbound que `lib/channels/inbound.ts` consome |
| `lib/evolution/webhook-auth.ts` | Verificação do webhook — Evolution API não faz HMAC nativo como o WAHA; a autenticidade vem do path token opaco por sessão (mesmo padrão do Zernio/`webhook_path_token`), não de assinatura de payload. A confirmar na implementação se a instância do dono do produto expõe algum header de assinatura configurável |
| `lib/channels/adapters/evolution.ts` | O `ChannelAdapter`: `resolveRecipient`, `isConfigured`, `send`, `checkHealth`, `fetchInboundMedia`, `codes`. Delega tudo a `lib/evolution/*`, igual ao `waha.ts` — nenhuma regra de negócio aqui |

### Banco

Segue a tripla obrigatória (migration + apêndice idempotente no `baseline.sql` + linha no
`MANIFEST.md`), próxima migration é `0161`.

```sql
alter table public.channel_sessions
  add column if not exists evolution_instance_name text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'evolution'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name       is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id    is not null) or
    (provider = 'zernio'     and zernio_account_id       is not null) or
    (provider = 'evolution'  and evolution_instance_name is not null)
  );
```

Os dois `drop constraint` + `add constraint` são recriados por inteiro (não
`duplicate_object`), pelo mesmo motivo documentado no apêndice da 0131: um clone que já
rodou o `update.sh` anterior já tem a constraint com 3 valores, e engolir o `create`
deixaria o Evolution API sempre recusado ali, com o script saindo verde.

`channel_sessions_engine_check` (`NOWEB`/`WEBJS`) **não muda** — é específico do WAHA
(qual motor Baileys ele roda por dentro) e não se aplica ao Evolution API, que tem o
próprio conceito de instância sem expor "engine" ao CRM.

### Configuração (`lib/env.ts`, `.env.example`)

```
EVOLUTION_API_BASE_URL   — obrigatória se o provider evolution for usado (mesmo padrão de WAHA_API_BASE_URL)
EVOLUTION_API_KEY        — chave admin da instância (cria/gerencia instâncias)
```

Ambas opcionais no schema Zod (como o WAHA) — a ausência já é tratada como "canal não
configurado" (`isConfigured() === false`), sem exigir env nova para quem não usa este
canal (packaging doctrine: env sem default não pode quebrar instalação existente).

### Webhook

`app/api/v1/webhooks/evolution/[token]/route.ts` — `[token]` é o
`webhook_path_token` da sessão (coluna já existente, genérica, reusada). Mesmo modelo de
autenticidade que o Zernio: o token no path é o segredo, não uma assinatura HMAC do corpo
(a confirmar contra a doc/instância real do Evolution API se ele suporta HMAC — se sim,
preferir e documentar o desvio do padrão Zernio).

### UI de conexão

A tela de conectar canal ganha "Evolution API" como opção QR, reaproveitando o componente
de exibição de QR já usado pelo fluxo WAHA — troca-se apenas a fonte dos dados (chamada a
`lib/evolution/client.ts` em vez de `lib/waha/client.ts`).

## Testes

- `lib/channels/adapters/evolution.test.ts` — mirror do teste de adapter existente (WAHA/Zernio)
- `lib/evolution/ingest.test.ts` — parsing de payload de webhook real (fixture capturada da instância do dono do produto)
- `pnpm test:db` — baseline install (fresh) + update (idempotência) com o 4º provider, incluindo o teste de isolamento RLS entre 2 organizações
- `pnpm lint:channels` — nenhum arquivo fora de `lib/channels/`/`lib/evolution/` deve nomear `"evolution"`

## Riscos e o que falta medir na implementação

- **Formato exato do payload de webhook do Evolution API** não foi confirmado contra uma
  instância real neste design — precisa de uma captura real (curl/log) antes de escrever
  `ingest.ts`, para não inventar estrutura.
- **Conversão de áudio** (`voiceNote: "server-convert"` vs `"opus-only"`) — herdado do WAHA
  por semelhança de engine (Baileys), mas não medido contra o Evolution API especificamente.
  Confirmar na implementação antes de finalizar a capability.
- **Autenticidade do webhook** — se o Evolution API não oferecer HMAC configurável, o
  path-token-como-segredo é mais fraco que o HMAC do WAHA (que assina o corpo). Aceitável
  por ora (mesmo nível do Zernio), mas vale registrar como dívida se o Evolution API não
  suportar nada melhor.
- **`echoExternalIds`** — o WAHA precisa disso por causa da assimetria NOWEB (id cru no
  envio vs. composto no webhook). Se o Evolution API for simétrico (mesmo id nos dois
  lados), este método opcional pode ficar de fora da v1; confirmar comparando IDs reais.

## Definition of Done desta feature

Segue o checklist padrão do `CLAUDE.md` (typecheck, lint, testes, RLS testada, audit log,
`.env.example`/`lib/env.ts` atualizados, migration + baseline + MANIFEST, tela nova com
porta em `lib/navigation/registry.ts` se aplicável, Living System Checklist). Como esta
feature não é fluxo de usuário novo por si só (é canal adicional dentro do fluxo de conexão
existente), a doutrina de QA Visual com Recursos Reais se aplica ao fluxo de **conectar via
QR até receber/enviar uma mensagem real** contra a instância do dono do produto.
