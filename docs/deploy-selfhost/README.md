# DeskcommCRM self-hosted — instalação em VPS (com agente de IA)

> Sistema operacional de vendas open source com agente SDR de IA integrado
> (WhatsApp via WAHA) — pra qualquer negócio que vende conversando.
> Este guia sobe TUDO numa VPS com `docker compose`: app web, worker do
> agente, WAHA e proxy com HTTPS automático. Tempo estimado: ~30 min.

## O que você precisa antes

| Item | Onde conseguir |
|---|---|
| VPS Linux (2 vCPU / 4 GB+) com Docker | qualquer provedor |
| Um domínio apontando para a VPS (registro A) | seu DNS |
| Projeto **Supabase** (o plano free serve; acompanhe a cota em Settings → Usage — ver [runbook de custo](../runbooks/custo-e-cota-do-supabase.md)) | supabase.com — é o Postgres+Auth+Storage do CRM |
| Chave **Anthropic** (ou cadastre BYOK depois na tela) | console.anthropic.com |
| Um número de WhatsApp para o agente | qualquer chip/celular |

> **Por que Supabase e não um Postgres no compose?** O CRM usa Auth, Storage e
> RLS do Supabase nativamente. O caminho suportado é um projeto Supabase (cloud,
> free tier) — simples e com backup gerenciado. Supabase self-hosted também
> funciona, mas não é coberto por este guia.

## 1. Clonar e configurar

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git && cd DeskcommCRM
cp .env.hostgator.example .env   # o template de produção (o .env.example é o de dev)
```

Edite o `.env` e preencha (mínimo):

- **Supabase** (Settings → API do seu projeto): `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Banco direto** (Settings → Database → connection string): `SUPABASE_DB_URL`
  > É a conexão do **app**. Quem mexe no **schema** — `create extension`, o
  > `baseline.sql`, a promoção do dono, o `pg_dump` do backup — pode ser outra:
  > `SUPABASE_DB_ADMIN_URL`. Ela é **opcional** e, vazia, tudo roda pela de cima
  > (é o caso da nuvem: a string do pooler já vem privilegiada). Preencha quando
  > o Postgres for **seu** e a de cima for uma role menor — ver §2.
- **Domínio**: `DOMAIN`, `NEXT_PUBLIC_APP_URL=https://SEU_DOMINIO`,
  `WAHA_WEBHOOK_BASE_URL=https://SEU_DOMINIO`
  > Rodando SEM TLS (ex.: `http://IP:PORTA`, sem o Caddy)? Basta o
  > `NEXT_PUBLIC_APP_URL` começar com `http://` — o cookie de sessão deixa de
  > ser `Secure` automaticamente e o login funciona. Com `https://`, `Secure`
  > sempre ligado.
  >
  > Em `http://` o app funciona 100%: as três Web APIs que somem fora de
  > secure context estão tratadas (cookie `Secure`, `crypto.randomUUID` e
  > `navigator.clipboard` — os botões de copiar usam fallback). Ainda assim,
  > HTTPS via Caddy é o recomendado de produção: fecha a família inteira de
  > restrições de contexto não-seguro de uma vez.
- **Segredos** (gere com `openssl rand -base64 32` cada): `INTERNAL_SECRET`,
  `INTERNAL_CRON_SECRET`, `CPF_ENCRYPTION_KEY`, `AI_CRED_AES_KEY`,
  `WAHA_BYO_ENCRYPTION_KEY`, `IMPERSONATE_COOKIE_SECRET`, `LGPD_SIGNING_KEY`, `SRH_TOKEN`
- **WAHA**: `WAHA_API_KEY` (invente uma), `WAHA_API_KEY_SHA512`
  (`echo -n "$WAHA_API_KEY" | shasum -a 512 | awk '{print $1}'`), `WAHA_HMAC_SECRET`
- **IA**: `ANTHROPIC_API_KEY` (ou deixe vazio e cadastre a chave depois em
  `/app/ai/credentials` — fica cifrada no banco)

## 2. Aplicar o schema no Supabase

```bash
# uma vez, do seu computador ou da VPS (precisa do psql):
# projeto Supabase NOVO: habilite antes as extensões que o schema usa
DDL="${SUPABASE_DB_ADMIN_URL:-$SUPABASE_DB_URL}"   # a do dono do banco, se houver
psql "$DDL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'
psql "$DDL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql
```

O `baseline.sql` é idempotente — cria o CRM inteiro + as tabelas do agente
(migrations 0001→atual). Para **atualizar** uma instalação existente, rode o mesmo
comando de novo, **com a mesma flag**: re-aplicar não erra.

Isso passou a ser verdade em 2026-08-13 (issue #184). Antes o arquivo era
idempotente só em parte — as tabelas tinham `IF NOT EXISTS`, índices, constraints e
policies não —, e re-aplicar com `ON_ERROR_STOP=1` parava em
`multiple primary keys for table "ai_agent_runs"`. Sem a flag saía "verde" com 301
erros dentro, e quatro deles faziam uma mudança de RLS **não chegar** ao clone.
O gate que prova isso é o job `invariants`, que agora re-aplica com a flag.

> **Usando Postgres próprio em vez de Supabase?** Aplique ANTES o
> `scripts/selfhost-prelude.sql` (roles/schemas/extensões que o dump supõe).
> Limite: auth/storage viram stubs — o login do app exige Supabase real; o
> worker/agente funcionam integralmente.

Crie também a role dedicada do worker (mais seguro que usar o superusuário):

```sql
create role agent_worker login password 'TROQUE-ESTA-SENHA' bypassrls;
grant usage on schema public to agent_worker;
grant select, insert, update, delete on all tables in schema public to agent_worker;
grant usage, select on all sequences in schema public to agent_worker;
grant execute on all functions in schema public to agent_worker;
```

Aponte `SUPABASE_DB_URL` do `.env` para ela — e deixe a conexão do **dono** em
`SUPABASE_DB_ADMIN_URL`. Antes isto era uma recomendação sem encaixe: o
`install.sh` e o `update.sh` usavam a MESMA string para o app e para o schema, e
quem seguia este parágrafo via o `baseline.sql` falhar por falta de permissão —
com a saída de editar o `.env` na mão entre uma etapa e outra (issue #192).

Para conferir quem é quem na sua instalação, sem acreditar neste texto:

```bash
# cada linha diz "chamada ao Postgres → com qual string"
grep -nE '(psql|pg_dump) "' hostgator-setup-kit/*.sh
```

`url_do_schema` (em `hostgator-setup-kit/_common.sh`) é a resolução: usa
`SUPABASE_DB_ADMIN_URL` e, ausente ou vazia, cai em `SUPABASE_DB_URL`.

Duas consequências que valem saber antes de escolher onde declarar:

- O `docker-compose.prod.yml` entrega o `.env` inteiro ao `app` e ao `worker`
  (`env_file: .env`). Declarar `SUPABASE_DB_ADMIN_URL` ali a expõe aos
  contêineres. Para não expor, passe-a só no comando:
  `SUPABASE_DB_ADMIN_URL='...' bash hostgator-setup-kit/install.sh`.
- Em compensação, o `update.sh` roda **sozinho** (cron do `agent.sh`) e é ele
  que entrega migration nova ao clone. Sem a chave no `.env`, cada atualização
  precisa da sua mão. Escolha consciente, não descuido.

O `install.sh` **nunca grava** `SUPABASE_DB_ADMIN_URL` no `.env` — se ela estiver
lá, foi você que pôs.

## 3. Subir

```bash
docker compose -f docker-compose.prod.yml up -d
```

> A imagem do app vem pronta do GHCR (`APP_IMAGE` no .env). Para buildar
> localmente (fork/sem registry): adicione `-f docker-compose.build.yml` e
> rode `... build` antes do `up` (precisa de ≥4 GB RAM; ~15-25 min).

Sobe: `caddy` (HTTPS automático via Let's Encrypt) → `app` (CRM) → `worker`
(agente 24/7) → `waha` (WhatsApp) → `redis`/`srh` → `scheduler` (crons).

Confira: `docker compose -f docker-compose.prod.yml ps` — tudo `healthy`.
O worker loga `agent-engine pronto` (`docker compose logs worker`).

## 3.5 E-mails de auth (criar conta e recuperar senha)

O app tem signup self-service (`/signup`) e recuperação de senha
(`/login/forgot`). Os dois dependem do e-mail transacional do Supabase Auth
chegando com link para `https://SEU_DOMINIO/auth/confirm`.

**O caminho automático (recomendado):** com um Personal Access Token exportado,

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...      # supabase.com/dashboard/account/tokens
bash hostgator-setup-kit/marca-emails.sh
```

Ele sobe assunto e corpo dos dois e-mails **com a marca da sua instalação**
(`APP_NAME` do `.env`), configura `Site URL` e `Redirect URLs`, e **relê o que
gravou** para provar que a API aceitou. O `install.sh` já o chama sozinho
quando o token está no ambiente. Sem o token, ele imprime o passo manual e sai
sem quebrar nada.

**O caminho manual:** no Dashboard →

1. **Authentication → Sign In / Up**: habilite *Allow new users to sign up* e
   mantenha *Confirm email* ligado.
2. **Authentication → URL Configuration**: `Site URL = https://SEU_DOMINIO` e
   adicione `https://SEU_DOMINIO/auth/confirm` em *Redirect URLs*.
3. **Authentication → Email Templates**: troque o link dos templates
   *Confirm signup* e *Reset password* para o fluxo server-side:

   ```html
   <!-- Confirm signup -->
   <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}">Confirmar e-mail</a>
   <!-- Reset password -->
   <a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}">Redefinir senha</a>
   ```

   ⚠️ **`&`, nunca `?`.** O app já manda `.RedirectTo` com o `?type=` embutido
   (`app/actions/auth/signUp.ts` e `requestPasswordReset.ts`), então um `?`
   aqui produz `...?type=signup?token_hash=...`: o navegador para de reconhecer
   `token_hash` como parâmetro (ele vira parte do valor de `type`) e
   `/auth/confirm` manda o usuário para `/login?error=link_invalido` — com o
   link correto. Esta seção ensinava a forma com `?` até 2026-08-14, e o
   projeto Supabase de produção estava com ela gravada: quem seguiu a receita
   reproduziu o defeito.

4. **SMTP próprio** (Authentication → SMTP): o sender embutido do Supabase tem
   limite baixo (~2 e-mails/h) — configure Resend/SES/etc. para produção.
   Isto é sobre VOLUME de envio: editar o corpo do e-mail **não** exige SMTP
   próprio (medido em 2026-08-14: `PATCH /v1/projects/{ref}/config/auth` com
   `mailer_templates_*` responde 200 e persiste num projeto com
   `smtp_host: null`).

**GoTrue self-hosted:** equivalente por env:
`GOTRUE_DISABLE_SIGNUP=false`, `GOTRUE_MAILER_AUTOCONFIRM=false`,
`GOTRUE_SITE_URL=https://SEU_DOMINIO`,
`GOTRUE_URI_ALLOW_LIST=https://SEU_DOMINIO/auth/confirm`,
`GOTRUE_SMTP_{HOST,PORT,USER,PASS}` e
`GOTRUE_MAILER_TEMPLATES_{CONFIRMATION,RECOVERY}` apontando para as **rotas do
próprio app**:

```bash
GOTRUE_MAILER_TEMPLATES_CONFIRMATION=https://SEU_DOMINIO/email-templates/confirmation
GOTRUE_MAILER_TEMPLATES_RECOVERY=https://SEU_DOMINIO/email-templates/recovery
GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Confirme seu e-mail · SUA MARCA"
GOTRUE_MAILER_SUBJECTS_RECOVERY="Redefinir sua senha · SUA MARCA"
```

O app serve o modelo já com a marca resolvida **do banco** — então trocar nome,
cor ou logo em **Configurações › Marca** chega ao e-mail sozinho, em até 10
minutos (`GOTRUE_MAILER_TEMPLATE_MAX_AGE`), sem reiniciar nada e sem rodar
script.

> ⚠️ **Tem de ser URL `http(s)`. Caminho de arquivo NÃO funciona — e falha
> calado.** O GoTrue cola o que não começa com `http` no fim do `SITE_URL` e faz
> um GET (`supabase/auth` v2.196.0,
> `internal/mailer/templatemailer/template.go:456`). Apontar para
> `/opt/.../confirmation.html` faz ele buscar
> `https://SEU_DOMINIO/opt/.../confirmation.html`, receber o HTML da tela de
> login e **mandar isso para a caixa de entrada do cliente**. Medido em
> 2026-09-09 numa instalação real: o Gmail marcou como phishing.
>
> Esta seção mandava exatamente isso até 2026-09-10. Se você seguiu a versão
> antiga, troque as duas variáveis pelas URLs acima.

`bash hostgator-setup-kit/marca-emails.sh --render-em <dir>` continua existindo
para **inspecionar** o HTML antes, ou para quem prefere servir os moldes por
conta própria — num caminho HTTP seu, nunca como caminho de arquivo.

## 4. Conectar o WhatsApp

1. Acesse `https://SEU_DOMINIO/app` e crie sua conta/organização.
2. Vá em **Conexões** → adicionar número → escaneie o QR com o WhatsApp do
   número do agente (Aparelhos conectados → Conectar aparelho).
3. O status vira **WORKING**. (Se travar em SCAN_QR_CODE, gere novo QR — o
   watchdog do worker mantém o status sincronizado sozinho.)

## 5. Criar o agente (tudo pela tela)

1. **Agentes IA → Novo agent**: nome, persona (system prompt), modelo,
   credencial, o número conectado, ferramentas (leitura de leads/pipelines
   etc.) e palavras-chave de handoff.
2. **Publicar**. A partir do próximo turno o agente responde com essa config.
   Editar cria versão nova; publicar troca por ponteiro; reverter é um clique.
3. Mande um WhatsApp de outro número para o número conectado — a resposta
   aparece no **Inbox** com o badge IA.

## 6. Operação

- **Backup diário** (do seu crontab na VPS):
  `0 3 * * * /caminho/repo/scripts/backup-db.sh /var/backups/deskcomm`
  (restaure com
  `pg_restore --clean --no-owner -d "${SUPABASE_DB_ADMIN_URL:-$SUPABASE_DB_URL}" arquivo.dump`
  — `--clean` derruba e recria objetos, o que é trabalho de dono do banco)
- **Flywheel** (auto-melhoria): o worker julga conversas reais a cada 6h
  (`FLYWHEEL_INTERVAL_MS`) e grava PROPOSTAS de melhoria de prompt em
  `flywheel_distiller_proposals`. Nada é aplicado sozinho: revise e cole o
  bullet no prompt do agente na tela, publicando uma versão nova.
- **Atualizar**: `bash hostgator-setup-kit/update.sh` — ele puxa a tag publicada,
  re-aplica o `baseline.sql` (idempotente), sobe e faz backup antes. Não use
  `up -d --build`: isso reconstrói na sua máquina em vez de puxar a imagem
  testada, e **numa VPS com proxy reverso próprio o `up -d` precisa dos dois
  arquivos de compose** — omitir `-f docker-compose.traefik.yml` recria o
  contêiner sem as labels de roteamento e o domínio inteiro passa a responder
  404, com o contêiner `healthy`.

## Solução de problemas

| Sintoma | Causa provável | Conserto |
|---|---|---|
| Resposta do agente fica `queued` | espelho de sessão divergiu do WAHA | o watchdog reconcilia e reenvia sozinho em ≤2 min; veja `docker compose logs worker | grep watchdog` |
| Publish falha com `channel_session_offline` | sessão não está WORKING | reconecte o número em Conexões |
| Turno duplicado | dois consumidores de dispatch | garanta `AGENT_DISPATCH_CONSUMER=engine` (default) — o cron nativo vira no-op |
| Worker não sobe: "schema do harness ausente" | baseline não aplicado | rode o passo 2 |
