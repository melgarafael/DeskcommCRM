<div align="center">

[🇧🇷 Português](README.md) · 🇺🇸 English · [🇪🇸 Español](README.es.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/deskcomm-logo-dark.svg">
  <img src="docs/brand/deskcomm-logo.svg" alt="Deskcomm CRM" width="420">
</picture>

# 🛠️ DeskcommCRM — The open-source AI Sales OS for WhatsApp

**AI agents that answer, qualify and sell on WhatsApp — inside an open-source CRM running on your own server.**
**No subscription, no gated features, your data stays yours. The open alternative to Kommo, Octadesk and Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-one%20command-orange)](hostgator-setup-kit/)
[![CI](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml/badge.svg)](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/melgarafael)
<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-206-orange.svg?style=flat-square)](#contributors-)
<!-- ALL-CONTRIBUTORS-BADGE:END -->
[**⚡ Install**](#-install-on-your-vps-the-main-path) · [**🔄 Update**](#-updating) · [**🧭 Vision**](VISION.md) · [**🏗️ Architecture**](ARCHITECTURE.md) · [**🤝 Contributing**](CONTRIBUTING.en.md) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

<img src="docs/assets/demo-deskcomm.gif" alt="DeskcommCRM demo: AI agents, sales pipeline and prospecting" width="800">

</div>

---

> ### ☁️ Run this CRM in production with one command
>
> DeskcommCRM is developed in **partnership with HostGator**: the [`hostgator-setup-kit/`](hostgator-setup-kit/)
> installs the full CRM (app + WhatsApp + database) on a VPS with a single command, and the
> [production runbook](docs/runbooks/waha-hostgator.md) assumes that environment.
>
> **[👉 Get the HostGator VPS with the partnership discount](https://www.hostgator.com.br/52708-141-3-52.html)** —
> São Paulo datacenter, ideal for WhatsApp running 24/7. *(partner link — subscribing through it supports the project and costs you less)*
>
> **No server yet?** Run this **on your own computer** (macOS, Linux or WSL). It tells you which
> plan to buy — with the runbook's real numbers, not a "it depends" — and hands you the exact
> command for your case:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/comecar.sh | bash
> ```
>
> *(prefer to read before executing? clone the repo and run `bash hostgator-setup-kit/comecar.sh` —
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
bash hostgator-setup-kit/install.sh
```

That's it. **You don't install Node, or pnpm, or compile anything** — the app image is
prebuilt. If Docker is missing, the installer asks and installs it for you.

### What you need on hand

| Item | Where to get it |
|---|---|
| **VPS with Docker** | [HostGator](https://www.hostgator.com.br/52708-141-3-52.html) (partnership) — or any VPS with Docker. 4 GB RAM recommended |
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

> **Non-interactive mode:** copy `.env.hostgator.example` to `.env`, fill it in and run
> `bash hostgator-setup-kit/install.sh --yes`.

### Another host? (Hostinger, Coolify, Dokploy, CapRover…)

It works. If your VPS already ships with its **own reverse proxy** occupying ports 80/443, the
installer **detects that on its own** and publishes the CRM through it, instead of trying to
start a Caddy that wouldn't fit. In one specific case — a proxy on `--network host`, as
Hostinger does — it **asks instead of guessing**, because publishing behind the wrong proxy
"successfully" installs a mute website. Details in
[`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md).

### First access

Open `https://<your-domain>` (the padlock takes ~1 min to appear), sign in as the admin, and
have **Google Authenticator** or **Authy** at hand *if* you want to turn on two-step verification — it is **optional** and lives in Settings › Security; the first login does **not** require it. During
onboarding, scan the QR code with your WhatsApp number.

### 🤖 Rather have an AI install it for you?

The repository ships **assistant guides** that load on their own in Claude Code, Codex, Cursor,
OpenCode or Antigravity: install, set up a client per niche, analyze metrics, tune the agent
prompt and contribute. To have them in **any folder** — including before cloning, on your own
machine — run once:

```bash
curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash
```

Then open a new session of your assistant and say *"I want to install the CRM on my VPS"*: asking
for the subject in Portuguese triggers the right guide in any of the five. To call a guide by name,
each one has its own way — `/deskcomm-instalar` in Claude Code, Cursor and Antigravity;
`$deskcomm-instalar` in Codex; in OpenCode, ask for it by name, in natural language.

The guides do **not** update themselves: running the same command again brings the new version. To
undo:

```bash
curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/scripts/instalar-guias.sh | bash -s -- --remover
```

With the repository already cloned, the guides come inside it (`.agents/skills/`) and none of that
is needed. If you ran the command anyway, know that in Claude Code the installed guide wins over
the one in the clone — and stays on the version of the day you ran it, until you run it again (or
undo). The old way still works too: drop just the `hostgator-setup-kit/` folder into the **Claude
Code** chat inside the VPS — it reads the kit's [`CLAUDE.md`](hostgator-setup-kit/CLAUDE.md) and
walks you through everything, in Portuguese.

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
cd /path/to/DeskcommCRM
bash hostgator-setup-kit/update.sh
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
filters that noise and prints `✓ banco atualizado`. If the database is busy with the CRM serving
customers, it applies again on its own (up to 3 passes) and says so — this holds from the update
after the one that installs this fix. If you see `⚠ Apareceram avisos no banco que NÃO são os esperados`, that one
is worth keeping: the **end** of the output tells you what to do in each case (repeat with `--force`
when the database was busy, declare `SUPABASE_DB_ADMIN_URL` when it was permissions).

**Something went wrong?** Keep the message and ask for help. `restore.sh` does **not** put the
backup back over the database in use: it only restores into an empty database (see [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md)).
**Just want a diagnosis?** `bash hostgator-setup-kit/healthcheck.sh`.

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

### 🧹 Uninstall (take this application out of Docker)

To stop and delete **only the Docker resources of this installation**, from the repository root:

```bash
bash desinstalar_docker.sh
```

It finds the project through the label Docker Compose writes and removes only the containers,
volumes and internal networks of **this** project. Other applications on the same server, images,
build cache, the reverse proxy's external network, the code, the `.env`, the backups and an
external Supabase are left untouched.

The interactive mode shows how many resources it found and requires the confirmation
`REMOVER-<project-name>` before removing anything. For throwing an environment away,
`bash desinstalar_docker.sh --force` skips the question. Use `--project-name NAME` only when the
installation has a custom `COMPOSE_PROJECT_NAME` that is no longer in the `.env`.

> **The volumes go with it** — local WhatsApp sessions included. Run `backup.sh` before if you
> need to keep them.

---

## ✨ What is it

**Deskcomm** comes from **Desk** + **comm** (commerce): your entire sales operation on a single desk, run by people and AI agents working together.

The project was born as an e-commerce CRM — and the open-source community took it much further: today it runs in **clinics, real-estate agencies, info-product businesses, agencies, stores and service providers** — any business that sells over WhatsApp. The product followed that shift and became a **sales operating system**: AI agents with per-tenant RAG answer customers, qualify leads, move them through the pipeline, trigger automations and know when to hand off to a human — with the whole CRM exposed via **MCP** so agents can truly operate it. The full story is in [`VISION.md`](VISION.md).

### Why it's different

- 🤖 **AI agents that operate the CRM** — per-tenant RAG, skills the agent executes on its own mid-conversation, operational memory, sentiment analysis, audited AI→human handoff, AI as a first-class assignee and per-org spending caps. Not a decorative chatbot: the agent answers, qualifies and moves the funnel.
- 🔁 **Nothing dies in silence** — follow-up that revives a cold conversation (with adaptive timing and per-stage triggers), a radar of what's at risk of dying unanswered, and a notice center for what needs a human decision.
- 🧠 **Self-improving agents** — resolved conversations become new knowledge; the **AI Evolution** screen shows whether the agent is improving, where it fails and what's left to teach; **Proposals** are improvements the AI suggests for itself, applicable as a new version — always human-gated.
- 🧩 **Multi-niche by design** — configurable vocabulary per pipeline: a lead becomes a *Customer*, *Patient* or *Buyer*; "won" becomes *Paid*, *Booked* or *Closed*. The same core serves e-commerce (our birthplace, with native Nuvemshop integration), clinics, real estate or info-products.
- 💬 **WhatsApp two ways** — via **QR code** (WAHA, multi-number, with anti-ban: throttle + jitter + time windows) or through **Meta's official channel** (Cloud API, with approved templates kept in sync). Media via Storage, STOP detection.
- 🔀 **Choose your AI** — OpenRouter, Anthropic or OpenAI, decided at install time and switchable later from the screen, **per part of the system** (whatever talks doesn't have to be whatever indexes).
- 👥 **Support governance** — real server-side RBAC, audited assignment/transfer, round-robin queue, automatic intent routing and per-role visibility scopes.
- 🏢 **Multi-tenant + privacy by design (LGPD)** — RLS on every tenant-aware table with an isolation test as a CI gate; anonymization preferred over deletion; append-only audit log with 5-year retention.
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
| **Channels** | **Connections** (QR or Meta's official channel, with health, reconnect and templates) · **Nuvemshop** · **Webhooks** |
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
| **AI** | Vercel AI SDK v7 — OpenRouter, Requesty, Anthropic, OpenAI and Google | The installer asks which; switch later from the screen |
| **Validation** | Zod | External input, env, payloads |
| **Observability** | Sentry (scrubbed in errors, transactions, spans and breadcrumbs) | Opt-in telemetry at install time |
| **Hosting** | Any VPS with Docker (HostGator/SP in the partnership) | App + WhatsApp + workers on your own box |

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

# On a NEW Supabase project, first enable the extensions the schema uses —
# without them the baseline stops at `type public.vector does not exist`.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

[`docs/SETUP.md`](docs/SETUP.md) is the complete tutorial for **every integration** (Supabase, WAHA, AI providers, Upstash, Sentry, Resend, Nuvemshop) — ~60–90 min from zero to a running app. *(Docs are in Brazilian Portuguese; translations welcome!)*

---

## 📁 Structure

```
DeskcommCRM/
├── app/                    # Next.js App Router
│   ├── (admin)/            # super-admin routes (impersonate, tenants)
│   ├── (public)/           # Login, recovery
│   ├── app/                # Authenticated routes: inbox, radar, kanban, contacts,
│   │                       #   connections, ai/*, integrations, metrics, lgpd,
│   │                       #   audit, team, settings
│   └── api/v1/             # Canonical REST API
├── components/             # React (ui/, inbox/, kanban/, shell/, ...)
├── lib/                    # supabase/, waha/, channels/, ai/, agent-engine/,
│                           #   api/, routing/, navigation/, env.ts
├── workers/                # event_log consumers (AI, RAG, LGPD, media, routines)
├── supabase/migrations/    # Versioned SQL (+ baseline.sql for self-host)
├── tests/{e2e,unit,invariants,shell}/
├── scripts/                # seeds, qa-waves, maintenance
├── docs/                   # PRDs, specs, runbooks, SETUP.md, ATUALIZANDO.md
└── hostgator-setup-kit/    # self-host install and update
```

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
| `invariants` | boots a clean Postgres, applies `baseline.sql` in **install** mode (`ON_ERROR_STOP=1`) and then in **update** mode (proving idempotency), and runs the invariants for RBAC, assignment, scoping, routing, follow-up, webhooks and automations |
| `build-and-size` | `pnpm build` on Node 22 |
| `e2e` | boots a local Supabase, applies `baseline.sql` and runs through the frontend every Playwright spec except the ones `FORA_DO_CI` declares |
| `imagens-ok` | fails when any of the three Docker images (`app`, `worker`, `scheduler`) does not build — it is the artifact the self-hoster installs |

Which specs stay out is a question for a command, not for reading — this line used to claim the only one was `vps-fresh-onboarding`, and since PR #983 it runs in CI:

```bash
git show origin/main:.github/workflows/e2e.yml | python3 -c "import sys,re; y=sys.stdin.read(); print(sorted({s for _,c in re.findall(r'(FORA_DO_CI):\s*>-\n((?:[ ]{8,}.*\n)+)',y) for s in re.findall(r'[a-z0-9-]+\.spec\.ts',c)}))"
```

`vps-fresh-onboarding` is still the **P0** of our visual-QA doctrine, because the fresh install is the product we sell. Having a gate does not replace proving it on screen: a gate proves it did not regress, not that the experience is good.

Among the invariants is the **RLS isolation test**: it creates 2 organizations, simulates JWT claims through the same `auth.uid()` / `fn_user_org_ids()` path production policies use, and proves a user of org A sees **zero rows** of org B in `conversations`, `messages`, `contacts` and `crm_leads`. A control case first proves org B's rows actually exist — without it, the test would pass against an empty table.

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md) | **Self-host installation** — the kit, the scripts, hosts with their own proxy |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | **How to update** your installation, in plain language |
| [`VISION.md`](VISION.md) | **Vision & positioning** — what the project is, what it believes, where it's going |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each version — **read your target version's section before updating** |
| [`docs/SETUP.md`](docs/SETUP.md) | Development setup, step by step, for every integration |
| [`docs/white-label.en.md`](docs/white-label.en.md) | **Installing for clients** — rebranding, one-install-per-client vs shared, reseller operations |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Production runbook for WAHA (sizing, recovery) |
| [`CLAUDE.md`](CLAUDE.md) | Non-negotiable conventions (required reading to contribute) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | One-page architecture overview |
| [`docs/index.md`](docs/index.md) | Index of all 157 documents, with a precedence rule |
| [`docs/prd/`](docs/prd/) · [`docs/specs/`](docs/specs/) | PRDs and technical specs (SQL schema, payloads, MCP, governance) |

> Most docs are written in Brazilian Portuguese — our primary community. Translation contributions are very welcome.

---

## 🤝 Contributing

This project is open source for the community. Every contribution is welcome — from doc typo fixes to new features.

1. Read [`CLAUDE.md`](CLAUDE.md) (~5 min) — non-negotiable conventions (multi-tenancy, RLS, audit, privacy).
2. Read [`CONTRIBUTING.en.md`](CONTRIBUTING.en.md) — branch flow, commits.
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

<a id="contributors-"></a>

## 🙌 Who builds DeskcommCRM

Thanks to everyone who has contributed code, a well-reported bug, an idea, docs or a translation. To join this list, see [how to contribute](CONTRIBUTING.en.md) ([emoji key](https://allcontributors.org/docs/en/emoji-key)).

Want to support the project another way? [Sponsor it on GitHub Sponsors](https://github.com/sponsors/melgarafael).

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/melgarafael"><img src="https://avatars.githubusercontent.com/u/119944436?v=4?s=64" width="64px;" alt="Rafael Melgaço"/><br /><sub><b>Rafael Melgaço</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=melgarafael" title="Code">💻</a> <a href="#maintenance-melgarafael" title="Maintenance">🚧</a> <a href="#ideas-melgarafael" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/webtecnica"><img src="https://avatars.githubusercontent.com/u/75556242?v=4?s=64" width="64px;" alt="webtecnica"/><br /><sub><b>webtecnica</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=webtecnica" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/commits?author=webtecnica" title="Documentation">📖</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/paulolimajr77"><img src="https://avatars.githubusercontent.com/u/60278689?v=4?s=64" width="64px;" alt="Paulo Lima Jr"/><br /><sub><b>Paulo Lima Jr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=paulolimajr77" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jmpo"><img src="https://avatars.githubusercontent.com/u/23352109?v=4?s=64" width="64px;" alt="Marcelo Pompa"/><br /><sub><b>Marcelo Pompa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jmpo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Tong-bit-art"><img src="https://avatars.githubusercontent.com/u/239565928?v=4?s=64" width="64px;" alt="ordinary being"/><br /><sub><b>ordinary being</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Tong-bit-art" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/JowaniOrantes"><img src="https://avatars.githubusercontent.com/u/99059532?v=4?s=64" width="64px;" alt="Jowani Orantes"/><br /><sub><b>Jowani Orantes</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=JowaniOrantes" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/joaopaulomirandamatias"><img src="https://avatars.githubusercontent.com/u/37987074?v=4?s=64" width="64px;" alt="João Paulo"/><br /><sub><b>João Paulo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=joaopaulomirandamatias" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/IanCouto"><img src="https://avatars.githubusercontent.com/u/48738352?v=4?s=64" width="64px;" alt="Ian Couto"/><br /><sub><b>Ian Couto</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=IanCouto" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelbatistazz"><img src="https://avatars.githubusercontent.com/u/173963432?v=4?s=64" width="64px;" alt="rafaelbatistazz"/><br /><sub><b>rafaelbatistazz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelbatistazz" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/423313"><img src="https://avatars.githubusercontent.com/u/175169448?v=4?s=64" width="64px;" alt="423313"/><br /><sub><b>423313</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=423313" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vitorlacerdadigital"><img src="https://avatars.githubusercontent.com/u/328979566?v=4?s=64" width="64px;" alt="vitorlacerdadigital"/><br /><sub><b>vitorlacerdadigital</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vitorlacerdadigital" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/maugarciasa"><img src="https://avatars.githubusercontent.com/u/290142000?v=4?s=64" width="64px;" alt="maugarciasa"/><br /><sub><b>maugarciasa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=maugarciasa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ozzure"><img src="https://avatars.githubusercontent.com/u/4605101?v=4?s=64" width="64px;" alt="ozzure"/><br /><sub><b>ozzure</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ozzure" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hiro-nikaitou"><img src="https://avatars.githubusercontent.com/u/249086173?v=4?s=64" width="64px;" alt="hiro-nikaitou"/><br /><sub><b>hiro-nikaitou</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hiro-nikaitou" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/maclevison"><img src="https://avatars.githubusercontent.com/u/1932636?v=4?s=64" width="64px;" alt="Mac Silva"/><br /><sub><b>Mac Silva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=maclevison" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/bossprt"><img src="https://avatars.githubusercontent.com/u/316014294?v=4?s=64" width="64px;" alt="bossprt"/><br /><sub><b>bossprt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=bossprt" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gustavorodcruz96"><img src="https://avatars.githubusercontent.com/u/221748661?v=4?s=64" width="64px;" alt="Gustavo Rodrigues"/><br /><sub><b>Gustavo Rodrigues</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gustavorodcruz96" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LuckasBrito-Dev"><img src="https://avatars.githubusercontent.com/u/188809167?v=4?s=64" width="64px;" alt="Lucas Brito"/><br /><sub><b>Lucas Brito</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LuckasBrito-Dev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/FabioMundoDigital"><img src="https://avatars.githubusercontent.com/u/136749579?v=4?s=64" width="64px;" alt="Fabio Kortex"/><br /><sub><b>Fabio Kortex</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=FabioMundoDigital" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/automatikpg-ux"><img src="https://avatars.githubusercontent.com/u/313559075?v=4?s=64" width="64px;" alt="automatikpg-ux"/><br /><sub><b>automatikpg-ux</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=automatikpg-ux" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nsbastosconsultoria"><img src="https://avatars.githubusercontent.com/u/221592931?v=4?s=64" width="64px;" alt="Leandro Nogueira de Souza Bastos"/><br /><sub><b>Leandro Nogueira de Souza Bastos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=nsbastosconsultoria" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vgamkt"><img src="https://avatars.githubusercontent.com/u/62725454?v=4?s=64" width="64px;" alt="VANDER GUSTAVO ALVES"/><br /><sub><b>VANDER GUSTAVO ALVES</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vgamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelcesardev"><img src="https://avatars.githubusercontent.com/u/108206396?v=4?s=64" width="64px;" alt="Rafael César"/><br /><sub><b>Rafael César</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelcesardev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SnoopyHuman"><img src="https://avatars.githubusercontent.com/u/175789268?v=4?s=64" width="64px;" alt="SnoopyHuman"/><br /><sub><b>SnoopyHuman</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SnoopyHuman" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/saraivabr"><img src="https://avatars.githubusercontent.com/u/243859142?v=4?s=64" width="64px;" alt="Saraiva"/><br /><sub><b>Saraiva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=saraivabr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/valterhjr"><img src="https://avatars.githubusercontent.com/u/10075011?v=4?s=64" width="64px;" alt="Valter"/><br /><sub><b>Valter</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=valterhjr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/omayklourenco"><img src="https://avatars.githubusercontent.com/u/75747871?v=4?s=64" width="64px;" alt="Mayk Lourenço"/><br /><sub><b>Mayk Lourenço</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=omayklourenco" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Draven9"><img src="https://avatars.githubusercontent.com/u/99404696?v=4?s=64" width="64px;" alt="Eric Azevedo"/><br /><sub><b>Eric Azevedo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Draven9" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Gervanno"><img src="https://avatars.githubusercontent.com/u/189672957?v=4?s=64" width="64px;" alt="Gervànno"/><br /><sub><b>Gervànno</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Gervanno" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipebnt"><img src="https://avatars.githubusercontent.com/u/56138438?v=4?s=64" width="64px;" alt="Felipe Oliveira"/><br /><sub><b>Felipe Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipebnt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/flaviosiq"><img src="https://avatars.githubusercontent.com/u/24714170?v=4?s=64" width="64px;" alt="flaviosiq"/><br /><sub><b>flaviosiq</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=flaviosiq" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brunowatz"><img src="https://avatars.githubusercontent.com/u/156392074?v=4?s=64" width="64px;" alt="Bruno Jakowatz "/><br /><sub><b>Bruno Jakowatz </b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=brunowatz" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fillipe-felix"><img src="https://avatars.githubusercontent.com/u/39422542?v=4?s=64" width="64px;" alt="fillipe-felix"/><br /><sub><b>fillipe-felix</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fillipe-felix" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/claude"><img src="https://avatars.githubusercontent.com/u/81847?v=4?s=64" width="64px;" alt="Claude"/><br /><sub><b>Claude</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=claude" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/sprakashsurya-debug"><img src="https://avatars.githubusercontent.com/u/319809785?v=4?s=64" width="64px;" alt="sprakashsurya-debug"/><br /><sub><b>sprakashsurya-debug</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=sprakashsurya-debug" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/luka1601"><img src="https://avatars.githubusercontent.com/u/134978198?v=4?s=64" width="64px;" alt="luka1601"/><br /><sub><b>luka1601</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=luka1601" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/samirhvbr"><img src="https://avatars.githubusercontent.com/u/123646616?v=4?s=64" width="64px;" alt="Samir Hanna Verza"/><br /><sub><b>Samir Hanna Verza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=samirhvbr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/advglauberpires"><img src="https://avatars.githubusercontent.com/u/329235513?v=4?s=64" width="64px;" alt="advglauberpires"/><br /><sub><b>advglauberpires</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=advglauberpires" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Tanderakkkj"><img src="https://avatars.githubusercontent.com/u/86134641?v=4?s=64" width="64px;" alt="Tanderakkkj"/><br /><sub><b>Tanderakkkj</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Tanderakkkj" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vagnerrm122"><img src="https://avatars.githubusercontent.com/u/142553039?v=4?s=64" width="64px;" alt="vagnerrm122"/><br /><sub><b>vagnerrm122</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vagnerrm122" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/betoarts"><img src="https://avatars.githubusercontent.com/u/43428188?v=4?s=64" width="64px;" alt="Humberto Moura Neto DEV"/><br /><sub><b>Humberto Moura Neto DEV</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=betoarts" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/italopabloferreria"><img src="https://avatars.githubusercontent.com/u/163482370?v=4?s=64" width="64px;" alt="Ítalo Pablo Ferreira"/><br /><sub><b>Ítalo Pablo Ferreira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=italopabloferreria" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Wyllams"><img src="https://avatars.githubusercontent.com/u/98239020?v=4?s=64" width="64px;" alt="Wyllams Bione"/><br /><sub><b>Wyllams Bione</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Wyllams" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/opp4s"><img src="https://avatars.githubusercontent.com/u/85846969?v=4?s=64" width="64px;" alt="opp4s"/><br /><sub><b>opp4s</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=opp4s" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nusretbayindir-stack"><img src="https://avatars.githubusercontent.com/u/243019259?v=4?s=64" width="64px;" alt="nusretbayindir-stack"/><br /><sub><b>nusretbayindir-stack</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=nusretbayindir-stack" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/thiagobaltuilhe"><img src="https://avatars.githubusercontent.com/u/255193626?v=4?s=64" width="64px;" alt="thiagobaltuilhe"/><br /><sub><b>thiagobaltuilhe</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=thiagobaltuilhe" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fabianmartinelli-fm"><img src="https://avatars.githubusercontent.com/u/214162846?v=4?s=64" width="64px;" alt="Fabian Martinelli"/><br /><sub><b>Fabian Martinelli</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fabianmartinelli-fm" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Elevstudio-Dev"><img src="https://avatars.githubusercontent.com/u/276807577?v=4?s=64" width="64px;" alt="Elevstudio-Dev"/><br /><sub><b>Elevstudio-Dev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Elevstudio-Dev" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipedelvan"><img src="https://avatars.githubusercontent.com/u/24362133?v=4?s=64" width="64px;" alt="felipedelvan"/><br /><sub><b>felipedelvan</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipedelvan" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/in100tiva"><img src="https://avatars.githubusercontent.com/u/160179103?v=4?s=64" width="64px;" alt="Luan Oliveira Dos Santos"/><br /><sub><b>Luan Oliveira Dos Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=in100tiva" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mauriciobera1990-droid"><img src="https://avatars.githubusercontent.com/u/318639880?v=4?s=64" width="64px;" alt="mauriciobera1990-droid"/><br /><sub><b>mauriciobera1990-droid</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mauriciobera1990-droid" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SerusoNakamoto"><img src="https://avatars.githubusercontent.com/u/347560292?v=4?s=64" width="64px;" alt="SerusoNakamoto"/><br /><sub><b>SerusoNakamoto</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SerusoNakamoto" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jostoz"><img src="https://avatars.githubusercontent.com/u/150358190?v=4?s=64" width="64px;" alt="josuetoz"/><br /><sub><b>josuetoz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jostoz" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Drmachado0"><img src="https://avatars.githubusercontent.com/u/129681341?v=4?s=64" width="64px;" alt="Drmachado0"/><br /><sub><b>Drmachado0</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Drmachado0" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rogercampel"><img src="https://avatars.githubusercontent.com/u/281720644?v=4?s=64" width="64px;" alt="Roger Campel"/><br /><sub><b>Roger Campel</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rogercampel" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/raphaelmartins"><img src="https://avatars.githubusercontent.com/u/100216897?v=4?s=64" width="64px;" alt="Raphael Martins"/><br /><sub><b>Raphael Martins</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=raphaelmartins" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/matheuspedro360"><img src="https://avatars.githubusercontent.com/u/247238489?v=4?s=64" width="64px;" alt="matheuspedro360"/><br /><sub><b>matheuspedro360</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=matheuspedro360" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lzandonadi"><img src="https://avatars.githubusercontent.com/u/132299432?v=4?s=64" width="64px;" alt="Lucas Falqueto Zandonadi"/><br /><sub><b>Lucas Falqueto Zandonadi</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lzandonadi" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LeonardoMarcelo"><img src="https://avatars.githubusercontent.com/u/94540229?v=4?s=64" width="64px;" alt="leonardo marcelo santana da paz"/><br /><sub><b>leonardo marcelo santana da paz</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LeonardoMarcelo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/cabindaferreira"><img src="https://avatars.githubusercontent.com/u/64534090?v=4?s=64" width="64px;" alt="João Ferreira"/><br /><sub><b>João Ferreira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=cabindaferreira" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/claudioghirellifh"><img src="https://avatars.githubusercontent.com/u/42969756?v=4?s=64" width="64px;" alt="Claudio Ghirelli Filho"/><br /><sub><b>Claudio Ghirelli Filho</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=claudioghirellifh" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxfabioxx12"><img src="https://avatars.githubusercontent.com/u/215034747?v=4?s=64" width="64px;" alt="xxfabioxx12"/><br /><sub><b>xxfabioxx12</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxfabioxx12" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaeskytrabalho"><img src="https://avatars.githubusercontent.com/u/273271440?v=4?s=64" width="64px;" alt="Renan Rafaesky"/><br /><sub><b>Renan Rafaesky</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaeskytrabalho" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/andersontomazi-ctrl"><img src="https://avatars.githubusercontent.com/u/308762107?v=4?s=64" width="64px;" alt="andersontomazi-ctrl"/><br /><sub><b>andersontomazi-ctrl</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=andersontomazi-ctrl" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/agencyspeedagend-del"><img src="https://avatars.githubusercontent.com/u/246169724?v=4?s=64" width="64px;" alt="agencyspeedagend-del"/><br /><sub><b>agencyspeedagend-del</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=agencyspeedagend-del" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vanksestevao"><img src="https://avatars.githubusercontent.com/u/14091195?v=4?s=64" width="64px;" alt="vanksestevao"/><br /><sub><b>vanksestevao</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vanksestevao" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxjjjj"><img src="https://avatars.githubusercontent.com/u/49385833?v=4?s=64" width="64px;" alt="URNOTKRYSTALXU"/><br /><sub><b>URNOTKRYSTALXU</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxjjjj" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/kocaemre"><img src="https://avatars.githubusercontent.com/u/110906681?v=4?s=64" width="64px;" alt="Emre K."/><br /><sub><b>Emre K.</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=kocaemre" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/arthurbarreto07"><img src="https://avatars.githubusercontent.com/u/273399227?v=4?s=64" width="64px;" alt="arthurbarreto07"/><br /><sub><b>arthurbarreto07</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=arthurbarreto07" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/dilneiss"><img src="https://avatars.githubusercontent.com/u/4564667?v=4?s=64" width="64px;" alt="Dilnei"/><br /><sub><b>Dilnei</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=dilneiss" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/resdasilva"><img src="https://avatars.githubusercontent.com/u/210542727?v=4?s=64" width="64px;" alt="resdasilva"/><br /><sub><b>resdasilva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=resdasilva" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hampikamayuq"><img src="https://avatars.githubusercontent.com/u/179255165?v=4?s=64" width="64px;" alt="Diego Galvez"/><br /><sub><b>Diego Galvez</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hampikamayuq" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/andradevander"><img src="https://avatars.githubusercontent.com/u/4044621?v=4?s=64" width="64px;" alt="Vanderson Andrade"/><br /><sub><b>Vanderson Andrade</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=andradevander" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Thibaultjaigu"><img src="https://avatars.githubusercontent.com/u/84420566?v=4?s=64" width="64px;" alt="Thibault Jaigu"/><br /><sub><b>Thibault Jaigu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Thibaultjaigu" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rodrigotxt"><img src="https://avatars.githubusercontent.com/u/7013329?v=4?s=64" width="64px;" alt="Rodrigo Martins"/><br /><sub><b>Rodrigo Martins</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rodrigotxt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/GGBueno"><img src="https://avatars.githubusercontent.com/u/152066770?v=4?s=64" width="64px;" alt="Giovane Bueno"/><br /><sub><b>Giovane Bueno</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=GGBueno" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/erikyudi"><img src="https://avatars.githubusercontent.com/u/55798120?v=4?s=64" width="64px;" alt="erikyudi"/><br /><sub><b>erikyudi</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=erikyudi" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/eudanielhenrique"><img src="https://avatars.githubusercontent.com/u/24281146?v=4?s=64" width="64px;" alt="Daniel Henrique"/><br /><sub><b>Daniel Henrique</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=eudanielhenrique" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Clalber"><img src="https://avatars.githubusercontent.com/u/54963815?v=4?s=64" width="64px;" alt="Clalber Pereira"/><br /><sub><b>Clalber Pereira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Clalber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AllisonFABRASoftware"><img src="https://avatars.githubusercontent.com/u/143289500?v=4?s=64" width="64px;" alt="Allison FABRA Software"/><br /><sub><b>Allison FABRA Software</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AllisonFABRASoftware" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/allisonwilliancandido"><img src="https://avatars.githubusercontent.com/u/77209255?v=4?s=64" width="64px;" alt="Allison Willian"/><br /><sub><b>Allison Willian</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=allisonwilliancandido" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Alencaf"><img src="https://avatars.githubusercontent.com/u/95728740?v=4?s=64" width="64px;" alt="Alencaf"/><br /><sub><b>Alencaf</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Alencaf" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Sandersono"><img src="https://avatars.githubusercontent.com/u/42549260?v=4?s=64" width="64px;" alt="Sanderson Palmeira de Oliveira"/><br /><sub><b>Sanderson Palmeira de Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Sandersono" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/victor-will"><img src="https://avatars.githubusercontent.com/u/217840268?v=4?s=64" width="64px;" alt="victor-will"/><br /><sub><b>victor-will</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=victor-will" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/salomaobatistamkt"><img src="https://avatars.githubusercontent.com/u/265253308?v=4?s=64" width="64px;" alt="salomaobatistamkt"/><br /><sub><b>salomaobatistamkt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=salomaobatistamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gaberaldo-svg"><img src="https://avatars.githubusercontent.com/u/300506992?v=4?s=64" width="64px;" alt="gaberaldo-svg"/><br /><sub><b>gaberaldo-svg</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gaberaldo-svg" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vinicoretecnologia-svg"><img src="https://avatars.githubusercontent.com/u/297014955?v=4?s=64" width="64px;" alt="vinicoretecnologia-svg"/><br /><sub><b>vinicoretecnologia-svg</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vinicoretecnologia-svg" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/RafaelBarbosaBR"><img src="https://avatars.githubusercontent.com/u/295654727?v=4?s=64" width="64px;" alt="RafaelBarbosaBR"/><br /><sub><b>RafaelBarbosaBR</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=RafaelBarbosaBR" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/pedroscharrff"><img src="https://avatars.githubusercontent.com/u/8728421?v=4?s=64" width="64px;" alt="pedroscharrff"/><br /><sub><b>pedroscharrff</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=pedroscharrff" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/LuigiMDev"><img src="https://avatars.githubusercontent.com/u/161367522?v=4?s=64" width="64px;" alt="Luigi Matheus"/><br /><sub><b>Luigi Matheus</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=LuigiMDev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tatarevick"><img src="https://avatars.githubusercontent.com/u/5930817?v=4?s=64" width="64px;" alt="tatarevick"/><br /><sub><b>tatarevick</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=tatarevick" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/anarkaike"><img src="https://avatars.githubusercontent.com/u/583356?v=4?s=64" width="64px;" alt="Junio de Almeida Vitorino"/><br /><sub><b>Junio de Almeida Vitorino</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=anarkaike" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/JonathasmpDEV"><img src="https://avatars.githubusercontent.com/u/99084233?v=4?s=64" width="64px;" alt="Jonathas Micael de Paulo"/><br /><sub><b>Jonathas Micael de Paulo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=JonathasmpDEV" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Frank-zhu2000"><img src="https://avatars.githubusercontent.com/u/332350688?v=4?s=64" width="64px;" alt="jack"/><br /><sub><b>jack</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Frank-zhu2000" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/CristianoFF43"><img src="https://avatars.githubusercontent.com/u/111487334?v=4?s=64" width="64px;" alt="CristianoFF43"/><br /><sub><b>CristianoFF43</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=CristianoFF43" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/obrunogonzaga"><img src="https://avatars.githubusercontent.com/u/6759972?v=4?s=64" width="64px;" alt="Bruno Gonzaga Santos"/><br /><sub><b>Bruno Gonzaga Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=obrunogonzaga" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brastramidia"><img src="https://avatars.githubusercontent.com/u/308168479?v=4?s=64" width="64px;" alt="José Oliveira"/><br /><sub><b>José Oliveira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=brastramidia" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AlecsanderAbreu"><img src="https://avatars.githubusercontent.com/u/14840357?v=4?s=64" width="64px;" alt="Alecsander Abreu"/><br /><sub><b>Alecsander Abreu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AlecsanderAbreu" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/careis-junior"><img src="https://avatars.githubusercontent.com/u/38914210?v=4?s=64" width="64px;" alt="careis-junior"/><br /><sub><b>careis-junior</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=careis-junior" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/dajiaohuang"><img src="https://avatars.githubusercontent.com/u/108231307?v=4?s=64" width="64px;" alt="Wu Shuwen"/><br /><sub><b>Wu Shuwen</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=dajiaohuang" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lauropilatti-c01"><img src="https://avatars.githubusercontent.com/u/239239929?v=4?s=64" width="64px;" alt="lauropilatti-c01"/><br /><sub><b>lauropilatti-c01</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lauropilatti-c01" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/AngelaHelloKittyBaby"><img src="https://avatars.githubusercontent.com/u/220612323?v=4?s=64" width="64px;" alt="AngelaHelloKittyBaby"/><br /><sub><b>AngelaHelloKittyBaby</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=AngelaHelloKittyBaby" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mbiero"><img src="https://avatars.githubusercontent.com/u/34111676?v=4?s=64" width="64px;" alt="mbiero"/><br /><sub><b>mbiero</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mbiero" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/peterkeussen"><img src="https://avatars.githubusercontent.com/u/54675621?v=4?s=64" width="64px;" alt="Peter Keussen de Souza"/><br /><sub><b>Peter Keussen de Souza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=peterkeussen" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/profpeque"><img src="https://avatars.githubusercontent.com/u/248962333?v=4?s=64" width="64px;" alt="profpeque"/><br /><sub><b>profpeque</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=profpeque" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/scavio-ai"><img src="https://avatars.githubusercontent.com/u/264839281?v=4?s=64" width="64px;" alt="Scavio AI"/><br /><sub><b>Scavio AI</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=scavio-ai" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/wellpelomundo"><img src="https://avatars.githubusercontent.com/u/88757007?v=4?s=64" width="64px;" alt="Wellington Ribeiro"/><br /><sub><b>Wellington Ribeiro</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=wellpelomundo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ygorebos"><img src="https://avatars.githubusercontent.com/u/178900847?v=4?s=64" width="64px;" alt="Ygor E O Silva"/><br /><sub><b>Ygor E O Silva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ygorebos" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/DissonADSon"><img src="https://avatars.githubusercontent.com/u/254525408?v=4?s=64" width="64px;" alt="Anderson Simão"/><br /><sub><b>Anderson Simão</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=DissonADSon" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/carloshmlima"><img src="https://avatars.githubusercontent.com/u/144650334?v=4?s=64" width="64px;" alt="Carlos Lima"/><br /><sub><b>Carlos Lima</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=carloshmlima" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucasa15"><img src="https://avatars.githubusercontent.com/u/129917152?v=4?s=64" width="64px;" alt="lucasa15"/><br /><sub><b>lucasa15</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucasa15" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ajsaranetaeu"><img src="https://avatars.githubusercontent.com/u/265983391?v=4?s=64" width="64px;" alt="ajsaranetaeu"/><br /><sub><b>ajsaranetaeu</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ajsaranetaeu" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/SrPascoa"><img src="https://avatars.githubusercontent.com/u/64105691?v=4?s=64" width="64px;" alt="Fábio Páscoa"/><br /><sub><b>Fábio Páscoa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=SrPascoa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felpzGondim"><img src="https://avatars.githubusercontent.com/u/149640165?v=4?s=64" width="64px;" alt="felpzGondim"/><br /><sub><b>felpzGondim</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felpzGondim" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/HigorLira"><img src="https://avatars.githubusercontent.com/u/241835983?v=4?s=64" width="64px;" alt="HigorLira"/><br /><sub><b>HigorLira</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=HigorLira" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/joaoalexsandroed"><img src="https://avatars.githubusercontent.com/u/290192057?v=4?s=64" width="64px;" alt="joaoalexsandroed"/><br /><sub><b>joaoalexsandroed</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=joaoalexsandroed" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucasprestes1"><img src="https://avatars.githubusercontent.com/u/315875467?v=4?s=64" width="64px;" alt="lucasprestes1"/><br /><sub><b>lucasprestes1</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucasprestes1" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/matheussouzasantos"><img src="https://avatars.githubusercontent.com/u/118771606?v=4?s=64" width="64px;" alt="Matheus Santos"/><br /><sub><b>Matheus Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=matheussouzasantos" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/RenanzitoIA"><img src="https://avatars.githubusercontent.com/u/210782324?v=4?s=64" width="64px;" alt="Renan Alves"/><br /><sub><b>Renan Alves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=RenanzitoIA" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rominparekh"><img src="https://avatars.githubusercontent.com/u/3831468?v=4?s=64" width="64px;" alt="Romin Parekh"/><br /><sub><b>Romin Parekh</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rominparekh" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xxgamesxx14"><img src="https://avatars.githubusercontent.com/u/38382596?v=4?s=64" width="64px;" alt="xxgamesxx14"/><br /><sub><b>xxgamesxx14</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xxgamesxx14" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/chiliec"><img src="https://avatars.githubusercontent.com/u/982358?v=4?s=64" width="64px;" alt="Vladimir Babin"/><br /><sub><b>Vladimir Babin</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=chiliec" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Aleshan-dev"><img src="https://avatars.githubusercontent.com/u/274909599?v=4?s=64" width="64px;" alt="Aleshan-dev"/><br /><sub><b>Aleshan-dev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Aleshan-dev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/faxamkt"><img src="https://avatars.githubusercontent.com/u/271869890?v=4?s=64" width="64px;" alt="faxa marketing"/><br /><sub><b>faxa marketing</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=faxamkt" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mentitaa"><img src="https://avatars.githubusercontent.com/u/218529152?v=4?s=64" width="64px;" alt="Mentita"/><br /><sub><b>Mentita</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mentitaa" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/luiscgc91"><img src="https://avatars.githubusercontent.com/u/167824274?v=4?s=64" width="64px;" alt="luiscgc91"/><br /><sub><b>luiscgc91</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=luiscgc91" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucivan212"><img src="https://avatars.githubusercontent.com/u/126484896?v=4?s=64" width="64px;" alt="lucivan212"/><br /><sub><b>lucivan212</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lucivan212" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/leadframeassessoria-lab"><img src="https://avatars.githubusercontent.com/u/246556712?v=4?s=64" width="64px;" alt="leadframeassessoria-lab"/><br /><sub><b>leadframeassessoria-lab</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=leadframeassessoria-lab" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gabigurgeldev"><img src="https://avatars.githubusercontent.com/u/217263330?v=4?s=64" width="64px;" alt="GABRIEL MORAIS GURGEL"/><br /><sub><b>GABRIEL MORAIS GURGEL</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gabigurgeldev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/actions-user"><img src="https://avatars.githubusercontent.com/u/65916846?v=4?s=64" width="64px;" alt="actions-user"/><br /><sub><b>actions-user</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=actions-user" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/fillipeagra-cyber"><img src="https://avatars.githubusercontent.com/u/334704227?v=4?s=64" width="64px;" alt="fillipeagra-cyber"/><br /><sub><b>fillipeagra-cyber</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=fillipeagra-cyber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/carlospaivabr"><img src="https://avatars.githubusercontent.com/u/225022566?v=4?s=64" width="64px;" alt="Carlos Paiva"/><br /><sub><b>Carlos Paiva</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=carlospaivabr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/caiofacchinato"><img src="https://avatars.githubusercontent.com/u/22156666?v=4?s=64" width="64px;" alt="caiofacchinato"/><br /><sub><b>caiofacchinato</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=caiofacchinato" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/alexneverland"><img src="https://avatars.githubusercontent.com/u/219037244?v=4?s=64" width="64px;" alt="Lazaros Avramidis"/><br /><sub><b>Lazaros Avramidis</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=alexneverland" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/scademir"><img src="https://avatars.githubusercontent.com/u/17762455?v=4?s=64" width="64px;" alt="Ademir Santos"/><br /><sub><b>Ademir Santos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=scademir" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/patronotech"><img src="https://avatars.githubusercontent.com/u/107273923?v=4?s=64" width="64px;" alt="patronotech"/><br /><sub><b>patronotech</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=patronotech" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rabbitkleber"><img src="https://avatars.githubusercontent.com/u/201826597?v=4?s=64" width="64px;" alt="rabbitkleber"/><br /><sub><b>rabbitkleber</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rabbitkleber" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rafaelbatistak"><img src="https://avatars.githubusercontent.com/u/333355664?v=4?s=64" width="64px;" alt="rafaelbatistak"/><br /><sub><b>rafaelbatistak</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rafaelbatistak" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ragaspaleilao"><img src="https://avatars.githubusercontent.com/u/237982352?v=4?s=64" width="64px;" alt="ragaspaleilao"/><br /><sub><b>ragaspaleilao</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ragaspaleilao" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/realLoganLuo"><img src="https://avatars.githubusercontent.com/u/157785179?v=4?s=64" width="64px;" alt="Logan-Luo"/><br /><sub><b>Logan-Luo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=realLoganLuo" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/renatofortal"><img src="https://avatars.githubusercontent.com/u/253097215?v=4?s=64" width="64px;" alt="renatofortal"/><br /><sub><b>renatofortal</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=renatofortal" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rgisjr"><img src="https://avatars.githubusercontent.com/u/192881385?v=4?s=64" width="64px;" alt="rgisjr"/><br /><sub><b>rgisjr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rgisjr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/stivanellidrop-dotcom"><img src="https://avatars.githubusercontent.com/u/252956995?v=4?s=64" width="64px;" alt="stivanellidrop-dotcom"/><br /><sub><b>stivanellidrop-dotcom</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=stivanellidrop-dotcom" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tratham-oficial"><img src="https://avatars.githubusercontent.com/u/194640682?v=4?s=64" width="64px;" alt="tratham-oficial"/><br /><sub><b>tratham-oficial</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=tratham-oficial" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/vitor-licassali"><img src="https://avatars.githubusercontent.com/u/279541725?v=4?s=64" width="64px;" alt="vitor-licassali"/><br /><sub><b>vitor-licassali</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=vitor-licassali" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/w4rlockem"><img src="https://avatars.githubusercontent.com/u/306561836?v=4?s=64" width="64px;" alt="w4rlockem"/><br /><sub><b>w4rlockem</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=w4rlockem" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/xofrd"><img src="https://avatars.githubusercontent.com/u/132912940?v=4?s=64" width="64px;" alt="William"/><br /><sub><b>William</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=xofrd" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Agenciatektus"><img src="https://avatars.githubusercontent.com/u/176332039?v=4?s=64" width="64px;" alt="Agência Tektus"/><br /><sub><b>Agência Tektus</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Agenciatektus" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/codex"><img src="https://avatars.githubusercontent.com/u/267193182?v=4?s=64" width="64px;" alt="Codex"/><br /><sub><b>Codex</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=codex" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/EduFkn"><img src="https://avatars.githubusercontent.com/u/203916739?v=4?s=64" width="64px;" alt="Eduardo Almeida"/><br /><sub><b>Eduardo Almeida</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=EduFkn" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/edaben"><img src="https://avatars.githubusercontent.com/u/36493350?v=4?s=64" width="64px;" alt="edaben"/><br /><sub><b>edaben</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=edaben" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/thinhnx128"><img src="https://avatars.githubusercontent.com/u/300279120?v=4?s=64" width="64px;" alt="Gau·Beo"/><br /><sub><b>Gau·Beo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=thinhnx128" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gyanu2507"><img src="https://avatars.githubusercontent.com/u/81113356?v=4?s=64" width="64px;" alt="Gyanu Mayank"/><br /><sub><b>Gyanu Mayank</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gyanu2507" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hamiltonviana"><img src="https://avatars.githubusercontent.com/u/10765079?v=4?s=64" width="64px;" alt="hamiltonviana"/><br /><sub><b>hamiltonviana</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hamiltonviana" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Hefesto25"><img src="https://avatars.githubusercontent.com/u/259682362?v=4?s=64" width="64px;" alt="Hefesto25"/><br /><sub><b>Hefesto25</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Hefesto25" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/holive"><img src="https://avatars.githubusercontent.com/u/6090596?v=4?s=64" width="64px;" alt="holive"/><br /><sub><b>holive</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=holive" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/oianmaxdev"><img src="https://avatars.githubusercontent.com/u/273223021?v=4?s=64" width="64px;" alt="oianmaxdev"/><br /><sub><b>oianmaxdev</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=oianmaxdev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/KauaAmaral"><img src="https://avatars.githubusercontent.com/u/105084991?v=4?s=64" width="64px;" alt="Kauã Amaral"/><br /><sub><b>Kauã Amaral</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=KauaAmaral" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/kristhianlumai-lgtm"><img src="https://avatars.githubusercontent.com/u/240210983?v=4?s=64" width="64px;" alt="kristhianlumai-lgtm"/><br /><sub><b>kristhianlumai-lgtm</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=kristhianlumai-lgtm" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/devmonisat"><img src="https://avatars.githubusercontent.com/u/114448312?v=4?s=64" width="64px;" alt="Monisat"/><br /><sub><b>Monisat</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=devmonisat" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lcsilvestrini"><img src="https://avatars.githubusercontent.com/u/47918106?v=4?s=64" width="64px;" alt="Luiz Carlos Silvestrini"/><br /><sub><b>Luiz Carlos Silvestrini</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lcsilvestrini" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lmarceloc"><img src="https://avatars.githubusercontent.com/u/10298381?v=4?s=64" width="64px;" alt="Marcelo"/><br /><sub><b>Marcelo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=lmarceloc" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/marcelovolei15"><img src="https://avatars.githubusercontent.com/u/273241567?v=4?s=64" width="64px;" alt="marcelovolei15"/><br /><sub><b>marcelovolei15</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=marcelovolei15" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/murilloimparavel"><img src="https://avatars.githubusercontent.com/u/114107747?v=4?s=64" width="64px;" alt="Murillo Alves"/><br /><sub><b>Murillo Alves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=murilloimparavel" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/pljrcombr"><img src="https://avatars.githubusercontent.com/u/246193933?v=4?s=64" width="64px;" alt="pljrcombr"/><br /><sub><b>pljrcombr</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=pljrcombr" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Teowfb"><img src="https://avatars.githubusercontent.com/u/197986058?v=4?s=64" width="64px;" alt="Teowfb"/><br /><sub><b>Teowfb</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Teowfb" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/terceiroregiss"><img src="https://avatars.githubusercontent.com/u/244394977?v=4?s=64" width="64px;" alt="Terceiro Régis"/><br /><sub><b>Terceiro Régis</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=terceiroregiss" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/PiahDoNeumann"><img src="https://avatars.githubusercontent.com/u/56264244?v=4?s=64" width="64px;" alt="Valdecir Neumann"/><br /><sub><b>Valdecir Neumann</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=PiahDoNeumann" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ViktorHugodev"><img src="https://avatars.githubusercontent.com/u/85125378?v=4?s=64" width="64px;" alt="Victor H Correa"/><br /><sub><b>Victor H Correa</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ViktorHugodev" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ygorl"><img src="https://avatars.githubusercontent.com/u/105249488?v=4?s=64" width="64px;" alt="ygorl"/><br /><sub><b>ygorl</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ygorl" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/bfs2021"><img src="https://avatars.githubusercontent.com/u/101915083?v=4?s=64" width="64px;" alt="zgy"/><br /><sub><b>zgy</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=bfs2021" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ricagui"><img src="https://avatars.githubusercontent.com/u/63175361?v=4?s=64" width="64px;" alt="Ricardo Mendes"/><br /><sub><b>Ricardo Mendes</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ricagui" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/ZvisionAutomations"><img src="https://avatars.githubusercontent.com/u/263388721?v=4?s=64" width="64px;" alt="ZvisionAutomations"/><br /><sub><b>ZvisionAutomations</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=ZvisionAutomations" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jhometal"><img src="https://avatars.githubusercontent.com/u/86752996?v=4?s=64" width="64px;" alt="jhometal"/><br /><sub><b>jhometal</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ajhometal" title="Bug reports">🐛</a> <a href="#ideas-jhometal" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/juniorpagedown"><img src="https://avatars.githubusercontent.com/u/81428565?v=4?s=64" width="64px;" alt="juniorpagedown"/><br /><sub><b>juniorpagedown</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ajuniorpagedown" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/nemyasalmeida"><img src="https://avatars.githubusercontent.com/u/298016233?v=4?s=64" width="64px;" alt="nemyasalmeida"/><br /><sub><b>nemyasalmeida</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Anemyasalmeida" title="Bug reports">🐛</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/hudson-souza-mkt"><img src="https://avatars.githubusercontent.com/u/173297369?v=4?s=64" width="64px;" alt="hudson-souza-mkt"/><br /><sub><b>hudson-souza-mkt</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hudson-souza-mkt" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Ahudson-souza-mkt" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/NeroSued"><img src="https://avatars.githubusercontent.com/u/250192521?v=4?s=64" width="64px;" alt="Nero Sued"/><br /><sub><b>Nero Sued</b></sub></a><br /><a href="#ideas-NeroSued" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/aerosuiteapp"><img src="https://avatars.githubusercontent.com/u/284125218?v=4?s=64" width="64px;" alt="Danilo Costa"/><br /><sub><b>Danilo Costa</b></sub></a><br /><a href="#ideas-aerosuiteapp" title="Ideas, Planning, & Feedback">🤔</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Aaerosuiteapp" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/frankjohann"><img src="https://avatars.githubusercontent.com/u/184155572?v=4?s=64" width="64px;" alt="Frank Johann"/><br /><sub><b>Frank Johann</b></sub></a><br /><a href="#ideas-frankjohann" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/tec7alex"><img src="https://avatars.githubusercontent.com/u/101949364?v=4?s=64" width="64px;" alt="tec7alex"/><br /><sub><b>tec7alex</b></sub></a><br /><a href="#ideas-tec7alex" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/shu-chen-dot-ca"><img src="https://avatars.githubusercontent.com/u/338845574?v=4?s=64" width="64px;" alt="Shu Chen"/><br /><sub><b>Shu Chen</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=shu-chen-dot-ca" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/renatomprado"><img src="https://avatars.githubusercontent.com/u/216311270?v=4?s=64" width="64px;" alt="Renato Prado"/><br /><sub><b>Renato Prado</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=renatomprado" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Villa-Nova-Cont"><img src="https://avatars.githubusercontent.com/u/216889679?v=4?s=64" width="64px;" alt="Villa-Nova-Cont"/><br /><sub><b>Villa-Nova-Cont</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Villa-Nova-Cont" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://seax.com.br/"><img src="https://avatars.githubusercontent.com/u/344303443?v=4?s=64" width="64px;" alt="Seax"/><br /><sub><b>Seax</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=seax-trophy" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/routeti"><img src="https://avatars.githubusercontent.com/u/150551659?v=4?s=64" width="64px;" alt="routeti"/><br /><sub><b>routeti</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=routeti" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://codenome.com/"><img src="https://avatars.githubusercontent.com/u/7620822?v=4?s=64" width="64px;" alt="Ricardo Souza"/><br /><sub><b>Ricardo Souza</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Riicksouzaa" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3ARiicksouzaa" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/rglucchini-ai"><img src="https://avatars.githubusercontent.com/u/294623315?v=4?s=64" width="64px;" alt="rglucchini-ai"/><br /><sub><b>rglucchini-ai</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=rglucchini-ai" title="Code">💻</a> <a href="#ideas-rglucchini-ai" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://asishkumar.com/"><img src="https://avatars.githubusercontent.com/u/87874775?v=4?s=64" width="64px;" alt="Asish Kumar"/><br /><sub><b>Asish Kumar</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=officialasishkumar" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/mindflowai1"><img src="https://avatars.githubusercontent.com/u/212163253?v=4?s=64" width="64px;" alt="mindflowai1"/><br /><sub><b>mindflowai1</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=mindflowai1" title="Code">💻</a> <a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Amindflowai1" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/jay23606"><img src="https://avatars.githubusercontent.com/u/4602056?v=4?s=64" width="64px;" alt="Jay"/><br /><sub><b>Jay</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=jay23606" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://hanbintan.com/"><img src="https://avatars.githubusercontent.com/u/48960067?v=4?s=64" width="64px;" alt="Hanbin Tan"/><br /><sub><b>Hanbin Tan</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=hskl18" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/felipehenriquess"><img src="https://avatars.githubusercontent.com/u/141957140?v=4?s=64" width="64px;" alt="Felipe Henrique"/><br /><sub><b>Felipe Henrique</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=felipehenriquess" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/betoloko1970"><img src="https://avatars.githubusercontent.com/u/204420278?v=4?s=64" width="64px;" alt="betoloko1970"/><br /><sub><b>betoloko1970</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=betoloko1970" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/berrub00"><img src="https://avatars.githubusercontent.com/u/269054991?v=4?s=64" width="64px;" alt="berrub00"/><br /><sub><b>berrub00</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=berrub00" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/zeroaiproject"><img src="https://avatars.githubusercontent.com/u/355486270?v=4?s=64" width="64px;" alt="Zero AI"/><br /><sub><b>Zero AI</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=zeroaiproject" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/World2576"><img src="https://avatars.githubusercontent.com/u/202460698?v=4?s=64" width="64px;" alt="World2576"/><br /><sub><b>World2576</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=World2576" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/wanjinhao1"><img src="https://avatars.githubusercontent.com/u/34562501?v=4?s=64" width="64px;" alt="Kratos"/><br /><sub><b>Kratos</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=wanjinhao1" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/Denispds"><img src="https://avatars.githubusercontent.com/u/151410339?v=4?s=64" width="64px;" alt="Denis pereira dos santos Araújo"/><br /><sub><b>Denis pereira dos santos Araújo</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=Denispds" title="Code">💻</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gabriel-lima-git-hub"><img src="https://avatars.githubusercontent.com/u/306846636?v=4?s=64" width="64px;" alt="gabriel-lima-git-hub"/><br /><sub><b>gabriel-lima-git-hub</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/commits?author=gabriel-lima-git-hub" title="Code">💻</a></td>
    </tr>
    <tr>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/lucas-nobrega"><img src="https://avatars.githubusercontent.com/u/38710249?v=4?s=64" width="64px;" alt="Lucas"/><br /><sub><b>Lucas</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Alucas-nobrega" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/WaldineyGodoy"><img src="https://avatars.githubusercontent.com/u/163134445?v=4?s=64" width="64px;" alt="WaldineyGodoy"/><br /><sub><b>WaldineyGodoy</b></sub></a><br /><a href="#ideas-WaldineyGodoy" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/brunno-soaress"><img src="https://avatars.githubusercontent.com/u/318511864?v=4?s=64" width="64px;" alt="brunno-soaress"/><br /><sub><b>brunno-soaress</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Abrunno-soaress" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/gleisaum"><img src="https://avatars.githubusercontent.com/u/4007202?v=4?s=64" width="64px;" alt="Gleison Neves"/><br /><sub><b>Gleison Neves</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3Agleisaum" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/amexgestao"><img src="https://avatars.githubusercontent.com/u/211154203?v=4?s=64" width="64px;" alt="amexgestao"/><br /><sub><b>amexgestao</b></sub></a><br /><a href="#ideas-amexgestao" title="Ideas, Planning, & Feedback">🤔</a></td>
      <td align="center" valign="top" width="12.5%"><a href="https://github.com/InvestidorDiversificado"><img src="https://avatars.githubusercontent.com/u/336340817?v=4?s=64" width="64px;" alt="InvestidorDiversificado"/><br /><sub><b>InvestidorDiversificado</b></sub></a><br /><a href="https://github.com/melgarafael/DeskcommCRM/issues?q=author%3AInvestidorDiversificado" title="Bug reports">🐛</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

---

## 🐛 Reporting bugs

Open an [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — the template asks for what we need (environment, `/api/v1/health`, steps). Running `bash hostgator-setup-kit/healthcheck.sh` and pasting the output helps a lot.

For **security vulnerabilities**, **do NOT open a public issue** — use [private vulnerability reporting](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Details in [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Shipped

- **Foundation & platform** — auth (MFA for admins), multi-tenancy with RLS + isolation test, 4-role RBAC, append-only audit log, tenant onboarding.
- **WhatsApp support** — real-time 3-pane inbox, multi-number connections via **QR (WAHA)** or **Meta's official channel** (approved templates kept in sync), media via Storage, anti-ban (throttle + jitter + time windows), STOP detection.
- **CRM & orders** — kanban with per-niche configurable vocabulary (fractional indexing), pipeline management from the screen, customer 360, contacts, tags, Nuvemshop integration.
- **Native AI** — agents with per-tenant RAG (pgvector), **skills** the agent runs by itself, **organization memory**, per-number intent router, sentiment analysis, AI→human handoff, per-org spending caps, internal MCP server.
- **AI provider choice** — OpenRouter, Anthropic or OpenAI, decided at install time and switchable per part of the system from the screen.
- **Living follow-up** — reviving cold conversations with adaptive timing, per-stage and per-case triggers, round-robin queue, and the Radar of what risks dying unanswered.
- **Privacy (LGPD)** — export and redact via workers, cascading anonymization, audited consent.
- **Self-host** — `hostgator-setup-kit` (app + WhatsApp + database with one command), self-healing `baseline.sql`, **updating from the screen** with automatic backup, production runbook.
- **Webhooks & automation** — capture sources + WHEN/IF/THEN rules + triggers for external systems.
- **Support governance** — server-side RBAC across the API, audited assignment/transfer (AI as a first-class assignee), per-role visibility (RLS) + per-agent metrics, automatic routing with queue and management panel, and a governance contract for external AI agents ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)).
- **Visible operation** — anti-ban hold reasons translated in the conversation, a notice center with severities, stuck-message alerts, send-protection controls (window/pace/cap), declared agent capabilities and flywheel proposals applicable as a new version (human-gated).

### 🔮 Next

- **Public MCP** — CRM capabilities exposed to the agent ecosystem: plug in any agent and it operates Deskcomm.
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
- **You are responsible for your installation.** Updates are not automatic (you click, or run `update.sh`, when you want), and keeping/backing up your server is on you.
- **Data protection:** whoever **hosts** the instance is the **controller** of the personal data processed there (customers, conversations, orders), with the legal obligations that follow. The project maintainers are **neither** controllers nor processors of your instance, and have no access to your database, your WhatsApp or your storage.
- **Telemetry (Sentry):** `install.sh` **asks** during installation and respects your answer; in non-interactive mode, with no `SENTRY_DSN` set, telemetry is **off**. If you accept the community Sentry, what gets sent are **error reports** (stack traces) with national IDs, phone numbers and emails replaced, sensitive headers stripped, and webhook/invite tokens redacted from URLs — **no** performance tracing and **no** session replay, both pinned to 0 on that path. To turn it off at any time: `SENTRY_DSN=off` in `.env`. To send to **your** Sentry (there, with performance and replay): `SENTRY_DSN=<your-dsn>`. What is redacted, and why, lives in [`lib/sentry/scrub.ts`](lib/sentry/scrub.ts); DSN resolution in [`lib/sentry/dsn.ts`](lib/sentry/dsn.ts).

---

## 🙏 Acknowledgements

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — WhatsApp engine.
- **Supabase** — Postgres + Auth + Storage + Realtime in one stack.
- **HostGator** — the infrastructure partnership that made one-command self-hosting possible.
- **Anthropic**, **OpenAI** and **OpenRouter** — the AI providers the CRM knows how to use.
- **shadcn/ui** — component base.
- The community that took Deskcomm from e-commerce to clinics, real estate, info-products and beyond — you defined what this project is.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

</div>
