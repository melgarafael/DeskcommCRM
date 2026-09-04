<div align="center">

[🇧🇷 Português](README.md) · 🇺🇸 English

# 🛠️ SonghaiCRM — The open-source AI Sales OS for WhatsApp

**AI agents that answer, qualify and sell on WhatsApp — inside an open-source CRM running on your own server.**
**No subscription, no gated features, your data stays yours. The open alternative to Kommo, Octadesk and Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-one%20command-orange)](self-host-kit/)
[![CI](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml/badge.svg)](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**⚡ Install**](#-install-on-your-vps-the-main-path) · [**🔄 Update**](#-updating) · [**🧭 Vision**](VISION.md) · [**🏗️ Architecture**](ARCHITECTURE.md) · [**🤝 Contributing**](CONTRIBUTING.md) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

</div>

---

> ### ☁️ Run this CRM in production with one command
>
> The [`self-host-kit/`](self-host-kit/) installs the full CRM (app + WhatsApp + database) on
> any VPS with Docker with a single command, and the
> [production runbook](docs/runbooks/waha-vps.md) assumes that environment.
>
> **No server yet?** Run this **on your own computer** (macOS, Linux or WSL). It tells you which
> plan to buy — with the runbook's real numbers, not a "it depends" — and hands you the exact
> command for your case:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/self-host-kit/comecar.sh | bash
> ```
>
> *(prefer to read before executing? clone the repo and run `bash self-host-kit/comecar.sh` —
> it installs nothing without your confirmation.)*

---

## ⚡ Install on your VPS (the main path)

### 1. Connect to your VPS

Open a **Terminal** on your computer (**PowerShell** on Windows; **Terminal** on macOS or Linux)
and connect using the IP and port your host emailed you:

```bash
ssh -p PORT root@YOUR_IP
```

Replace `PORT` and `YOUR_IP` with yours. If your host never mentioned a port, it's the default
(22) and you can omit it: `ssh root@YOUR_IP`.

It will ask for your password. **As you type, nothing appears on screen — not even asterisks.**
That is not a freeze: the terminal is hiding your password. Type (or paste) it and press Enter.

> On the first connection it asks `Are you sure you want to continue connecting?` — answer
> `yes`. That's the server introducing itself for the first time.

### 2. Run the installer

Once inside the VPS:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM
bash self-host-kit/install.sh
```

That's it. **You don't install Node, or pnpm, or compile anything** — the app image is
prebuilt. If Docker is missing, the installer asks and installs it for you.

### What you need on hand

| Item | Where to get it |
|---|---|
| **VPS with Docker** | Any VPS provider with Docker. 4 GB RAM recommended |
| **Domain** | An **A** record pointing to your VPS IP (e.g. `crm.yourcompany.com`) |
| **Database** | Free account at [supabase.com](https://supabase.com) — 3 keys + the **Session pooler** connection string |
| **AI** | An **OpenRouter**, **Anthropic** or **OpenAI** key — the installer asks which one you want |
| **WhatsApp** | Your number, connected via QR code during onboarding (or Meta's official channel) |

> 💡 **Supabase can be created by the installer itself.** Export a `SUPABASE_ACCESS_TOKEN`
> before running and it creates the project, waits for the database to become healthy, fetches
> all 4 credentials and discovers the pooler host by testing a real connection — no copy-paste.

### What the installer does for you

It **only asks for what's yours** (domain, keys, admin password), **validates every answer
before moving on** — a wrong key is rejected right there, not three steps later — and handles
the rest:

1. Generates every technical secret itself (you invent no passwords).
2. Creates the Postgres extensions and applies the full schema (`supabase/baseline.sql`).
3. Creates the first admin with the email and password you chose.
4. Brings the whole stack up with **automatic HTTPS** and checks its health at the end.
5. Installs the **automations cron** (without it, WHEN/IF/THEN rules pile up in the queue) and
   the **update agent**, which is what makes the "Update now" button exist on screen.

**Running it again breaks nothing** — `install.sh` is idempotent: it doesn't duplicate the cron,
doesn't recreate the user, and resumes where it stopped.

> **Non-interactive mode:** copy `.env.selfhost.example` to `.env`, fill it in and run
> `bash self-host-kit/install.sh --yes`.

### Another host? (Hostinger, Coolify, Dokploy, CapRover…)

It works. If your VPS already ships with its **own reverse proxy** occupying ports 80/443, the
installer **detects that on its own** and publishes the CRM through it, instead of trying to
start a Caddy that wouldn't fit. In one specific case — a proxy on `--network host`, as
Hostinger does — it **asks instead of guessing**, because publishing behind the wrong proxy
"successfully" installs a mute website. Details in
[`self-host-kit/README.md`](self-host-kit/README.md).

### First access

Open `https://<your-domain>` (the padlock takes ~1 min to appear), sign in as the admin, and
have **Google Authenticator** or **Authy** at hand *if* you want to turn on two-step verification — it is **optional** and lives in Settings › Security; the first login does **not** require it. During
onboarding, scan the QR code with your WhatsApp number.

### 🤖 Rather have an AI install it for you?

Drop the `self-host-kit/` folder into **Claude Code** running inside the VPS and say
*"install SonghaiCRM for me"*. It reads the kit's [`CLAUDE.md`](self-host-kit/CLAUDE.md)
— which carries the step-by-step and the already-mapped pitfalls — and walks you through it.

---

## 🔄 Updating

New version out? There are two paths, and the first one needs no terminal.

### From the screen (recommended)

When a new version exists, the sidebar footer lights up **"Nova versão"** — only for the server
owner, because alerting someone who can't update is noise. Click it and you land on
**Settings → Update**, which shows what changed, **takes a database backup by itself** and
follows every phase (backup → code → database → live) to the end. No SSH.

If the new version comes up broken, the agent **rolls back to the previous image on its own**
and records that rollback in `.env` — without it, the next restart would silently bring the
broken app back.

> Under the hood: the app only records the request; the executor is the agent `install.sh` left
> on your VPS, on a cron that checks **every 5 minutes** — so the update starts within 5 minutes
> of the click. If that agent is down, the screen says **"Atualização automática indisponível"**
> and shows the command below — it never pretends it worked.

### From the terminal

```bash
cd /path/to/SonghaiCRM
bash self-host-kit/update.sh
```

In order, the command: (1) checks whether there really is a new version — if not, it exits
immediately; (2) **backs up the database before touching anything**; (3) pulls the new code;
(4) updates the database by re-applying `baseline.sql`, which is idempotent and **self-healing**
(it repairs data left inconsistent by older versions); (5) pulls the new app image; (6) checks
health at the end.

**The target is the latest published release** (`v1.2.3`), not the tip of `main` — updating
always lands on a tagged version described in [`CHANGELOG.md`](CHANGELOG.md), never on an
untested commit. It **refuses** to go back to a version older than the installed one (that would
turn off things you already have); `--force` exists for that, deliberately.

**Normal things you will see:** a pile of `already exists` / `multiple primary keys` during the
database step — **expected and harmless**, those are things that already existed. The script
filters that noise and prints `✓ banco atualizado`. If you see `⚠ avisos que não são os
esperados`, that one is worth keeping.

**Something went wrong?** `bash self-host-kit/restore.sh` returns to the backup.
**Just want a diagnosis?** `bash self-host-kit/healthcheck.sh`.

> ⚠️ **On an older install that doesn't have the screen agent yet**, run `update.sh` **twice**:
> the first run is still the old script (which downloads the new one); the second installs the
> agent and turns the button on.

### Other kit commands

| Script | What it does |
|---|---|
| `install.sh` | Installs everything (idempotent — safe to re-run) |
| `update.sh` | Updates to a new version, with automatic backup |
| `backup.sh` | Backs up the database + WhatsApp sessions |
| `restore.sh` | Restores a backup |
| `reset-password.sh` | Resets a user's password |
| `reset-mfa.sh` | Removes MFA for someone who lost their phone |
| `healthcheck.sh` | Diagnoses every service at once |

> **Backups matter:** Supabase's free plan **does not back up on its own**. Schedule `backup.sh`
> daily via cron. `update.sh` already takes one before every update.

---

## ✨ What is it

**Deskcomm** comes from **Desk** + **comm** (commerce): your entire sales operation on a single desk, run by people and AI agents working together.

The project was born as an e-commerce CRM — and the open-source community took it much further: today it runs in **clinics, real-estate agencies, info-product businesses, agencies, stores and service providers** — any business that sells over WhatsApp. The product followed that shift and became a **sales operating system**: AI agents with per-tenant RAG answer customers, qualify leads, move them through the pipeline, trigger automations and know when to hand off to a human — with the whole CRM exposed via **MCP** so agents can truly operate it. The full story is in [`VISION.md`](VISION.md).

### Why it's different

- 🤖 **AI agents that operate the CRM** — per-tenant RAG, skills the agent executes on its own mid-conversation, operational memory, sentiment analysis, audited AI→human handoff, AI as a first-class assignee and per-org spending caps. Not a decorative chatbot: the agent answers, qualifies and moves the funnel.
- 🔁 **Nothing dies in silence** — follow-up that revives a cold conversation (with adaptive timing and per-stage triggers), a radar of what's at risk of dying unanswered, and a notice center for what needs a human decision.
- 🧠 **Self-improving agents** — resolved conversations become new knowledge; the **AI Evolution** screen shows whether the agent is improving, where it fails and what's left to teach; **Proposals** are improvements the AI suggests for itself, applicable as a new version — always human-gated.
- 🧩 **Multi-niche by design** — configurable vocabulary per pipeline: a lead becomes a *Customer*, *Patient* or *Buyer*; "won" becomes *Paid*, *Booked* or *Closed*. The same core serves e-commerce (our birthplace), clinics, real estate or info-products.
- 💬 **WhatsApp two ways** — via **QR code** (WAHA, multi-number, with anti-ban: throttle + jitter + time windows) or through **Meta's official channel** (Cloud API, with approved templates kept in sync). Media via Storage, STOP detection.
- 🔀 **Choose your AI** — OpenRouter, Anthropic or OpenAI, decided at install time and switchable later from the screen, **per part of the system** (whatever talks doesn't have to be whatever indexes).
- 👥 **Support governance** — real server-side RBAC, audited assignment/transfer, round-robin queue, automatic intent routing and per-role visibility scopes.
- 🏢 **Multi-tenant + privacy by design** — RLS on every tenant-aware table with an isolation test as a CI gate; anonymization preferred over deletion; append-only audit log with 5-year retention. Legal basis: Law no. 3/2017 (Mozambique).
- 🖥️ **Truly self-hosted** — your data on your VPS; install and update with one command (or one click); no paid tier, no gated features.

### 🔌 Webhooks & Automations

Every tenant can create **capture sources**: a public endpoint (`/api/v1/webhooks/in/<token>`) that receives leads from landing pages, custom forms or tools like Zapier/n8n via POST (JSON or `application/x-www-form-urlencoded`) and drops them straight into the chosen pipeline/stage — no code, no per-tenant custom integration. On top of those sources (and the other CRM events — lead changed stage, got a tag, WhatsApp message arrived), tenants build **automations**: WHEN/IF/THEN rules that add tags, move leads, assign agents, send WhatsApp messages or notify external systems via outgoing webhooks.

In the UI everything lives under **Webhooks** in the sidebar (visible only to `manager`/`admin` roles). Three tabs: **Receive data** (create a source, copy the ready-made endpoint/form, fire a test lead, see recent deliveries), **Automations** (build rules, which are always born paused until reviewed and enabled) and **Activity** (a timeline of each run, with per-action results and manual retry when an external webhook call fails).

Under the hood, every event becomes a row in `event_log` — no database trigger ever makes an HTTP call. The `/api/v1/cron/event-log-drain` route drains the queue every minute. **`install.sh`/`update.sh` configure that cron automatically** — without it, automations get created normally but never run.

---

## 🖥️ What you operate (the screens)

| Group | Screens |
|---|---|
| **Support** | **Inbox** (WhatsApp conversations, you and the AI side by side) · **Radar** (who went cold and is still open) · **Quick replies** |
| **CRM** | **Kanban** (where each deal sits in the funnel) · **Contacts** · **Pipelines** (stages, business vocabulary and loss reasons) |
| **AI Agent** | **Agents** · **Follow-ups** · **Routers** · **Providers** and **Credentials** · **Knowledge** (RAG) · **Memory** · **Skills** · **Cases** · **Alerts** · **Proposals** · **Runs** · **Usage & budget** |
| **Channels** | **Connections** (QR or Meta's official channel, with health, reconnect and templates) · **Webhooks** |
| **Analytics** | **Performance** (funnel and per-agent metrics) · **AI Evolution** · **Audit Log** |
| **Organization** | **Team** · **Support distribution** · **Organization** · **LGPD** · **API Tokens** · **Security** (MFA, recovery codes, sessions) · Profile, Notifications, Billing |

Every screen has a door in the navigation — CI fails a screen that exists but can only be reached by typing its URL.

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
| **WhatsApp** | WAHA Plus (NOWEB engine) + Meta Cloud API | QR to start fast; official channel to scale |
| **Queues** | `event_log` table + workers (cron) | A database trigger never makes HTTP calls |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, free tier is enough |
| **AI** | Vercel AI SDK v7 — OpenRouter, Anthropic, OpenAI and Google | The installer asks which; switch later from the screen |
| **Validation** | Zod | External input, env, payloads |
| **Observability** | Sentry (scrubbed in errors, transactions, spans and breadcrumbs) | Opt-in telemetry at install time |
| **Hosting** | Any VPS with Docker | App + WhatsApp + workers on your own box |

Details: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 🧑‍💻 Development (only to contribute to the code)

> ⚠️ **If you want to USE the CRM, this is not it** — use the [VPS installer](#-install-on-your-vps-the-main-path).
> This section is for people who will change the code.

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

nvm use                     # Node 22
npm install -g pnpm && pnpm install

cp .env.example .env.local  # full guide in docs/SETUP.md

docker compose up -d        # local WAHA (optional in dev without WhatsApp)

# Schema: apply the baseline, NOT the migrations.
# Migrations 0001-0009 and 0013 are `SELECT 1;` stubs — the chain does not build from zero.
# The real schema lives in baseline.sql, the same one install.sh applies on the VPS.
# `supabase db push` "succeeds" and leaves you with an empty database.
supabase link --project-ref <your-ref>
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

[`docs/SETUP.md`](docs/SETUP.md) is the complete tutorial for **every integration** (Supabase, WAHA, AI providers, Upstash, Sentry, Resend) — ~60–90 min from zero to a running app. *(Docs are in Brazilian Portuguese; translations welcome!)*

---

## 🧪 Tests

```bash
pnpm typecheck     # tsc --noEmit (strict)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest (does NOT include tests/invariants/**)
pnpm test:db       # ephemeral Postgres + baseline install/update + invariants
pnpm test:e2e      # Playwright (requires dev server)
```

**These checks are required** to merge into `main`. This list has already said "four" and then "five" — **measure, don't trust it**:

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  --jq '.required_status_checks.contexts|join(", ")'
# on 2026-08-14: verify, build-and-size, invariants, e2e, imagens-ok
```


| Check | What it does |
|---|---|
| `verify` | typecheck + lint + `lint:channels` + `test:unit` + `test:shell` |
| `invariants` | boots a clean Postgres, applies `baseline.sql` in **install** mode (`ON_ERROR_STOP=1`) and then in **update** mode (proving idempotency), and runs **618 invariants across 98 files** — RBAC, assignment, scoping, routing, follow-up, webhooks and automations |
| `build-and-size` | `pnpm build` on Node 22 |
| `e2e` | boots a local Supabase, applies `baseline.sql` and runs **44 of the 45** Playwright specs through the frontend |

The only spec outside `e2e` is `vps-fresh-onboarding` — it needs a real WAHA + Redis + Resend. It is the **P0** of our visual-QA doctrine, so a green `e2e` does **not** prove the fresh-install journey; that one is proven on a VPS.

Among the invariants is the **RLS isolation test**: it creates 2 organizations, simulates JWT claims through the same `auth.uid()` / `fn_user_org_ids()` path production policies use, and proves a user of org A sees **zero rows** of org B in `conversations`, `messages`, `contacts` and `crm_leads`. A control case first proves org B's rows actually exist — without it, the test would pass against an empty table.

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`self-host-kit/README.md`](self-host-kit/README.md) | **Self-host installation** — the kit, the scripts, hosts with their own proxy |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | **How to update** your installation, in plain language |
| [`VISION.md`](VISION.md) | **Vision & positioning** — what the project is, what it believes, where it's going |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each version — **read your target version's section before updating** |
| [`docs/SETUP.md`](docs/SETUP.md) | Development setup, step by step, for every integration |
| [`docs/white-label.en.md`](docs/white-label.en.md) | **Installing for clients** — rebranding, one-install-per-client vs shared, reseller operations |
| [`docs/runbooks/waha-vps.md`](docs/runbooks/waha-vps.md) | Production runbook for WAHA (sizing, recovery) |
| [`CLAUDE.md`](CLAUDE.md) | Non-negotiable conventions (required reading to contribute) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | One-page architecture overview |
| [`docs/index.md`](docs/index.md) | Index of all 157 documents, with a precedence rule |
| [`docs/prd/`](docs/prd/) · [`docs/specs/`](docs/specs/) | PRDs and technical specs (SQL schema, payloads, MCP, governance) |

> Most docs are written in Brazilian Portuguese — our primary community. Translation contributions are very welcome.

---

## 🤝 Contributing

This project is open source for the community. Every contribution is welcome — from doc typo fixes to new features.

1. Read [`CLAUDE.md`](CLAUDE.md) (~5 min) — non-negotiable conventions (multi-tenancy, RLS, audit, privacy).
2. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch flow, commits.
3. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Short flow:**

```bash
git checkout -b feat/short-slug
# implement + tests
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
pnpm test:db   # needs Docker — this is the `invariants` job, required to merge
git commit -m "feat(scope): description"
```

Those two lines are **everything you can run on your machine**, on purpose: running half of them and discovering the rest as a red surprise after hours of waiting is the worst first experience this repository knows how to deliver.

Two required gates do **not** fit there and only run in CI: `e2e` (needs a local Supabase) and `imagens-ok` (builds the three Docker images). Green on your machine is not green at merge time.

**Definition of Done:** zero typecheck errors, zero lint errors, relevant tests green, RLS tested if a tenant-aware table is touched, audit log emitted on mutations, versioned migration **+ an idempotent appendix in `baseline.sql`** if the schema changes (otherwise the change never reaches self-hosters).

---

## 🐛 Reporting bugs

Open an [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — the template asks for what we need (environment, `/api/v1/health`, steps). Running `bash self-host-kit/healthcheck.sh` and pasting the output helps a lot.

For **security vulnerabilities**, **do NOT open a public issue** — use [private vulnerability reporting](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Details in [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Shipped

- **Foundation & platform** — auth (MFA for admins), multi-tenancy with RLS + isolation test, 4-role RBAC, append-only audit log, tenant onboarding.
- **WhatsApp support** — real-time 3-pane inbox, multi-number connections via **QR (WAHA)** or **Meta's official channel** (approved templates kept in sync), media via Storage, anti-ban (throttle + jitter + time windows), STOP detection.
- **CRM & orders** — kanban with per-niche configurable vocabulary (fractional indexing), pipeline management from the screen, customer 360, contacts, tags.
- **Native AI** — agents with per-tenant RAG (pgvector), **skills** the agent runs by itself, **organization memory**, per-number intent router, sentiment analysis, AI→human handoff, per-org spending caps, internal MCP server.
- **AI provider choice** — OpenRouter, Anthropic or OpenAI, decided at install time and switchable per part of the system from the screen.
- **Living follow-up** — reviving cold conversations with adaptive timing, per-stage and per-case triggers, round-robin queue, and the Radar of what risks dying unanswered.
- **Privacy (LGPD)** — export and redact via workers, cascading anonymization, audited consent.
- **Self-host** — `self-host-kit` (app + WhatsApp + database with one command), self-healing `baseline.sql`, **updating from the screen** with automatic backup, production runbook.
- **Webhooks & automation** — capture sources + WHEN/IF/THEN rules + triggers for external systems.
- **Support governance** — server-side RBAC across the API, audited assignment/transfer (AI as a first-class assignee), per-role visibility (RLS) + per-agent metrics, automatic routing with queue and management panel, and a governance contract for external AI agents ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)).
- **Visible operation** — anti-ban hold reasons translated in the conversation, a notice center with severities, stuck-message alerts, send-protection controls (window/pace/cap), declared agent capabilities and flywheel proposals applicable as a new version (human-gated).

### 🔮 Next

- **Public MCP** — CRM capabilities exposed to the agent ecosystem: plug in any agent and it operates Deskcomm.
- **Niche templates** — ready-made pipelines and vocabularies for clinics, real estate, info-products and services (e-commerce already shipped).
- **Integrations** — VTEX and Shopify via an e-commerce adapter pattern.
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
- **You are responsible for your installation.** Updates are not automatic (you click, or run `update.sh`, when you want), and keeping/backing up your server is on you.
- **Data protection:** whoever **hosts** the instance is the **controller** of the personal data processed there (customers, conversations, orders), with the legal obligations that follow. The project maintainers are **neither** controllers nor processors of your instance, and have no access to your database, your WhatsApp or your storage.
- **Telemetry (Sentry):** `install.sh` **asks** during installation and respects your answer; in non-interactive mode, with no `SENTRY_DSN` set, telemetry is **off**. If you accept the community Sentry, what gets sent are **error reports** (stack traces) with national IDs, phone numbers and emails replaced, sensitive headers stripped, and webhook/invite tokens redacted from URLs — **no** performance tracing and **no** session replay, both pinned to 0 on that path. To turn it off at any time: `SENTRY_DSN=off` in `.env`. To send to **your** Sentry (there, with performance and replay): `SENTRY_DSN=<your-dsn>`. What is redacted, and why, lives in [`lib/sentry/scrub.ts`](lib/sentry/scrub.ts); DSN resolution in [`lib/sentry/dsn.ts`](lib/sentry/dsn.ts).

---

## 🙏 Acknowledgements

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — WhatsApp engine.
- **Supabase** — Postgres + Auth + Storage + Realtime in one stack.
- **Anthropic**, **OpenAI** and **OpenRouter** — the AI providers the CRM knows how to use.
- **shadcn/ui** — component base.
- The community that took Deskcomm from e-commerce to clinics, real estate, info-products and beyond — you defined what this project is.

---

<div align="center">

**Built with ☕ in Moçambique** · **Made for the community**

</div>
