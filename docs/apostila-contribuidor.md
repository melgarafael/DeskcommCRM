# Apostila do Contribuidor — DeskcommCRM

> **Do zero até o seu primeiro Pull Request**, passo a passo, sem pressupor que você já programou.
> Serve para duas leituras: **você**, que segue os capítulos em ordem, e **o seu assistente de IA**
> (Claude Code, Codex, Cursor, OpenCode, Antigravity), que pode ler este arquivo inteiro como
> contexto e executar os passos com você. O capítulo 12 traz os textos prontos para colar na IA.

**Quanto tempo leva:** de 1 a 2 horas na primeira vez (a maior parte é download). Depois disso,
abrir o ambiente para trabalhar leva 2 minutos.

**Quanto custa:** nada. Tudo roda no seu computador. Nenhum cartão de crédito é necessário.

**Uma regra antes de tudo:** se algum comando desta apostila divergir do que o repositório faz de
verdade, **vale o repositório**. Esta apostila aponta, em cada capítulo, o arquivo que é a fonte.
Preferimos ensinar o *comando que mede* a escrever um número que envelhece.

---

## Sumário

0. [O mapa: o que você vai montar](#0-o-mapa-o-que-você-vai-montar)
1. [O que baixar e instalar](#1-o-que-baixar-e-instalar)
2. [Pegar o código](#2-pegar-o-código)
3. [Subir o banco de dados local](#3-subir-o-banco-de-dados-local)
4. [Configurar o ambiente (`.env.local`)](#4-configurar-o-ambiente-envlocal)
5. [Criar o dono e abrir o sistema](#5-criar-o-dono-e-abrir-o-sistema)
6. [Peças opcionais: WhatsApp, IA, rotinas, e-mail](#6-peças-opcionais-whatsapp-ia-rotinas-e-e-mail)
7. [O dia a dia: ligar, desligar, atualizar](#7-o-dia-a-dia-ligar-desligar-atualizar)
8. [Desenvolver uma feature sem retrabalho](#8-desenvolver-uma-feature-sem-retrabalho)
9. [Testar: a escada de verificações](#9-testar-a-escada-de-verificações)
10. [Testar pela tela com Playwright](#10-testar-pela-tela-com-playwright)
11. [Abrir o Pull Request](#11-abrir-o-pull-request)
12. [Contribuir com a ajuda de uma IA](#12-contribuir-com-a-ajuda-de-uma-ia)
13. [Deu errado? Problemas comuns](#13-deu-errado-problemas-comuns)
14. [Glossário](#14-glossário)

---

## 0. O mapa: o que você vai montar

O DeskcommCRM é um CRM com agentes de IA que atendem pelo WhatsApp. Para mexer no código, você
vai montar no seu computador uma cópia pequena e completa do sistema:

```
   Seu navegador  ──►  App Next.js (pnpm dev)  ──►  Supabase local (Docker)
   localhost:3000      o código que você edita       banco Postgres + login + arquivos
                              │
                              └─► opcionais: WhatsApp (WAHA), Redis, provedor de IA
```

- **App Next.js** — a tela e a API. Roda direto no seu computador e recarrega sozinho quando
  você salva um arquivo.
- **Supabase local** — o banco de dados, o login e o armazenamento de arquivos. Roda dentro do
  Docker, que é um programa que liga "computadores de mentira" (contêineres) no seu.
- **Opcionais** — WhatsApp, Redis e IA só são necessários se a sua mudança mexe neles. Para a
  maioria das telas e regras, o sistema sobe sem eles.

### Dois caminhos — escolha o seu

| Você quer… | Caminho | Onde |
|---|---|---|
| **Desenvolver** (editar código, testar, abrir PR) — em Mac, Linux ou Windows | O desta apostila | Capítulos 1 a 11 |
| **Só ver o sistema rodando** numa máquina Ubuntu (ou VM), sem editar código | O instalador local | `./ubuntu-local-installer.sh` — ver [`SETUP.md`](SETUP.md), seção "Instalação local em Ubuntu/VM" |
| **Usar o CRM de verdade** numa VPS | O instalador da VPS | [`README.md`](../README.md), seção "Instalar na sua VPS" |

> O instalador Ubuntu roda o app **dentro** do Docker em modo produção: ótimo para olhar, ruim para
> desenvolver (cada mudança pede reconstruir a imagem). Ele também usa `apt-get` e `hostname -I`,
> que só existem no Linux. Por isso esta apostila segue o caminho do desenvolvedor, que funciona
> nos três sistemas.

---

## 1. O que baixar e instalar

### Windows: comece pelo WSL

Os scripts do projeto são escritos para o terminal do Linux (`bash`). No Windows, instale o
**WSL 2 com Ubuntu** e faça **tudo** desta apostila dentro dele:

1. Abra o PowerShell como administrador e rode `wsl --install -d Ubuntu`.
2. Reinicie o computador, abra o app "Ubuntu" e crie seu usuário.
3. Instale o **Docker Desktop** para Windows e, nas configurações dele, ligue
   *Resources › WSL integration* para a distribuição Ubuntu.
4. Daqui em diante, siga as instruções marcadas como **Linux** — dentro do terminal do Ubuntu.

Guarde o código **dentro** do Linux (ex.: `~/code/DeskcommCRM`), não em `/mnt/c/...`: o disco do
Windows visto pelo WSL é muitas vezes mais lento e quebra a recarga automática.

### A lista de ferramentas

| Ferramenta | Para quê | Mac | Linux / WSL |
|---|---|---|---|
| **Git** | Baixar o código e registrar mudanças | `xcode-select --install` | `sudo apt install -y git` |
| **Node.js 22** | Rodar o app e os scripts | via `nvm` (abaixo) | via `nvm` (abaixo) |
| **pnpm 9.15.9** | Instalar as dependências do projeto | `corepack` (abaixo) | `corepack` (abaixo) |
| **Docker** | Rodar o banco e os serviços | [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Docker Desktop (WSL) ou `curl -fsSL https://get.docker.com \| sudo sh` |
| **Supabase CLI** | Ligar o banco local | `brew install supabase/tap/supabase` | [instruções oficiais](https://supabase.com/docs/guides/local-development/cli/getting-started) |
| **psql** | Aplicar o esquema no banco | `brew install libpq && brew link --force libpq` | `sudo apt install -y postgresql-client` |
| **GitHub CLI** (`gh`) | Fork, PR e acompanhar o CI pelo terminal | `brew install gh` | [instruções oficiais](https://github.com/cli/cli#installation) |
| **Editor + assistente de IA** | Escrever o código | VS Code, Cursor, ou Claude Code no terminal | idem |

No Mac, se você não tem o Homebrew (`brew`), instale primeiro em <https://brew.sh>.

**Node 22 com `nvm`** (o arquivo `.nvmrc` do projeto diz a versão):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# feche e abra o terminal
nvm install 22
```

**pnpm na versão exata do projeto** (o campo `packageManager` do `package.json` diz qual):

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
```

### Confira tudo de uma vez

Cole no terminal. Cada linha deve responder com uma versão; nenhuma pode dizer
`command not found`:

```bash
git --version; node -v; pnpm -v; docker --version; docker ps >/dev/null && echo "docker OK"
supabase --version; psql --version; gh --version | head -1; openssl version
```

O que esperar: `node -v` começa com `v22`; `pnpm -v` é `9.15.9`; `docker OK` aparece (se não
aparecer, o Docker Desktop não está aberto). O `openssl` já vem no Mac e no Linux.

> **Memória do computador.** O banco local sozinho ocupa perto de 2 GB de RAM. Com o app, o navegador
> e o editor, conte com **8 GB no mínimo** e 16 GB para rodar os testes de tela com folga.

---

## 2. Pegar o código

### 2.1 Fork e clone

O código mora em <https://github.com/melgarafael/DeskcommCRM>. Você não escreve direto nele: cria
uma **cópia sua** (o *fork*), trabalha nela e propõe as mudanças de volta (o *Pull Request*).

```bash
gh auth login                                  # entra na sua conta do GitHub (uma vez só)
gh repo fork melgarafael/DeskcommCRM --clone   # cria o fork E baixa para o computador
cd DeskcommCRM
git remote -v                                  # origin = o seu fork; upstream = o projeto
```

Sem o `gh`: clique em **Fork** no site do GitHub, depois
`git clone https://github.com/<seu-usuario>/DeskcommCRM.git` e
`git remote add upstream https://github.com/melgarafael/DeskcommCRM.git`.

### 2.2 Assine os seus commits com o seu nome

Sem isto, o seu trabalho não aparece no seu perfil do GitHub:

```bash
git config --global user.name  "Seu Nome"
git config --global user.email "o-email-da-sua-conta@github.com"
```

### 2.3 Instale as dependências e arme as guardas

```bash
pnpm install
bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh
```

O segundo comando instala três guardas do git que evitam os erros mais caros: commit de
mudança no banco sem os três arquivos obrigatórios, push direto na `main` e commit assinado como
`root`. Elas avisam e bloqueiam só o que é irreversível.

### 2.4 Nunca trabalhe na `main` — crie um ramo

Cada mudança nasce num **ramo** (branch) novo, a partir da `main` **do projeto** (não do seu fork):

```bash
git fetch upstream
git switch -c fix/o-que-voce-conserta upstream/main
```

Nomes de ramo: `feat/...` para funcionalidade, `fix/...` para conserto, `docs/...` para
documentação, `chore/...` para manutenção.

> **Por que não do `main` do fork?** Se você também usa o seu fork para a sua própria instalação,
> o `main` dele carrega a sua marca e as suas configurações — e um PR aberto de lá proporia tudo
> isso ao produto inteiro, sem gerar conflito nenhum. Já aconteceu (PR #465).

---

## 3. Subir o banco de dados local

Fonte: o mesmo roteiro que o CI usa, em
[`receita-e2e-local.md`](../.agents/skills/deskcomm-contribuir/references/receita-e2e-local.md).

### 3.1 Por que não "rodar as migrations"

A pasta `supabase/migrations/` é o **histórico** de mudanças do banco. Ela não sobe sozinha num
banco vazio (algumas peças antigas dependiam do Supabase na nuvem). O esquema completo e atual vive
num único arquivo, **`supabase/baseline.sql`** — o mesmo que o instalador aplica na VPS de cada
cliente. Por isso a receita abaixo liga o Supabase **sem** as migrations e aplica o baseline.

### 3.2 A receita (com o Docker aberto, na pasta do projeto)

```bash
# 1. liga o Supabase sem a pasta de migrations (ela é devolvida no passo 5)
mv supabase/migrations /tmp/migrations-off && mkdir -p supabase/migrations
supabase start

# 2. extensões que o esquema usa (sem elas: "type public.vector does not exist")
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL

# 3. o esquema inteiro
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -q -f supabase/baseline.sql

# 4. o tempo real precisa reiniciar para enxergar as tabelas que acabaram de nascer
docker restart $(docker ps -q --filter name=supabase_realtime)

# 5. devolve a pasta de migrations (alguns testes precisam dela)
mv /tmp/migrations-off/* supabase/migrations/ && rmdir /tmp/migrations-off
```

A primeira vez demora: o `supabase start` baixa as imagens (alguns GB). Ao terminar, ele imprime
endereços e chaves. Os que você vai usar:

| O quê | Endereço |
|---|---|
| API do Supabase | `http://127.0.0.1:54321` |
| Banco Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| **Studio** (painel para ver as tabelas) | <http://127.0.0.1:54323> |
| **Mailpit** (caixa de e-mail falsa: convites, recuperação de senha) | <http://127.0.0.1:54324> |

> Não troque a versão do Postgres em `supabase/config.toml`: o baseline usa recursos que exigem a
> versão que está lá.

**Se o passo 1 falhar no meio**, a pasta de migrations pode ter ficado em `/tmp/migrations-off`.
Antes de qualquer coisa, devolva-a com o passo 5 e confira com `git status` que nada sumiu.

---

## 4. Configurar o ambiente (`.env.local`)

O app lê suas configurações de um arquivo chamado `.env.local`, na raiz do projeto. Ele **nunca**
vai para o GitHub (está no `.gitignore`), porque guarda chaves.

### 4.1 Gerar o arquivo a partir do banco que está de pé

Cole o bloco inteiro. Ele lê as chaves do Supabase local e gera as chaves de criptografia:

```bash
S="$(supabase status -o env)"
ler() { printf '%s\n' "$S" | grep "^$1=" | cut -d= -f2- | tr -d '"'; }
umask 077
cat > .env.local <<EOF
# --- Supabase local (lido de 'supabase status') ---
NEXT_PUBLIC_SUPABASE_URL=$(ler API_URL)
NEXT_PUBLIC_SUPABASE_ANON_KEY=$(ler ANON_KEY)
SUPABASE_SERVICE_ROLE_KEY=$(ler SERVICE_ROLE_KEY)
SUPABASE_DB_URL=$(ler DB_URL)

# --- Endereço do app ---
NEXT_PUBLIC_APP_URL=http://localhost:3000

# --- Chaves de criptografia (geradas agora, só suas) ---
INTERNAL_SECRET=$(openssl rand -hex 32)
INTERNAL_CRON_SECRET=$(openssl rand -hex 32)
IMPERSONATE_COOKIE_SECRET=$(openssl rand -base64 32)
CPF_ENCRYPTION_KEY=$(openssl rand -base64 32)
WAHA_BYO_ENCRYPTION_KEY=$(openssl rand -base64 32)
AI_CRED_AES_KEY=$(openssl rand -base64 32)
LGPD_SIGNING_KEY=$(openssl rand -hex 32)
EOF
grep -c '=' .env.local   # deve mostrar 12
```

Confira que as quatro primeiras linhas **não** ficaram vazias: `head -5 .env.local`. Se ficaram, o
Supabase não está de pé — volte ao capítulo 3.

> **Atenção à URL.** `NEXT_PUBLIC_SUPABASE_URL` precisa começar com `http://127.0.0.1` ou
> `http://localhost`. Se aparecer um endereço `supabase.co`, você está apontando para um banco na
> nuvem — pare e corrija. Testes rodando contra um banco real já escreveram dados de teste em
> produção neste projeto.

### 4.2 O que cada grupo significa

| Variável | Em palavras simples |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` | Onde o navegador acha o banco, e a chave pública dele |
| `SUPABASE_SERVICE_ROLE_KEY` | A chave-mestra do banco, que só o servidor usa. Nunca vai para o navegador |
| `SUPABASE_DB_URL` | Conexão direta com o Postgres, usada por scripts |
| `NEXT_PUBLIC_APP_URL` | O endereço em que o app responde |
| `*_SECRET`, `*_KEY` | Cadeados: protegem CPF, credenciais de IA e do WhatsApp, links de exportação LGPD e as rotinas internas |

**Só três variáveis são obrigatórias para o app abrir em desenvolvimento** (as do Supabase). As
demais o app exige apenas em produção — a regra está em `lib/env.ts`, nas funções `required` e
`requiredAlways`. Gerar os cadeados mesmo assim evita erro na hora em que você salvar uma chave
de IA ou um CPF.

A lista completa de variáveis, com explicação de cada uma, está em [`.env.example`](../.env.example)
e no guia [`SETUP.md`](SETUP.md).

### 4.3 Um segredo que mora no banco (só se for mexer em integrações)

Webhooks de captação, Nuvemshop e a credencial própria de WhatsApp usam uma chave guardada **no
banco**, não no `.env.local`. Sem ela, telas como "Gerar segredo" respondem
`encryption_unavailable`. O instalador da VPS sempre grava essa chave; aqui, grave uma vez:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -c \
  "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$(openssl rand -hex 32)')
   on conflict (name) do nothing;"
```

---

## 5. Criar o dono e abrir o sistema

O DeskcommCRM **não tem tela de cadastro aberta**: o primeiro usuário (o "dono") é criado por um
script, exatamente como o instalador faz numa VPS.

```bash
OWNER_EMAIL=voce@exemplo.com OWNER_PASSWORD='Uma-Senha-Forte-123' OWNER_ORG_NAME='Minha Loja Teste' \
  pnpm exec tsx scripts/bootstrap-owner.ts
```

Ele cria, sem duplicar se rodar de novo: o usuário, a organização, o vínculo de `admin` e a
permissão de super-administrador da plataforma.

Agora ligue o app:

```bash
pnpm dev
```

Abra <http://localhost:3000>, entre com o e-mail e a senha acima, e o **onboarding** do próprio
sistema conduz o resto (WhatsApp, IA, funil, equipe). Pode pular as etapas que dependem de peças
opcionais.

Para conferir a saúde do sistema: <http://localhost:3000/api/v1/health>. Sem WhatsApp e sem Redis
configurados, é normal ele apontar essas duas peças como indisponíveis.

**Pronto: você tem o DeskcommCRM rodando no seu computador.** O resto da apostila é sobre mexer
nele com segurança.

---

## 6. Peças opcionais: WhatsApp, IA, rotinas e e-mail

Ligue só o que a sua mudança precisa.

### Inteligência artificial

As chaves de IA **não** vão no `.env.local`: o dono as cadastra pela tela, em
**IA › Credenciais** (`/app/ai/credentials`), escolhendo o provedor (OpenRouter, Anthropic,
OpenAI, Google…). A chave fica cifrada no banco com o `AI_CRED_AES_KEY` que você gerou. Para
testar o agente conversando, você precisa de uma chave real de algum provedor.

### WhatsApp (WAHA)

O WhatsApp passa pelo WAHA, que roda em Docker. O passo a passo completo — gerar a chave, o hash
SHA-512, o segredo do webhook e um endereço público com `ngrok` — está em
[`SETUP.md`](SETUP.md), seção "3. WAHA — WhatsApp". Resumo: preencher `WAHA_API_KEY`,
`WAHA_API_KEY_SHA512`, `WAHA_HMAC_SECRET`, `WAHA_API_BASE_URL=http://localhost:3030` e
`WAHA_WEBHOOK_BASE_URL` no `.env.local`, e então subir só o WAHA:

```bash
docker compose --env-file .env.local up -d waha
```

O `--env-file` importa: sem ele, o Docker procura as chaves num arquivo `.env` e sobe o WAHA sem
senha. O endereço pelo qual o WAHA avisa o app sobre mensagens novas vem de `WAHA_HOOK_BASE_URL`
(veja o `docker-compose.yml`); com o app em `pnpm dev`, ele é `http://host.docker.internal:3000`.
O painel do WAHA fica em <http://localhost:3030/dashboard/>.

> Em Mac com chip Apple (M1 em diante), a imagem do WAHA roda emulada (`linux/amd64`): funciona,
> mas é mais lenta.

### Rotinas (crons) e o worker

Na VPS, um agendador chama as rotinas do sistema (drenar a fila de eventos, follow-ups,
prospecção). Com `pnpm dev`, ninguém as chama. Quando sua mudança depende delas, abra um segundo
terminal:

```bash
pnpm dev:crons   # chama as rotinas a cada 15 s (precisa do app no ar)
pnpm worker      # o processador de eventos e do agente de IA
```

### Redis

Sem `UPSTASH_REDIS_REST_URL` no `.env.local`, o limite de requisições usa um contador em memória —
perfeito para desenvolver. **Não** preencha essa variável apontando para um Redis que não está de
pé: alguns testes passam a esperar 15 s por ele e falham.

### E-mail

Os e-mails de login (convite, recuperação de senha) caem no **Mailpit**,
<http://127.0.0.1:54324>. Os e-mails do próprio CRM (via SMTP ou Resend) ficam desligados enquanto
as variáveis estiverem vazias — que é exatamente o estado de uma instalação nova, e bom de testar.

---

## 7. O dia a dia: ligar, desligar, atualizar

| Quero… | Comando |
|---|---|
| Ligar o banco | `supabase start` (o Docker precisa estar aberto) |
| Ligar o app | `pnpm dev` |
| Desligar o banco (os dados ficam) | `supabase stop` |
| Ver as tabelas | Studio: <http://127.0.0.1:54323> |
| Apagar tudo e começar do zero | `supabase stop --no-backup`, depois o capítulo 3 inteiro, o 4.3 (o segredo do banco foi junto) e o 5 |

Se um dia o `supabase start` reclamar de alguma migration, ligue com o bloco inteiro do
capítulo 3.2: ele é seguro de repetir.

### Trazer as novidades do projeto

O projeto muda todo dia. Antes de começar qualquer trabalho:

```bash
git fetch upstream
git merge upstream/main          # traz as novidades para o seu ramo, sem apagar nada seu
pnpm install                     # caso as dependências tenham mudado
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -q -f supabase/baseline.sql
```

A última linha aplica as mudanças de banco que chegaram. O baseline é **idempotente**: aplicar de
novo não duplica nem quebra nada — é exatamente o que o `update.sh` faz na VPS dos clientes.

**Nunca** use `git reset --hard` nem `git push --force` para "atualizar": esses comandos apagam
trabalho. Se o `merge` acusar conflito, pare e leia os dois lados (ou peça ajuda no PR).

---

## 8. Desenvolver uma feature sem retrabalho

### 8.1 Onde fica cada coisa

```
app/                 telas (App Router) e a API em app/api/v1/
  app/               telas de quem está logado: inbox, kanban, contatos, IA, configurações…
  api/v1/            a API REST
components/          componentes React (ui/, inbox/, kanban/…)
lib/                 regras de negócio: supabase/, ai/, channels/, routing/, i18n/, navigation/…
workers/             processadores da fila de eventos
supabase/            baseline.sql (o esquema) e migrations/ (o histórico)
tests/               unit/, e2e/ (Playwright), invariants/ (banco real), shell/
.changes/            os avisos de release (capítulo 11)
docs/                documentação — o mapa é docs/index.md
```

### 8.2 Antes de codar

1. **Escolha uma issue** em <https://github.com/melgarafael/DeskcommCRM/issues> (procure as
   etiquetas `good first issue` e `help wanted`) e comente **"pego esta"**. Um mantenedor atribui a
   você. Sem resposta em 48 h, comece e diga isso no PR.
2. **Leia a doutrina** do que vai tocar: [`CLAUDE.md`](../CLAUDE.md) é a lei do projeto;
   [`AGENTS.md`](../AGENTS.md) é a versão para qualquer IA; [`docs/current-state.md`](current-state.md)
   diz o que está pronto e o que está quebrado.
3. **Traga a `main`** (capítulo 7) para começar atualizado.

### 8.3 As regras que mais derrubam PR

Não é preciso decorar o `CLAUDE.md` inteiro no primeiro dia. Estas são as que mais custam:

| Regra | Em palavras simples |
|---|---|
| **Toda tabela de cliente tem `organization_id` e RLS** | Cada empresa só enxerga os próprios dados. Tabela nova sem isso vaza dado entre clientes |
| **Mudança de banco sai como "tripla"** | (1) arquivo novo em `supabase/migrations/`, (2) bloco idempotente no fim do `supabase/baseline.sql` e (3) uma linha `-- manifest: <o quê e por quê>` no cabeçalho do próprio `.sql`. Sem o baseline, a mudança nunca chega a quem já instalou |
| **Todo dado de fora passa pelo Zod** | Corpo de requisição, webhook, variável de ambiente: validados antes de usar |
| **A API responde com `ok()` / `fail()`** | Os formatos de sucesso e erro vivem em `lib/api/wrappers.ts` |
| **Texto de tela passa por `t("...")` e ganha espanhol** | O produto fala português e espanhol; frase nova sem tradução em `lib/i18n/dicionario.ts` reprova no CI. Não fala espanhol? Mande assim mesmo e avise no PR |
| **Tela nova tem porta** | Declare-a em `lib/navigation/registry.ts`, senão ninguém chega nela sem digitar a URL |
| **Nada de `console.log`** | Use `lib/logger.ts`. O lint só *avisa* — a revisão reprova |
| **Feature não cita fornecedor** | O código das funcionalidades não chama WAHA, Meta etc. pelo nome; passa pela camada de canais. Confira com `pnpm lint:channels` |
| **A marca não se troca no código** | Nome e logo da sua instalação vivem no banco e na tela Configurações › Marca |

Se a sua peça é algo vivo do sistema (lead, agente, follow-up, tela, worker), responda também o
**checklist do Sistema Vivo** em [`doctrine/sistema-vivo.md`](doctrine/sistema-vivo.md): toda
peça tem entrada, saída, registro, tela, porta e um jeito de não morrer calada.

### 8.4 O ciclo de trabalho

```
issue → "pego esta" → ramo novo → código → teste que fica vermelho sem o conserto
      → sabotagem (cap. 9.3) → verificações (cap. 9) → prova pela tela (cap. 10) → PR (cap. 11)
```

Commits seguem o padrão *conventional commits*, em português mesmo, no imperativo:
`fix(agenda): a consulta remarcada não some do dia`.

---

## 9. Testar: a escada de verificações

### 9.1 Os degraus

Rode de cima para baixo. Os primeiros são rápidos e pegam a maior parte dos problemas.

| Comando | O que confere | Precisa de Docker? | Quando rodar |
|---|---|---|---|
| `pnpm cercas` | As guardas estruturais: baseline, docs, workflows, espanhol, fragmentos de release — o que mais reprova PR | Não | Sempre |
| `pnpm typecheck` | Os tipos do TypeScript, inclusive nos testes | Não | Sempre |
| `pnpm lint` | Estilo e erros comuns | Não | Sempre |
| `pnpm lint:channels` | Nenhuma feature citando fornecedor | Não | Sempre |
| `pnpm test:unit` | Todos os testes unitários do repositório | Não | Sempre |
| `pnpm test:shell` | Os scripts de instalação e atualização da VPS | Não | Se tocou `hostgator-setup-kit/`, `Dockerfile*` ou `docker-compose*` |
| `pnpm test:db` | Postgres limpo + baseline instalado e reaplicado + as leis do banco (isolamento entre empresas) | **Sim** | Se tocou banco, RLS, permissões, roteamento, automações |
| `pnpm build` | O app compila em modo produção | Não | Antes do PR |
| Playwright | A jornada pela tela | **Sim** | Se tocou tela ou fluxo (capítulo 10) |

O CI roda tudo isso de novo no seu PR. Rodar antes só poupa a ida e volta.

### 9.2 Ler o resultado do `test:unit` sem se enganar

Duas armadilhas já custaram PRs aqui:

- **`pnpm test:unit` não é `vitest run tests/unit`.** O script roda o repositório inteiro, inclusive
  os testes que moram ao lado do código em `lib/`, `app/` e `components/`. Rodar só a pasta
  `tests/unit` dá um verde menor.
- **Não corte a saída com `tail`.** Guarde tudo num arquivo e leia o rodapé:

```bash
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests " /tmp/vt.log | tail -2        # o rodapé: esta é a resposta
grep -aE "^ *FAIL " /tmp/vt.log | sed 's/ > .*//' | sort | uniq -c   # quais arquivos falharam
```

Para rodar um arquivo só enquanto trabalha: `pnpm test:unit caminho/do/arquivo.test.ts`.

> **Vermelho que não é seu:** `lib/ai/dispatcher/rate-limit.test.ts` falha se o seu `.env.local`
> tiver `UPSTASH_REDIS_REST_URL` apontando para um Redis desligado. Tire a variável (capítulo 6).

### 9.3 A sabotagem: provar que o seu teste vigia

Um teste que continua verde quando o conserto sai não protege nada. Depois de **commitar**:

1. Desfaça só a linha do conserto (não o commit inteiro).
2. Preveja quantos testes vão falhar, e quais.
3. Rode e confira se bateu.
4. Restaure o conserto e confira que ele está lá de novo (`git diff` vazio, e o conserto presente).

Escreva no PR: *"sabotagem: 1 vermelho de 12, o previsto"*. **Commite antes de sabotar** — sabotar
trabalho não salvo já apagou consertos neste projeto mais de uma vez.

---

## 10. Testar pela tela com Playwright

O Playwright é um robô que abre um navegador de verdade, clica e lê a tela como uma pessoa faria.
Neste projeto, ele é a **prova de que a experiência funciona** — chamada de API (`curl`) prova o
servidor, não o que o usuário vê. Fonte da receita:
[`receita-e2e-local.md`](../.agents/skills/deskcomm-contribuir/references/receita-e2e-local.md) e,
acima dela, o próprio [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml).

### 10.1 Preparar (uma vez)

Os testes de tela rodam num **ambiente separado** do seu `.env.local`, para nunca escreverem no
banco errado. Faça numa cópia de trabalho própria (*worktree*), ao lado do projeto — não em `/tmp`,
que o sistema limpa sozinho:

```bash
git worktree add ../deskcomm-e2e HEAD && cd ../deskcomm-e2e
pnpm install                                         # node_modules de verdade, nunca um atalho
pnpm exec playwright install --with-deps chromium    # o navegador do robô
```

Com o Supabase local já ligado (capítulo 3):

```bash
pnpm e2e:env     # gera o .env.e2e apontando para o Supabase LOCAL (recusa qualquer outro)
pnpm e2e:build   # compila o app em modo produção, como na VPS
cp .env.e2e .env.local && pnpm exec tsx scripts/seed-e2e-credentials.ts   # cria os usuários de teste
```

Os usuários de teste têm e-mails `e2e-admin@deskcomm.test`, `e2e-manager@…`, `e2e-agent@…`,
`e2e-viewer@…` e `e2e-dono@…`. Algumas specs pedem dados extras; o cabeçalho de cada uma diz qual
`scripts/seed-e2e-*.ts` rodar. O CI sempre roda estes três:

```bash
pnpm exec tsx scripts/seed-e2e-escalacao.ts
pnpm exec tsx --env-file=.env.local scripts/seed-e2e-capacidades-ausentes.ts
pnpm exec tsx scripts/seed-e2e-followup-agent.ts
```

### 10.2 Rodar

```bash
pnpm exec playwright test tests/e2e/credenciais-de-ia.spec.ts --reporter=list   # uma spec
pnpm exec playwright test tests/e2e/credenciais-de-ia.spec.ts --headed          # vendo o navegador
pnpm exec playwright test --ui                                                  # painel interativo
pnpm exec playwright test tests/e2e/<spec>.spec.ts --trace on                   # grava o passo a passo
pnpm exec playwright show-trace test-results/<pasta>/trace.zip                  # assiste à gravação
```

O próprio Playwright liga o app (`next start`) na porta 3001; não é preciso deixar o `pnpm dev`
ligado. Rode **uma spec por vez** — a suíte inteira é tarefa do CI, que a divide em partes.

**Mudou código do app?** Rode `pnpm e2e:build` de novo antes: o teste usa o app compilado.

**Leia o rodapé, não os símbolos.** Um ✘ pode ser um teste marcado como "falha esperada". A
resposta é a linha final: `N passed`, `N failed`.

### 10.3 Escrever uma spec

Use como molde uma spec curta que já existe, por exemplo
[`tests/e2e/credenciais-de-ia.spec.ts`](../tests/e2e/credenciais-de-ia.spec.ts). O esqueleto:

```ts
/**
 * Jornada: <o que a pessoa faz> — e o defeito que esta spec impede de voltar.
 */
import { test, expect } from "./helpers/test";               // sempre daqui, nunca de @playwright/test
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();

test.describe("Nome da jornada", () => {
  test("[P0] o que a pessoa vê quando faz X", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/<tela>");

    const nome = `E2E ${Date.now()}`;                          // dado com nome único
    await page.getByRole("button", { name: /adicionar/i }).click();
    // … preencher, salvar …

    await expect(page.getByText(nome)).toBeVisible();         // confira o VALOR, não só a presença
    // … apagar pela própria tela o que a spec criou …

    await page.screenshot({ path: "evidence/<nome-da-spec>.png", fullPage: true });
  });
});
```

Regras do molde:

- **Confira o valor, não a presença.** "O botão existe" não prova nada; texto exato, contagem, e
  medidas de layout via `getBoundingClientRect` / `getComputedStyle` provam. Nada de "a olho".
- **Prefira papéis e textos** (`getByRole`, `getByText`) a seletores frágeis de CSS.
- **Limpe o que criou**, de preferência pela própria tela.
- **Evidência** (prints) em `evidence/` — essa pasta vai para o git.
- **Registre a jornada** em [`docs/testing/user-journey-map.md`](testing/user-journey-map.md), com a
  prioridade (`[P0]` é primeira impressão: login, onboarding, primeiro lead).
- **Coloque a spec no CI**: acrescente o nome numa das listas `SPECS_PARTE_N` do
  `.github/workflows/e2e.yml` — ou em `FORA_DO_CI`, com o motivo escrito, se ela depende de
  WhatsApp, e-mail ou loja reais. O teste `tests/unit/e2e-cobertura-completa.test.ts` reprova spec
  que não está em lugar nenhum.
- Rode `pnpm typecheck` depois: a spec também é TypeScript.

Para descobrir seletores sem adivinhar, o gravador do Playwright escreve código enquanto você
clica: `pnpm exec playwright codegen http://localhost:3000` (com o `pnpm dev` ligado).

### 10.4 Quando não dá

Sem Docker, sem memória ou sem tempo? Mande o que conseguiu provar (testes unitários + o que você
testou na mão, passo a passo, com o que viu) e escreva no PR *"prova de tela não medida: <motivo>"*.
A prova de tela fica com quem mantém o projeto — é o combinado público, não uma falha sua.

---

## 11. Abrir o Pull Request

### 11.1 O pré-voo

Antes de abrir, rode o script que mede o mesmo que a revisão vai medir:

```bash
bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh
```

Ele aponta: ramo atrasado em relação à `main`, arquivos que não são do produto (sua marca, seu
`.env`), segredo vazado no diff, `console.log` novo, migration sem a tripla, fragmento de release,
e se os seus commits estão assinados com o seu e-mail.

### 11.2 O aviso de release (`.changes/`)

Se a sua mudança é **percebida por quem opera uma VPS**, crie um arquivo `.changes/<nome-curto>.md`:

```markdown
---
impacto: capacidade_nova        # nada_mudou | capacidade_nova | exige_acao
secao: adicionado               # adicionado | alterado | corrigido
titulo: O que muda, na voz de quem usa
---
Um parágrafo do ponto de vista de quem opera. Crédito: @seu-usuario.
```

Confira o formato com `pnpm release:conferir`. **Nunca** escreva uma seção de versão
(`## [1.x.y]`) no `CHANGELOG.md`: o número da versão é calculado automaticamente no corte da release.
Se esquecer o fragmento, tudo bem — quem tria escreve, com o seu nome.

### 11.3 Enviar e abrir

```bash
git push -u origin fix/o-que-voce-conserta
gh pr create --repo melgarafael/DeskcommCRM --fill --web
```

O formulário do PR já traz o checklist. No texto, escreva:

- **O que muda para quem usa** (1 a 3 frases) e `Closes #<número da issue>`.
- **O que você mediu**: os comandos e o rodapé de cada um, a sabotagem, a prova de tela.
- **O que NÃO mediu** — e por quê. Este é o campo que mais ajuda quem revisa.

### 11.4 Depois de abrir — o que parece erro e não é

- **Os testes ficam parados "aguardando aprovação"** no seu primeiro PR: é regra do GitHub para quem
  nunca contribuiu. Um mantenedor libera; do segundo PR em diante roda sozinho.
- **Um mantenedor empurrou um commit no seu ramo**: com "Allow edits by maintainers" ligado, o
  projeto pode trazer a `main` ou fazer um ajuste mecânico, sempre como commit novo e avisando.
  Antes do seu próximo push, rode `git pull --no-rebase`.
- **Não feche o seu PR** achando que fez "ruído". PR de fork é exatamente o jeito certo de contribuir.

Acompanhe o CI com `gh pr checks --watch`.

---

## 12. Contribuir com a ajuda de uma IA

### 12.1 Os guias já estão no repositório

A pasta `.agents/skills/` traz **guias** que os assistentes carregam sozinhos ao abrir o projeto:

| Guia | Quando entra em ação |
|---|---|
| `deskcomm-contribuir` | Contribuir: régua do PR, pré-voo, sabotagem, prova de tela |
| `deskcomm-doutrina` | Escrever ou revisar código: as regras do `CLAUDE.md` |
| `sistema-vivo` | Criar uma peça nova do sistema (tela, worker, métrica…) |
| `deskcomm-instalar` | Instalar numa VPS |
| `deskcomm-prompt`, `deskcomm-metricas`, `deskcomm-cliente-novo`… | Operar e afinar uma instalação |

No Claude Code, chame pelo nome com `/deskcomm-contribuir`; no Codex, `$deskcomm-contribuir`; nos
demais, peça em português ("quero contribuir com o DeskcommCRM").

Os assistentes também leem sozinhos o [`CLAUDE.md`](../CLAUDE.md) (Claude Code) ou o
[`AGENTS.md`](../AGENTS.md) (os demais). Você não precisa colar a doutrina.

### 12.2 Textos prontos para colar

**Montar o ambiente comigo:**

> Leia `docs/apostila-contribuidor.md` e me conduza pelos capítulos 1 a 5, um passo de cada vez.
> Antes de cada comando, diga em uma frase o que ele faz. Depois de cada um, confira o resultado
> e só então siga. Se algo falhar, procure a causa no capítulo 13 antes de tentar outra coisa.

**Implementar uma issue:**

> Quero resolver a issue #<N> do DeskcommCRM. Carregue o guia `deskcomm-contribuir`. Antes de
> codar: leia a issue, o `CLAUDE.md` e o código que ela toca, e me mostre um plano curto com os
> arquivos que vão mudar e o teste que vai ficar vermelho sem o conserto. Só codifique depois que
> eu aprovar o plano.

**Escrever a prova pela tela:**

> Escreva uma spec Playwright em `tests/e2e/` para a jornada <descreva>, seguindo o capítulo 10.3
> da apostila e o molde de `tests/e2e/credenciais-de-ia.spec.ts`. Asserte valores, não presença.
> Registre a spec numa `SPECS_PARTE_N` do `e2e.yml` e a jornada no `user-journey-map.md`. Rode a
> spec e me mostre o rodapé.

**Revisar antes do PR:**

> Rode o pré-voo (`.agents/skills/deskcomm-contribuir/scripts/pre-voo.sh`) e a escada do
> capítulo 9 da apostila. Para cada item, mostre o comando e o rodapé da saída. Depois escreva o
> corpo do PR com as seções "o que muda", "o que medi" e "o que NÃO medi".

### 12.3 Bloco de contexto para a IA

Se o seu assistente não carrega os guias, cole este bloco no início da conversa:

```text
CONTEXTO — DeskcommCRM (contribuição)
- Repo: github.com/melgarafael/DeskcommCRM. Doutrina: CLAUDE.md (autoridade) e AGENTS.md. Mapa: docs/index.md.
- Stack: Next.js 16 App Router + React 19 + TypeScript estrito + Tailwind + shadcn/ui; Supabase (Postgres+RLS);
  Zod; Vitest; Playwright. Node 22, pnpm 9.15.9.
- Banco local: `supabase start` SEM supabase/migrations + `psql -f supabase/baseline.sql`. A cadeia de
  migrations não sobe do zero; nunca use `supabase db push`.
- Multi-tenant: toda tabela de cliente tem organization_id + RLS (tenant_isolation_<tabela>_all via
  fn_user_org_ids()). Service role exige filtro manual de organization_id, vindo de fonte confiável, nunca do body.
- Mudança de schema = tripla: migration nova em supabase/migrations/ (<timestamp>_<NNNN>_<slug>.sql, com
  `-- manifest:` no cabeçalho) + apêndice idempotente no fim do supabase/baseline.sql. Função nova em public:
  `revoke execute ... from public, anon`.
- API: /api/v1/, snake_case, respostas via ok()/fail() de lib/api/wrappers.ts; Zod em todo input externo;
  getUser() nunca getSession(); audit log em mutação; sem console.log (lib/logger.ts).
- Texto de tela: t("...") + linha em espanhol em lib/i18n/dicionario.ts. Tela nova: lib/navigation/registry.ts.
- Features não nomeiam fornecedor (pnpm lint:channels). Marca vive no banco, não no código.
- Verificações: pnpm cercas, typecheck, lint, lint:channels, test:unit (sem caminho; ler o rodapé),
  test:shell (kit/Docker), test:db (schema/RLS), build. Prova de UI = Playwright em ambiente fresco
  (.env.e2e local), spec registrada em SPECS_PARTE_N do .github/workflows/e2e.yml.
- Release: fragmento em .changes/<kebab>.md (impacto/secao/titulo); nunca editar versão no CHANGELOG.md.
- Git: ramo novo a partir de upstream/main; nunca reset --hard, push --force ou rebase de commit publicado.
- Antes de afirmar "funciona"/"passou": mostrar o comando e a saída. Declarar o que não foi medido.
```

### 12.4 Três cuidados com a IA

1. **Peça a evidência, não a frase.** "Passou" sem o rodapé do comando não é prova. Peça sempre o
   comando e a saída.
2. **Não deixe a IA apagar para "atualizar".** Se ela sugerir `reset --hard`, `push --force` ou
   apagar pastas para resolver um conflito, recuse e peça o caminho do capítulo 7.
3. **Mudança de banco sem a tripla não chega a ninguém.** Se a IA criou uma migration, confira que
   o `baseline.sql` também mudou no mesmo commit (a guarda do capítulo 2.3 avisa).

---

## 13. Deu errado? Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `docker: command not found` ou `Cannot connect to the Docker daemon` | Docker não instalado ou fechado | Abra o Docker Desktop e espere ele dizer "running" |
| `type public.vector does not exist` | Extensões não criadas antes do baseline | Rode o passo 2 do capítulo 3.2 e aplique o baseline de novo |
| O banco subiu, mas está **vazio** | Usou `supabase db push` ou deixou as migrations aplicarem | Use a receita do capítulo 3: o esquema vem do `baseline.sql` |
| `Variáveis de ambiente inválidas` ao ligar o app | `.env.local` faltando ou com as chaves do Supabase vazias | `head -5 .env.local`; se vazias, refaça o capítulo 4.1 com o Supabase ligado |
| `Error: supabaseUrl is required` | Idem | Idem |
| `Invalid JWT` | Chaves de outro Supabase (ex.: outro projeto local, ou um da nuvem) | Gere o `.env.local` de novo (capítulo 4.1) |
| Porta 3000 ocupada | Outro programa usando a porta | `pnpm dev --port 3005` e ajuste `NEXT_PUBLIC_APP_URL` |
| Supabase não liga: porta 54321/54322 ocupada | Outro projeto Supabase ligado no computador | `supabase stop --project-id <outro>` ou feche o outro projeto |
| Turbopack recusa `node_modules` "out of filesystem root" | `node_modules` é um atalho (symlink) | Rode `pnpm install` dentro daquela cópia |
| `encryption_unavailable` ao gerar segredo | Falta a chave guardada no banco | Capítulo 4.3 |
| `.env.e2e aponta para um Supabase que não é local` | A trava contra testar em produção funcionou | Ligue o Supabase local e rode `pnpm e2e:env` de novo |
| Testes de `rate-limit` demoram 15 s e falham | `UPSTASH_REDIS_REST_URL` apontando para Redis desligado | Tire a variável do `.env.local` |
| Teste de espanhol (`i18n-espanhol-cobre-a-tela`) falha | Frase de tela nova sem tradução | Acrescente a linha em `lib/i18n/dicionario.ts` |
| Spec nova reprova `e2e-cobertura-completa` | A spec não está no `e2e.yml` | Capítulo 10.3, item "Coloque a spec no CI" |
| `git push` recusado na `main` | A guarda do capítulo 2.3 funcionou | Crie um ramo (capítulo 2.4) |
| WAHA muito lento no Mac | Emulação `amd64` no chip Apple | Normal; use WhatsApp só quando a mudança precisar |

Não achou aqui? O guia [`SETUP.md`](SETUP.md) tem uma seção de *Troubleshooting* por integração.
Dúvidas abertas: [GitHub Discussions](https://github.com/melgarafael/DeskcommCRM/discussions).
Bug: [abra uma issue](https://github.com/melgarafael/DeskcommCRM/issues/new/choose).

---

## 14. Glossário

| Termo | O que é |
|---|---|
| **Baseline** | O arquivo `supabase/baseline.sql`, com o esquema inteiro do banco. É o que se aplica numa instalação nova e em cada atualização |
| **Branch / ramo** | Uma linha de trabalho separada no git. Cada mudança nasce no seu |
| **CI** | Os testes automáticos que o GitHub roda em todo PR |
| **Commit** | Um "salvamento" registrado no git, com mensagem |
| **Docker / contêiner** | Programa que roda serviços isolados no seu computador, como mini-computadores |
| **Fork** | A sua cópia do projeto no GitHub |
| **Idempotente** | Que pode ser aplicado várias vezes com o mesmo resultado, sem duplicar nem quebrar |
| **Migration** | Um arquivo que descreve uma mudança no banco. Fica no histórico em `supabase/migrations/` |
| **Multi-tenant / tenant** | Vários clientes (empresas) no mesmo sistema, cada um vendo só o que é seu |
| **Playwright** | O robô que testa pela tela, num navegador de verdade |
| **PR (Pull Request)** | O pedido para que a sua mudança entre no projeto |
| **RLS** | *Row Level Security*: a regra do Postgres que esconde as linhas de outra empresa |
| **Seed** | Script que cria dados de teste (usuários, organizações) |
| **Spec** | Um arquivo de teste do Playwright (`tests/e2e/*.spec.ts`) |
| **Supabase** | O conjunto banco + login + arquivos + tempo real que o sistema usa |
| **VPS** | Um servidor alugado, onde o cliente instala o DeskcommCRM |
| **WAHA** | O serviço que conecta o sistema ao WhatsApp |
| **Worktree** | Uma segunda pasta de trabalho do mesmo repositório, com outro ramo |
| **Zod** | A biblioteca que valida dados que chegam de fora |

---

*Esta apostila descreve comandos, não números, de propósito: números envelhecem, comandos medem.
Achou um passo que não funciona mais? Corrija aqui e abra um PR — é uma ótima primeira
contribuição.*
