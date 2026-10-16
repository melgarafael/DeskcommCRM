---
title: Máquinas de Estado
parent: README.md
fonte: Sub-PRDs 03/04/05/06 + research/architecture-diagrams
version: 0.1
date: 2026-04-28
---

# 05 — State Machines

> Diagramas Mermaid `stateDiagram-v2` das máquinas de estado críticas do produto. Cada uma vira contrato visual entre PRDs e UI.

---

## 5.1 Conversation status

Estados canônicos (Sub-PRD 04 §3.4): `open` (humano/IA ativos OU aguardando 1ª resposta) — `pending` (atendente respondeu, aguardando cliente) — `resolved`.

```mermaid
stateDiagram-v2
    [*] --> open: nova msg inbound
    open --> pending: atendente envia outbound
    pending --> open: cliente responde
    open --> resolved: 'Resolver' (atendente)
    pending --> resolved: 'Resolver' (atendente)
    open --> resolved: bot detecta handoff_resolved (raro)
    resolved --> open: cliente responde em ≤24h
    resolved --> open: nova conversation no mesmo contact (>24h cria conversation nova)
    resolved --> [*]: arquivada (>30d sem reabertura)
    open --> pending: handoff_triggered (4 gatilhos)
```

---

## 5.2 Lead status (open → won/lost via stage flags)

Sub-PRD 02 §3.8. Transição automática via `fn_crm_lead_close_on_stage` quando stage tem `is_won=true` ou `is_lost=true`.

```mermaid
stateDiagram-v2
    [*] --> open: lead criado (default)
    open --> won: movido pra stage com is_won=true
    open --> lost: movido pra stage com is_lost=true (lost_reason obrigatório)
    won --> open: reaberto (manager+, audit)
    lost --> open: reaberto (manager+, audit)
    won --> [*]: arquivado
    lost --> [*]: arquivado
    
    note right of won
      closed_at preenchido
      automaticamente
    end note
    
    note right of lost
      lost_reason em:
      requested_by_customer
      price | no_response
      product_unavailable
      other
    end note
```

---

## 5.3 Channel session (WAHA)

Sub-PRD 03 §3.1. 1 sessão = 1 número WhatsApp.

```mermaid
stateDiagram-v2
    [*] --> STARTING: POST /api/sessions WAHA
    STARTING --> SCAN_QR_CODE: WAHA gerou QR (≤10s)
    STARTING --> FAILED: WAHA não respondeu
    SCAN_QR_CODE --> WORKING: usuário escaneou QR
    SCAN_QR_CODE --> FAILED: timeout / WAHA crash
    SCAN_QR_CODE --> SCAN_QR_CODE: auto-refresh 30s (mesmo estado, novo QR)
    WORKING --> STOPPED: stop manual / pareamento perdido
    WORKING --> FAILED: WAHA crash / banimento detectado
    STOPPED --> STARTING: restart manual
    FAILED --> STARTING: retry manual
    STOPPED --> [*]: deletado pelo admin
    FAILED --> [*]: deletado pelo admin
    
    note right of WORKING
      cron sync-sessions
      checa a cada 1min
    end note
```

---

## 5.4 Bot mode (active → handoff → reactivated)

Sub-PRD 05 §3.7-3.8. Por conversation.

```mermaid
stateDiagram-v2
    [*] --> bot_active: agent ativo & não force_human
    bot_active --> human_handoff: G1/G2/G3/G4 disparado
    bot_active --> human_handoff: atendente clica 'Eu cuido'
    human_handoff --> bot_active: atendente clica 'Passar pra IA'
    human_handoff --> resolved: atendente resolve
    bot_active --> resolved: bot resolve (raro)
    resolved --> [*]
    bot_active --> bot_disabled: orçamento 100% (modo disable)
    bot_active --> bot_throttled: orçamento 100% (modo throttle = Haiku only)
    bot_disabled --> bot_active: admin aumenta budget OU vira mês
    bot_throttled --> bot_active: idem
    
    note right of human_handoff
      conversation.status=pending
      activity handoff_triggered
      com trigger_reason
    end note
```

---

## 5.5 LGPD request lifecycle

Sub-PRD 06 §3.9 + Sub-PRD 01 §3.6. SLA D+7 (data_request) / D+15 (redact).

O pedido de dados (`data_request`) — inclusive o que chega pela Nuvemshop — fica em `received` até a aprovação do admin; nada é montado nem enviado antes dela (doc 134, opção A). No banco, `approved` não é um valor de `status`: a aprovação grava `processing` e emite o evento que o worker consome.

```mermaid
stateDiagram-v2
    [*] --> received: webhook validado + log raw
    received --> approved: admin aprova em /app/lgpd/requests/[id]
    received --> alarm_d5: D+5 sem ação (data_request)
    received --> alarm_d10: D+10 sem ação (redact)
    alarm_d5 --> approved: admin aprova após alarme
    alarm_d10 --> approved: idem
    approved --> processing: worker async iniciou
    processing --> completed: export gerado / redact aplicado
    processing --> failed: erro no worker
    failed --> processing: retry manual
    failed --> escalated: 3x falhou → super-admin
    escalated --> processing: super-admin retry
    completed --> [*]: email entregue ao titular + audit
    received --> expired: D+7/D+15 sem ação (escala)
    expired --> escalated
    
    note right of completed
      audit log denso:
      who/which/mode/
      cascaded_to/confirmed_at
    end note
```

---

## 5.6 Atendente presence

Sub-PRD 04 §3.8. Toggle manual + auto-detect inactivity.

```mermaid
stateDiagram-v2
    [*] --> offline: login pendente
    offline --> online: usuário toggle / login completo
    online --> busy: 5min sem input (auto)
    online --> busy: usuário toggle manual
    busy --> online: usuário interage
    busy --> online: usuário toggle manual
    online --> offline: fecha última aba
    busy --> offline: fecha última aba
    online --> offline: usuário toggle manual
    
    note right of online
      recebe roteamento
      round-robin
    end note
    
    note right of busy
      mantém conversas
      abertas; não recebe
      novas
    end note
```

---

## 5.7 Outbound message status

Sub-PRD 03 §3.4. Optimistic UI flow.

```mermaid
stateDiagram-v2
    [*] --> sending: INSERT antes de chamar WAHA
    sending --> sent: WAHA responde 200
    sending --> failed: WAHA erro / timeout 5min (cron)
    sent --> delivered: webhook ack delivered
    delivered --> read: webhook ack read
    sent --> read: ack read direto (algumas sessões)
    failed --> sending: retry manual pelo atendente
    read --> [*]
    failed --> [*]: desistido
```

---

## 5.8 Channel session warmup (overlay sobre 5.3)

Sub-PRD 03 §3.7. Aplicado a número novo nos primeiros 7–14 dias.

```mermaid
stateDiagram-v2
    [*] --> warming_d1_7: número conectado (limit 50/dia)
    warming_d1_7 --> warming_d8_14: D+7 (limit 100→200/dia)
    warming_d8_14 --> mature: D+14 (limit 500/dia)
    mature --> seasoned: 90d ativo + baixo bloqueio (limit 1000+)
    warming_d1_7 --> banned: detecção de banimento
    warming_d8_14 --> banned
    mature --> banned
    seasoned --> banned
    banned --> [*]: número morto, runbook troca
    
    note right of warming_d1_7
      campanhas BLOQUEADAS
      apenas conversas reais
    end note
```

---

## 5.9 Nuvemshop connection

Sub-PRD 06 §3.2-3.3.

```mermaid
stateDiagram-v2
    [*] --> not_connected
    not_connected --> connecting: admin clica 'Conectar'
    connecting --> healthy: callback OK + healthcheck OK
    connecting --> failed: OAuth erro / scopes_insufficient
    failed --> connecting: retry
    healthy --> token_expired: refresh falhou (healthcheck 30min)
    token_expired --> healthy: re-auth bem-sucedido
    token_expired --> disconnected: 7d sem reconexão
    healthy --> disconnected: lojista revogou no painel Nuvemshop
    disconnected --> connecting: admin reconecta (preserva connection_id)
    healthy --> store_redacted: webhook store/redact
    store_redacted --> [*]: tenant em redact massivo
```
