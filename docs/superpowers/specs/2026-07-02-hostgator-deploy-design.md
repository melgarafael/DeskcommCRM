# Spec — SonghaiCRM como template self-hosted na HostGator

**Data:** 2026-07-02
**Autor:** Maestro (sessão Claude Code) + investigação multi-agente
**Status:** aguardando revisão do Rafael
**Objetivo:** transformar o SonghaiCRM num **template open-source auto-hospedável** cuja rota de deploy oficial é a infra da HostGator (via links de afiliado), com (1) adaptação técnica do projeto, (2) tutorial passo-a-passo para leigos e (3) um `.zip` "Setup Kit" que a pessoa joga no Claude Code dela e ele conduz a configuração.

---

## 1. Contexto e modelo de negócio

O software é **grátis**; para rodá-lo a pessoa contrata a **infra HostGator pelo link de afiliado**. Isso amarra a decisão técnica: o produto-âncora precisa gerar comissão **e** rodar a stack. Como o app é Next.js 15 SSR + Docker, dos 12 produtos HostGator só **VPS** (e Dedicado, como upsell) atendem — hospedagem compartilhada, WordPress, criador de sites e revenda são PHP/estático e **não rodam** este CRM.

Limite honesto de "100% HostGator": todo o **compute e o WhatsApp** rodam no VPS; o **banco** fica no Supabase Cloud (grátis) e a **IA** (Anthropic) é serviço externo com chave da pessoa — o modelo de IA roda na nuvem da Anthropic por natureza. "100% HostGator" = toda a infra de compute na HostGator + serviços gerenciados grátis/externos para dado e IA.

## 2. Decisões travadas

| # | Decisão | Escolha | Origem |
|---|---------|---------|--------|
| D1 | Onde vive o banco | **Híbrido** — compute no VPS, DB no Supabase Cloud grátis | Rafael |
| D2 | Formato do `.zip` | `install.sh` determinístico **+** Claude Code como copiloto | Rafael |
| D3 | Fluxo GitHub | Fork + `git clone` + `docker compose up` (CI/CD é opcional avançado) | Rafael |
| D4 | Escopo do template | **Genérico** — Nuvemshop atrás de flag `NUVEMSHOP_ENABLED=false` | Rafael |
| D5 | WhatsApp/WAHA | **WAHA Core grátis** como default (validar no código); Plus opcional via env | Rafael |
| D6 | Baseline do schema | Gerar via **acesso MCP** ao projeto remoto `rrydmwnporysaiysiztn` | Rafael |
| D7 | Workers de IA-por-evento | **Port fiel** — dormentes viram roadmap, não ativar no v1 | Rafael |
| D8 | Redis | **Local no VPS** via `serverless-redis-http` (SRH), sem conta Upstash | Maestro (leigo-first) |
| D9 | Reverse proxy | **Caddy** (HTTPS Let's Encrypt automático) | Maestro (menos config) |
| D10 | Scheduler | **Ofelia** batendo nas rotas `/api/v1/cron/*` via `curlimages/curl` na rede interna | Maestro |

## 3. Arquitetura de deploy (topologia no VPS)

```
Internet ─▶ Caddy (:80/:443, HTTPS auto)
              └─▶ app        Next.js 15 standalone (node server.js :3000)
                    ├─(rede interna)─ waha     WAHA Core (WhatsApp)
                    ├─(rede interna)─ redis    fila + rate-limit (efêmero)
                    ├─(rede interna)─ srh      serverless-redis-http → mantém @upstash/redis via REST
                    └─(rede interna)─ scheduler Ofelia → curl nas 4 rotas /api/v1/cron/*
Serviços externos (chaves no .env): Supabase Cloud (DB/Auth/Realtime/Storage/pgvector) · Anthropic (IA) · Resend (e-mail, opcional)
```

**Somente o Caddy publica portas (80/443).** `app`, `waha`, `redis`, `srh` ficam só na rede interna do compose. Verificado: o app fala com WAHA por `http://waha:3000` e o webhook WAHA→app por `http://app:3000` — **sem domínio público nem ngrok** (a rota de webhook resolve a sessão por `body.session`).

## 4. Onde a HostGator entra (mapa fechado)

| Ponto | Papel | Produto (link de afiliado) |
|---|---|---|
| **VPS** (host dos 6 containers) | núcleo | âncora de comissão — VPS com Docker (n8n/OpenClaw/GatorClaw já vêm com Docker) |
| Dedicado | tenant grande / muitos números | upsell |
| Domínio + DNS | A-record → IP do VPS | registro de domínio HostGator |
| SSL | HTTPS (Caddy/Let's Encrypt, grátis) | — |

Os demais 8 produtos não rodam a stack → viram material de apoio/upsell no tutorial, não caminho principal.

## 5. Mudanças de código necessárias (mínimas)

Todas preservam o deploy Vercel atual (aditivas, atrás de config/flag):

1. **`next.config.ts`**: adicionar `output: 'standalone'` **e** `images: { unoptimized: true }` (não usamos `next/image` de fato; evita exigir `sharp` no runtime).
2. **`lib/env.ts`** — guarda de fase de build: o Zod hoje faz `throw` no import quando `NODE_ENV=production`, o que roda **durante `next build`** e exigiria todos os segredos de runtime na hora de buildar a imagem (vazariam se passados como ARG). Fix: só lançar quando `process.env.NEXT_PHASE !== 'phase-production-build'`; na fase de build, degradar para `console.warn`. Assim o build só precisa dos `NEXT_PUBLIC_*`.
3. **`lib/env.ts`** — Nuvemshop opcional: trocar as 4 vars `NUVEMSHOP_*` de `required()` para `.optional().default("")` e adicionar `NUVEMSHOP_ENABLED` (enum true/false, default false).
4. **`app/onboarding/page.tsx:17`** — auto-skip: só redirecionar para `connect-nuvemshop` quando `env.NUVEMSHOP_ENABLED`.
5. **Build com turbopack** (`pnpm build`): medido na execução — webpack levava **34min** contra **~4min** do turbopack, inviável num VPS de leigo. O plugin Sentry (sourcemap em build-time) é pulado, mas o Sentry runtime segue ativo (DSN hardcoded). Requer `NODE_OPTIONS=--max-old-space-size=4096` (o build estoura o heap default de 2GB) → **VPS ≥4GB RAM ou swap**.

Nenhuma outra mudança de código é necessária para o self-host: middleware, instrumentation, Sentry configs, crons (Bearer `INTERNAL_SECRET`), WAHA client e Redis client **já são portáveis** (zero uso de SDK/APIs Vercel; comandos Redis triviais 100% compatíveis com SRH).

## 6. Baseline do schema Supabase (bloqueador nº 1)

**Problema:** as migrations `0001–0009` e `0013` são stubs `SELECT 1;` — o schema real (38 tabelas, confirmadas via MCP, todas com RLS) foi aplicado via MCP e vive só no projeto remoto. `supabase db push` num projeto novo **não** recria o schema e as migrations `0010+` (ALTER) falham.

**Solução (D6):** gerar um `supabase/baseline.sql` consolidado a partir do projeto `rrydmwnporysaiysiztn`, incluindo obrigatoriamente:
- schema `public` (38 tabelas + RLS + triggers + funções `fn_user_org_ids`/`fn_is_platform_admin`/`emit_event`/`fn_encrypt_oauth`);
- schema `storage`: buckets `ai-policy` e `lgpd-exports` + policies (um dump só de `public` os perde);
- extensions `uuid-ossp`, `pgcrypto`, `vector`;
- `publication supabase_realtime` incluindo **`messages`, `conversations`, `crm_leads`** (hoje faltam em arquivo → inbox/kanban ficariam sem realtime) + as 3 de IA;
- **`REPLICA IDENTITY FULL`** nas tabelas de realtime (senão UPDATE/DELETE vêm sem payload).

O leigo aplica o baseline via `psql "$SUPABASE_DB_URL" -f supabase/baseline.sql` (nova env `SUPABASE_DB_URL`, connection string direta — hoje ausente do projeto). O `db:migrate` (stub) passa a apontar para esse fluxo.

## 7. Setup do projeto Supabase Cloud (o leigo cria grátis)

Checklist que o `install.sh`/tutorial orquestram:
1. Criar projeto grátis (região sa-east-1), guardar DB password.
2. Copiar do Dashboard: Project URL, anon key, service_role key → `.env`.
3. `SUPABASE_DB_URL` (Settings → Database → connection string).
4. Aplicar `baseline.sql` (§6) + migrations `0010+`.
5. Conferir extensions e buckets `ai-policy`/`lgpd-exports` (nascem do baseline; **não** criar `whatsapp-media` — é aspiracional/não usado no código).
6. Realtime: confirmar publication (§6).
7. Auth no Dashboard: Site URL = domínio do VPS; Redirect += `https://<dom>/auth/callback`; signup off; TOTP on.
8. **Bootstrap do 1º dono** (§9).

## 8. Env vars (consolidado)

**Build-time (baked na imagem — trocar exige rebuild):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ADMIN_URL`.

**Runtime — externas (chaves que o leigo cola):** `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY`, `RESEND_API_KEY` (opcional).

**Runtime — geradas pelo `install.sh` (`openssl rand`):** `INTERNAL_SECRET`, `INTERNAL_CRON_SECRET`, `CPF_ENCRYPTION_KEY`, `AI_CRED_AES_KEY`, `WAHA_BYO_ENCRYPTION_KEY`, `WAHA_API_KEY`(+hash SHA512), `WAHA_HMAC_SECRET`, `SRH_TOKEN`(=`UPSTASH_REDIS_REST_TOKEN`).

**Runtime — internas (nomes de serviço docker):** `WAHA_API_BASE_URL=http://waha:3000`, `WAHA_WEBHOOK_BASE_URL=http://app:3000`, `UPSTASH_REDIS_REST_URL=http://srh:80`, `NODE_ENV=production`, `HOSTNAME=0.0.0.0`, `PORT=3000`.

**Desligadas por padrão:** `NUVEMSHOP_ENABLED=false` + 4 `NUVEMSHOP_*` vazias. **Forçar:** `INTERNAL_AGENT_RUN_STUB=false` (senão o bot responde fake).

> Cuidado documentado: `WAHA_WEBHOOK_BASE_URL` é validada no boot mas só o compose a usa — se faltar, o app nem sobe. `NEXT_PUBLIC_APP_URL` precisa estar correta **no build** (o dispatcher a usa para chamar o runner de agente).

## 9. Bootstrap do primeiro dono (não há signup no app)

O app só tem login por senha — **não existe tela de cadastro**. O `install.sh` roda um passo idempotente que, via admin API + `SUPABASE_DB_URL`:
1. cria o usuário (`auth.admin.createUser`, email_confirm=true) com email/senha que o dono digita;
2. cria a `organization` + `user_organizations` (role admin) + pipeline default;
3. insere a linha em `platform_admins` (super-admin) — hoje sem seed;
4. instrui o dono a instalar um app autenticador **antes** do 1º login (MFA TOTP é forçado para admin); inclui `reset-mfa.sh` e `reset-password.sh` de emergência.

Base: adaptar `scripts/seed-e2e-credentials.ts` (único seed funcional) num `bootstrap-owner.ts` limpo. `seed-tenant.ts` é placeholder — não usar.

## 10. Scheduler (Ofelia) — 4 crons reais

Container `scheduler` (`mcuadros/ofelia`, `TZ=UTC`) com jobs `run` usando `curlimages/curl` na rede interna (`http://app:3000`, header `Authorization: Bearer $INTERNAL_SECRET`):

| Rota | Cadência | Nota |
|---|---|---|
| `agent-dispatcher` | `@every 30s` | VPS não tem cap de 1min da Vercel; baixa latência da IA |
| `storage-redaction?limit=50` | `@every 5m` | dreno LGPD de mídia |
| `lgpd-sla-watcher` | `0 0 12 * * *` | diário 12:00 UTC = 09:00 BRT |
| `kb-conversations-batch` | `0 30 3 * * *` | ingestão RAG noturna |

## 11. Segurança

- `ufw`: abrir só **22/80/443**; negar 3000/3030/6379/porta do SRH.
- **Não publicar** a porta do WAHA. Parear QR via proxy Caddy em `/waha` atrás de basic-auth (ou túnel SSH). Dashboard WAHA **nunca** público.
- `.env` com permissão `600`.
- Webhook WAHA só interno (HMAC não é enforçado hoje — placeholder no DB; manter interno mitiga).
- Rotação de log Docker (`max-size: 10m`, `max-file: 3`) em todo serviço — senão o disco enche.

## 12. Backup & restore

Supabase free **não tem backup automático**. Container/cron de `pg_dump "$SUPABASE_DB_URL"` diário para disco do VPS (+ offsite opcional). Volume `waha-data` (`/app/.sessions`) precisa persistir e ser snapshotado — perdê-lo = re-parear todos os números. `restore.sh` incluído.

## 13. Fluxo do leigo (end-to-end)

1. Forka o repo template no GitHub.
2. Contrata VPS (link afiliado) → acessa por SSH.
3. Cria projeto Supabase grátis; aponta o A-record do domínio → IP do VPS; **espera propagar** (`install.sh` valida com `dig` antes de subir o Caddy, senão o Let's Encrypt falha).
4. Joga o `.zip` no Claude Code **ou** roda `install.sh` → clona o fork, gera segredos, valida `.env` completo, aplica o baseline, faz bootstrap do dono, **puxa a imagem genérica** e sobe `docker compose up -d`.
5. Escaneia o QR do WhatsApp; cola as chaves (Supabase, Anthropic).
6. Login → enrola TOTP → operando.

## 13-bis. Imagem GENÉRICA + env em runtime (Opção B — decidida pós-medição)

O build do Next leva ~6min numa máquina forte e **estoura 2GB de RAM** — o VPS baratinho (2GB) não buildaria. Solução: **uma imagem genérica pré-buildada** (CI → GHCR) que serve qualquer projeto Supabase; o leigo **puxa** (sobe em ~2min, roda em 2GB), não builda. As `NEXT_PUBLIC_*` deixam de ser baked:
- **Browser:** `app/public-env-script.tsx` (server, `await headers()` → runtime) injeta `window.__PUBLIC_ENV__`; `lib/supabase/browser.ts` lê dali (fallback `process.env` no Vercel/dev).
- **Servidor:** `lib/env.ts` parseia `process.env` inteiro em runtime → `env.*` já reflete o container. Convites usam `env.NEXT_PUBLIC_APP_URL` (não mais acesso baked).
- **Build:** `NEXT_PUBLIC_*` viram placeholders; nenhum dado de usuário na imagem.
- **CI:** `.github/workflows/publish-image.yml` builda nos runners do GitHub → `ghcr.io/<repo>:latest`.
- Build local segue possível (avançado): `docker-compose.build.yml` + VPS ≥4GB.

## 14. Atualização

`update.sh`: `git pull` → migrator (schema **antes** do app) → **`docker compose pull app && up -d`** (puxa a nova imagem genérica; volumes persistem, sessão WhatsApp sobrevive). Como a imagem é genérica, **trocar domínio/projeto Supabase não exige rebuild** — só editar o `.env` e reiniciar (os valores são runtime).

## 15. Os 3 entregáveis

**Frente A — Adaptação técnica** *(pré-requisito das outras)*
`Dockerfile` multi-stage (node:20-alpine, corepack/pnpm, `build:webpack`, copiar `.next/standalone`+`.next/static`+`public`, user non-root, `HOSTNAME=0.0.0.0`) · `docker-compose.prod.yml` (app+waha+redis+srh+scheduler+caddy, healthchecks, `depends_on: service_healthy`, log rotation) · `Caddyfile` (proxy + HTTPS + timeout ≥300s em `/api/internal/agents/run`) · Ofelia config · `.env.hostgator.example` · as 5 mudanças de código (§5) · `baseline.sql` (§6) · **validação WAHA Core** (engine NOWEB vs WEBJS, limite de sessão — ver §17).

**Frente B — Tutorial para leigos**
`docs/deploy-hostgator/` passo-a-passo com prints e comandos copiáveis; links de afiliado nos pontos certos (VPS, domínio); sizing recomendado (§17); ordem DNS→SSL; QR; MFA.

**Frente C — Setup Kit `.zip`**
`hostgator-setup-kit/`: `install.sh` idempotente (clona, gera segredos, valida `.env`, aplica baseline, bootstrap do dono, sobe) · `CLAUDE.md` copiloto (conduz, coleta credenciais, destrava erros) · `checklist.md` · `.env.template` · `healthcheck.sh` · `update.sh`/`restore.sh`/`reset-*.sh`.

## 16. Healthcheck & ordering (gap crítico)

`/api/v1/health` retorna **503** se WAHA ou Redis caem. Se for o healthcheck do container `app` com `Caddy depends_on: app service_healthy`, uma falha do WAHA deixaria o app "unhealthy" para sempre → **Caddy nunca sobe → nem a tela de login abre**. Portanto: healthcheck do container `app` = probe TCP barato (`:3000`); `/api/v1/health` fica reservado para monitoração humana.

## 17. Riscos e validações abertas

- **WAHA Core (D5):** validar na Frente A se o engine (o compose usa NOWEB, historicamente Plus) e o limite de 1 sessão do Core atendem o template single-número; ajustar `WAHA_DEFAULT_ENGINE`/compose. Confirmar arquitetura do VPS (imagem é amd64) e se o QR pareia.
- **Ambiguidade da API key WAHA:** `client.ts` diz hash SHA512 no `X-Api-Key`; `.env.example` diz plaintext. Validar contra a imagem real no 1º deploy (erro = 401 em tudo).
- **Sizing VPS:** mínimo **4 GB RAM / 2 vCPU / 60 GB SSD** (build do Next é faminto; 2 GB só com swap ou build fora do VPS). Mapear ao plano HostGator no tutorial.
- **E-mail Resend:** opcional, mas convites falham calados (201 sem enviar) e não há reset de senha por e-mail. Mitigação: expor link de convite na UI quando e-mail falha + `reset-password.sh`.

## 18. Fora de escopo do v1 (roadmap)

- Workers de IA-por-evento (resposta automática, sentiment, RAG indexer, budget) — dormentes hoje (falta rota `event-log-drain`); documentar como próximo passo (D7).
- Mídia real de WhatsApp (hoje o front só mostra ícone; outbound é text-only).
- CI/CD GitHub Actions → VPS por SSH (documentar como opção avançada).
- Multi-número/multi-tenant pesado (exige WAHA Plus).

## 19. Sequenciamento

Frente A primeiro (as B e C documentam/embrulham o que A cria). B e C começam com a spec e ajustam quando A entrega. Maestro coordena; frentes podem rodar em paralelo entre terminais do time após a spec aprovada.
