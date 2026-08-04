<div align="center">

🇧🇷 Português · [🇺🇸 English](README.en.md) · [🇪🇸 Español](README.es.md)

# 🛠️ DeskcommCRM — o Sistema Operacional de Vendas com IA, open source, pro WhatsApp

**Agentes de IA que atendem, qualificam e vendem no WhatsApp — dentro de um CRM open source rodando no seu servidor.**
**Sem mensalidade, sem feature travada, seus dados com você. A alternativa aberta a Kommo, Octadesk e Intercom.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![Self-hosted](https://img.shields.io/badge/self--hosted-1%20comando-orange)](hostgator-setup-kit/)
[![CI](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml/badge.svg)](https://github.com/melgarafael/DeskcommCRM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**🧭 Visão**](VISION.md) · [**📘 Setup Guide**](docs/SETUP.md) · [**🏗️ Arquitetura**](ARCHITECTURE.md) · [**🤝 Contribuir**](CONTRIBUTING.md) · [**📋 PRDs**](docs/prd/) · [**🗺️ Roadmap**](#%EF%B8%8F-roadmap)

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
>
> **Ainda não tem servidor?** Rode isto **no seu computador** (macOS, Linux ou WSL). Ele diz
> qual plano contratar — com os números do runbook, não um "depende" — e te devolve o
> comando certo pro seu caso:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/hostgator-setup-kit/comecar.sh | bash
> ```
>
> *(prefere ler antes de executar? clone o repo e rode `bash hostgator-setup-kit/comecar.sh` —
> ele não instala nada sem você confirmar.)*
>
> Já tem a VPS? Entre nela por SSH e rode:
>
> ```bash
> git clone https://github.com/melgarafael/DeskcommCRM.git
> cd DeskcommCRM
> bash hostgator-setup-kit/install.sh
> ```
>
> O instalador pergunta só o que é seu (domínio, chaves do Supabase, chave de IA, senha do
> admin), valida cada resposta antes de seguir, gera todos os outros segredos sozinho, aplica
> o schema do banco e sobe a stack inteira com HTTPS. Detalhes em
> [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md).
>
> ⚠️ O **Quickstart** abaixo é o caminho de *desenvolvimento* (rodar o app na sua máquina).
> Se você comprou a VPS pra rodar o CRM, use o comando acima, não o Quickstart.

## ✨ O que é

**Deskcomm** vem de **Desk** (mesa) + **comm** (comércio): **o comercial de mesa** — toda a operação de vendas do seu negócio numa mesa só, operada por pessoas e agentes de IA juntos.

O projeto nasceu como CRM de e-commerce e a comunidade o levou muito além: hoje roda em **clínicas, imobiliárias, infoprodutos, agências, lojas e prestadores de serviço** — qualquer negócio que vende pelo WhatsApp. O produto acompanhou essa virada e virou um **sistema operacional de vendas**: agentes de IA com RAG por tenant atendem, qualificam, movem leads no funil, disparam automações e sabem a hora de passar pra um humano — com o CRM inteiro exposto via **MCP** pros agentes operarem de verdade. A história completa está em [`VISION.md`](VISION.md).

### Diferenciais

- 🤖 **Agentes de IA que operam o CRM** — RAG por tenant, análise de sentimento, handoff IA→humano auditado, IA como assignee de primeira classe e controle de budget por organização. Não é chatbot decorativo: o agente atende, qualifica e move o funil.
- 🔁 **Agentes que se auto-aprimoram** — conversas resolvidas viram conhecimento novo na base RAG; handoffs marcam onde o agente ainda não alcança; métricas fecham o loop. Cada mês de operação torna o agente melhor, com gate humano no que importa.
- 🧩 **Multi-nicho por design** — vocabulário configurável por pipeline: lead vira *Cliente*, *Paciente* ou *Comprador*; won vira *Pago*, *Agendado* ou *Fechado*. O mesmo core serve e-commerce (nosso berço, com integração Nuvemshop), clínica, imobiliária ou infoproduto.
- 🔌 **MCP-ready** — MCP server interno pros agentes; contrato público pra agentes externos em construção. O CRM como infraestrutura pra qualquer agente de IA.
- 💬 **WhatsApp-native via WAHA** — multi-número, anti-banimento (throttle + jitter + janela de horário), mídia via Storage, STOP detection.
- 👥 **Governança de atendimento** — RBAC server-side de verdade, atribuição/transferência auditada, fila com posição, roteamento automático e escopo de visualização por papel.
- 🏢 **Multi-tenant + LGPD by-design** — RLS em toda tabela tenant-aware com teste de isolamento como gate de CI; anonimização preferida sobre delete; audit append-only com retenção 5 anos.
- 🖥️ **Self-hosted de verdade** — seus dados na sua VPS; instalação com 1 comando; sem versão paga, sem feature travada.

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

# 2. Node 22 + pnpm
nvm use                    # ou instale Node 22+
npm install -g pnpm
pnpm install

# 3. Env vars
cp .env.example .env.local
# Edite .env.local — guia completo em docs/SETUP.md

# 4. WAHA local (opcional em dev sem WhatsApp)
docker compose up -d

# 5. Schema do banco — aplique o baseline, NÃO as migrations
#    As migrations 0001-0009 e 0013 são stubs `SELECT 1;`: a cadeia não sobe do
#    zero. O schema real vive no baseline.sql, que é o mesmo que o install.sh
#    aplica na VPS. `supabase db push` "passa" e deixa o banco vazio.
supabase link --project-ref <seu-ref>
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

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
| **Observability** | Sentry (scrub em erro, transação, span e breadcrumb) | Telemetria opt-in no install |
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
pnpm test:unit     # Vitest (NÃO inclui tests/invariants/**)
pnpm test:db       # Postgres efêmero + baseline install/update + invariantes
pnpm test:e2e      # Playwright (requer dev server)
```

O job **`verify`** roda `typecheck`, `lint`, `lint:channels`, `test:unit` e `test:shell` em todo PR. Um segundo job — **`invariants`** — sobe um Postgres limpo, aplica o `supabase/baseline.sql` em modo install (`ON_ERROR_STOP=1`) e depois em modo update (provando idempotência), e roda **364 testes de invariante** distribuídos em 56 arquivos, cobrindo RBAC, atribuição, escopo de visualização, roteamento, follow-up, webhooks e automações.

Entre eles está o **teste de isolamento RLS**: cria 2 organizações, simula os claims JWT pelo mesmo caminho `auth.uid()` / `fn_user_org_ids()` que as policies de produção usam, e prova que um usuário da org A enxerga **zero linhas** da org B em `conversations`, `messages`, `contacts` e `crm_leads`. Antes disso, um caso de controle prova que as linhas da org B realmente existem no banco — sem ele, o teste passaria mesmo com a tabela vazia.

---

## 📚 Documentação

| Doc | O que tem |
|---|---|
| [`VISION.md`](VISION.md) | **Visão e posicionamento** — o que o projeto é, no que acredita e pra onde vai |
| [`docs/SETUP.md`](docs/SETUP.md) | **Setup completo passo a passo** de todas as integrações |
| [`docs/white-label.md`](docs/white-label.md) | **Instalar para clientes** — trocar a marca, uma instalação por cliente vs compartilhada, operação de revenda |
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
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
pnpm test:db   # precisa de Docker — é o job `invariants`, obrigatório no merge
git commit -m "feat(escopo): descrição"
# abre PR — o template já traz o checklist de Definition of Done
```

Essa linha é a lista **completa** dos gates obrigatórios, de propósito: rodar só metade e descobrir o
resto como surpresa vermelha depois de horas de espera é a pior primeira experiência que este
repositório sabe entregar.

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
- **CRM & pedidos** — kanban com vocabulário configurável por nicho (fractional indexing), customer 360, contatos, tags, integração Nuvemshop pra e-commerce.
- **IA nativa** — agentes com RAG por tenant (pgvector), análise de sentimento, handoff IA→humano, controle de budget por org, MCP server interno.
- **LGPD** — export e redact via workers, anonimização em cascata, consentimento auditado.
- **Self-host** — `hostgator-setup-kit` (app + WAHA + banco com 1 comando), `baseline.sql` auto-curativo, runbook de produção.
- **Webhooks & automação** — fontes de captação + regras QUANDO/SE/ENTÃO + gatilhos pra sistemas externos.
- **Governança de atendimento** — RBAC server-side em toda a API, atribuição e transferência auditadas (IA como assignee de 1ª classe), visualização por papel (RLS) + métricas por atendente, roteamento automático com fila e painel de gestão, e contrato de governança pra agentes de IA externos ([`docs/specs/14`](docs/specs/14-contrato-governanca-agentes-externos.md)). Épico guiado por 100+ invariantes (G1–G6).
- **Operação visível** — telas pro operador entender o agente: motivo da retenção anti-ban traduzido na conversa, central de avisos com severidade, controle de proteção de envio (janela/ritmo/teto) e propostas do flywheel aplicáveis como versão nova (com gate humano).

### 🔮 Próximo

- **MCP público** — capabilities do CRM expostas pro ecossistema de agentes: plugue o agente que quiser e ele opera o Deskcomm.
- **Flywheel de auto-aprimoramento** — o loop conversa resolvida → conhecimento → agente melhor, medido e com gate humano.
- **Templates por nicho** — pipelines e vocabulários prontos pra clínica, imobiliária, infoproduto e serviços (e-commerce já entregue).
- **Integrações** — VTEX e Shopify via adapter pattern (Nuvemshop já entregue).
- **Identity probabilística** — unificação de contatos entre canais.

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
  mantenedores do projeto **não são** controladores nem operadores da sua instância, e não
  têm acesso ao seu banco, ao seu WhatsApp nem ao seu storage. A única coisa que pode sair
  da sua máquina para nós é o relatório de erro descrito abaixo — e só se você deixar.
- **Telemetria (Sentry):** o `install.sh` **pergunta** durante a instalação e respeita a
  sua resposta; em modo não-interativo, sem `SENTRY_DSN` definido, a telemetria fica
  **desligada**. Se você aceitar o Sentry da comunidade, o que é enviado são **relatórios
  de erro** (stack trace) com CPF, telefone e e-mail substituídos, cabeçalhos sensíveis
  removidos, e token de webhook/convite redigido da URL — **sem** rastreamento de
  performance e **sem** replay de sessão, que ficam em 0 nesse caminho. Para desligar a
  qualquer momento: `SENTRY_DSN=off` no `.env`. Para mandar ao **seu** Sentry (aí sim com
  performance e replay): `SENTRY_DSN=<seu-dsn>`. O que é redigido, e por quê, está em
  [`lib/sentry/scrub.ts`](lib/sentry/scrub.ts); a resolução do DSN em
  [`lib/sentry/dsn.ts`](lib/sentry/dsn.ts).

---

## 🙏 Agradecimentos

- **WAHA** ([devlikeapro](https://waha.devlikeapro.com/)) — engine WhatsApp.
- **Supabase** — Postgres + Auth + Storage + Realtime numa stack só.
- **Vercel** — hosting + AI Gateway.
- **Anthropic** (Claude) — IA conversacional.
- **shadcn/ui** — base de componentes.
- A comunidade que nos levou do e-commerce pra clínicas, imobiliárias, infoprodutos e além — vocês definiram o que este projeto é.

---

<div align="center">

**Built with ☕ in Brasil** · **Made for the community**

Siga o desenvolvimento: [Instagram](https://www.instagram.com/melgarafael) · [YouTube](https://www.youtube.com/@melgarafael)

</div>
