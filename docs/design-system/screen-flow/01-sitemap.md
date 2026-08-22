---
title: Sitemap — Mapa de Rotas Next.js App Router
parent: README.md
fonte: docs/prd/01..06
version: 0.1
date: 2026-04-28
---

# 01 — Sitemap

> Árvore canônica de rotas do SonghaiCRM. Toda tela construída deve aparecer aqui. Persona, auth e prioridade por rota; layouts pais explícitos. Convenção Next.js 14 App Router.

## Convenção de leitura

- `Persona`: P1=Operador BPO, P2=Super-admin, P3=Tenant admin, P4=Atendente tenant
- `Auth`: pública / autenticada / MFA-obrigatória / super-admin / role específico
- `Layout`: layout pai do App Router
- `Prio`: P0 (semana 1–4), P1 (semana 5–8), P2 (semana 9–12 / Fase 1.5)
- `RT`: requer Realtime?

## 1. Tronco público + auth (`(public)`)

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/` | todos | pública | `(public)` | P2 | não |
| `/login` | todos | pública | `(public)` | P0 | não |
| `/login/recovery` | todos | pública | `(public)` | P1 | não |
| `/login/mfa` | todos | parcial (pré-MFA) | `(public)` | P0 | não |
| `/logout` | todos | autenticada | n/a (action) | P0 | não |

Notas: `/login/mfa` recebe usuário com sessão pré-MFA; admin/super-admin sem TOTP cadastrado é redirecionado pra `/onboarding/mfa-setup` antes de qualquer outra rota (Sub-PRD 01 §3.1).

## 2. Onboarding (`(onboarding)`)

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/onboarding` | P3, P4 | autenticada (1º login) | `(onboarding)` | P0 | não |
| `/onboarding/welcome` | P3, P4 | autenticada | `(onboarding)` | P0 | não |
| `/onboarding/mfa-setup` | P3 (admin), P2 | autenticada | `(onboarding)` | P0 | não |
| `/onboarding/connect-whatsapp` | P3 | autenticada (admin+) | `(onboarding)` | P0 | sim (status sessão) |
| `/onboarding/connect-nuvemshop` | P3 | autenticada (admin+) | `(onboarding)` | P0 | não |
| `/onboarding/configure-ai` | P3 | autenticada (admin+) | `(onboarding)` | P1 | não |
| `/onboarding/invite-team` | P3 | autenticada (admin+) | `(onboarding)` | P1 | não |
| `/onboarding/done` | P3, P4 | autenticada | `(onboarding)` | P0 | não |

## 3. App autenticado de tenant (`/app`)

Layout pai: `/app` (sidebar global, header com vocabulary do pipeline atual, bell de notificações, avatar com presence dot).

### 3.1 Inbox (default landing pós-login)

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app` (redirect → `/app/inbox`) | P1, P3, P4 | autenticada | `/app` | P0 | — |
| `/app/inbox` | P1, P3, P4 | autenticada | `/app/inbox` (3 col) | P0 | sim |
| `/app/inbox/[conversationId]` | P1, P3, P4 | autenticada (RLS) | `/app/inbox` | P0 | sim |
| `/app/inbox?filter=unread` | idem | idem | idem | P0 | sim |
| `/app/inbox?filter=mine` | idem | idem | idem | P0 | sim |
| `/app/inbox?filter=unassigned` | idem | idem | idem | P0 | sim |
| `/app/inbox?filter=resolved` | idem | idem | idem | P1 | sim |

### 3.2 Pipeline & Kanban

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/pipelines` | P3, P4 (manager+) | autenticada | `/app` | P1 | não |
| `/app/pipelines/[pipelineId]` | P1, P3, P4 | autenticada (RLS) | `/app/pipelines` | P0 | sim |
| `/app/pipelines/[pipelineId]/settings` | P3 (manager+) | autenticada | `/app/pipelines/[id]` | P1 | não |
| `/app/pipelines/[pipelineId]/stages` | P3 (manager+) | autenticada | idem | P1 | não |
| `/app/pipelines/[pipelineId]/custom-fields` | P3 (manager+) | autenticada | idem | P1 | não |
| `/app/pipelines/new` | P3 (manager+) | autenticada | `/app/pipelines` | P1 | não |

### 3.3 Contacts

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/contacts` | P1, P3, P4 | autenticada | `/app` | P1 | não |
| `/app/contacts/[contactId]` | P1, P3, P4 | autenticada (RLS) | `/app/contacts/[id]` | P0 | sim (timeline) |
| `/app/contacts/[contactId]/timeline` | idem | idem | idem | P0 | sim |
| `/app/contacts/[contactId]/orders` | idem | idem | idem | P1 | não |
| `/app/contacts/[contactId]/conversations` | idem | idem | idem | P1 | não |
| `/app/contacts/[contactId]/consent` | P3 (manager+) | autenticada | idem | P1 | não |
| `/app/contacts/merge-queue` | P3 (manager+), P2 | autenticada | `/app/contacts` | P1 | sim |
| `/app/contacts/merge-queue/[mergeId]` | idem | idem | idem | P1 | não |

### 3.4 Orders (agregado)

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/orders` | P1, P3, P4 | autenticada | `/app` | P1 | não |
| `/app/orders/[orderId]` | idem | autenticada (RLS) | `/app/orders/[id]` | P1 | não |

### 3.5 IA — agents, knowledge, usage

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/ai` (redirect → `/app/ai/agents`) | P3 (admin) | autenticada | `/app/ai` | P1 | — |
| `/app/ai/agents` | P3 (admin) | autenticada | `/app/ai` | P1 | não |
| `/app/ai/agents/[agentId]` | P3 (admin) | autenticada | `/app/ai/agents` | P1 | não |
| `/app/ai/agents/new` | P3 (admin) | autenticada | `/app/ai/agents` | P2 | não |
| `/app/ai/knowledge` | P3 (manager+) | autenticada | `/app/ai` | P1 | não |
| `/app/ai/knowledge/sources` | P3 (manager+) | autenticada | `/app/ai/knowledge` | P1 | não |
| `/app/ai/knowledge/sources/faq` | idem | idem | idem | P1 | não |
| `/app/ai/knowledge/sources/policies` | idem | idem | idem | P1 | não |
| `/app/ai/knowledge/sources/catalog` | idem | idem | idem | P1 | não |
| `/app/ai/knowledge/sources/conversations` | idem | idem | idem | P1 | não |
| `/app/ai/usage` | P3 (admin) | autenticada | `/app/ai` | P1 | sim (custo live) |
| `/app/ai/budget` | P3 (admin) | autenticada | `/app/ai` | P1 | não |

### 3.6 Integrações

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/integrations` | P3 (admin) | autenticada | `/app` | P0 | não |
| `/app/integrations/whatsapp` | P3 (admin) | autenticada | `/app/integrations` | P0 | sim (sessões) |
| `/app/integrations/whatsapp/[sessionId]` | idem | idem | idem | P0 | sim |
| `/app/integrations/whatsapp/[sessionId]/qr` | idem | idem | idem | P0 | sim (polling) |
| `/app/integrations/whatsapp/new` | idem | idem | idem | P0 | sim |
| `/app/integrations/nuvemshop` | P3 (admin) | autenticada | `/app/integrations` | P0 | não |
| `/app/integrations/nuvemshop/connect` | idem | idem | idem | P0 | não |
| `/app/integrations/nuvemshop/sync` | idem | idem | idem | P1 | sim (progresso) |
| `/app/integrations/nuvemshop/webhooks` | idem | idem | idem | P1 | não |
| `/app/integrations/nuvemshop/mapping` | idem | idem | idem | P1 | não |

### 3.7 Team

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/team` | P3 (admin) | autenticada | `/app` | P1 | sim (presence) |
| `/app/team/invite` | P3 (admin) | autenticada | `/app/team` | P1 | não |
| `/app/team/[userId]` | P3 (admin) | autenticada | `/app/team` | P2 | não |

### 3.8 Audit

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/audit` | P3 (admin) | autenticada | `/app` | P1 | não |
| `/app/audit/[entryId]` | P3 (admin) | autenticada | `/app/audit` | P1 | não |

### 3.9 LGPD

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/lgpd` | P3 (admin) | autenticada | `/app` | P0 | não |
| `/app/lgpd/requests` | P3 (admin) | autenticada | `/app/lgpd` | P0 | não |
| `/app/lgpd/requests/[id]` | P3 (admin) | autenticada | `/app/lgpd/requests` | P0 | não |
| `/app/lgpd/redact` | P3 (admin) | autenticada | `/app/lgpd` | P0 | não |
| `/app/lgpd/consent` | P3 (admin) | autenticada | `/app/lgpd` | P1 | não |

### 3.10 Settings

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/app/settings` | P3, P4 | autenticada | `/app/settings` | P0 | não |
| `/app/settings/profile` | todos | autenticada | `/app/settings` | P0 | não |
| `/app/settings/notifications` | todos | autenticada | `/app/settings` | P1 | não |
| `/app/settings/security` | todos | autenticada | `/app/settings` | P0 | não |
| `/app/settings/security/mfa` | todos | autenticada+MFA | `/app/settings/security` | P0 | não |
| `/app/settings/security/sessions` | todos | autenticada | idem | P1 | não |
| `/app/settings/tenant` | P3 (admin) | autenticada | `/app/settings` | P1 | não |
| `/app/settings/tenant/vocabulary` | P3 (manager+) | autenticada | idem | P1 | não |
| `/app/settings/tenant/branding` | P3 (admin) | autenticada | idem | P2 | não |
| `/app/settings/api-tokens` | P3 (admin) | autenticada | `/app/settings` | P1 | não |
| `/app/settings/billing` | P3 (admin) | autenticada | `/app/settings` | P2 (Fase 2) | não |

## 4. Super-admin de plataforma (`/admin`, subdomínio `admin.deskcomm.com`)

Layout pai: `/admin` — sidebar dedicada, header com seletor "todos os tenants" + busca, bell cross-tenant, badge "Modo Plataforma".

| Path | Persona | Auth | Layout | Prio | RT |
|---|---|---|---|---|---|
| `/admin` | P2 | super-admin + MFA | `/admin` | P0 | sim |
| `/admin/dashboard` | P2 | idem | `/admin` | P0 | sim |
| `/admin/inbox` | P2 | idem | `/admin/inbox` (3 col cross-tenant) | P0 | sim |
| `/admin/inbox/[conversationId]` | P2 | idem (RLS bypass com flag) | idem | P0 | sim |
| `/admin/tenants` | P2 | idem | `/admin` | P0 | não |
| `/admin/tenants/new` | P2 | idem | `/admin/tenants` | P0 | não |
| `/admin/tenants/[id]` | P2 | idem | `/admin/tenants/[id]` | P0 | sim |
| `/admin/tenants/[id]/health` | P2 | idem | idem | P0 | sim |
| `/admin/tenants/[id]/team` | P2 | idem | idem | P1 | sim |
| `/admin/tenants/[id]/usage` | P2 | idem | idem | P1 | não |
| `/admin/tenants/[id]/impersonate` | P2 | idem (action → redirect /app) | idem | P0 | não |
| `/admin/audit` | P2 | idem | `/admin` | P0 | não |
| `/admin/audit/[entryId]` | P2 | idem | `/admin/audit` | P0 | não |
| `/admin/lgpd` | P2 | idem | `/admin` | P0 | não |
| `/admin/lgpd/requests` | P2 | idem | `/admin/lgpd` | P0 | não |
| `/admin/lgpd/requests/[id]` | P2 | idem | idem | P0 | não |
| `/admin/incidents` | P2 | idem | `/admin` | P1 | sim |
| `/admin/incidents/[id]` | P2 | idem | `/admin/incidents` | P1 | não |
| `/admin/usage` | P2 | idem | `/admin` | P1 | não |
| `/admin/users` | P2 | idem | `/admin` | P1 | não |
| `/admin/users/[id]` | P2 | idem | `/admin/users` | P1 | não |
| `/admin/platform-admins` | P2 | idem (read-only via UI) | `/admin` | P2 | não |
| `/admin/settings` | P2 | idem | `/admin` | P2 | não |

## 5. API & webhooks (não-UI)

Listadas pra completude do roteamento, mas sem UI associada.

| Path | Auth | Prio |
|---|---|---|
| `/api/v1/*` | Bearer / cookie | P0 |
| `/api/v1/health` | pública | P0 |
| `/api/wa/webhook` ou `/api/v1/webhooks/waha/[session]` | HMAC-SHA512 | P0 |
| `/api/v1/webhooks/nuvemshop/order-*` | HMAC | P0 |
| `/api/v1/webhooks/nuvemshop/customer-redact` | HMAC | P0 |
| `/api/v1/webhooks/nuvemshop/customer-data-request` | HMAC | P0 |
| `/api/v1/webhooks/nuvemshop/store-redact` | HMAC | P0 |
| `/api/v1/cron/*` | `INTERNAL_SECRET` header | P0 |

## 6. Telas de erro globais

| Path | Quando | Prio |
|---|---|---|
| `/_not-found` (404) | rota inválida | P0 |
| `/_error` (500) | erro server-side | P0 |
| `/403` (forbidden) | role insuficiente | P0 |
| `/503` (service down) | health-check em falha | P1 |
| `/maintenance` | janela manual | P2 |

## 7. Resumo quantitativo

- **Rotas autenticadas tenant** (`/app/*`): ~52
- **Rotas super-admin** (`/admin/*`): ~22
- **Rotas públicas + onboarding**: ~12
- **Rotas de erro globais**: 5
- **Total estimado de telas únicas**: ~70 (vide `03-screen-inventory.md`)
