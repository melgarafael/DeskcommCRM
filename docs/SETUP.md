# Guia de Setup — DeskcommCRM

> **Pra quem é este doc?** Você acabou de clonar o repo, copiou `.env.example` pra `.env.local`, abriu o arquivo e bateu o desespero: "o que é cada uma dessas chaves e onde eu pego?". Este guia resolve isso. Sem pular etapas, sem assumir que você já configurou nada antes.
>
> **Tempo estimado:** 60–90 minutos pra preencher tudo do zero. Você pode fazer em partes — o app sobe com algumas chaves vazias (veja [Ordem recomendada](#ordem-recomendada)).
>
> **Custo:** R$ 0 pra rodar em dev. Todos os serviços listados têm free tier generoso. Marcamos com 💳 onde a plataforma pede cartão (mesmo no plano grátis) só pra validar identidade.

---

## Instalação local em Ubuntu/VM (PostgreSQL + serviços em Docker)

Em uma VM Ubuntu nova, execute o instalador uma única vez na raiz do clone:

```bash
chmod +x ubuntu-local-installer.sh
./ubuntu-local-installer.sh
```

O instalador sobe o Supabase local em Docker (PostgreSQL com `pgvector`, Auth,
PostgREST, Storage e Realtime), aplica `supabase/baseline.sql`, e inicia o app,
worker, scheduler, WAHA e Redis/SRH pelo `docker-compose.local.yml`. As chaves
ficam somente em `.env.local`, que não é versionado. O primeiro build pode levar
alguns minutos e precisa de espaço para as imagens do Supabase e do WAHA.

O instalador também cria o usuário inicial e escolhe uma porta livre para o app.
Não é necessário executá-lo novamente a cada reinício.

### Uso diário

Depois da instalação inicial, use:

```bash
pnpm local:up
pnpm local:status
pnpm local:logs          # ou: bash scripts/local-stack.sh logs worker
pnpm local:down
```

`pnpm local:up` verifica se o Supabase local está ativo e confere o `.env.local`.
Se o arquivo estiver ausente ou incompleto, ele gera automaticamente as URLs e
chaves locais do PostgreSQL/Supabase, WAHA, Redis/SRH e da aplicação. Se já
existir um `.env.local` de outro ambiente, ele é preservado como
`.env.local.cloud-backup` antes da geração local.

Para atualizar o código e aplicar a versão nova:

```bash
git pull --ff-only
pnpm local:up
```

Para aplicar uma alteração manual no `.env.local`, use também `pnpm local:up`,
pois a aplicação precisa ser recriada e recompilada para carregar as novas
variáveis. `docker compose restart` sozinho não atualiza o ambiente do
container.

O endereço e a porta são mostrados ao final do instalador. Se a porta 3000 já
estiver ocupada, ele escolhe a próxima porta livre. O painel local do Supabase
fica em `http://127.0.0.1:54323` e o WAHA em `http://127.0.0.1:3030`.

> A cadeia histórica de migrations contém dependências antigas e não é usada
> para uma instalação fresca. O helper inicia a infraestrutura sem aplicá-la e
> carrega o baseline versionado, que é o artefato de instalação do self-host.

## Índice

1. [Antes de começar](#antes-de-começar)
2. [Ordem recomendada](#ordem-recomendada)
3. [Supabase — banco + auth + storage](#1-supabase--banco--auth--storage)
4. [Upstash Redis — rate limit + idempotência](#2-upstash-redis--rate-limit--idempotência)
5. [WAHA — WhatsApp](#3-waha--whatsapp)
6. [Anthropic + Vercel AI Gateway — IA](#4-anthropic--vercel-ai-gateway--ia)
7. [OpenAI — embeddings do RAG](#5-openai--embeddings-do-rag)
8. [Sentry — monitoramento de erros](#6-sentry--monitoramento-de-erros)
9. [SMTP — email transacional](#7-smtp--email-transacional)
10. [Nuvemshop — integração e-commerce](#8-nuvemshop--integração-e-commerce)
11. [Chaves geradas localmente](#9-chaves-geradas-localmente--encryption--secrets)
12. [Verificação final](#verificação-final)
13. [Troubleshooting](#troubleshooting)
14. [Próximos passos](#próximos-passos)

---

## Antes de começar

**O que você precisa ter instalado:**

- **Node.js 22** — recomendamos via [nvm](https://github.com/nvm-sh/nvm). No repo, rode `nvm use` e ele puxa a versão certa. A suíte `pnpm test:db` exige Node 22+: os testes instanciam o cliente do Supabase, que precisa do `WebSocket` global (nativo só a partir do 22).
- **Docker Desktop** — pra rodar o WAHA local. [Download](https://www.docker.com/products/docker-desktop/).
- **pnpm** — `npm install -g pnpm` (gerenciador de pacotes que usamos).
- **Git** — você já tem se clonou o repo.
- **Conta de email principal** — vai usar pra criar contas em vários SaaS.
- **Cartão de crédito** 💳 — alguns serviços pedem só pra "comprovar identidade" mesmo no plano grátis (Supabase, Sentry). Se ficar dentro do free tier, **não cobram nada**.

**Como o `.env.local` funciona:**

- Fica na **raiz do projeto**: `/seu-caminho/DeskcommCRM/.env.local`.
- Cada linha é `NOME_DA_VARIAVEL=valor` — sem espaço antes/depois do `=`.
- Strings com caracteres especiais: envolva em aspas duplas (`"valor com espaço"`).
- Variáveis com `NEXT_PUBLIC_` no nome são **expostas no browser** — nunca coloque secret aí.
- O resto fica server-only.

**Regra de ouro:** nunca commite o `.env.local`. Já está no `.gitignore`, mas confira com `git status` antes de qualquer push.

---

## Ordem recomendada

Se você quer rodar o app o mais rápido possível com o mínimo viável:

**🟢 Mínimo pra `pnpm dev` subir sem erro fatal (~15 min):**

1. [Supabase](#1-supabase--banco--auth--storage) — sem isso nada funciona (auth + DB).
2. [Chaves geradas localmente](#9-chaves-geradas-localmente--encryption--secrets) — `INTERNAL_SECRET`, encryption keys.
3. [Upstash Redis](#2-upstash-redis--rate-limit--idempotência) — rate limit é gate de várias rotas.

**🟡 Pra testar features de IA (+10 min):** 4. [Anthropic](#4-anthropic--vercel-ai-gateway--ia) ou Vercel AI Gateway. 5. [OpenAI](#5-openai--embeddings-do-rag) — embeddings do RAG.

**🟡 Pra testar WhatsApp (+15 min):** 6. [WAHA](#3-waha--whatsapp) + ngrok (precisa URL pública).

**⚪ Pode ficar vazio em dev (degradam graciosamente):**

- [Sentry](#6-sentry--monitoramento-de-erros) — não monitora erros, mas app sobe.
- [SMTP](#7-smtp--email-transacional) — e-mails não saem, mas o app sobe com link de convite copiável.
- [Nuvemshop](#8-nuvemshop--integração-e-commerce) — UI mostra "Integração não configurada".

---

## 1. Supabase — banco + auth + storage

**O que é:** Backend-as-a-service. Aqui mora seu Postgres, autenticação, storage de mídia e realtime. Sem isso, nada funciona. **Free tier:** 500MB DB + 1GB storage + 50k MAU. Suficiente pra dev e protótipos.

### Passo a passo

1. Acesse <https://supabase.com> → **Start your project** → faça login com GitHub.
2. No dashboard, clique **New project**.
   - **Name:** `deskcomm-dev` (ou o que quiser).
   - **Database password:** clique no ícone de dado pra gerar. **Salve essa senha num gerenciador (1Password, Bitwarden)** — você vai precisar pra rodar migrations e nunca verá ela de novo no dashboard.
   - **Region:** `South America (São Paulo)` — latência mínima pro Brasil.
   - **Pricing plan:** Free.
3. Clique **Create new project**. Aguarde ~2 minutos enquanto provisiona.
4. Quando carregar, vá em **Project Settings** (engrenagem no menu lateral) → **API**.

### Onde pegar as 3 chaves

Na tela **Project Settings → API**:

| Campo no Supabase                                  | Variável no `.env.local`        | Detalhe                                                 |
| -------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| **Project URL** (ex: `https://abc123.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL`      | URL pública, pode ir pro browser                        |
| **Project API keys → `anon` `public`**             | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Chave pública. RLS protege os dados                     |
| **Project API keys → `service_role` `secret`**     | `SUPABASE_SERVICE_ROLE_KEY`     | **CRÍTICA**. Bypassa RLS. Nunca exponha. Nunca commite. |

> ⚠️ **Aviso de segurança:** a `service_role` é o equivalente a senha de root do banco. Se vazar, qualquer pessoa lê/escreve tudo. Em prod, configure rotação trimestral.

### Rodar as migrations

Depois de preencher as 3 variáveis acima:

```bash
# Instale o CLI do Supabase
brew install supabase/tap/supabase   # macOS
# Ou siga https://supabase.com/docs/guides/cli/getting-started pra Windows/Linux

# Login (abre o browser)
supabase login

# Conecte ao seu projeto (project-ref está na URL do dashboard)
supabase link --project-ref <seu-project-ref>

# Num projeto Supabase NOVO, habilite antes as extensões que o schema usa —
# sem elas o baseline para em `type public.vector does not exist`.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

# Aplica o SCHEMA — o baseline, não a cadeia de migrations.
# Re-aplicar é seguro e não erra: o arquivo é idempotente (issue #184).
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql
```

> ⚠️ **Não use `supabase db push` num banco novo.** As migrations `0001`–`0009` e `0013`
> são stubs `SELECT 1;` — o schema fundacional não está nelas, e a cadeia não sobe do
> zero. O `db push` **passa sem erro** e te deixa com um banco vazio, e você só descobre
> muito depois, num erro que não aponta pra cá. O `supabase/baseline.sql` é o schema real
> e é exatamente o que o `hostgator-setup-kit/install.sh` aplica na VPS.
>
> As migrations continuam sendo a fonte da verdade para quem **já tem** um banco e está
> atualizando — é o baseline que serve pra criar do zero.

Se não conseguir usar o CLI, abra **SQL Editor → New query** no dashboard e cole o conteúdo
de `supabase/baseline.sql`.

### Storage bucket

No menu lateral → **Storage** → **New bucket**:

- **Name:** `whatsapp-media`
- **Public bucket:** **NÃO** (deixe desmarcado — usamos URLs assinadas)

---

## 2. Upstash Redis — rate limit + idempotência

**O que é:** Redis serverless. Usado pra rate limit de API e cache de idempotency keys. **Free tier:** 10k commands/dia, 256MB. Mais que suficiente pra dev.

### Passo a passo

1. Acesse <https://upstash.com> → **Sign up** com GitHub.
2. No dashboard, clique **Create Database**.
   - **Name:** `deskcomm-dev`
   - **Type:** Regional (mais barato que Global pra dev)
   - **Region:** `sa-east-1` (São Paulo) — ou `us-east-1` se SP não estiver disponível no free tier.
   - **Eviction:** habilitado (default).
3. Clique **Create**.
4. Na tela do banco criado, role até a seção **REST API**. Você vai ver:

| Campo no Upstash                                             | Variável no `.env.local`   |
| ------------------------------------------------------------ | -------------------------- |
| **UPSTASH_REDIS_REST_URL** (botão de copy)                   | `UPSTASH_REDIS_REST_URL`   |
| **UPSTASH_REDIS_REST_TOKEN** (clique no olhinho pra revelar) | `UPSTASH_REDIS_REST_TOKEN` |

> 💡 O Upstash mostra os snippets prontos em vários formatos. Use a aba **`.env`** que ele já formata certo — é só colar.

---

## 3. WAHA — WhatsApp

**O que é:** Servidor que se conecta ao WhatsApp e expõe API HTTP. O default fixo é `devlikeapro/waha:latest-2026.7.2`, engine NOWEB. A prova local desta versão criou duas sessões CORE simultâneas até `SCAN_QR_CODE`; não houve pairing nem envio real. Versão/engine e pós-condição da operação determinam a compatibilidade; o tier sozinho não bloqueia um segundo número.

### Passo 1 — gerar a API key (plaintext + hash)

WAHA tem um esquema de auth particular: o **container** guarda o hash SHA512 da chave; a **app** envia o plaintext em cada request. Por isso você precisa dos dois.

```bash
# 1. Gere uma string aleatória forte (no terminal)
openssl rand -hex 32
# → cola algo tipo: 7a3f9b2c1d4e5f...
```

Esse é o **plaintext**. Copie. Agora gere o **hash SHA512 hex** dele:

```bash
# 2. Hash do plaintext
echo -n "7a3f9b2c1d4e5f..." | shasum -a 512 | awk '{print $1}'
# → cola algo tipo (longão, ~128 chars): 9f8e7d6c...
```

> ⚠️ **Erro #1 de quem clona o projeto:** confundir plaintext com hash. Memoriza:
>
> - O **container WAHA** recebe o **HASH** → vai em `WAHA_API_KEY_SHA512`.
> - O **app Next.js** envia o **PLAINTEXT** no header `X-Api-Key` → vai em `WAHA_API_KEY`.

### Passo 2 — gerar o HMAC secret pro webhook

WAHA assina cada webhook com HMAC SHA512. Geramos um segundo secret pra isso:

```bash
openssl rand -hex 32
# → cola em WAHA_HMAC_SECRET
```

### Passo 3 — preencher .env.local

```env
# Plaintext que a app Next envia no header X-Api-Key
WAHA_API_KEY=<plaintext-do-passo-1>

# Hash SHA512 do plaintext acima — usado pelo docker-compose pra configurar o container
WAHA_API_KEY_SHA512=<hash-do-passo-1>

# HMAC do webhook
WAHA_HMAC_SECRET=<plaintext-do-passo-2>

# WAHA roda em localhost:3030 (mapeamento do docker-compose, host:3030 → container:3000)
WAHA_API_BASE_URL=http://localhost:3030

# URL pública que o WAHA chama de volta — preenchido no Passo 4
WAHA_WEBHOOK_BASE_URL=
```

### Passo 4 — URL pública pra webhook (ngrok)

WAHA precisa chamar nossa app de volta quando chega mensagem. Localhost não serve — precisa de URL HTTPS pública.

```bash
# Instale ngrok
brew install ngrok

# Cadastre conta grátis em https://ngrok.com e pegue seu authtoken
ngrok config add-authtoken <seu-token>

# Em outro terminal, expõe a porta 3000 (onde o Next.js vai rodar)
ngrok http 3000
```

O ngrok mostra: `Forwarding https://abc-123-456.ngrok-free.app -> http://localhost:3000`.

Copie a URL `https://...` e cole em:

```env
WAHA_WEBHOOK_BASE_URL=https://abc-123-456.ngrok-free.app
```

> ⚠️ A URL do ngrok muda toda vez que você reinicia (no plano free). Pague $8/mês pelo subdomínio fixo se for trabalhar muito com WAHA, ou use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (gratuito com domínio próprio).

### Passo 5 — subir o WAHA

```bash
docker compose up -d
```

Confira em <http://localhost:3030/dashboard/> que o WAHA está respondendo (painel do WAHA). Pra criar sessão e escanear QR, veja a doc oficial: <https://waha.devlikeapro.com/docs/overview/quick-start/>.

---

## 4. Anthropic + Vercel AI Gateway — IA

**O que é:** O cérebro da IA conversacional (Claude). Usamos o **Vercel AI Gateway** preferencialmente (fallback automático entre provedores, observability, zero data retention) e o Anthropic direto como fallback. **Custo:** pay-per-use. Anthropic dá $5 de crédito grátis ao cadastrar.

### Opção A — Vercel AI Gateway (recomendado)

1. Acesse <https://vercel.com> → faça login.
2. No dashboard → **AI** (no menu lateral) → **Get started with AI Gateway**.
3. Clique **Create API Key** → nome `deskcomm-dev` → copie a chave.

```env
AI_GATEWAY_API_KEY=<chave-do-gateway>
AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1
VERCEL_AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1
```

> 💡 Com o Gateway, o código usa strings tipo `"anthropic/claude-sonnet-4-6"` — o Gateway resolve qual provedor chamar. Se Anthropic estiver fora, ele tenta o backup automaticamente.

### Opção B — Anthropic direto (fallback ou se preferir)

1. Acesse <https://console.anthropic.com> → **Sign Up**. 💳
2. Adicione método de pagamento (eles dão $5 de crédito grátis).
3. **Settings → API Keys → Create Key** → nome `deskcomm-dev` → copie.

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

> ⚠️ Se as duas chaves estiverem vazias, o worker `ai-response-worker` pula com `skip="ai_gateway_key_missing"` — o app sobe normal, só não responde com IA. Em dev tá ok. Em prod, configure pelo menos uma das duas.

---

## 5. OpenAI — embeddings do RAG

**O que é:** Usado **só** pra gerar embeddings (vetores) das bases de conhecimento dos tenants pro chatbot RAG. Não usamos GPT pra gerar texto — esse trabalho é do Claude. **Custo:** baratíssimo. `text-embedding-3-small` = $0.02 / 1M tokens.

1. Acesse <https://platform.openai.com> → **Sign up**. 💳
2. Adicione método de pagamento (eles não dão mais crédito grátis em conta nova).
3. **API Keys → Create new secret key** → nome `deskcomm-dev-embeddings` → copie.

```env
OPENAI_API_KEY=sk-proj-...
```

---

## 6. Sentry — monitoramento de erros

**O que é:** Captura erros, stack traces e performance. Sem isso, você só sabe que o app quebrou quando o cliente reclama. **Free tier:** 5k erros/mês, 10k performance units/mês.

1. Acesse <https://sentry.io> → **Sign up** com GitHub. 💳
2. Crie um workspace (ou use o pessoal) → **Create Project**.
   - **Platform:** `Next.js`
   - **Alert frequency:** "Alert me on every new issue"
   - **Project name:** `deskcomm-dev`
3. Após criar, o Sentry mostra o **DSN** numa tela de quickstart. É uma URL tipo `https://abc123@o456.ingest.sentry.io/789`.
4. Se você fechou a tela: **Project Settings → Client Keys (DSN)** → copie o "DSN" público.

```env
SENTRY_DSN=https://abc123@o456.ingest.sentry.io/789
```

> 💡 O DSN é considerado "público o suficiente" — pode ir no client. Mas mantenha como server var por padrão (já está em `.env.local`).

---

## 7. SMTP — email transacional

Convites de equipe, entrega de export LGPD e alarmes usam o servidor SMTP da sua
empresa. A configuração preferida fica em **Configurações → E-mail e convites**
(`/app/settings/resend` por compatibilidade de URL); ela é criptografada no banco
da instalação. O mesmo transporte também pode ser provisionado no `.env`.

```env
SMTP_HOST=smtp.seudominio.com
SMTP_PORT=465
SMTP_SECURITY=tls
SMTP_USERNAME=suporte@seudominio.com
SMTP_PASSWORD=uma-senha-de-aplicativo
SMTP_FROM_EMAIL=suporte@seudominio.com
SMTP_FROM_NAME=Minha Empresa
```

Use **465 + `tls`** para SMTP com SSL/TLS implícito, ou **587 + `starttls`**
para STARTTLS. Em `SMTP_HOST`, informe somente o hostname — sem `smtp://` e sem
`:465`. O campo de remetente recebe apenas o e-mail, por exemplo
`suporte@seudominio.com`.

> ℹ️ Sem host ou remetente, o app continua funcionando: o convite mostra o link
> de aceite para copiar e o export LGPD fica em `pending_review`. Não há envio
> incompleto nem domínio padrão do produto.

---

## 8. Nuvemshop — integração e-commerce

**O que é:** Plataforma de e-commerce brasileira. Nossa integração OAuth importa pedidos, produtos, clientes pro CRM.

> ℹ️ **Pode pular em dev.** Se essas vars ficarem vazias, a UI mostra "Integração não configurada" e você toca o resto do app normal.

### Passo a passo

1. Acesse <https://partners.tiendanube.com/> → **Sign up** como parceiro (gratuito).
2. No dashboard de parceiro → **Apps → Create new app**.
   - **App name:** `DeskcommCRM Dev`.
   - **Redirect URI:** `https://<sua-url-ngrok>.ngrok-free.app/api/v1/integrations/nuvemshop/callback` (mesmo ngrok do WAHA, ou outro).
   - **Scopes:** marque tudo relacionado a `read_orders`, `read_customers`, `read_products`, `write_orders` (pra atualizar status).
3. Após criar, a tela do app mostra:

| Campo no portal                                           | Variável no `.env.local`       |
| --------------------------------------------------------- | ------------------------------ |
| **App ID** (na URL: `partners.tiendanube.com/apps/12345`) | `NUVEMSHOP_APP_ID` (= `12345`) |
| **Client ID**                                             | `NUVEMSHOP_CLIENT_ID`          |
| **Client Secret** (clique pra revelar)                    | `NUVEMSHOP_CLIENT_SECRET`      |

```env
NUVEMSHOP_APP_ID=12345
NUVEMSHOP_CLIENT_ID=...
NUVEMSHOP_CLIENT_SECRET=...
```

4. Configure também a URL pública do app:

```env
NEXT_PUBLIC_APP_URL=https://<sua-url-ngrok>.ngrok-free.app
```

A URL do callback OAuth precisa bater **exatamente** com a `Redirect URI` cadastrada no portal — incluindo `https`, sem barra final.

---

## 9. Chaves geradas localmente — encryption + secrets

Estas você **gera você mesmo** — não tem dashboard, não tem login. São strings aleatórias usadas pra criptografia interna e segredos da app.

```bash
# Rode 6x e cole cada saída numa variável diferente
openssl rand -hex 32
```

Distribua nas variáveis:

```env
# Bearer secret pros endpoints /api/v1/cron/* (DIFERENTE do service role key)
INTERNAL_SECRET=<saída-1>

# Criptografia de PII (LGPD)
CPF_ENCRYPTION_KEY=<saída-2>

# Criptografia de tokens OAuth Nuvemshop
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=<saída-3>

# Criptografia de credenciais BYO-WAHA (cliente que roda WAHA próprio)
WAHA_BYO_ENCRYPTION_KEY=<saída-4>

# HMAC do cookie de impersonate (super-admin) — mínimo 32 chars
IMPERSONATE_COOKIE_SECRET=<saída-5>

# Assinatura de URLs de export LGPD
LGPD_SIGNING_KEY=<saída-6>
```

> ⚠️ **NUNCA reutilize** a mesma string em produção. Cada uma criptografa uma coisa diferente — se vazar uma, queremos blast radius limitado.
>
> ⚠️ **NUNCA mude `CPF_ENCRYPTION_KEY` ou `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` depois que tiver dados em prod** — você não consegue mais descriptografar o que foi salvo. Rotação dessas chaves exige migration de re-encryption.

### Outras vars opcionais

```env
# DPO oficial (LGPD) — vai como reply-to em emails de data request
LGPD_DPO_EMAIL=dpo@seudominio.com

# Validade dos links de export LGPD (default 72h)
LGPD_EXPORT_EXPIRES_HOURS=72

# URLs canônicas (em dev geralmente localhost; em prod aponta pra domínio)
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_ADMIN_URL=http://localhost:3000

# Workers — ritmo com que o worker roda os handlers do event_log. Vazio = os
# defaults (2s com trabalho, 10s ocioso, 50 por lote). Não há mais opt-in: o
# `EVENT_LOG_WORKER_ENABLED` que ficava aqui nunca teve leitor e saiu em
# 2026-08-25, junto com a chegada do laço de verdade no worker.
EVENT_LOG_DRAIN_INTERVAL_MS=2000
EVENT_LOG_DRAIN_IDLE_INTERVAL_MS=10000
EVENT_LOG_DRAIN_BATCH_SIZE=50
```

---

## Verificação final

Depois de preencher tudo, valide:

```bash
# 1. Type-check (vai reclamar de env faltando)
pnpm typecheck

# 2. Sobe o app
pnpm dev

# 3. Em outro terminal, bate no health check
curl http://localhost:3000/api/v1/health
```

A resposta deve ser tipo:

```json
{
  "data": {
    "supabase": "ok",
    "redis": "ok",
    "waha": "ok"
  }
}
```

Se algum service vier `"degraded"` ou `"down"`, abra o terminal do `pnpm dev` e veja o erro — geralmente é variável faltando ou typo no valor.

---

## Troubleshooting

### `Variáveis de ambiente inválidas` no boot

O Zod (`lib/env.ts`) valida no startup. Olha a lista de erros que ele imprime — fala exatamente qual var está faltando ou com formato errado.

### `Error: supabaseUrl is required`

Você esqueceu de preencher `NEXT_PUBLIC_SUPABASE_URL` ou tem espaço/aspa errada. Confira se a linha é exatamente `NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co` (sem aspas, sem espaço antes do `=`).

### `Invalid JWT` ao chamar Supabase

A `anon key` ou `service role key` foi colada errada (cortou no meio). JWTs do Supabase são longos (~200 chars). Volte no dashboard e use o botão **Copy** em vez de selecionar manualmente.

### WAHA retorna 401 `Unauthorized`

Provável: você botou o **hash** em `WAHA_API_KEY` em vez do **plaintext**. Confira: a app envia o que tá no `.env.local` no header — o container WAHA é quem tem o hash (em `WAHA_API_KEY_SHA512`). Refaça o passo 1 do WAHA.

### Webhook do WAHA não chega

- O ngrok está rodando? (`ngrok http 3000`)
- A URL do ngrok atual está em `WAHA_WEBHOOK_BASE_URL`? (muda a cada restart no plano free).
- Você reiniciou o `pnpm dev` depois de mudar o `.env.local`? Variáveis de ambiente são lidas no boot.
- Confira logs do container: `docker logs deskcomm-waha`.

### Porta 3000 já em uso

Algum outro processo rodando. Mata com `lsof -ti:3000 | xargs kill -9` ou roda o Next em outra porta: `pnpm dev -- -p 3001` (e atualize `WAHA_WEBHOOK_BASE_URL` no ngrok pra apontar pra nova porta).

### SMTP não envia (mas o app sobe)

Confira em **Configurações → E-mail e convites** se o teste de conexão conclui e
se a combinação de porta e segurança está correta: **465 + TLS** ou **587 +
STARTTLS**. O host não deve conter `smtp://` ou a porta. Sem SMTP configurado,
convites continuam com link copiável e o restante do app segue disponível.

### Migrations não rodam

Confira se você está logado: `supabase login` — vai abrir o browser pra autorizar. Depois `supabase link --project-ref <ref>` de novo.

### Esqueci a senha do banco do Supabase

**Project Settings → Database → Reset database password**. Lembrando que isso invalida conexões existentes.

### Docker compose não sobe o WAHA

- Docker Desktop está rodando? Ícone na barra de menus.
- Em Mac M1/M2/M3, o `platform: linux/amd64` no docker-compose pode dar warning — é normal, só roda mais devagar via emulação. Funciona.

---

## Próximos passos

Com tudo verde no `/api/v1/health`:

1. Crie usuários de teste rodando `pnpm tsx scripts/seed-e2e-credentials.ts` — gera `.e2e-creds.json` com admin/manager/agent.
2. Leia [`README.md`](../README.md) pra fluxo de criar sessão WAHA + escanear QR.
3. Leia [`CLAUDE.md`](../CLAUDE.md) pra convenções do projeto.
4. Veja [`tasks/todo.md`](../tasks/todo.md) pra entender o backlog atual.

Bem-vindo ao DeskcommCRM. 🛠️

---

> **Achou um erro neste guia?** Abra uma [issue](https://github.com/melgarafael/DeskcommCRM/issues) ou mande um PR — esse doc vive da contribuição da comunidade.
