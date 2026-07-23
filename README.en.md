<div align="center">

[🇧🇷 Português](README.md) · 🇺🇸 English · [🇪🇸 Español](README.es.md)

# 🛠️ DeskcommCRM — The AI Sales OS

**AI agents that answer, qualify and sell on WhatsApp — inside an open-source CRM running on your own server.**
**No subscription, no gated features, your data stays yours. The open alternative to Kommo, Octadesk and Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-one%20command-orange)](hostgator-setup-kit/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**🧭 Vision**](VISION.md) · [**📘 Setup Guide**](docs/SETUP.md) · [**🏗️ Architecture**](ARCHITECTURE.md) · [**🤝 Contributing**](CONTRIBUTING.md) · [**📋 PRDs**](docs/prd/) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

</div>

---

> ### ☁️ Run this CRM in production with one command
>
> DeskcommCRM is developed in **partnership with HostGator**: the [`hostgator-setup-kit/`](hostgator-setup-kit/)
> installs the full CRM (app + WAHA + database) on a VPS with a single command, and the
> [production runbook](docs/runbooks/waha-hostgator.md) assumes that environment.
>
> **[👉 Get the HostGator VPS with the partnership discount](https://www.hostgator.com.br/52708-141-3-52.html)** —
> São Paulo datacenter, ideal for WhatsApp running 24/7. *(partner link — subscribing through it supports the project and costs you less)*

## ✨ What is it

**Deskcomm** comes from **Desk** + **comm** (commerce): your entire sales operation on a single desk, run by people and AI agents working together.

The project was born as an e-commerce CRM — and the open-source community took it much further: today it runs in **clinics, real-estate agencies, info-product businesses, agencies, stores and service providers** — any business that sells over WhatsApp. The product followed that shift and became a **sales operating system**: AI agents with per-tenant RAG answer customers, qualify leads, move them through the pipeline, trigger automations and know when to hand off to a human — with the whole CRM exposed via **MCP** so agents can truly operate it. The full story is in [`VISION.md`](VISION.md).

### Why it's different

- 🤖 **AI agents that operate the CRM** — per-tenant RAG, sentiment analysis, audited AI→human handoff, AI as a first-class assignee and per-org budget control. Not a decorative chatbot: the agent answers, qualifies and moves the funnel.
- 🔁 **Self-improving agents** — resolved conversations become new RAG knowledge; handoffs mark where the agent falls short; metrics close the loop. Every month of operation makes the agent better, with a human gate where it matters.
- 🧩 **Multi-niche by design** — configurable vocabulary per pipeline: a lead becomes a *Customer*, *Patient* or *Buyer*; "won" becomes *Paid*, *Booked* or *Closed*. The same core serves e-commerce (our birthplace, with native Nuvemshop integration), clinics, real estate or info-products.
- 🔌 **MCP-ready** — internal MCP server for the built-in agents; a public contract for external agents is in the works. The CRM as infrastructure for any AI agent.
- 💬 **WhatsApp-native via WAHA** — multi-number, anti-ban (throttle + jitter + time windows), media via Storage, STOP detection.
- 👥 **Support governance** — real server-side RBAC, audited assignment/transfer, queue with position, automatic routing and per-role visibility scopes.
- 🏢 **Multi-tenant + privacy by design (LGPD)** — RLS on every tenant-aware table with an isolation test as a CI gate; anonymization preferred over deletion; append-only audit log with 5-year retention.
- 🖥️ **Truly self-hosted** — your data on your VPS; one-command install; no paid tier, no gated features.

### 🔌 Webhooks & Automations

Every tenant can create **capture sources**: a public endpoint (`/api/v1/webhooks/in/<token>`) that receives leads from landing pages, custom forms or tools like Zapier/n8n via POST (JSON or `application/x-www-form-urlencoded`) and drops them straight into the chosen pipeline/stage — no code, no per-tenant custom integration. On top of those sources (and the other CRM events — lead changed stage, got a tag, WhatsApp message arrived), tenants build **automations**: WHEN/IF/THEN rules that add tags, move leads, assign agents, send WhatsApp messages or notify external systems via outgoing webhooks.

In the UI everything lives under **Webhooks** in the sidebar (visible only to `manager`/`admin` roles). Three tabs: **Receive data** (create a source, copy the ready-made endpoint/form, fire a test lead, see recent deliveries), **Automations** (build rules, which are always born paused until reviewed and enabled) and **Activity** (a timeline of each run, with per-action results and manual retry when an external webhook call fails).

Under the hood, every event becomes a row in `event_log` — no database trigger ever makes an HTTP call. The `/api/v1/cron/event-log-drain` route drains the queue every minute. On Vercel that's a managed Cron Job; **on the HostGator self-host kit** (`hostgator-setup-kit/`), `install.sh`/`update.sh` automatically configures a `crontab` line that hits the route every minute with the `INTERNAL_SECRET` from `.env`.

---

## 🚀 Quickstart (see it running in 5 minutes)

```bash
# 1. Clone
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

# 2. Node 20 + pnpm
nvm use                    # or install Node 20+
npm install -g pnpm
pnpm install

# 3. Env vars
cp .env.example .env.local
# Edit .env.local — full guide in docs/SETUP.md

# 4. Local WAHA (optional in dev without WhatsApp)
docker compose up -d

# 5. Supabase migrations
supabase link --project-ref <your-ref>
supabase db push

# 6. Run the app
pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

> 🆕 **First time? Don't skip steps.** [`docs/SETUP.md`](docs/SETUP.md) is the complete step-by-step tutorial for **every integration** (Supabase, WAHA, Anthropic, Upstash, Sentry, Resend, Nuvemshop) — written for people who have never configured any of this. ~60–90 min from zero to a running app. *(Docs are in Brazilian Portuguese; translations welcome!)*

---

## 🧱 Stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + strict TypeScript 6 | Server Components + Route Handlers in one repo |
| **Styling** | Tailwind + shadcn/ui (`new-york`, neutral) | Customizable without lock-in |
| **DB** | Supabase (Postgres + RLS + `vector`) | Native multi-tenancy, embeddings for RAG |
| **Auth** | Supabase Auth via `@supabase/ssr` | SameSite=Strict, HttpOnly cookies |
| **Realtime** | Supabase Realtime | postgres_changes + broadcast |
| **Storage** | Supabase Storage (signed URLs) | Private `whatsapp-media` bucket |
| **WhatsApp** | WAHA Plus (NOWEB engine) | Multi-tenant, retry, S3 |
| **Queues** | `event_log` table + workers (cron) | No Inngest/Trigger in the MVP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, free tier is enough |
| **AI** | Vercel AI SDK v7 (Anthropic/Google/OpenAI providers v4) via AI Gateway | Automatic fallback, ZDR |
| **Validation** | Zod | External input, env, payloads |
| **Observability** | Sentry (sanitized `beforeSend`) | No PII in breadcrumbs |
| **Hosting** | Vercel (app) + HostGator VPS Turing/SP (WAHA) | Edge + dedicated box for WhatsApp; Brazil datacenter |

Details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 🧪 Tests

```bash
pnpm typecheck     # tsc --noEmit (strict)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest
pnpm test:e2e      # Playwright (requires dev server)
```

CI runs everything before merge. **The RLS isolation test is a mandatory gate** — it creates 2 tenants and verifies no leakage. The **governance invariants suite** (100+ tests) locks down RBAC, assignment, scoping and routing against regressions.

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`VISION.md`](VISION.md) | **Vision & positioning** — what the project is, what it believes, where it's going |
| [`docs/SETUP.md`](docs/SETUP.md) | **Complete step-by-step setup** for every integration |
| [`CLAUDE.md`](CLAUDE.md) | Non-negotiable conventions (required reading to contribute) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | One-page architecture overview |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | PR flow |
| [`docs/prd/`](docs/prd/) | PRDs (master, platform, customer 360, WhatsApp, pipeline, AI-RAG, Nuvemshop) |
| [`docs/specs/`](docs/specs/) | Technical specs 01–13 (SQL schema, payloads, MCP, governance) |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Full production runbook for WAHA (HostGator VPS) |

> Most docs are written in Brazilian Portuguese — our primary community. Translation contributions are very welcome.

---

## 🤝 Contributing

This project is open source for the community. Every contribution is welcome — from doc typo fixes to new features.

1. Read [`CLAUDE.md`](CLAUDE.md) (~5 min) — non-negotiable conventions (multi-tenancy, RLS, audit, privacy).
2. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch flow, commits.
3. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Definition of Done:** zero typecheck errors, zero lint errors, relevant tests green, RLS tested if a tenant-aware table is touched, audit log emitted on mutations, versioned migration if the schema changes.

---

## 🐛 Reporting bugs

Open an [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — the template asks for what we need (environment, `/api/v1/health`, steps).

For **security vulnerabilities**, **do NOT open a public issue** — use [private vulnerability reporting](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Details in [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Shipped

- **Foundation & platform** — auth (MFA for admins), multi-tenancy with RLS + isolation test, 4-role RBAC, append-only audit log, tenant onboarding.
- **WhatsApp support** — real-time 3-pane inbox, multi-number WAHA connections, media via Storage, anti-ban (throttle + jitter + time windows), STOP detection.
- **CRM & orders** — kanban with per-niche configurable vocabulary (fractional indexing), customer 360, contacts, tags, Nuvemshop integration for e-commerce.
- **Native AI** — agents with per-tenant RAG (pgvector), sentiment analysis, AI→human handoff, per-org budget control, internal MCP server.
- **Privacy (LGPD)** — export and redact via workers, cascading anonymization, audited consent.
- **Self-host** — `hostgator-setup-kit` (app + WAHA + database with one command), self-healing `baseline.sql`, production runbook.
- **Webhooks & automation** — capture sources + WHEN/IF/THEN rules + triggers for external systems.
- **Support governance** — server-side RBAC across the API, audited assignment/transfer (AI as a first-class assignee), per-role visibility (RLS) + per-agent metrics, automatic routing with queue and management panel, and a governance contract for external AI agents ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)). Epic driven by 100+ invariants (G1–G6).
- **Visible operation** — screens that let operators understand the agent: anti-ban hold reasons translated in the conversation, a notice center with severities, send-protection controls (window/pace/cap) and flywheel proposals applicable as a new version (human-gated).

### 🔮 Next

- **Phase FG** — the Vendaval agent consumes governance via `ai_dispatch_mode=external` 🔜 *(awaiting owner prioritization)*

- **Public MCP** — CRM capabilities exposed to the agent ecosystem: plug in any agent and it operates Deskcomm.
- **Self-improvement flywheel** — the resolved-conversation → knowledge → better-agent loop, measured and human-gated.
- **Niche templates** — ready-made pipelines and vocabularies for clinics, real estate, info-products and services (e-commerce already shipped).
- **Integrations** — VTEX and Shopify via the adapter pattern (Nuvemshop already shipped).
- **Probabilistic identity** — contact unification across channels.

---

## 💬 Community

- **Discussions:** [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions)
- **Issues:** [GitHub Issues](https://github.com/melgarafael/DeskcommCRM/issues)
- **Instagram:** [@melgarafael](https://www.instagram.com/melgarafael)
- **YouTube:** [youtube.com/@melgarafael](https://www.youtube.com/@melgarafael)

---

## 📜 License

Distributed under the **MIT** license — see [`LICENSE`](LICENSE). You may use, modify and distribute freely, including commercially. The software is provided **"as is", without warranties**.

---

## 🛟 Support & responsibilities (self-host)

This is a **self-hosted** project: each person runs the CRM on their **own infrastructure** (own VPS, Supabase database and AI key). That means:

- **Support is community-based and "as-is".** No SLA — it's open source maintained by goodwill.
- **You are responsible for your installation**, including updates (`bash hostgator-setup-kit/update.sh`) and backups.
- **Data protection:** whoever **hosts** the instance is the **controller** of the personal data processed there. The project maintainers **have no access** to your data.
- **Telemetry (Sentry):** by default, **anonymized** errors (no PII) are sent to the community Sentry. Set `SENTRY_DSN=off` to disable, or `SENTRY_DSN=<your-dsn>` to use your own.

---

## 🙏 Acknowledgements

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — WhatsApp engine.
- **Supabase**, **Vercel**, **Anthropic** (Claude), **shadcn/ui**.
- The community that took Deskcomm from e-commerce to clinics, real estate, info-products and beyond — you defined what this project is.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

</div>
