---
marp: true
theme: default
class: invert
paginate: true
title: SonghaiCRM — Pitch Deck v0.1
description: CRM operacional com IA pra e-commerce moçambicano
date: 2026-04-29
---

# SonghaiCRM

### O CRM operacional onde **IA e humanos atendem juntos** os clientes finais de PMEs de e-commerce no WhatsApp.

**Multi-tenant · LGPD-nativo · MCP-ready · Moçambique-first**

<sub>Songhai, Lda — Maputo, 29 de abril de 2026</sub>

---

## 1. O problema

PME de e-commerce brasileiro hoje atende cliente final num caos:

- **WhatsApp Web pessoal + planilha + memória do atendente.** Quando o atendente sai, leva o relacionamento junto.
- **Atendimento 100% humano custa caro.** 5 atendentes 12h/dia não fecha conta.
- **CRMs B2B (Pipedrive, RD, Zendesk) não servem.** Funil de SaaS ≠ ciclo de e-commerce.
- **LGPD em pé de fragilidade.** Multas crescendo desde 2023; lojista é o primeiro alvo.
- **Nenhum CRM expõe MCP nativo.** Cliente power-user que quer agente IA orquestrar não tem alternativa.

> **Resultado**: PME ou paga muito por atendimento ruim, ou perde vendas e queima reputação.

---

## 2. A nossa visão

SonghaiCRM é a plataforma onde:

| Atendimento | Tecnologia | Compliance |
|---|---|---|
| **IA cobre 60-70%** dos casos repetitivos | RAG por tenant (FAQ + política + catálogo + histórico) | LGPD nativa: webhooks redact/data_request da Nuvemshop são contrato de 1ª classe |
| Humanos cuidam **só do que importa** | Sentiment detection escala automaticamente | Audit trail íntegro, retenção 5 anos |
| **Multi-canal pronto** (WhatsApp v1; Instagram/email v4) | Multi-tenant SaaS-ready desde o dia 1 | MFA TOTP forçado pra admin |

**Em 3 anos**: dominar BPO de atendimento de e-commerce no Brasil → abrir SaaS direto pra lojistas → expandir VTEX/Shopify → MCP público pra clientes power-user.

---

## 3. Quem usa

### Hoje — Modo BPO
**Sua empresa** opera o CRM internamente, atendendo múltiplos e-commerces clientes via *caixa de entrada unificada* (super-admin role que cruza tenants).

### Amanhã — Modo SaaS
Mesmo produto vendido direto pra lojistas operarem por conta. **Zero refactor** — multi-tenancy via RLS Postgres desde o dia 1.

### Cliente alvo (tenant)
PME brasileiro de e-commerce na **Nuvemshop**:
- ~5.000 pedidos/mês
- ~300 atendimentos/dia
- 2-5 atendentes humanos
- 1-2 números WhatsApp

---

## 4. Diferencial competitivo

### 4 pilares que nenhum incumbente oferece junto

🤖 **IA operando o atendimento, não chatbot decorativo**
- RAG por tenant (FAQ + política + catálogo Nuvemshop + conversas resolvidas)
- Sentiment detection em tempo real (Haiku 4.5)
- Resposta principal Sonnet 4.6 via Vercel AI Gateway

🛒 **E-commerce-native, não B2B genérico**
- Pipeline default já mapeado: Carrinho abandonado → Pago → Enviado → Entregue → Pós-venda
- Vocabulary customizável por nicho (Cliente/Pedido/Pago vs Lead/Deal/Won)

🔌 **MCP-ready** (Fase 2)
- 19 tools canônicas pra LLMs orquestrarem o CRM
- Resource `crm://schema` pra grounding de IA externa

🛡️ **LGPD-nativa**
- Webhooks Nuvemshop `customer/redact`, `customer/data_request`, `store/redact`
- SLA: data_request D+7, redact D+15
- CPF criptografado at-rest com pgcrypto

---

## 5. Arquitetura (visão alta)

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Next.js 14 App Router)        Vercel             │
│  - Inbox 3 colunas (Conversas + Chat + CRM SidePanel)       │
│  - Kanban com drag-drop fractional indexing                 │
│  - Realtime via Supabase Realtime                           │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│  Backend (Next.js Route Handlers + Workers)                 │
│  - API REST /api/v1 (cursor pagination, idempotency-key)    │
│  - Webhooks: WAHA + Nuvemshop                               │
│  - Workers: AI bot · Sentiment · LGPD · Sync · Anti-ban     │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│  Postgres (Supabase, sa-east-1) — 15 tabelas com RLS        │
│  - organizations · contacts · crm_leads · crm_lead_links    │
│  - messages · ai_chunks (pgvector) · event_log · audit_log  │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────┐    ┌──────────────────┐    ┌──────────┐
│  WAHA Plus (NoWeb)  │    │ Vercel AI Gateway│    │ Upstash  │
│  Hostgator VPS BR     │    │ Anthropic +      │    │ Redis    │
│                     │    │ OpenAI fallback  │    │ (rate)   │
└─────────────────────┘    └──────────────────┘    └──────────┘
```

**Doutrina arquitetural**: trigger NUNCA faz HTTP · `event_log` + workers · idempotência via `unique(org, external_id)` · RLS em toda tabela tenant-aware · adapter pattern pra plataformas.

---

## 6. O que já está pronto (28/04/2026)

### Documentação

- ✅ **PRD-Mestre + 6 Sub-PRDs** (~25k palavras) — visão, escopo, ACs, riscos
- ✅ **60 Regras de Negócio** catalogadas (T/L/W/P/AT/IA/B) com enforcement layer + override matrix
- ✅ **8 Specs Técnicas** (~60k palavras) — schema SQL, código TS, fluxos detalhados
- ✅ **15 diagramas Mermaid** (C4 L1/L2/L3, ER, sequence, state machines)

### Infra deployada

- ✅ **Supabase project ativo em sa-east-1** (`rrydmwnporysaiysiztn`)
- ✅ **15 tabelas com RLS** habilitada (organizations, contacts, crm_leads, event_log, audit_log, idempotency_keys, etc.)
- ✅ **3 migrations aplicadas** (platform_base, event_log, customer_360)
- ✅ **Triggers de domínio** (auto won/lost, denorm activity, emit events, seed pipeline)
- ✅ **Helpers RLS canônicos** (`fn_user_org_ids`, `fn_is_platform_admin`, `fn_role_at_least`)

### Código base

- ✅ Next.js 14+ App Router scaffold (config, env, supabase clients, API wrappers)
- ✅ docker-compose pra WAHA local
- ✅ CLAUDE.md com convenções pra dev futuras
- 🔄 Inbox + Kanban + AI workers (próximo)

---

## 7. Roadmap

| Fase | Duração | Entrega |
|---|---|---|
| **MVP-B** | 8-12 sem | Plataforma + Customer 360 + WAHA + Pipeline + Atendimento + Chatbot RAG + Handoff sentiment + Nuvemshop |
| **1.5 Hardening** | +4-8 sem | Testes E2E densos, runbooks, observability profunda, security review |
| **2 MCP público** | +6-8 sem | MCP server `/crm-mcp` com 19 tools, deploy HTTP, auth Bearer |
| **3 Identity probabilística** | +4 sem | Device fingerprint, behavior matching, merge UI |
| **4 Multi-canal** | +6-8 sem | Instagram DM, email, web chat |
| **5 Multi-plataforma** | +4 sem cada | VTEX, depois Shopify |

---

## 8. Métricas de sucesso (MVP)

| KPI | Target | Como medimos |
|---|---|---|
| Taxa de resolução por IA | 50–60% | Conversas sem `handoff_triggered` ÷ total resolvidas |
| Tempo médio 1ª resposta | <30s IA, <5min humano | Diff `messages.created_at` inbound → próximo outbound |
| NPS pós-atendimento | ≥75 | Pesquisa automática após `conversation.status='resolved'` |
| Custo médio por atendimento | <R$ 3,00 | Custo total mensal ÷ conversas resolvidas |
| Taxa de banimento WAHA | 0% (alarme em ≥1) | Health check + Sentry |
| SLA data_request LGPD | ≤7 dias úteis | Diff `webhook.received_at` → `export.delivered_at` |
| Uptime tenant | ≥99,5% | Health-check externo |

**MVP-validado quando**: 1 tenant real em produção 30 dias contínuos sem incidente + 5/7 KPIs medidos automaticamente + LGPD passa revisão manual.

---

## 9. Custo operacional (MVP, 1-3 tenants)

| Componente | Mensal |
|---|---|
| Vercel Pro | $20 |
| Supabase Pro | $25 + add-ons |
| Hostgator VPS (WAHA, plano Turing, SP) | ~R$140 (~$28) |
| Upstash Redis | $5–15 |
| WAHA Plus | $30 |
| Sentry Team | $26 |
| AI (Anthropic via Gateway) | $50–300 / tenant (variável) |
| **Total fixo** | **~$140/mês** |
| **Total com IA** | **~$170–420/mês por tenant** |

**Margem**: a R$ 1.500/mês por tenant (preço-alvo) → margem bruta >70% no modo SaaS.

---

## 10. Riscos & mitigações

| Risco | Severidade | Mitigação |
|---|---|---|
| **Banimento WAHA** (WhatsApp detecta API não-oficial) | 🔴 Crítico | Anti-banimento herdado (throttle, warm-up, spinning, STOP). Número backup pré-aquecido. Runbook documentado. |
| **Mudança contratual Nuvemshop** | 🟠 Alto | Adapter pattern isola; testes de contrato no CI. |
| **WAHA Plus banido upstream** | 🟠 Alto | BYO mode documentado; migração futura pra API oficial Meta planejada. |
| **Custo IA escala pior que receita** | 🟠 Alto | Orçamento por tenant + alarme 80% / throttle 100%; fallback Haiku. |
| **LGPD multa primeiro tenant** | 🔴 Crítico | LGPD desde dia 1; revisão jurídica pré-produção; SLA D+7 com alarme em D+5. |
| **Vazamento cross-tenant** | 🔴 Crítico | RLS em toda tabela; testes de isolamento no CI obrigatórios. |
| **Equipe pequena queima** | 🟡 Médio | Sub-PRDs priorizados Now/Next/Later; MVP-A (sem IA) como fallback. |

---

## 11. Por que agora

**Janela competitiva única, 3 fatores convergindo:**

1. **WhatsApp Business no Brasil** já é canal #1 (RD Station: 65% das empresas BR usam WhatsApp). Nenhum CRM brasileiro nativo no canal + IA.
2. **MCP da Anthropic ganhou tração em 2025**. Janela aberta pra ser o **primeiro CRM brasileiro MCP-ready**.
3. **LGPD entrando em fase de fiscalização ativa**. PMEs estão expostas; **compliance vira diferencial** de venda, não custo.

> Quem chegar primeiro com a stack certa **define o padrão do nicho**.

---

## 12. Por que vai dar certo

### Doutrina arquitetural sólida

Adotamos integralmente o **bundle herdado** da referência *Aula CRM Nichado WAHA* — schema testado conceitualmente, edge cases catalogados (banimento, LGPD, multi-device), 9 anti-patterns nomeados (incluindo o letal "trigger faz HTTP").

### Engenharia disciplinada

- **60 regras de negócio** com enforcement layer documentada
- **Multi-tenancy via RLS** desde o dia 1 (não retrofit)
- **Idempotência por padrão** em todo webhook
- **Audit trail** denso, append-only, 5 anos

### Time-to-market realista

8-12 semanas pra MVP-B em produção. Sem fé cega, sem otimismo sem base — **estimativa calibrada na ordem de implementação herdada da referência**.

---

## 13. O que precisamos pra próximo passo

### Capital

- ~R$ 80-150k pra cobrir 1º trimestre de desenvolvimento (2-3 devs full-stack + 1 DevOps part-time + infra)
- ~R$ 30k/mês pra operação BPO inicial (1-2 atendentes seniors enquanto IA escala)

### Validação de mercado

- 1-2 e-commerces piloto Nuvemshop (5k+ pedidos/mês) pra MVP-validation
- Carta de intenção / pré-contrato pra ancorar o roadmap comercial

### Time

- 1 lead engineer (eu)
- 2 mid/senior full-stack
- 1 DevOps part-time
- Acompanhamento jurídico LGPD ad-hoc

---

## 14. Demo / próximas ações

### Hoje

- 🎯 Apresentação do plano técnico-comercial (este deck)
- 🎯 Repo público / privado no GitHub com toda documentação + scaffolding
- 🎯 Supabase + Vercel já provisionados (sa-east-1)

### Próximas 2 semanas

1. Implementar Inbox + Kanban (Sub-PRD 04 → Spec 04 já pronto)
2. Conectar 1º número WhatsApp via WAHA local
3. Implementar webhook receiver com HMAC + idempotência
4. Stub do bot RAG com 1 fonte (FAQ markdown)

### Próximo trimestre

- MVP-B em produção
- 1º tenant piloto operando
- Iteração baseada em métricas reais

---

## 15. Obrigado

> "**Não é mais um CRM. É a plataforma onde IA e humanos atendem juntos.**"

📧 info@songhai.cc
📍 Maputo, Moçambique
🔗 docs: github.com/melgarafael/DeskcommCRM (em breve)

**Perguntas?**
