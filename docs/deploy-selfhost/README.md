# DeskcommCRM self-hosted — instalação em VPS (com agente de IA)

> CRM operacional para e-commerce com agente SDR de IA integrado (WhatsApp via
> WAHA). Este guia sobe TUDO numa VPS com `docker compose`: app web, worker do
> agente, WAHA e proxy com HTTPS automático. Tempo estimado: ~30 min.

## O que você precisa antes

| Item | Onde conseguir |
|---|---|
| VPS Linux (2 vCPU / 4 GB+) com Docker | qualquer provedor |
| Um domínio apontando para a VPS (registro A) | seu DNS |
| Projeto **Supabase** (o plano free serve) | supabase.com — é o Postgres+Auth+Storage do CRM |
| Chave **Anthropic** (ou cadastre BYOK depois na tela) | console.anthropic.com |
| Um número de WhatsApp para o agente | qualquer chip/celular |

> **Por que Supabase e não um Postgres no compose?** O CRM usa Auth, Storage e
> RLS do Supabase nativamente. O caminho suportado é um projeto Supabase (cloud,
> free tier) — simples e com backup gerenciado. Supabase self-hosted também
> funciona, mas não é coberto por este guia.

## 1. Clonar e configurar

```bash
git clone https://github.com/deskcommcrm/deskcommcrm.git && cd deskcommcrm
cp .env.hostgator.example .env   # o template de produção (o .env.example é o de dev)
```

Edite o `.env` e preencha (mínimo):

- **Supabase** (Settings → API do seu projeto): `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Banco direto** (Settings → Database → connection string): `SUPABASE_DB_URL`
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
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql
```

O `baseline.sql` é idempotente — cria o CRM inteiro + as tabelas do agente
(migrations 0001→atual).

> **Usando Postgres próprio em vez de Supabase?** Aplique ANTES o
> `scripts/selfhost-prelude.sql` (roles/schemas/extensões que o dump supõe).
> Limite: auth/storage viram stubs — o login do app exige Supabase real; o
> worker/agente funcionam integralmente. Para ATUALIZAR uma instalação existente, rode o mesmo
comando de novo (sem a flag `ON_ERROR_STOP`): só o que falta é aplicado.

Crie também a role dedicada do worker (mais seguro que usar o superusuário):

```sql
create role agent_worker login password 'TROQUE-ESTA-SENHA' bypassrls;
grant usage on schema public to agent_worker;
grant select, insert, update, delete on all tables in schema public to agent_worker;
grant usage, select on all sequences in schema public to agent_worker;
grant execute on all functions in schema public to agent_worker;
```

E aponte `SUPABASE_DB_URL` do `.env` para ela.

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
  (restaure com `pg_restore --clean --no-owner -d "$SUPABASE_DB_URL" arquivo.dump`)
- **Flywheel** (auto-melhoria): o worker julga conversas reais a cada 6h
  (`FLYWHEEL_INTERVAL_MS`) e grava PROPOSTAS de melhoria de prompt em
  `flywheel_distiller_proposals`. Nada é aplicado sozinho: revise e cole o
  bullet no prompt do agente na tela, publicando uma versão nova.
- **Atualizar**: `git pull && docker compose -f docker-compose.prod.yml up -d --build`
  + re-rodar o `baseline.sql` (idempotente).

## Solução de problemas

| Sintoma | Causa provável | Conserto |
|---|---|---|
| Resposta do agente fica `queued` | espelho de sessão divergiu do WAHA | o watchdog reconcilia e reenvia sozinho em ≤2 min; veja `docker compose logs worker | grep watchdog` |
| Publish falha com `channel_session_offline` | sessão não está WORKING | reconecte o número em Conexões |
| Turno duplicado | dois consumidores de dispatch | garanta `AGENT_DISPATCH_CONSUMER=engine` (default) — o cron nativo vira no-op |
| Worker não sobe: "schema do harness ausente" | baseline não aplicado | rode o passo 2 |
