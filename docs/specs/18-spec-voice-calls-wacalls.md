---
title: Spec Técnica 18 — Chamada de Voz WhatsApp (WaCalls)
parent: 00-prd-master.md
depends_on: 01-spec-platform-base.md, 03-spec-whatsapp-waha.md, 07-spec-events-workers.md
version: 0.1
status: rascunho
date: 2026-09-02
owner: Daniel Henrique
related_rules: (nenhuma regra de negócio formal ainda — decisões de produto capturadas na §1.2 desta spec, não existe sub-PRD dedicado)
---

# Spec Técnica 18 — Chamada de Voz WhatsApp (WaCalls)

> Capacidade nova, fora do escopo original do MVP (`00-prd-master.md` §4). Não existe sub-PRD dedicado — as decisões de produto que normalmente estariam lá foram tomadas diretamente com o dono do produto e estão registradas na §1.2. Se a feature crescer (gravação, IVR, discador em massa), promover pra sub-PRD próprio.

---

## 1. Visão Geral

### 1.1 O que é

[WaCalls](https://github.com/JotaDev66/WaCalls) é um servidor Go + cliente React, MIT, que pareia uma conta WhatsApp via QR (biblioteca `whatsmeow`, INDEPENDENTE da sessão WAHA/NOWEB já usada pro canal de mensagens) e permite chamada de voz 1:1 pelo navegador: microfone vira PCM 16kHz sobre WebRTC data channel, o servidor Go codifica em MLow e injeta no relay SRTP do WhatsApp.

Não é um canal de mensagem — não implementa `ChannelAdapter` (`lib/channels/adapters/*`). É uma sessão de mídia ao vivo, tratada como subsistema próprio.

### 1.2 Decisões de produto fechadas

1. **Segundo dispositivo vinculado, risco aceito.** WaCalls pareia uma sessão separada da WAHA no mesmo número. Isso é um segundo linked device do WhatsApp — risco de ban adicional, sem a mitigação de warm-up/throttle que a doutrina já tem pro WAHA (`docs/business-rules` W-*). **Aceito, opt-in por organização, nunca ligado por padrão.**
2. **Gravação de chamada (`record: true` da API do WaCalls) fica DESLIGADA no MVP desta feature.** Grava voz = dado sensível LGPD, exige consentimento e entrada no cascade de redact (`fn_lgpd_cascade_redact_contact`). Decisão de ligar fica pra depois, separada.
3. **UI mínima obrigatória: discar, atender chamada recebida, chamada em andamento** (ver §5).

### 1.3 Posição na arquitetura

```
┌─────────────────────────┐                          ┌──────────────────────┐
│  Frontend Next.js       │   WebRTC (áudio direto)   │  WaCalls (Go)        │
│  - Discador             │◄─────────────────────────►│  - whatsmeow session │
│  - Toast chamada recebida│                          │  - pion WebRTC bridge│
│  - UI chamada em andamento│  SDP/controle via proxy  │  - SQLite (sessão)   │
└─────────┬────────────────┘                          └──────────┬───────────┘
          │ /api/v1/voice/*  (getUser + org check)                │ <call> stanza
          ▼                                                       ▼
┌─────────────────────────┐                            ┌──────────────────────┐
│  Backend Next.js        │──── event_log ────► worker │  WhatsApp relay      │
│  proxy server-to-server │     (SSE listener)         │  (SRTP)              │
└─────────┬────────────────┘                           └──────────────────────┘
          ▼
┌─────────────────────────┐
│ Postgres (Supabase)     │
│ - channel_sessions      │  (+colunas wacalls_*)
│ - voice_calls (nova)    │
│ - crm_lead_activities   │  (atividade type='voice_call')
│ - agent_inbox_items     │  (chamada perdida)
└─────────────────────────┘
```

**`wacalls` não publica a porta HTTP de controle na internet.** A imagem autenticada exige `WACALLS_ADMIN_USER`/`WACALLS_ADMIN_PASSWORD` no boot e `WACALLS_API_TOKEN` nas chamadas de automação. A API fica na rede `internal` do compose, alcançável pelo `app` e pelo `worker`; apenas a porta UDP de áudio é publicada. Fontes: `docker-compose.prod.yml`, `lib/wacalls/client.ts` e `lib/wacalls/events-bridge.ts`.

---

## 2. Schema

### 2.1 `channel_sessions` — novo provider

```sql
-- provider ganha 'wacalls' no vocabulário fechado (CHECK constraint existente)
alter table channel_sessions
  add column if not exists wacalls_session_id text,
  add column if not exists wacalls_jid text,
  add column if not exists wacalls_paired_at timestamptz;
```

Mesmo padrão de `meta_phone_number_id`/`zernio_account_id` — colunas nullable específicas de provider na mesma tabela, não tabela separada por provider.

### 2.2 `voice_calls` (nova)

```sql
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  wacalls_call_id text not null,
  direction text not null check (direction in ('inbound','outbound')),
  peer_phone text not null,
  -- Vocabulário do UPSTREAM (cmd/server/broker.go CallStatus) — passthrough
  -- literal, medido no código-fonte (não na doc do README, que não lista os
  -- valores). "Chamada perdida" NÃO é status próprio lá: é end_reason numa
  -- chamada sem answered_at.
  status text not null check (status in ('starting','ringing','connected','ended')),
  -- Vocabulário do UPSTREAM (internal/voip/core EndCallReason), sem CHECK —
  -- pode ganhar valor novo numa versão futura do WaCalls (doutrina DIRC).
  -- Conhecidos hoje: user_ended, declined, timeout, busy, cancelled, failed,
  -- do_not_disturb, unknown.
  end_reason text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, wacalls_call_id)
);

create index if not exists idx_voice_calls_org on voice_calls(organization_id);
create index if not exists idx_voice_calls_contact on voice_calls(contact_id);

alter table voice_calls enable row level security;
create policy tenant_isolation_voice_calls_all on voice_calls
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));
```

`recording_url` **não entra** nesta versão (gravação desligada, §1.2 item 2). Adicionar em migration própria quando a decisão de gravação for tomada — evita coluna morta hoje.

### 2.3 `crm_lead_activities`

`lead_id` é `NOT NULL` nesta tabela — uma chamada só vira atividade se resolver pra um **negócio (lead)**, não basta o contato. Reusa `resolveActiveLeadForContact` (`lib/leads/active-lead.ts`), já usado pra esse exato problema (contato → lead ativo): `routed: true` grava `crm_lead_activities` (`source_module='voice_calls'`, `source_id=voice_calls.id`, `type='voice_call'`, `lead_id` resolvido); `routed: false` (`no_open_lead`/`ambiguous_open_leads`) só atualiza `voice_calls`, sem linha de atividade — mesmo padrão que o resto do sistema já usa pra não chutar o card errado.

`type` é vocabulário aberto (sem CHECK — doutrina DIRC/exceção de `crm_lead_activities.type`), então `'voice_call'` entra como constante compartilhada em TS, não string literal solta.

### 2.4 Migration + baseline

`supabase/migrations/20260902190000_0206_chamada_de_voz_wacalls.sql` + apêndice idempotente no `supabase/baseline.sql` + linha no `MANIFEST.md` — aplicado e provado 3× contra o projeto de teste (install + 2 reaplicações idempotentes, exit 0). `lib/database.types.ts` já reflete o schema.

---

## 3. Serviço `wacalls`

### 3.1 Imagem e ativação — CONFIRMADO em `docker-compose.prod.yml`

O serviço usa a imagem do upstream `ghcr.io/jotadev66/wacalls`, fixada por digest no compose. Não há imagem própria para reconstruir. O serviço pertence ao profile `voz`, desligado por padrão; `COMPOSE_PROFILES=voz` o inclui nas próximas atualizações da instalação.

A API é autenticada. `WACALLS_ADMIN_USER` e `WACALLS_ADMIN_PASSWORD` permitem o boot; `WACALLS_API_TOKEN` é a credencial compartilhada pelo serviço, pelo app e pelo worker. O instalador e o atualizador completam os segredos ausentes. `WACALLS_API_BASE_URL=http://wacalls:8080` aponta os clientes para a rede interna.

### 3.2 Persistência e rede

A sessão fica no volume `wacalls-data`, em `/data`. A porta HTTP 8080 não é publicada. O compose publica somente UDP, com a mesma porta no host e no serviço, definida por `WACALLS_WEBRTC_UDP_PORT` (padrão 7881).

### 3.3 Mídia WebRTC

`WACALLS_PUBLIC_IP` precisa conter o IP público da VPS, e a porta UDP configurada precisa estar alcançável pelo navegador. O controle HTTP passa pelo backend do CRM; o áudio segue diretamente entre navegador e serviço. Caddy não transporta esse áudio.

O estado HTTP saudável não comprova áudio. A prova de ligação exige aparelho pareado e participantes reais; redes que bloqueiam UDP podem exigir um relay TURN, que não faz parte desta instalação.

---

## 4. Backend — proxy e ponte de eventos

### 4.1 Rotas `app/api/v1/voice/*`

Todas exigem `getUser()` + verificação de organização (nunca confiar em `organization_id` do body). Traduzem pra chamada server-to-server em `http://wacalls:8080/...` — contrato medido no código-fonte (`cmd/server/httpapi.go`, não no README, que não lista os shapes):

| Rota DeskcommCRM | WaCalls | Body / resposta upstream |
|---|---|---|
| `POST /api/v1/voice/sessions/pair` | `GET /api/sessions` + `POST /api/sessions` — **e nunca `POST /api/sessions/{sid}/pair`** | `{name}` → `{id}`; a criação já inicia o pareamento, e o QR chega por SSE no `auth-state` (ver §4.2). O `/pair` do upstream troca o cliente whatsmeow sem refazer o subsistema de chamadas (`replaceClient` em `internal/app/session/session.go`), e o discador fica preso ao cliente desconectado — a rota o chamava desde a primeira versão da feature (2026-09-08). Antes de apagar ou criar, a rota lê `GET /api/sessions`: sessão pareada lá (banco atrasado, worker reiniciando) é gravada no banco e responde `409 voice_already_paired`, nunca é apagada — apagar desloga o aparelho. Sessão que nunca pareou, e órfã não pareada com o nome da organização (`org_<uuid inteiro>`), é apagada e recriada; sessão criada sem conseguir registro no banco é desfeita |
| `GET /api/v1/voice/sessions/status` | `GET /api/sessions` (filtrado pela org) | `{sessions: [{id,name,jid,state,paired}]}` — campo é `state`, não `status` como o README da tabela de API sugere |
| `POST /api/v1/voice/calls` | `POST /api/sessions/{sid}/calls` | `{phone, duration_ms?, record?}` → `{call: {callId}}`. **`record` nunca é passado `true`** (§1.2 item 2). **`phone` é o número que o WhatsApp registrou, não o do cadastro:** o WaCalls monta o destino com `types.NewJID(dígitos, DefaultUserServer)` sem consultar nada, e o WhatsApp registra muito celular brasileiro sem o nono dígito. Medido na VPS em 2026-09-15: contato `+5531998966398`, `check-exists` do WAHA → `553198966398@c.us`; discado com o nono, a oferta saiu para um endereço inexistente e expirou tocando. A rota pergunta ao WAHA da organização (`lib/voice/numero-discavel.ts`) e, sem WAHA, sem sessão de mensagens em pé ou só com `@lid`, disca o cadastro. A resposta devolve a linha inteira de `voice_calls` (o painel decide "é minha?" pelo dono) |
| `POST /api/v1/voice/calls/:id/webrtc` | `POST .../calls/{id}/webrtc` | `{sdp_offer}` → `{sdp_answer}` — relay puro do SDP |
| `POST /api/v1/voice/calls/:id/accept` | `POST .../calls/{id}/accept` | → `{call: {callId}}` |
| `POST /api/v1/voice/calls/:id/reject` | `POST .../calls/{id}/reject` | → `{status: "ok"}` |
| `DELETE /api/v1/voice/calls/:id` | `DELETE .../calls/{id}` | → 204 |
| `GET /api/v1/voice/calls/history` | `GET .../history` | → `{rows: CallRecord[]}` |

**Erro do upstream em `POST /api/v1/voice/calls`:** o texto passa por `wacallsFriendlyError` e a rota responde `502 wacalls_error` — com UMA exceção. `500 {"error":"usync devices: ... websocket not connected"}` sai de dentro do whatsmeow quando o cliente que disca está sem socket. Medido na VPS em 2026-09-15: a partir de 60 s depois de "sessão pareada", TODA ligação recebeu esse corpo, por duas horas, com o contêiner mantendo conexão estabelecida com a Meta — o socket de pé era do cliente que pareou, e quem discava era o cliente anterior, desconectado pelo `/pair` (ver a linha do pareamento acima); só `docker restart` do WaCalls resolveu. Isso está consertado na origem, e o `503` fica para a queda de rede de verdade, que o whatsmeow reconecta sozinho — **essa não foi medida**, é a leitura do código. Para esse caso a rota responde **`503 wacalls_not_connected` + `Retry-After: 3`** — `lib/api/client.ts` repete 503 (até 3 tentativas, honrando o `Retry-After`), e repetir é seguro porque o erro nasce antes de qualquer `<call>` sair. Regra em `wacallsSemConexao` (`lib/wacalls/client.ts`); medido em `tests/unit/voz-rotas-de-chamada.test.ts`.

**A ponte grava a ligação antes da rota.** O WaCalls emite `call-status` na `/api/events` ao enviar a oferta, antes de responder o `startCall`, e o worker grava a linha ~200 ms antes do INSERT da rota. Em `23505` (`voice_calls_organization_id_wacalls_call_id_key`) a rota completa a linha da ponte — sentido, dono, contato, sem tocar no status — e responde 201; antes respondia 502 com o telefone do outro lado tocando.

**`X-Client-Id`** (header ou `?clientId=`) é como o WaCalls identifica o OPERADOR dono de uma chamada (exclusividade — um atendente só segura uma chamada ativa por vez, `409 operator already on a call` senão). A rota DeskcommCRM injeta o `user.id` da sessão autenticada aqui — nunca deixa o frontend escolher esse valor.

`sessionId` do WaCalls nunca vaza pro frontend sem passar pela verificação de org — igual o `webhook_path_token` do WAHA não expõe `session_name` direto.

### 4.2 Ponte de eventos (worker)

**Contrato confirmado em código:** tanto o relay do QR como a ponte do worker
autenticam `GET /api/events` com `Authorization: Bearer WACALLS_API_TOKEN`.
A tela abre a SSE (`GET /api/v1/voice/events`) ANTES de pedir o pareamento e,
depois do `onopen`, envia um único `POST /api/v1/voice/sessions/pair` com `{}`.
O relay não exige sessão para abrir: ele reconhece a sessão da organização pelo
`name` (`nomeDaSessaoDeVoz`, `lib/wacalls/nome-da-sessao.ts`) no `session-list`
que o broker emite na criação e antes de cada QR — por isso o primeiro QR, que
sai antes de o banco conhecer o id, não se perde. O nome leva o uuid INTEIRO da
organização: com os 8 primeiros caracteres, dois tenants de mesmo prefixo
receberiam o QR um do outro. (A tela chegou a ter, entre 2026-09-14 e esta
correção, um passo `prepare_only` que só registrava a sessão para o relay ter um
id; o `/pair` que prendia o discador vinha no POST seguinte, e existia desde a
primeira versão — ver §4.1.) O relay repassa `qr`, `paired` e, quando o QR da
tela vence (`auth-state` com `state:"logged_out"` da MESMA sessão), `expired`.

**`call-status` não traz `direction`.** O envelope sai do broker com `type,
sessionId, id, owner, status, peer, startedAt, peerName, peerPhotoUrl`
(`internal/app/events/callregistry.go`); só o snapshot `call-list` e a API REST
carregam o campo. A ponte infere o sentido no INSERT pelo dono (`owner` presente
= discada pelo CRM, ausente = recebida), confirma `inbound` no evento `incoming`,
e reaplica o snapshot `call-list` a cada reconexão: ali o sentido é DECLARADO, e
só o declarado reescreve uma linha que já existe. Limite conhecido: ligação feita
fora do CRM (a tela web do WaCalls) nasce sem dono e é lida como recebida até o
snapshot a corrigir.

**O contato é achado pelas duas grafias do nono dígito** (`phoneLookupVariants`),
e a grafia idêntica ao peer vence. O peer vem como o WhatsApp registrou
(`553198966398`), o cadastro guarda com o nono (`+5531998966398`).

O serviço `worker` mantém uma conexão SSE por processo contra `http://wacalls:8080/api/events`. Cada evento resolve a sessão e sua organização antes de escrever no banco. Eventos medidos no código-fonte (`cmd/server/broker.go`), com `"type"` no envelope:

| `type` | Payload | O que o worker faz |
|---|---|---|
| `session-qr` | `{sessionId, qr}` | Ignorado pelo worker E pelo relay: o mesmo QR vem no `auth-state`, que é o que o relay (`app/api/v1/voice/events/route.ts`) lê |
| `auth-state` | `{sessionId, paired, state, qr}` | `paired=true` → grava `channel_sessions.wacalls_paired_at` e `status='WORKING'`. `paired=false` com `state='logged_out'` (aparelho desvinculado pelo celular, `Logout`, QR vencido) → limpa `wacalls_paired_at` e `status='STOPPED'` quando havia pareamento; sem isso a tela seguia "pareado" e parear de novo recebia 409. `paired=false` com `state='qr'` não muda nada |
| `call-status` | `{sessionId, id, owner, status, peer, startedAt}` | Upsert em `voice_calls` (`status` passthrough — `starting`/`ringing`/`connected`; `answered_at=now()` na transição pra `connected`) |
| `incoming` | `{sessionId, id, peer, offeredAt}` | Garante a linha em `voice_calls` como `direction='inbound'` (cria se o `call-status` se perdeu; corrige o sentido se a inferência pelo dono errou) — a notificação de chamada recebida (§5.2) vem do Realtime sobre a linha |
| `call-ended` | `{sessionId, id, owner, reason, endedAt}` | Fecha a chamada: `status='ended'`, `end_reason=reason`, `ended_at`, `duration_ms` calculado. Se `answered_at` nunca foi setado E a chamada é `inbound` → linha em `agent_inbox_items` (`kind='voice_call_missed'`), mesmo padrão do `message_send_stuck`. Ligação FEITA sem resposta não é perdida: vira atividade `voice_call_unanswered` ("Chamada de voz sem resposta") na linha do tempo, sem aviso |
| `call-list` | `{calls: CallRecord[]}` (`sessionId, callId, owner, direction, peer, startedAt, status`) | Reaplicado a cada reconexão da ponte, registro a registro (um que falha não derruba os outros; forma inesperada vira log): é a única fonte no stream com `direction`, e cobre a ligação que COMEÇOU enquanto a ponte estava caída. A que TERMINOU nesse intervalo não vem, e a linha dela segue aberta — limite conhecido |
| `session-list` | snapshot das sessões | Ignorado pelo worker; o relay do navegador usa o `name` para reconhecer a sessão da organização (§4.2 acima) |

Em todo `call-ended`: `emit_event()` → linha em `event_log` (consumidores futuros, ex. billing de minutos); e resolve lead via `resolveActiveLeadForContact` pra inserir em `crm_lead_activities` se `routed: true` (ver §2.3) — se `routed: false`, só `voice_calls` reflete o estado, sem atividade chutada.

**Trigger Postgres não entra aqui** — é o worker (processo de aplicação) que escuta SSE e escreve, não um trigger de banco fazendo HTTP.

---

## 5. Frontend — as 3 telas obrigatórias

### 5.1 Discador (iniciar chamada)

Botão "Ligar" no header do contato/lead (Customer 360) e no cabeçalho da conversa na Inbox (exceto grupos; `components/inbox/ConversationHeader.tsx`, mesmo `DialButton`), visível só quando: `organizations.settings.voice_calls.enabled = true` E existe `channel_sessions` com `provider='wacalls'` e status pareado pra essa org. Clique → `POST /api/v1/voice/calls` com o telefone do contato → abre painel de chamada em andamento (§5.3) já em estado `ringing`.

### 5.2 Chamada recebida

Escutado via Realtime (Supabase Realtime em `voice_calls`, filtrado por `organization_id` — mesmo mecanismo que outras notificações já usam) ou via SSE do próprio Next.js (`/api/v1/voice/events`, wrapper fino sobre o stream do worker). Toast/modal global (sobrepõe qualquer tela, como uma notificação de sistema): nome/telefone de quem liga (resolvido contra `contacts` se existir), botões **Atender** / **Recusar**. Toca som de toque (respeita mute do navegador).

### 5.3 Chamada em andamento

Painel fixo (não modal bloqueante — usuário deve conseguir navegar no CRM durante a ligação): duração corrida, nome do contato, botões mute/desmute e encerrar. Abre a `RTCPeerConnection` do navegador contra o endpoint de WebRTC do WaCalls (via proxy de sinalização do §4.1; mídia direta conforme §3.3). Estado sincronizado com `voice_calls.status` via Realtime — se a ligação cair do lado do WhatsApp, o painel reflete `ended`/`failed` sem esperar o usuário clicar em nada.

**Uma perna de áudio por ligação, e é a da aba do gesto.** O WaCalls guarda uma ponte de áudio por chamada: a troca de SDP mais recente substitui a anterior e fecha a outra sem erro nem log (`setBridge`, `internal/app/session/session.go`). Medido em produção em 2026-09-15: o áudio abria em todo documento do usuário que recebia o `connected` pelo Realtime; duas abas trocaram SDP com 7 ms de diferença e ninguém ouviu ninguém. Regra em vigor (`hooks/voice/useVoiceCallSession.ts`):

- o áudio abre **no clique** — "Chamar" logo depois de a ligação nascer, ainda tocando, e "Atender" depois do aceite —, como o cliente oficial do WaCalls (`client/src/hooks/useStartCall.ts`). `doWebRTC` só exige que a chamada exista; a crença de que a troca precisava esperar o atendimento era falsa;
- a aba do gesto grava a marca `voz:midia` em `sessionStorage` (por aba, sobrevive ao recarregar). O `connected` só reabre o áudio na aba com a marca — o caso de recarregar no meio da ligação;
- outra aba ou aparelho do mesmo usuário mostra "O áudio desta ligação está em outra aba" com **Ouvir aqui**, que traz a ponte para ela;
- cada troca de SDP manda um id aleatório da aba, gravado em `voice.call_media_attached.metadata.aba`: `count(distinct metadata->>'aba')` por ligação responde quantas abas abriram áudio sem console de navegador.

**O painel não depende de uma entrega única.** Enquanto há ligação, o hook confere `GET /api/v1/voice/calls/history` a cada 10 s, quando a aba volta a ficar visível, quando o canal Realtime avisa que reassinou e quando a conexão de áudio cai (o fim da ligação fecha a ponte, e é a primeira notícia que o navegador tem). A conferência só avança o ciclo de vida, nunca recua nem ressuscita ligação encerrada. Medido em 2026-09-15: o `ended` não chegou pelo Realtime e o painel ficou 66 s depois de o celular desligar.

**O aviso de mídia separa as causas:** "O áudio desta ligação está em outra aba" (Ouvir aqui), "Sem áudio: o canal de voz não abriu" (Tentar de novo — rede, porta UDP) e "O áudio caiu" (Reconectar — o canal chegou a abrir). Encerrar tem trava de clique repetido, e `DELETE /api/v1/voice/calls/:id` de ligação já `ended` responde 204 sem chamar o WaCalls nem auditar.

Design: aplicar `hm-design`/`frontend-design` antes de considerar pronto — não é tela de formulário, é UI de estado ao vivo (padrão de referência: discador do macOS/iOS FaceTime, não um `<Dialog>` genérico shadcn).

---

## 6. Living System Checklist (doutrina `sistema-vivo.md`)

- **Entrada**: botão Ligar no Customer 360 e no cabeçalho da conversa na Inbox (exceto grupos); discador acessível.
- **Saída**: `voice_calls` na timeline do lead + `agent_inbox_items` pra chamada perdida.
- **Atividade/log**: `crm_lead_activities` type `voice_call`; `event_log` via `emit_event`.
- **Porta na navegação**: painel de chamada é overlay global, não precisa de item de menu próprio; configuração de pareamento entra em Configurações › Canais (grupo já existente em `lib/navigation/registry.ts`).
- **Anti-morte**: se `wacalls` cair, `worker` perde a conexão SSE — precisa reconectar com backoff (mesmo padrão de outros consumidores) e o discador deve refletir "canal indisponível" em vez de travar em `ringing` pra sempre.
- **Laço de retorno**: chamada perdida → `agent_inbox_items` → alguém vê na Central → liga de volta. Erro de pareamento → toast explícito na tela de Configurações › Canais, não silencioso.

---

## 7. Fora de escopo desta versão

- Gravação de chamada (§1.2 item 2).
- Discagem em massa / campanha de voz.
- IVR / menu de voz.
- Múltiplas chamadas concorrentes por atendente (o WaCalls suporta `-max-calls-per-session`, mas a UI desta versão assume 1 chamada ativa por vez no navegador).
- TURN relay próprio (fica como opção 2 do §3.3, não implementado nesta fase).
