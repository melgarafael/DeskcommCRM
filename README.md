<div align="center">

# 🛠️ DeskcommCRM

**CRM operacional multi-tenant para e-commerce, com IA conversacional nativa, WhatsApp via WAHA e LGPD by-design.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Tailwind](https://img.shields.io/badge/Tailwind-CSS-38bdf8?logo=tailwindcss)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**📘 Setup Guide**](docs/SETUP.md) · [**🏗️ Arquitetura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**📋 PRDs**](docs/prd/) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

</div>

---

> ### ☁️ Rode este CRM em produção com 1 comando
>
> O DeskcommCRM foi desenvolvido em **parceria com a HostGator**: o [`hostgator-setup-kit/`](hostgator-setup-kit/)
> instala o CRM completo (app + WAHA + banco) numa VPS com um único comando, e o
> [runbook de produção](docs/runbooks/waha-hostgator.md) já assume esse ambiente.
>
> **[👉 Assinar a VPS HostGator com desconto da parceria](https://www.hostgator.com.br/52708-141-3-52.html)** —
> datacenter em São Paulo, ideal pro WhatsApp rodando 24/7. *(link de parceiro — assinar por ele apoia o projeto e sai mais barato)*

## ✨ O que é

DeskcommCRM unifica **atendimento humano**, **agentes de IA com RAG por tenant**, **gestão de pedidos** e **pipeline de pós-venda** numa única plataforma. Canal primário: **WhatsApp via WAHA**. Multi-tenant desde o dia 1. LGPD nativa.

> **Modo atual:** BPO interno (uma operadora atende N tenants).
> **Modo futuro:** SaaS direto pra lojistas.

### Diferenciais

- 🤖 **IA operando o atendimento** — agentes com RAG por tenant, análise de sentimento, handoff IA→humano auditado e controle de budget. Não é chatbot decorativo, é triagem real.
- 🛒 **E-commerce-native** — vocabulário desenhado pro ciclo *Carrinho abandonado → Pago → Enviado → Entregue → Pós-venda*.
- 🇧🇷 **LGPD by-design** — webhooks `customer/redact` e `customer/data_request` da Nuvemshop como contrato de primeira-classe; anonimização preferida sobre delete; audit append-only com retenção 5 anos.
- 👥 **Governança de atendimento** — RBAC server-side de verdade, atribuição/transferência auditada, fila com posição, roteamento automático e escopo de visualização por papel.
- 🔌 **MCP-ready** — MCP server interno pros agentes; contrato público pra agentes externos em construção.
- 🏢 **Multi-tenant de verdade** — RLS em toda tabela tenant-aware, teste de isolamento como gate de CI.

### 🔌 Webhooks & Automações

Todo tenant pode criar **fontes de captação**: um endereço público (`/api/v1/webhooks/in/<token>`) que recebe leads de landing pages, formulários próprios ou ferramentas como Zapier/n8n via POST (JSON ou `application/x-www-form-urlencoded`) e já entra direto no funil/estágio escolhido — sem código, sem integração customizada por tenant. Em cima dessas fontes (e dos outros eventos do CRM — lead mudou de etapa, ganhou tag, chegou mensagem no WhatsApp), o tenant monta **automações**: regras no formato QUANDO/SE/ENTÃO que disparam ações como adicionar tag, mover o lead no funil, atribuir a um atendente, mandar uma mensagem de WhatsApp ou avisar outro sistema via webhook de saída.

Na UI, tudo mora em **Webhooks** na sidebar (visível só pra quem tem papel `manager`/`admin` — `agent`/`viewer` não veem o item nem acessam a rota, redirecionados pro inbox). A tela tem três abas: **Receber dados** (criar fonte, copiar o endereço/formulário pronto, disparar um lead de teste, ver os últimos recebimentos), **Automações** (montar a regra, que sempre nasce pausada até o tenant revisar e ligar) e **Atividade** (timeline de cada execução, com o resultado de cada ação e reenvio manual quando uma chamada de webhook externo falha).

Por baixo, cada evento (lead criado, tag adicionada, etc.) vira uma linha em `event_log` — nenhum trigger de banco faz chamada HTTP diretamente. Quem drena essa fila e realmente dispara as automações é a rota `/api/v1/cron/event-log-drain`, chamada a cada minuto. No Vercel isso é um Cron Job gerenciado; **no kit self-host da HostGator** (`hostgator-setup-kit/`), o `install.sh`/`update.sh` já configura sozinho uma linha de `crontab` que roda essa rota todo minuto com o `INTERNAL_SECRET` do `.env` — sem esse cron ativo, fontes e automações continuam sendo criadas normalmente, mas os eventos ficam empilhados em `event_log` e nenhuma automação chega a rodar de verdade.

---

## 🚀 Quickstart (5 minutos pra ver rodando)

```bash
# 1. Clone
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM

# 2. Node 20 + pnpm
nvm use                    # ou instale Node 20+
npm install -g pnpm
pnpm install

# 3. Env vars
cp .env.example .env.local
# Edite .env.local — guia completo em docs/SETUP.md

# 4. WAHA local (opcional em dev sem WhatsApp)
docker compose up -d

# 5. Migrations Supabase
supabase link --project-ref <seu-ref>
supabase db push

# 6. Sobe o app
pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

> 🆕 **Primeira vez? Não pula etapa.** [`docs/SETUP.md`](docs/SETUP.md) é o tutorial completo passo a passo de **todas as integrações** (Supabase, WAHA, Anthropic, Upstash, Sentry, Resend, Nuvemshop) — feito pra quem nunca configurou nada disso antes. ~60–90 min do zero ao app rodando.

---

## 🧱 Stack

| Camada | Escolha | Por quê |
|---|---|---|
| **Frontend** | Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito | Server Components + Route Handlers no mesmo repo |
| **Estilo** | Tailwind + shadcn/ui (`new-york`, neutral) | Customizável sem lock-in |
| **DB** | Supabase (Postgres + RLS + `vector`) | Multi-tenant nativo, embedding pra RAG |
| **Auth** | Supabase Auth via `@supabase/ssr` | Cookie SameSite=Strict, HttpOnly |
| **Realtime** | Supabase Realtime | postgres_changes + broadcast |
| **Storage** | Supabase Storage (URLs assinadas) | Bucket privado `whatsapp-media` |
| **WhatsApp** | WAHA Plus (engine NOWEB) | Multi-tenant, retry, S3 |
| **Filas** | `event_log` table + workers (cron) | Sem Inngest/Trigger no MVP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, free tier suficiente |
| **AI** | Vercel AI SDK v7 (providers Anthropic/Google/OpenAI v4) via AI Gateway | Fallback automático, ZDR |
| **Validação** | Zod | Input externo, env, payloads |
| **Observability** | Sentry (com `beforeSend` sanitizado) | Sem PII no breadcrumb |
| **Hospedagem** | Vercel (app) + Hostgator VPS Turing/SP (WAHA) | Edge + dedicado pra WhatsApp; datacenter Brasil |

Detalhes: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 📁 Estrutura

```
DeskcommCRM/
├── app/                    # Next.js App Router
│   ├── (admin)/            # Rotas super-admin (impersonate, tenants)
│   ├── (public)/           # Login, recovery
│   ├── app/                # Rotas autenticadas: inbox, kanban, contacts,
│   │                       #   connections, ai (agentes), integrations,
│   │                       #   metrics, lgpd, audit, team, settings
│   └── api/v1/             # API REST canônica
├── components/             # React (ui/, inbox/, kanban/, shell/, ...)
├── lib/                    # supabase/, waha/, ai/, api/, routing/, env.ts
├── hooks/
├── supabase/migrations/    # SQL versionado (+ baseline.sql pro self-host)
├── workers/                # consumers de event_log (IA, RAG, LGPD, rotinas)
├── tests/{e2e,unit,invariants}/
├── scripts/                # seeds, qa-waves, manutenção
├── docs/                   # PRDs, specs, stories, SETUP.md
└── hostgator-setup-kit/    # instalação self-host com 1 comando
```

---

## 🧪 Testes

```bash
pnpm typecheck     # tsc --noEmit (estrito)
pnpm lint          # eslint next/core-web-vitals
pnpm test:unit     # Vitest
pnpm test:e2e      # Playwright (requer dev server)
```

CI roda todos antes de merge. **Teste de isolamento RLS é gate obrigatório** — cria 2 tenants e verifica não-vazamento. A suíte de **invariantes de governança** (100+ testes) trava regressões de RBAC, atribuição, escopo e roteamento.

---

## 📚 Documentação

| Doc | O que tem |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | **Setup completo passo a passo** de todas as integrações |
| [`CLAUDE.md`](CLAUDE.md) | Convenções não-negociáveis (leitura obrigatória pra contribuir) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Visão de 1 página da arquitetura |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Fluxo PR + epic-executor |
| [`docs/prd/`](docs/prd/) | PRDs (master, platform, customer 360, WhatsApp, pipeline, IA-RAG, Nuvemshop) |
| [`docs/specs/`](docs/specs/) | Specs técnicas 01–13 (schema SQL, payloads, MCP, governança) |
| [`docs/business-rules/`](docs/business-rules/) | Regras de negócio fora do código |
| [`docs/DEPLOY-CHECKLIST.md`](docs/DEPLOY-CHECKLIST.md) | Preflight pré-go-live |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Runbook completo de WAHA em produção (VPS Hostgator) |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | Como atualizar uma instalação self-host |

---

## 🤝 Contribuindo

Esse projeto é open source pra comunidade. Toda contribuição é bem-vinda — desde fix de typo em doc até feature nova.

**Antes de abrir PR:**

1. Leia [`CLAUDE.md`](CLAUDE.md) (~5 min) — convenções não-negociáveis (multi-tenancy, RLS, audit, LGPD).
2. Leia [`CONTRIBUTING.md`](CONTRIBUTING.md) — fluxo de branches, commits, epic-executor.
3. Siga o [Código de Conduta](CODE_OF_CONDUCT.md).

**Fluxo curto:**

```bash
git checkout -b feat/short-slug
# implementa + testes
pnpm typecheck && pnpm lint && pnpm test:unit
git commit -m "feat(escopo): descrição"
# abre PR — o template já traz o checklist de Definition of Done
```

**Definition of Done:** typecheck zero, lint zero, testes relevantes verdes, RLS testada se toca tabela tenant-aware, audit log emitido em mutações, migration versionada se muda schema. Detalhes em [`CLAUDE.md`](CLAUDE.md#definition-of-done).

---

## 🐛 Reportando bugs

Abra uma [issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose) — o template pede o que precisamos (ambiente, `/api/v1/health`, steps).

Pra **vulnerabilidades de segurança**, **NÃO abra issue pública** — use o [relato privado de vulnerabilidades](https://github.com/melgarafael/DeskcommCRM/security/advisories/new). Detalhes em [`SECURITY.md`](SECURITY.md).

---

## 🗺️ Roadmap

### ✅ Entregue

- **Fundação & plataforma** — auth (MFA pra admin), multi-tenancy com RLS + teste de isolamento, RBAC 4 papéis, audit log append-only, onboarding de tenant.
- **Atendimento WhatsApp** — inbox 3 painéis em tempo real, conexões WAHA multi-número, mídia via Storage, anti-banimento (throttle + jitter + janela de horário), STOP detection.
- **CRM & pedidos** — kanban com vocabulário e-commerce (fractional indexing), customer 360, contatos, tags, integração Nuvemshop.
- **IA nativa** — agentes com RAG por tenant (pgvector), análise de sentimento, handoff IA→humano, controle de budget por org, MCP server interno.
- **LGPD** — export e redact via workers, anonimização em cascata, consentimento auditado.
- **Self-host** — `hostgator-setup-kit` (app + WAHA + banco com 1 comando), `baseline.sql` auto-curativo, runbook de produção.
- **Webhooks & automação** — gatilhos de eventos do CRM pra sistemas externos.

### 🔄 Em andamento — Governança de Atendimento

Épico guiado por invariantes (suíte de 100+ testes como eval), fase a fase:

- ✅ **G1** — provas & fundação (invariantes dos 7 eixos de dor, CI consolidado)
- ✅ **G2** — RBAC server-side em toda a API (matriz papel×endpoint)
- ✅ **G3** — atribuição & transferência auditadas; IA como assignee de 1ª classe; tags
- ✅ **G4** — escopo de visualização por papel (RLS) + métricas por atendente
- 🔄 **G5** — roteamento automático, fila com posição e painel de gestão *(fechando)*
- 🔜 **G6** — contrato de governança pra agentes de IA externos (MCP tools públicas)

### 🔮 Próximo

- **MCP público** — capabilities do CRM expostas pro ecossistema de agentes.
- **Integrações** — VTEX e Shopify via adapter pattern (Nuvemshop já entregue).
- **Identity probabilística** — unificação de contatos entre canais.
- **Modo SaaS** — self-service direto pra lojistas (hoje: BPO single-operator).

---

## 💬 Comunidade

- **Discussões:** [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions) — pra perguntas, ideias, showcase.
- **Issues:** [GitHub Issues](https://github.com/melgarafael/DeskcommCRM/issues) — bugs e tasks.
- **Instagram:** [@melgarafael](https://www.instagram.com/melgarafael)
- **YouTube:** [youtube.com/@melgarafael](https://www.youtube.com/@melgarafael)

---

## 📜 Licença

Distribuído sob a licença **MIT** — veja [`LICENSE`](LICENSE). Você pode usar, modificar
e distribuir livremente, inclusive comercialmente. O software é fornecido **"como está",
sem garantias** (ver cláusula de isenção no `LICENSE`).

---

## 🛟 Suporte & responsabilidades (self-host)

Este é um projeto **self-host**: cada pessoa roda o CRM na **própria infraestrutura**
(VPS, banco Supabase e chave de IA próprios). Isso implica:

- **Suporte é comunitário e "as-is".** Dúvidas e bugs entram como
  [Issues](https://github.com/melgarafael/DeskcommCRM/issues) ou
  [Discussions](https://github.com/melgarafael/DeskcommCRM/discussions). Não há SLA nem
  suporte garantido — é open source mantido por boa vontade.
- **Você é responsável pela sua instalação.** Atualizações não são automáticas
  (`bash hostgator-setup-kit/update.sh` quando quiser), e manter/backup do seu servidor
  é com você.
- **LGPD — atenção:** quem **hospeda** a instância é o **controlador** dos dados pessoais
  ali tratados (clientes, conversas, pedidos), com as obrigações legais decorrentes. Os
  mantenedores do projeto **não têm acesso** aos seus dados e **não são** controladores
  nem operadores da sua instância.
- **Telemetria (Sentry):** por padrão, erros **anonimizados** (CPF/telefone/e-mail
  removidos) são enviados ao Sentry da comunidade pra ajudar a corrigir bugs que afetam
  todos. Para **desligar**, use `SENTRY_DSN=off` no `.env`; para enviar ao **seu** Sentry,
  use `SENTRY_DSN=<seu-dsn>`. Ver [`lib/sentry/dsn.ts`](lib/sentry/dsn.ts).

---

## 🙏 Agradecimentos

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — engine WhatsApp.
- **Supabase** — Postgres + Auth + Storage + Realtime numa stack só.
- **Vercel** — hosting + AI Gateway.
- **Anthropic** (Claude) — IA conversacional.
- **shadcn/ui** — base de componentes.
- Comunidade brasileira de e-commerce que validou as primeiras hipóteses.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

Siga o desenvolvimento: [Instagram](https://www.instagram.com/melgarafael) · [YouTube](https://www.youtube.com/@melgarafael)

</div>
