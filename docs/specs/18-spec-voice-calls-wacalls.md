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

**`wacalls` NUNCA publica porta HTTP de controle pra internet** — API sem autenticação própria (README do projeto: "no authentication... run only on trusted LAN"). Fica só na rede `internal` do compose, alcançável apenas pelo `app` e pelo `worker`.

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

### 3.1 Imagem

`Dockerfile.wacalls` (multi-stage, non-root, Go 1.26+ build stage + client React/Vite build stage servido estático pelo binário — `-static client/dist`). WaCalls é vendorizado por **commit fixo** (`edeb31f0427aba896639db503153b777a405eccf`, HEAD da `main` em 2026-09-02), clonado dentro do Dockerfile — mesmo princípio de tag imutável da doutrina de packaging (invariante 4), aplicado a uma dependência sem release/tag própria. Publicado como `ghcr.io/melgarafael/deskcomm-wacalls:stable`, 4ª imagem na matriz de `publish-image.yml`. **Sem `build:`-only** — doutrina de packaging.

Build e boot **provados localmente**: imagem constrói (client Vite + Go `CGO_ENABLED=0`, binário estático), container sobe, `GET /api/sessions` responde `200 {"sessions":[]}`, roda como uid 1001 (non-root).

### 3.2 Compose (`docker-compose.prod.yml`)

```yaml
wacalls:
  mem_limit: 256m   # medir em staging antes de fixar — placeholder
  image: ${WACALLS_IMAGE:-ghcr.io/melgarafael/deskcomm-wacalls:stable}
  pull_policy: ${WACALLS_PULL_POLICY:-always}
  restart: unless-stopped
  command: ["-addr", ":8080", "-db", "/data/wacalls.db", "-static", "/app/client/dist"]
  volumes:
    - wacalls-data:/data
  networks: [internal]
  logging: *default-logging
```

Sem `ports:` — não publicado, nem pelo Caddy (ver §3.3 pro caminho de mídia).

### 3.3 Rede — mídia WebRTC (ponto em aberto, bloqueia produção)

O `app` consegue proxear o control-plane HTTP do WaCalls (`/api/sessions`, `/calls`, SDP exchange) porque é request/response comum. **A mídia (ICE/SRTP) não** — é conexão direta navegador↔container, Caddy é L7 HTTP e não faz passthrough de UDP.

Opções pra produção (decidir antes de sair de LAN/staging):
1. Subdomínio dedicado (`calls.<domain>`) com Caddy proxeando só a parte HTTP de sinalização, e faixa de porta UDP fixa aberta direto no firewall da VPS pro pion (`-webrtc-udp-range` — flag a confirmar se o WaCalls expõe; senão fica em PR upstream ou fork).
2. TURN relay próprio (mais infra, resolve NAT de forma mais robusta, mas é serviço a mais).

**Não bloqueia o teste em LAN** (mesma rede, sem NAT hostil) — bloqueia deploy real na VPS Hostgator. Marcar como TODO explícito antes de anunciar a feature pra cliente.

---

## 4. Backend — proxy e ponte de eventos

### 4.1 Rotas `app/api/v1/voice/*`

Todas exigem `getUser()` + verificação de organização (nunca confiar em `organization_id` do body). Traduzem pra chamada server-to-server em `http://wacalls:8080/...` — contrato medido no código-fonte (`cmd/server/httpapi.go`, não no README, que não lista os shapes):

| Rota DeskcommCRM | WaCalls | Body / resposta upstream |
|---|---|---|
| `POST /api/v1/voice/sessions/pair` | `POST /api/sessions` + `POST /api/sessions/{sid}/pair` | `{name}` → `{id}`; pair não devolve QR direto — o QR chega por SSE (`session-qr`, ver §4.2) |
| `GET /api/v1/voice/sessions/status` | `GET /api/sessions` (filtrado pela org) | `{sessions: [{id,name,jid,state,paired}]}` — campo é `state`, não `status` como o README da tabela de API sugere |
| `POST /api/v1/voice/calls` | `POST /api/sessions/{sid}/calls` | `{phone, duration_ms?, record?}` → `{call: {callId}}`. **`record` nunca é passado `true`** (§1.2 item 2) |
| `POST /api/v1/voice/calls/:id/webrtc` | `POST .../calls/{id}/webrtc` | `{sdp_offer}` → `{sdp_answer}` — relay puro do SDP |
| `POST /api/v1/voice/calls/:id/accept` | `POST .../calls/{id}/accept` | → `{call: {callId}}` |
| `POST /api/v1/voice/calls/:id/reject` | `POST .../calls/{id}/reject` | → `{status: "ok"}` |
| `DELETE /api/v1/voice/calls/:id` | `DELETE .../calls/{id}` | → 204 |
| `GET /api/v1/voice/calls/history` | `GET .../history` | → `{rows: CallRecord[]}` |

**`X-Client-Id`** (header ou `?clientId=`) é como o WaCalls identifica o OPERADOR dono de uma chamada (exclusividade — um atendente só segura uma chamada ativa por vez, `409 operator already on a call` senão). A rota DeskcommCRM injeta o `user.id` da sessão autenticada aqui — nunca deixa o frontend escolher esse valor.

`sessionId` do WaCalls nunca vaza pro frontend sem passar pela verificação de org — igual o `webhook_path_token` do WAHA não expõe `session_name` direto.

### 4.2 Ponte de eventos (worker)

O serviço `worker` (já 24/7 pro agent-engine) mantém 1 conexão SSE por org com sessão pareada, contra `http://wacalls:8080/api/events`. Eventos medidos no código-fonte (`cmd/server/broker.go`), com `"type"` no envelope:

| `type` | Payload | O que o worker faz |
|---|---|---|
| `session-qr` | `{sessionId, qr}` | Publica o QR pro frontend (Realtime/SSE fino do Next) — é o ÚNICO jeito de obter o QR, não tem endpoint síncrono |
| `auth-state` | `{sessionId, paired, state, qr}` | Atualiza `channel_sessions.wacalls_paired_at`/`wacalls_jid` quando `paired=true` |
| `call-status` | `{sessionId, id, owner, status, peer, startedAt}` | Upsert em `voice_calls` (`status` passthrough — `starting`/`ringing`/`connected`; `answered_at=now()` na transição pra `connected`) |
| `incoming` | `{sessionId, id, peer, offeredAt}` | Cria a linha em `voice_calls` (`direction='inbound'`, `status='ringing'`) — dispara a notificação de chamada recebida (§5.2) |
| `call-ended` | `{sessionId, id, owner, reason, endedAt}` | Fecha a chamada: `status='ended'`, `end_reason=reason`, `ended_at`, `duration_ms` calculado. Se `answered_at` nunca foi setado (nunca atendida) → linha em `agent_inbox_items` (`kind='voice_call_missed'`), mesmo padrão do `message_send_stuck` |
| `call-list` / `session-list` | snapshot completo | Ignorado pelo worker (é o snapshot pro client React do próprio WaCalls se reconectar) — nossa fonte de verdade é o incremental acima |

Em todo `call-ended`: `emit_event()` → linha em `event_log` (consumidores futuros, ex. billing de minutos); e resolve lead via `resolveActiveLeadForContact` pra inserir em `crm_lead_activities` se `routed: true` (ver §2.3) — se `routed: false`, só `voice_calls` reflete o estado, sem atividade chutada.

**Trigger Postgres não entra aqui** — é o worker (processo de aplicação) que escuta SSE e escreve, não um trigger de banco fazendo HTTP.

---

## 5. Frontend — as 3 telas obrigatórias

### 5.1 Discador (iniciar chamada)

Botão "Ligar" no header do contato/lead (Customer 360), visível só quando: `organizations.settings.voice_calls.enabled = true` E existe `channel_sessions` com `provider='wacalls'` e status pareado pra essa org. Clique → `POST /api/v1/voice/calls` com o telefone do contato → abre painel de chamada em andamento (§5.3) já em estado `ringing`.

### 5.2 Chamada recebida

Escutado via Realtime (Supabase Realtime em `voice_calls`, filtrado por `organization_id` — mesmo mecanismo que outras notificações já usam) ou via SSE do próprio Next.js (`/api/v1/voice/events`, wrapper fino sobre o stream do worker). Toast/modal global (sobrepõe qualquer tela, como uma notificação de sistema): nome/telefone de quem liga (resolvido contra `contacts` se existir), botões **Atender** / **Recusar**. Toca som de toque (respeita mute do navegador).

### 5.3 Chamada em andamento

Painel fixo (não modal bloqueante — usuário deve conseguir navegar no CRM durante a ligação): duração corrida, nome do contato, botões mute/desmute e encerrar. Abre a `RTCPeerConnection` do navegador contra o endpoint de WebRTC do WaCalls (via proxy de sinalização do §4.1; mídia direta conforme §3.3). Estado sincronizado com `voice_calls.status` via Realtime — se a ligação cair do lado do WhatsApp, o painel reflete `ended`/`failed` sem esperar o usuário clicar em nada.

Design: aplicar `hm-design`/`frontend-design` antes de considerar pronto — não é tela de formulário, é UI de estado ao vivo (padrão de referência: discador do macOS/iOS FaceTime, não um `<Dialog>` genérico shadcn).

---

## 6. Living System Checklist (doutrina `sistema-vivo.md`)

- **Entrada**: botão Ligar no Customer 360; discador acessível.
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
