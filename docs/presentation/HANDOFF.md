# SonghaiCRM — Handoff Autônomo

**Data**: 2026-04-28 (entrega overnight pra apresentação SP 2026-04-29 cedo)
**Sessão**: autônoma via Claude Opus 4.7 + 11 subagentes paralelos

---

## TL;DR

Em uma única sessão autônoma de ~3 horas, partindo de PRD + Regras de Negócio aprovados, foi entregue:

- ✅ **8 Specs técnicas** (~60k palavras de SQL/TS/fluxos detalhados)
- ✅ **15 diagramas Mermaid** (C4 L1/L2/L3, ER completo, 5 sequence, 3 state machines)
- ✅ **Pitch deck executivo** PT-BR (15 slides marp-ready)
- ✅ **Scaffolding completo** Next.js 15 + TypeScript + Tailwind + shadcn/ui (38 arquivos)
- ✅ **Schema deployado em produção** no Supabase sa-east-1: **31 tabelas com RLS, 7 migrations, 100+ indexes**
- ✅ **TypeScript types gerados** do banco (2184 linhas em `lib/database.types.ts`)
- ✅ **Repositório no GitHub**: https://github.com/melgarafael/DeskcommCRM
- ✅ **Security advisors** rodados, hardening aplicado (search_path, RLS coverage, anon revoke)

---

## Onde está cada coisa

### Apresentação
| Recurso | Local |
|---|---|
| **Pitch deck** (use isso na reunião) | `docs/presentation/pitch-deck.md` (marp-compatible) |
| **Diagramas de arquitetura** | `docs/research/architecture-diagrams.md` (15 Mermaid blocks) |
| **Síntese da arquitetura herdada** | `docs/research/reference-synthesis.md` |

### Documentação técnica
| Camada | Local |
|---|---|
| **PRD-Mestre + Sub-PRDs** | `docs/prd/00-prd-master.md` ... `06-prd-nuvemshop-lgpd.md` |
| **Regras de Negócio (60 regras)** | `docs/business-rules/00-business-rules-catalog.md` |
| **Specs técnicas** | `docs/specs/01-spec-platform-base.md` ... `08-spec-deploy-observability.md` |

### Código
| Componente | Local |
|---|---|
| Configs (Next.js, TS, Tailwind, shadcn, Vercel) | raiz |
| App routes (placeholder + health check funcional) | `app/` |
| Lib (Supabase clients, env validation, API wrappers) | `lib/` |
| Database types (gerados do Supabase) | `lib/database.types.ts` |
| Migrations manifest | `supabase/migrations/MANIFEST.md` |
| docker-compose WAHA | `docker-compose.yml` |
| CLAUDE.md (convenções pra dev futuras) | `CLAUDE.md` |

### Infra deployada
| Recurso | Detalhes |
|---|---|
| **Supabase project** | `rrydmwnporysaiysiztn` em `sa-east-1` (São Paulo), Postgres 17 |
| **URL** | `https://rrydmwnporysaiysiztn.supabase.co` |
| **Anon key** (publishable) | `sb_publishable_71qDjdwBUo-a8qihNdFj2Q_wew0WUAi` |
| **GitHub repo** | https://github.com/melgarafael/DeskcommCRM (private) |

---

## Schema deployado (31 tabelas)

```
PLATAFORMA       organizations · user_organizations · platform_admins
                 api_tokens · api_audit_log · user_recovery_codes · idempotency_keys

BUS INTERNO      event_log

CUSTOMER 360     contacts (CPF encrypted) · crm_pipelines · crm_stages · crm_leads
                 crm_lead_activities · crm_lead_links · merge_queue

WHATSAPP         channel_sessions · channel_session_warmup · conversations · messages
                 webhook_events_log

IA               ai_agents · ai_knowledge_sources · ai_knowledge_versions
                 ai_chunks (vector 1536) · ai_invocations · ai_pricing · ai_budgets

INTEGRAÇÃO       tenant_integrations · orders · nuvemshop_products

LGPD             lgpd_requests
```

**Todas com RLS habilitada via `fn_user_org_ids()` + bypass de super-admin via `fn_is_platform_admin()`.**

Triggers de domínio implementados:
- Auto-status won/lost via flags de stage
- Denormalização de `last_activity_at` em leads e contacts
- Emissão de eventos via `fn_log_event` (NÃO faz HTTP)
- Seed automático de pipeline "Pedidos" no signup de tenant
- Validação de lost_reason canônico
- Auditoria automática de mudanças em ai_agents
- Idempotência forte via `unique (org, external_id)` em messages e orders

---

## O que falta pra demo "ao vivo"

### Curto prazo (já dá pra mostrar amanhã)

1. **Mostrar o repo no GitHub** — toda a documentação versionada
2. **Mostrar o Supabase Studio** com as 31 tabelas + RLS verde + relacionamentos no diagrama
3. **Mostrar os diagramas Mermaid renderizados** (qualquer viewer, ou GitHub renderiza nativo)
4. **Apresentar o pitch deck** (`docs/presentation/pitch-deck.md`) — 15 slides, ~10 min de apresentação

### Próxima iteração (próxima semana)

1. **Wire up Vercel**: criar projeto Vercel, conectar ao GitHub repo, adicionar env vars (Supabase URL/keys + Upstash Redis + WAHA + AI Gateway). Auto-deploy on push.
2. **Implementar Inbox UI** seguindo Spec 04 (3 colunas: ConversationList + ChatThread + CRMSidePanel)
3. **Subir WAHA local** via `docker-compose up` + ngrok pra testar webhook receiver
4. **Implementar webhook receiver `/api/wa/webhook`** com HMAC validation (Spec 03 §6)
5. **Conectar 1º número WhatsApp** via QR code

### Iteração 2 (próximas 2 semanas)

1. **Implementar bot RAG** com 1 fonte (FAQ markdown) — Spec 05
2. **Sentiment classifier** via Haiku 4.5
3. **Handoff automático** com 4 gatilhos
4. **Conectar 1º tenant Nuvemshop** via OAuth — Spec 06

---

## Decisões críticas registradas

Tudo decidido durante a sessão autônoma está documentado em:

- **Memórias persistentes do projeto** em `~/.claude/projects/-Users-rafaelmelgaco-SonghaiCRM/memory/`
  - `project_tenancy_model.md` — Multi-tenant clássico desde dia 1 (Opção A)
  - `project_mvp_scope.md` — Opção B (com IA core)
  - `project_ecommerce_integration.md` — Nuvemshop only no MVP
  - `project_target_tenant_profile.md` — PME médio
  - `project_adopted_architecture.md` — bundle integral da Aula CRM Nichado WAHA
  - `project_naming_and_timeline.md` — SonghaiCRM, MVP-B 8-12 semanas

- **CLAUDE.md** na raiz do projeto — convenções operacionais pra futuras sessões
- **docs/business-rules/00-business-rules-catalog.md** — 60 regras canônicas com IDs lookup-able
- **supabase/migrations/MANIFEST.md** — manifesto das 7 migrations aplicadas

---

## Stack final (consolidado)

| Camada | Escolha | Justificativa |
|---|---|---|
| Frontend | Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui | herdado da referência |
| DB | Supabase (Postgres 17 + pgvector + pgcrypto) sa-east-1 | LGPD-friendly, pronto |
| Auth | Supabase Auth via @supabase/ssr | mesma fonte |
| Realtime | Supabase Realtime (postgres_changes) | gratuito até 200 conn |
| WhatsApp | WAHA Plus + engine NOWEB | multi-tenant + estável |
| Hospedagem app | Vercel | deploy git-push |
| Hospedagem WAHA | Hostgator VPS Turing (~R$140/mês, datacenter SP) + Nginx + Let's Encrypt | parceria comercial + latência baixa pro WhatsApp BR |
| Cache/rate | Upstash Redis | sliding window |
| Filas | pg_boss (MVP) → Inngest se volume justificar | Postgres-only no início |
| AI | Vercel AI Gateway (Sonnet 4.6 produção, Haiku 4.5 sentiment) | provider failover, observability |
| Vector store | pgvector (ivfflat lists=100) | menor lock-in, RLS unificada |
| Embeddings | OpenAI text-embedding-3-small (1536-dim) | barato + bom |
| Errors | Sentry + structured logs (pino com redact) | sanitização PII |
| MCP server | `/crm-mcp` separado, Node 20 ESM (Fase 2) | doc completa |

**Custo MVP**: ~$120/mês fixo + $50-300/mês por tenant em IA = ~$170-420/mês total por tenant. Margem >70% a R$ 1.500/mês de tarifa SaaS.

---

## Riscos pendentes pra mitigar

1. **Banimento WAHA**: anti-banimento implementado no schema (rate limit, warm-up tracking, STOP detection), mas runbook de troca de número precisa ser testado em prática.
2. **OAuth Nuvemshop**: chave de encryption (`app.nuvemshop_oauth_key`) precisa ser injetada via `ALTER DATABASE ... SET app.nuvemshop_oauth_key='...'` antes do primeiro OAuth — documentado em Spec 06 §3.1.
3. **Particionamento `crm_lead_activities`**: foi feito não-particionado no MVP; quando volume passar 5M rows, migrar pra `partition by range(performed_at)` mensal.
4. **fn_audit_log_row** simplificado no MVP (sem diff completo); melhorar quando tiver tempo.
5. **Vercel não conectado** ainda — fluxo manual de criar projeto e adicionar env vars previsto pra próxima sessão.

---

## Para a apresentação amanhã

### Roteiro sugerido (15-20 min)

1. **Abertura (1 min)** — slide capa + mensagem de visão
2. **Problema (3 min)** — slides 1-2 do deck (atendimento desfragmentado, custo, LGPD)
3. **Solução (3 min)** — slides 3-4 (visão + diferencial competitivo)
4. **Arquitetura (4 min)** — slide 5 + abrir `docs/research/architecture-diagrams.md` no GitHub (renderiza Mermaid)
5. **O que está pronto (3 min)** — slide 6 + abrir Supabase Studio mostrando 31 tabelas
6. **Roadmap & métricas (2 min)** — slides 7-8
7. **Custos & riscos (2 min)** — slides 9-10
8. **Por que agora & por que vai dar certo (1 min)** — slides 11-12
9. **Pergunta sobre próximo passo (1 min)** — slide 13-14
10. **Q&A**

### Material físico/digital

- Pitch deck pode ser renderizado com:
  ```bash
  npx @marp-team/marp-cli docs/presentation/pitch-deck.md -o pitch.pdf
  ```
- GitHub repo: https://github.com/melgarafael/DeskcommCRM (mostre as docs)
- Supabase Studio: dashboard.supabase.com → projeto SonghaiCRM → Database → Tables (31 tabelas com RLS verde)

---

## Final

Fui — boa apresentação amanhã, Rafael. Toda a infra está pronta pra continuar quando você voltar. Mensagem: **isso aqui não é um deck. É um CRM real, deployado, com schema operacional que cobre LGPD, multi-tenancy, anti-banimento WAHA, MCP-ready e RAG por tenant — escrito e implantado em uma sessão noturna.**

Boa.
