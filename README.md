<div align="center">

[Português](README.md) · [English](README.en.md) · [Español](README.es.md)

<img src="docs/brand/escreve-ai-logo.png" alt="escreve.ai — conversas que viram relacionamento" width="520">

# escreve.ai — atendimento e vendas com agentes de IA

**Converse, conheça seus clientes e acompanhe cada oportunidade no mesmo CRM.**

Agentes de IA, WhatsApp, canais sociais e prospecção com dados do lead — com controle humano, permissões e histórico da operação.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%2BAuth%2BStorage-3ecf8e?logo=supabase)](https://supabase.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[**Site da ferramenta**](https://escreve.ai) · [**Acessar o CRM**](https://crm.escreve.ai) · [**O que é**](#-o-que-é) · [**Desenvolvimento**](#-desenvolvimento) · [**Documentação**](#-documentação) · [**Contribuir**](CONTRIBUTING.md)

</div>

---

## ✨ O que é

O **escreve.ai** reúne atendimento, qualificação e gestão comercial em uma operação compartilhada entre pessoas e agentes de IA. É uma edição mantida por SARAIVA, baseada no [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM), de Rafael Melgaço e colaboradores.

Este README mantém a estrutura do projeto original e apresenta as personalizações desta edição. Histórico, créditos e licença MIT foram preservados.

### O que esta edição acrescenta

- **Prospecção nativa:** pesquisa de empresas via Apify, enriquecimento e acompanhamento dos resultados dentro do CRM, sem depender do Airtable.
- **Abordagem gradual:** fila com cadência, limites, agente e critérios de qualificação configuráveis. As proteções do canal continuam valendo.
- **Contexto do lead no Inbox:** dados obtidos na prospecção junto da conversa para apoiar o atendimento.
- **Configuração conversacional de agentes:** criação assistida a partir do objetivo, oferta e contexto do negócio.
- **Canais sociais:** integração Zernio e identificação visual do canal nas conversas; disponibilidade depende da conta e das permissões do provedor.
- **Assistentes de voz:** configuração da integração ElevenLabs Agents, além das capacidades de voz existentes.
- **Conversas acessíveis:** painel flutuante de mensagens e pareamento de WhatsApp por código quando suportado pelo provedor.

Esses recursos dependem de credenciais, publicação do agente, conexão do canal e permissões. Ter o código da integração não significa que uma conta externa esteja conectada.

### Diferenciais

- 🤖 **Agentes de IA que operam o CRM** — RAG por tenant, skills que o agente executa sozinho durante o atendimento, memória da operação, análise de sentimento, handoff IA→humano auditado, IA como assignee de primeira classe e teto de gasto por organização. Não é chatbot decorativo: o agente atende, qualifica e move o funil.
- 🔁 **Nada morre no silêncio** — follow-up que retoma a conversa esfriada (com tempo adaptativo e gatilhos por etapa do funil), radar do que está em risco de morrer sem resposta, e central de avisos pro que precisa de decisão humana.
- 🧠 **Agentes que se auto-aprimoram** — conversas resolvidas viram conhecimento novo; a tela de **Evolução da IA** mostra se o agente está melhorando, onde erra e o que falta ensinar; **Propostas** são melhorias que a IA sugere pra si mesma, aplicáveis como versão nova — sempre com gate humano.
- 🧩 **Multi-nicho por design** — vocabulário configurável por pipeline: lead vira *Cliente*, *Paciente* ou *Comprador*; won vira *Pago*, *Agendado* ou *Fechado*. O mesmo core serve e-commerce (com integração Nuvemshop), clínica, imobiliária ou infoproduto.
- 💬 **WhatsApp de duas formas** — por **QR code** (WAHA, multi-número, com anti-banimento: throttle + jitter + janela de horário) ou pelo **canal oficial da Meta** (Cloud API, com templates aprovados e sincronizados). Mídia via Storage, STOP detection.
- 🔀 **Escolha sua IA** — OpenRouter, Anthropic ou OpenAI, decidido na instalação e trocável depois pela tela, **por parte do sistema** (o que conversa não precisa ser o que indexa).
- 👥 **Governança de atendimento** — RBAC server-side de verdade, atribuição/transferência auditada, fila com rodízio, roteamento automático por intenção e escopo de visualização por papel.
- 🏢 **Multi-tenant + LGPD by-design** — RLS em toda tabela tenant-aware com teste de isolamento como gate de CI; anonimização preferida sobre delete; audit append-only com retenção 5 anos.
- 🖥️ **Self-hosted de verdade** — seus dados na sua VPS; app, workers e banco sob controle da sua operação. Consulte as diferenças de distribuição desta edição antes de usar os instaladores herdados.

### 🔌 Webhooks & Automações

Todo tenant pode criar **fontes de captação**: um endereço público (`/api/v1/webhooks/in/<token>`) que recebe leads de landing pages, formulários próprios ou ferramentas como Zapier/n8n via POST (JSON ou `application/x-www-form-urlencoded`) e já entra direto no funil/estágio escolhido — sem código, sem integração customizada por tenant. Em cima dessas fontes (e dos outros eventos do CRM — lead mudou de etapa, ganhou tag, chegou mensagem no WhatsApp), o tenant monta **automações**: regras no formato QUANDO/SE/ENTÃO que disparam ações como adicionar tag, mover o lead no funil, atribuir a um atendente, mandar uma mensagem de WhatsApp ou avisar outro sistema via webhook de saída.

Na UI, tudo mora em **Webhooks** na sidebar (visível só pra quem tem papel `manager`/`admin`). A tela tem três abas: **Receber dados** (criar fonte, copiar o endereço/formulário pronto, disparar um lead de teste, ver os últimos recebimentos), **Automações** (montar a regra, que sempre nasce pausada até você revisar e ligar) e **Atividade** (timeline de cada execução, com o resultado de cada ação e reenvio manual quando uma chamada externa falha).

Por baixo, cada evento vira uma linha em `event_log` — nenhum trigger de banco faz chamada HTTP diretamente. Quem drena essa fila é a rota `/api/v1/cron/event-log-drain`, chamada a cada minuto. **O `install.sh`/`update.sh` já configuram esse cron sozinhos** — sem ele, as automações são criadas normalmente mas nunca rodam.

---

## 🖥️ O que você opera (as telas)

| Grupo | Telas |
|---|---|
| **Atendimento** | **Inbox** (conversas de WhatsApp, você e a IA lado a lado) · **Radar** (quem esfriou e ainda está aberto) · **Respostas rápidas** |
| **CRM** | **Prospecção** · **Kanban** (onde cada negócio está no funil) · **Contatos** · **Funis** (etapas, vocabulário do negócio e motivos de perda) |
| **Agente de IA** | **Agentes** · **Follow-ups** · **Roteadores** · **Provedores** e **Credenciais** · **Conhecimento** (RAG) · **Memória** · **Skills** · **Casos** · **Alertas** · **Propostas** · **Execuções** · **Uso e orçamento** |
| **Canais** | **Conexões** (WhatsApp, redes sociais e voz; QR, código ou canal oficial da Meta, com saúde, reconexão e templates) · **Nuvemshop** · **Webhooks** |
| **Análise** | **Desempenho** (funil e performance por atendente) · **Evolução da IA** · **Audit Log** |
| **Organização** | **Equipe** · **Distribuição de atendimento** · **Organização** · **LGPD** · **API Tokens** · **Segurança** (MFA, códigos de recuperação, sessões) · Perfil, Notificações, Billing |

A navegação agrupa as ferramentas por função; a visibilidade respeita as permissões de cada usuário.

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
| **WhatsApp** | WAHA Plus (engine NOWEB) + Meta Cloud API | QR pra começar rápido; canal oficial pra escala |
| **Filas** | `event_log` table + workers (cron) | Trigger de banco nunca faz HTTP |
| **Rate limit** | Upstash Redis (sliding window) | Serverless, free tier suficiente |
| **AI** | Vercel AI SDK v7 — OpenRouter, Anthropic, OpenAI e Google | Instalador pergunta qual; troca depois pela tela |
| **Validação** | Zod | Input externo, env, payloads |
| **Observability** | Sentry (scrub em erro, transação, span e breadcrumb) | Telemetria opt-in no install |
| **Hospedagem** | VPS com Docker (self-host) | App + WhatsApp + workers na sua máquina |

Detalhes: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 🚀 Acesso, instalação e atualização

**Instalação existente:** [crm.escreve.ai](https://crm.escreve.ai). O acesso depende de uma conta autorizada.

**Repositório:** [saraivabr/escreve.ai](https://github.com/saraivabr/escreve.ai), privado. A branch padrão é `versao-atual`; `integracao-oficial` reúne atualizações do projeto original no [PR #1](https://github.com/saraivabr/escreve.ai/pull/1), ainda em revisão.

### Hospedar sua própria instalação

O projeto contém Dockerfiles, Compose, baseline do banco e o kit de instalação herdado. Para preservar as personalizações, use o código e imagens construídos a partir desta edição. Os instaladores e imagens publicados pelo projeto original distribuem o DeskcommCRM oficial.

1. Clone a branch desejada deste repositório com uma conta autorizada.
2. Configure o ambiente conforme [SETUP](docs/SETUP.md), sem commitar segredos.
3. Prepare banco, Redis, canais e credenciais dos provedores utilizados.
4. Construa as imagens desta revisão e configure `APP_IMAGE`, `WORKER_IMAGE` e a imagem do scheduler no ambiente de destino.
5. Valide os serviços, o login, as permissões e os canais antes de liberar a instalação.

Ainda não há uma imagem pública ou um instalador de um comando próprio do escreve.ai anunciado. Não use `update.sh` sem conferir de qual repositório e imagem ele baixará a atualização.

### Atualizar com segurança

Escolha uma revisão validada, faça backup do banco e das sessões, prepare as imagens e confira a compatibilidade do schema. A integração oficial não deve ser publicada apenas por estar mergeável. As GitHub Actions deste repositório estão desativadas: push não significa CI aprovado nem deploy.

| Referência | Uso |
|---|---|
| [Identidade e operação](docs/escreve-ai.md) | Branches, remotes e diferenças desta distribuição |
| [Kit self-host](hostgator-setup-kit/README.md) | Scripts herdados de instalação, backup, restauração e diagnóstico |
| [Deploy](docs/runbooks/deploy.md) | Contratos e verificações de publicação |
| [Marca própria](docs/white-label.md) | Identidade da instalação e das organizações |

---

## 🧑‍💻 Desenvolvimento

Ambiente local para quem vai contribuir com o código.

```bash
git clone --branch versao-atual https://github.com/saraivabr/escreve.ai.git
cd escreve.ai

nvm use                     # Node 22
npm install -g pnpm && pnpm install

cp .env.example .env.local  # guia completo em docs/SETUP.md

docker compose up -d        # WAHA local (opcional em dev sem WhatsApp)

# Schema: aplique o baseline, NÃO as migrations.
# As migrations 0001-0009 e 0013 são stubs `SELECT 1;` — a cadeia não sobe do zero.
# O schema real vive no baseline.sql, o mesmo que o install.sh aplica na VPS.
# `supabase db push` "passa" e deixa o banco vazio.
supabase link --project-ref <seu-ref>

# Num projeto Supabase NOVO, habilite antes as extensões que o schema usa —
# sem elas o baseline para em `type public.vector does not exist`.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

pnpm dev
```

App: <http://localhost:3000> · Health check: <http://localhost:3000/api/v1/health>

[`docs/SETUP.md`](docs/SETUP.md) é o tutorial completo de **todas as integrações** (Supabase, WAHA, provedores de IA, Upstash, Sentry, Resend, Nuvemshop) — ~60–90 min do zero ao app rodando.

---

## 📁 Estrutura

```
escreve.ai/
├── app/                    # Next.js App Router
│   ├── admin/            # Rotas super-admin (impersonate, tenants)
│   ├── (public)/           # Login, recovery
│   ├── app/                # Rotas autenticadas: inbox, radar, kanban, contacts,
│   │                       #   connections, ai/*, integrations, metrics, lgpd,
│   │                       #   audit, team, settings
│   └── api/v1/             # API REST canônica
├── components/             # React (ui/, inbox/, kanban/, shell/, ...)
├── lib/                    # supabase/, waha/, channels/, ai/, agent-engine/,
│                           #   api/, routing/, navigation/, env.ts
├── workers/                # consumers de event_log (IA, RAG, LGPD, mídia, rotinas)
├── supabase/migrations/    # SQL versionado (+ baseline.sql pro self-host)
├── tests/{e2e,unit,invariants,shell}/
├── scripts/                # seeds, qa-waves, manutenção
├── docs/                   # PRDs, specs, runbooks, SETUP.md, ATUALIZANDO.md
└── hostgator-setup-kit/    # instalação e atualização self-host
```

---

## 🧪 Testes

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:db
pnpm test:e2e
pnpm build
```

Os testes de banco precisam de Docker/Postgres; os testes de interface precisam do ambiente de teste configurado. Consulte [CONTRIBUTING](CONTRIBUTING.md) para os checks relevantes a cada mudança. Isolamento de organizações, permissões e fluxos de atendimento precisam de validação quando afetados.

---

## 📚 Documentação

| Doc | O que tem |
|---|---|
| [`hostgator-setup-kit/README.md`](hostgator-setup-kit/README.md) | **Instalação self-host** — o kit, os scripts, as hospedagens com proxy próprio |
| [`docs/ATUALIZANDO.md`](docs/ATUALIZANDO.md) | **Como atualizar** sua instalação, em linguagem simples |
| [`VISION.md`](VISION.md) | **Visão e posicionamento** — o que o projeto é, no que acredita e pra onde vai |
| [`CHANGELOG.md`](CHANGELOG.md) | O que mudou em cada versão — **leia a seção da versão antes de atualizar** |
| [`docs/SETUP.md`](docs/SETUP.md) | Setup de desenvolvimento, passo a passo de todas as integrações |
| [`docs/white-label.md`](docs/white-label.md) | **Instalar para clientes** — trocar a marca, uma instalação por cliente vs compartilhada, revenda |
| [`docs/runbooks/waha-hostgator.md`](docs/runbooks/waha-hostgator.md) | Runbook de WAHA em produção (dimensionamento, recuperação) |
| [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md) | Deploy em produção |
| [`CLAUDE.md`](CLAUDE.md) | Convenções não-negociáveis (leitura obrigatória pra contribuir) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Visão de 1 página da arquitetura |
| [`docs/index.md`](docs/index.md) | Índice da documentação, com regra de precedência |
| [`docs/prd/`](docs/prd/) · [`docs/specs/`](docs/specs/) | PRDs e specs técnicas (schema SQL, payloads, MCP, governança) |

---

## 🤝 Contribuindo

1. Leia [CLAUDE.md](CLAUDE.md), [CONTRIBUTING.md](CONTRIBUTING.md) e o [Código de Conduta](CODE_OF_CONDUCT.md).
2. Crie uma branch a partir de `versao-atual`, preservando as alterações de outras pessoas.
3. Implemente, execute os checks pertinentes e abra um PR contra `versao-atual`.
4. Para atualizações do projeto original, trabalhe na integração e resolva os conflitos preservando as personalizações.

## 🐛 Bugs e segurança

Registre problemas funcionais nas [issues deste repositório](https://github.com/saraivabr/escreve.ai/issues). Remova dados pessoais e segredos de logs e exemplos. Para vulnerabilidades, siga a [política de segurança](SECURITY.md).

## 🗺️ Continuidade do projeto

A versão atual inclui as personalizações descritas acima. A integração com atualizações oficiais permanece em revisão e precisa concluir sua validação funcional. Consulte [estado atual](docs/current-state.md) e [PR de integração](https://github.com/saraivabr/escreve.ai/pull/1) para separar implementação, teste e publicação.

## 📜 Licença e agradecimentos

Baseado no **DeskcommCRM**, criado por **Rafael Melgaço e colaboradores**, sob [licença MIT](LICENSE). O código, a arquitetura e a documentação original formam a base desta edição; as personalizações escreve.ai são mantidas por SARAIVA.

Links históricos, changelogs e créditos do upstream permanecem atribuídos ao projeto original. Parcerias comerciais e compromissos de suporte do upstream não se transferem automaticamente para esta edição.
