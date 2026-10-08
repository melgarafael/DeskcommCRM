# Censo da superfície de configuração — o que o painel de administração impacta

> **Investigação A** do épico "painel de administração da instalação".
> Worktree `/Users/rafaelmelgaco/wt/painel-admin`, branch `feat/painel-de-administracao`.
> **SHA medido: `b264bd2d65539cb415f09f1e64742cdea6eb719a`**, `git status --porcelain` vazio no
> início da medição. Medido em 2026-09-17.
>
> Toda afirmação numérica aqui traz o comando que a produziu. Onde a afirmação pôde
> virar comando, ela virou: número envelhece, `rode isto` não.

---

## 0. O tamanho da superfície (e por que 57 não bate)

O briefing desta investigação dizia "medi 57". **Medi 64.** O comando:

```bash
python3 - <<'PY'
import re
src = open("lib/env.ts", encoding="utf-8").read()
b = src[src.index("const schema = z.object({"):src.index("\n});", src.index("const schema"))]
b = re.sub(r"/\*.*?\*/", "", b, flags=re.S)          # tira comentário de bloco
b = re.sub(r"^\s*//.*$", "", b, flags=re.M)          # tira comentário de linha
print(len(re.findall(r"^  ([A-Z][A-Z0-9_]*):", b, flags=re.M)))
PY
# → 64
```

Controle contra a régua trocada (a mesma contagem por outro caminho, contando só as
linhas que abrem um validador):

```bash
awk '/^const schema = z.object\(\{$/,/^\}\);$/' lib/env.ts \
  | grep -cE '^  [A-Z][A-Z0-9_]*: *(z\.|required|diasDeRetencao)'
# → 60
```

**As duas sondas discordam, e a diferença é explicável, não defeito.** As 4 chaves de
diferença são as que abrem com validador em linha própria (`z` na linha de baixo):
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ADMIN_URL`, `INTERNAL_AGENT_RUN_STUB`,
`NUVEMSHOP_ENABLED`. A régua do primeiro comando (nome de chave no início da linha) é
a que corresponde a "chave declarada no schema"; a do segundo conta "chave cuja
declaração cabe numa linha". **A autoridade é a primeira: 64.**

Não achei como reproduzir 57 a partir deste SHA; declaro como não reconciliado.

### ⚠ O schema de `lib/env.ts` NÃO é a superfície de configuração inteira

Existe **um segundo schema Zod**, o do worker, em `lib/agent-engine/env.ts`, com **84
chaves**, das quais só **12** também estão no primeiro:

```bash
python3 - <<'PY'
import re
src=open("lib/agent-engine/env.ts",encoding="utf-8").read()
b=src[src.index("const envSchema = z.object({"):src.index("\n});")]
b=re.sub(r"/\*.*?\*/","",b,flags=re.S); b=re.sub(r"^\s*//.*$","",b,flags=re.M)
print(len(re.findall(r"^  ([A-Z][A-Z0-9_]*):",b,flags=re.M)))
PY
# → 84
```

E existem **20 nomes lidos por `process.env.X` em código de produção que não estão em
nenhum dos dois** — entre eles `INVITE_TOKEN_SECRET`, `AUTH_RATE_LIMIT_LOGIN_IP`,
`META_PHONE_NUMBER_ID`, `META_SYSTEM_USER_TOKEN`, `ZERNIO_API_KEY`,
`META_GRAPH_VERSION`, `APP_VERSION`. O comando que os produz está na seção 6.

Mais dois (`META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`) escapam até desse comando,
porque são lidos por **alias**: `lib/channels/meta/app.ts` recebe
`source: Record<string,string|undefined> = process.env` e lê `source.META_APP_SECRET`.
Uma sonda que procure `process.env.` não os vê.

**Consequência para quem desenha o painel:** "o painel cobre o `lib/env.ts`" não é o
mesmo que "o painel cobre o `.env`". São três censos diferentes, e o `.env` que o
`install.sh` escreve é o maior dos três.

---

## 1. Os três processos — e onde mora o modo de falha silenciosa

Medido em `docker-compose.prod.yml`:

```bash
grep -n "env_file" docker-compose.prod.yml
# → 38 (app), 98 (worker). E MAIS NENHUM.
python3 -c "
import re; y=open('docker-compose.prod.yml',encoding='utf-8').read()
b=y[y.index('\n  scheduler:'):y.index('\n  # ── Chamada de voz')]
print('env_file?', 'env_file' in b, '| environment:', re.findall(r'^      ([A-Z_]+):',b,flags=re.M))"
# → env_file? False | environment: ['TZ', 'INTERNAL_SECRET']
```

| serviço | como nasce | o que roda | de onde vêm as variáveis |
|---|---|---|---|
| `app` | `image: ghcr.io/…/deskcommcrm:stable` | `node server.js` (Next standalone) | `.env` inteiro (`env_file`) |
| `worker` | `image: ghcr.io/…/deskcomm-worker:stable` | `pnpm exec tsx workers/agent-worker/main.ts` (`Dockerfile.worker:27`) | `.env` inteiro + override `WAHA_API_BASE_URL` |
| `scheduler` | `image: ghcr.io/…/deskcomm-scheduler:stable` | `docker/scheduler/entrypoint.sh` → `crond` | **só `TZ` e `INTERNAL_SECRET`** |

**O `scheduler` não é um terceiro leitor de configuração.** Ele escreve um crontab e
bate `curl` em `http://app:3000/api/v1/cron/*` com `Bearer $INTERNAL_SECRET`. Todo cron
executa **dentro do processo `app`**. Das 64 chaves, ele lê **uma**.

### O `worker` carrega os DOIS schemas

Tracei o grafo de módulos a partir do entrypoint do worker (450 módulos):

```bash
# script completo em /tmp/painel-censo (resolve @/ e ./, segue import/export/require)
# resultado: 450 módulos, e lib/env.ts ESTÁ entre eles.
grep -rlE "from ['\"]@/lib/env['\"]" $(cat /tmp/painel-censo/worker-graph.txt | tr '\n' ' ') | wc -l
# → 19 módulos do grafo do worker importam @/lib/env
```

Os importadores incluem `lib/supabase/admin.ts`, `lib/audit/index.ts`,
`lib/branding/instalacao.ts`, `lib/crypto/aes_gcm.ts`, `lib/email/resend.ts`.
Ou seja: **o worker também valida as 64 chaves no boot** — uma `required()` faltando
derruba os dois contêineres, não só o app.

### O modo de falha que pode matar o painel, em uma frase

`lib/env.ts:392` faz `schema.safeParse(process.env)` **uma vez**, e `lib/env.ts:415`
exporta `const env = parsed.data`. `lib/agent-engine/env.ts:221` (`loadEnv`) é chamado
**uma vez**, em `workers/agent-worker/main.ts:622`.

> **Todo valor de `env.*` é uma foto do `process.env` no instante do boot DAQUELE
> contêiner.** Uma tela no `app` que grave no banco só muda o comportamento do `worker`
> se o código do worker **ler o banco**. Se ele lê `env.X`, a tela dirá "salvo" e o
> agente continuará com o valor do `.env` até alguém reiniciar o contêiner — sem
> sintoma em tela nenhuma.

O caso-limite mais puro é `AGENT_DISPATCH_CONSUMER`: leitor único em
`workers/agent-worker/main.ts:314`, resolvido por `loadEnv()`. Nenhuma tela do `app`
alcança esse valor, hoje ou depois.

**Boa notícia medida:** quase nada é lido em escopo de módulo, então trocar `env.X` por
um resolvedor assíncrono é substituição local, não refatoração.

```bash
# leituras de chave do schema em escopo de MÓDULO (congeladas no boot do módulo)
# → 4 ocorrências, todas conhecidas:
#   lib/env.ts (NODE_ENV, interno)
#   sentry.server.config.ts / sentry.edge.config.ts / workers/agent-worker/main.ts (SENTRY_DSN)
```

`SENTRY_DSN` é, portanto, a única chave do schema que um painel **não** consegue
mudar a quente sem reiniciar: o SDK do Sentry é inicializado no topo do arquivo.

---

## 2. A tabela do censo

Colunas: **processos que leem** vem do cruzamento de dois grafos de módulos reais
(entrypoint do worker × todas as entradas de `app/**` + `middleware`/`instrumentation`),
não de convenção de pasta. **Nº de leitores** conta arquivos de produção
(exclui `tests/`, `scripts/`, `evidence/`, `*.test.*`, `*.spec.*`) em que aparece
`env.X`, `process.env.X` ou `process.env["X"]`.

| variável | categoria | processos que leem | nº leitores (prod) | evidência | justificativa |
|---|---|---|---|---|---|
| `INTERNAL_SECRET` | BOOTSTRAP | app + scheduler | 31 | `app/api/internal/agents/run/route.ts:49` | ⚠ fora do molde: o par mora no contêiner `scheduler`, que NÃO tem `env_file` nem acesso ao banco — só `environment: TZ, INTERNAL_SECRET`. Trocar no banco não muda o crontab. |
| `INTERNAL_CRON_SECRET` | BOOTSTRAP | app | 25 | `app/api/v1/cron/agenda-expira-pendentes/route.ts:67` | Mesmo par do anterior; e em produção `CRON_SECRET` do ambiente a sobrescreve (lib/env.ts:427). |
| `NEXT_PUBLIC_SUPABASE_URL` | BOOTSTRAP | app + worker | 10 | `app/api/v1/health/route.ts:71` | É o endereço do próprio banco: sem ela `createAdminClient()` não existe, logo não há linha a ler. |
| `NODE_ENV` | BOOTSTRAP | app + worker | 7 | `app/onboarding/layout.tsx:35` | Modo do processo, gravado na imagem (`Dockerfile` runner `ENV NODE_ENV=production`); nenhuma tela decide isto. |
| `WAHA_API_KEY` | BOOTSTRAP | app + worker | 7 | `app/api/v1/channel-sessions/[id]/qr/route.ts:85` | ⚠ o par é `WAHA_API_KEY_SHA512`, entregue ao contêiner WAHA pelo compose — variável que nem está no schema. Trocar pela tela exigiria recriar o contêiner. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | BOOTSTRAP | app + worker | 5 | `app/api/v1/health/route.ts:75` | Credencial do cliente de browser; sem ela ninguém loga para chegar ao painel. |
| `SUPABASE_SERVICE_ROLE_KEY` | BOOTSTRAP | app + worker | 5 | `lib/agent-engine/agent/request-deps.ts:26` | Chave do admin client, o ÚNICO papel com grant nas tabelas `platform_*` (0201:60). |
| `SUPABASE_DB_URL` | BOOTSTRAP | app + worker | 4 | `lib/agent-engine/db/request-pool.ts:15` | Connection string do `pg` cru — é por ela que o worker alcança o banco. |
| `UPSTASH_REDIS_REST_TOKEN` | BOOTSTRAP | app + worker | 3 | `app/api/v1/health/route.ts:107` | ⚠ o par é `SRH_TOKEN` no contêiner `srh` (docker-compose.prod.yml). |
| `WACALLS_API_TOKEN` | BOOTSTRAP | app + worker | 3 | `app/api/v1/voice/events/route.ts:75` | ⚠ o par é `WACALLS_API_TOKEN` no contêiner `wacalls` (profile `voz`). |
| `WAHA_HMAC_SECRET` | BOOTSTRAP | app | 1 | `lib/waha/webhook-auth.ts:53` | ⚠ o par é `WHATSAPP_HOOK_HMAC_KEY` no contêiner WAHA (docker-compose.prod.yml) — com `_KEY`, o nome sem ele o WAHA ignora e nunca assina. |
| `SUPABASE_DB_ADMIN_URL` | BOOTSTRAP | **nenhum** | 0 | `— (sem leitor)` | Conexão de DDL do kit; `tests/unit/env-ddl-fora-do-app.test.ts` PROÍBE o app de lê-la. |
| `WAHA_WEBHOOK_BASE_URL` | BOOTSTRAP | **nenhum** | 0 | `— (sem leitor)` | ÓRFÃ no código; o único consumidor é o compose, que monta `WHATSAPP_HOOK_URL` do contêiner WAHA. |
| `IMPERSONATE_COOKIE_SECRET` | CHAVE-MESTRA | app | 2 | `lib/impersonate/cookie.ts:84` | HMAC do cookie de impersonate; um segredo de sessão não volta ao banco que a sessão protege. |
| `VAPID_PRIVATE_KEY` | CHAVE-MESTRA | app + worker | 2 | `lib/notifications/vapid.ts:4` | Metade privada do mesmo par. |
| `AI_CRED_AES_KEY` | CHAVE-MESTRA | app + worker | 1 | `lib/crypto/aes_gcm.ts:4` | Cifra as API keys de `ai_provider_credentials` (AES-256-GCM em Node); guardá-la cifrada por si mesma é circular. |
| `LGPD_SIGNING_KEY` | CHAVE-MESTRA | app + worker | 1 | `lib/lgpd/pades-signer.ts:24` | Assina o PDF PAdES do export; é chave de assinatura, não configuração. |
| `VAPID_PUBLIC_KEY` | CHAVE-MESTRA | app + worker | 1 | `lib/notifications/vapid.ts:4` | Metade de um par assimétrico; trocar invalida toda inscrição de push já feita. |
| `CPF_ENCRYPTION_KEY` | CHAVE-MESTRA | **nenhum** | 0 | `— (sem leitor)` | Chave de cifra declarada `required()` — e ÓRFÃ: zero leitores em código de produção. |
| `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` | CHAVE-MESTRA | **nenhum** | 0 | `— (sem leitor)` | A chave mestra de `fn_encrypt_oauth`. JÁ MORA NO BANCO (`private.app_secrets`), semeada pelo kit — nenhum TS a lê. |
| `WAHA_BYO_ENCRYPTION_KEY` | CHAVE-MESTRA | **nenhum** | 0 | `— (sem leitor)` | Chave de cifra declarada `required()` — e ÓRFÃ: zero leitores em código de produção. |
| `NEXT_PUBLIC_ADMIN_URL` | BUILD-TIME | **nenhum** | 0 | `— (sem leitor)` | `ARG`+`ENV` no estágio de build do Dockerfile (linhas 28 e 37) e ZERO leitores em código: fica no bundle e não move nada. |
| `SENTRY_DSN` | KNOB | app + worker | 4 | `app/public-env-script.tsx:64` | ⚠ lido em ESCOPO DE MÓDULO em `sentry.server.config.ts`, `sentry.edge.config.ts` e `workers/agent-worker/main.ts` — congelado no boot do SDK. |
| `NUVEMSHOP_ENABLED` | KNOB | app | 3 | `app/onboarding/done/page.tsx:22` | Liga/desliga do módulo; leitor real, só no `app`. |
| `AI_BUDGET_ENFORCEMENT` | KNOB | app + worker | 2 | `lib/agent-engine/edge/llm/credentials.ts:102` | Kill switch de gasto; lido nos DOIS processos, e no worker vem do `loadEnv()` de boot. |
| `INTERNAL_AGENT_RUN_STUB` | KNOB | app | 2 | `app/api/v1/ai/agents/[id]/versions/[vid]/test/route.ts:169` | Liga/desliga de trace falso; leitor real, só no `app`. |
| `AGENT_DISPATCH_CONSUMER` | KNOB | worker | 1 | `workers/agent-worker/main.ts:314` | ⚠ O CASO-LIMITE DO ÉPICO: leitor ÚNICO em `workers/agent-worker/main.ts:314`, lido no `loadEnv()` do boot (main.ts:622). Tela do `app` NÃO alcança. |
| `AUDIT_LOG_RETENTION_DAYS` | KNOB | app | 1 | `app/api/v1/cron/data-retention/route.ts:250` | Dias de retenção; leitor real no cron `data-retention`. |
| `EXTENSIONS_LOCAL_CATALOG_ORIGIN` | KNOB | app | 1 | `lib/extensions/service.ts:648` | Exceção de laboratório local (origem loopback); leitor real único. |
| `JOB_QUEUE_RETENTION_DAYS` | KNOB | app | 1 | `app/api/v1/cron/data-retention/route.ts:249` | Dias de retenção; leitor real no cron `data-retention`. |
| `LEAD_CAPTURE_RETENTION_DAYS` | KNOB | app | 1 | `app/api/v1/cron/webhook-log-retention/route.ts:70` | Dias de retenção; leitor real no cron (interpretada por lib/retencao/politica.ts). |
| `LGPD_EXPORT_EXPIRES_HOURS` | KNOB | app + worker | 1 | `workers/lgpd-export-worker.ts:63` | Horas de validade do link de export; leitor real no worker de export. |
| `SIGNUP_MODE` | KNOB | app | 1 | `lib/auth/politica-de-cadastro.ts:98` | JÁ MIGRADA: `platform_settings` está acima dela (lib/auth/politica-de-cadastro.ts) e a tela é `/admin/cadastro`. |
| `TRANSCRIPTION_MODEL` | KNOB | app + worker | 1 | `workers/media-derive-worker.ts:491` | Nome de modelo de transcrição; leitor real no worker de derivação de mídia. |
| `WAHA_WEBHOOK_REQUIRE_SIGNATURE` | KNOB | app | 1 | `lib/waha/webhook-auth.ts:61` | Booleano de exigência de assinatura; leitor real, só no processo `app`. |
| `WEBHOOK_LOG_BODY_RETENTION_DAYS` | KNOB | app | 1 | `app/api/v1/cron/webhook-log-retention/route.ts:55` | Dias de retenção; leitor real no cron. |
| `WEBHOOK_LOG_ROW_RETENTION_DAYS` | KNOB | app | 1 | `app/api/v1/cron/webhook-log-retention/route.ts:56` | Dias de retenção; leitor real no cron. |
| `NEXT_PUBLIC_APP_URL` | MIGRÁVEL | app + worker | 18 | `app/actions/auth/requestPasswordReset.ts:37` | ⚠ Migrável pelo caminho `env.*` (runtime), MAS o acesso direto `process.env.NEXT_PUBLIC_APP_URL` É dobrado no build — ver `app/app/webhooks/_components/SourceDetail.tsx:50-57`. |
| `WAHA_API_BASE_URL` | MIGRÁVEL | app + worker | 7 | `app/api/v1/channel-sessions/[id]/qr/route.ts:84` | Endereço interno do WAHA; lido nos dois processos, e o compose SOBRESCREVE no worker (`environment: WAHA_API_BASE_URL: http://waha:3000`). |
| `WACALLS_API_BASE_URL` | MIGRÁVEL | app + worker | 6 | `app/api/v1/voice/events/route.ts:72` | Endereço interno do WaCalls; string vazia é o sinal de 'instalação não oferece voz'. |
| `APP_NAME` | MIGRÁVEL | app + worker | 5 | `app/admin/(protected)/marca/_form.tsx:231` | JÁ MIGRADA (migration 0155 + `/admin/marca`). |
| `OPENAI_API_KEY` | MIGRÁVEL | app + worker | 5 | `app/app/ai/routers/[id]/page.tsx:57` | Credencial de IA; é o ÚLTIMO degrau da escada (lib/ai/embeddings/chave.ts). |
| `ANTHROPIC_API_KEY` | MIGRÁVEL | app + worker | 4 | `app/app/ai/routers/[id]/page.tsx:56` | Credencial de IA; precedente direto de `ai_provider_credentials`. |
| `APP_LOGO_URL` | MIGRÁVEL | app + worker | 4 | `app/app/settings/marca/page.tsx:103` | JÁ MIGRADA (0155). |
| `LGPD_DPO_EMAIL` | MIGRÁVEL | app + worker | 4 | `lib/legal/operador.ts:71` | Contato do DPO; `lib/legal/operador.ts` já resolve o DPO por camadas. |
| `OPENROUTER_API_KEY` | MIGRÁVEL | app + worker | 4 | `lib/agent-engine/edge/llm/credentials.ts:96` | Credencial de IA; mesma escada de resolução das demais. |
| `UPSTASH_REDIS_REST_URL` | MIGRÁVEL | app + worker | 3 | `app/api/v1/health/route.ts:106` | Endereço interno do `srh`; migrável, mas o valor de tela é quase nulo (é constante do compose). |
| `AI_GATEWAY_API_KEY` | MIGRÁVEL | app + worker | 2 | `lib/ai/embeddings/chave.ts:149` | Credencial de IA — o repo JÁ guarda credencial de IA cifrada por organização em `ai_provider_credentials`. |
| `AI_GATEWAY_BASE_URL` | MIGRÁVEL | app + worker | 2 | `lib/ai/embeddings/chave.ts:152` | URL de provedor de IA; lida por função, nunca em escopo de módulo. |
| `SUPPORT_EMAIL` | MIGRÁVEL | app + worker | 2 | `lib/branding/saida.ts:238` | E-mail mostrado ao cliente final; já é conteúdo de marca — mesmo objeto de `platform_branding`. |
| `APP_ACCENT_HEX` | MIGRÁVEL | app | 1 | `app/app/settings/marca/page.tsx:104` | JÁ MIGRADA (0155); o `.env` nem é semente aqui (install.sh nunca a grava). |
| `GOOGLE_CALENDAR_CLIENT_ID` | MIGRÁVEL | app | 1 | `lib/agenda/google/config.ts:79` | JÁ MIGRADA (migration 0201 + `/admin/google`): banco primeiro, `.env` como piso. |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | MIGRÁVEL | app | 1 | `lib/agenda/google/config.ts:80` | JÁ MIGRADA (0201), cifrada por `fn_encrypt_oauth`. |
| `NUVEMSHOP_APP_ID` | MIGRÁVEL | app + worker | 1 | `lib/nuvemshop/config.ts:22` | Credencial de app OAuth de instalação — molde idêntico ao do Google. |
| `NUVEMSHOP_CLIENT_ID` | MIGRÁVEL | app + worker | 1 | `lib/nuvemshop/config.ts:23` | Idem. |
| `NUVEMSHOP_CLIENT_SECRET` | MIGRÁVEL | app + worker | 1 | `lib/nuvemshop/config.ts:24` | Idem; é exatamente o caso que a 0201 resolveu para o Google. |
| `OPENROUTER_APP_TITLE` | MIGRÁVEL | app + worker | 1 | `lib/agent-engine/edge/llm/providers.ts:65` | Atribuição opcional (`X-Title`); lida por função. |
| `OPENROUTER_APP_URL` | MIGRÁVEL | app + worker | 1 | `lib/agent-engine/edge/llm/providers.ts:64` | Atribuição opcional (`HTTP-Referer`); lida por função. |
| `OPENROUTER_BASE_URL` | MIGRÁVEL | app + worker | 1 | `lib/ai/gateway.ts:77` | URL de provedor de IA. |
| `RESEND_API_KEY` | MIGRÁVEL | app + worker | 1 | `lib/email/resend.ts:56` | Credencial de e-mail; lida dentro de `fromAddress()`/cliente, nunca em escopo de módulo. |
| `RESEND_FROM_EMAIL` | MIGRÁVEL | app + worker | 1 | `lib/email/resend.ts:70` | Remetente; lida por função. |
| `TRANSCRIPTION_API_KEY` | MIGRÁVEL | app + worker | 1 | `workers/media-derive-worker.ts:485` | Credencial de transcrição; lida por função no worker de mídia. |
| `TRANSCRIPTION_BASE_URL` | MIGRÁVEL | app + worker | 1 | `workers/media-derive-worker.ts:462` | URL do serviço de transcrição. |
| `VERCEL_AI_GATEWAY_URL` | MIGRÁVEL | **nenhum** | 0 | `— (sem leitor)` | ÓRFÃ TOTAL: zero ocorrências fora de `.env.example` e `docs/SETUP.md`. |

### Placar

| categoria | nº | o que significa para o painel |
|---|---|---|
| **MIGRÁVEL** | 27 | pode virar campo de tela; 5 delas **já viraram** |
| **KNOB** | 15 | número/booleano de comportamento; 1 é inalcançável pelo `app` |
| **BOOTSTRAP** | 13 | não pode morar no banco |
| **CHAVE-MESTRA** | 8 | não pode ser guardada cifrada por si mesma |
| **BUILD-TIME** | 1 | mudar em runtime não tem efeito |
| **total** | **64** | |

Reproduza o placar com o classificador versionado ao lado deste documento?
**Não há um — a classificação é minha, em prosa, e é o único item deste relatório
que não sai de um comando.** Está declarado na seção 6.

### Já migradas (o painel não precisa inventá-las, precisa incorporá-las)

`APP_NAME`, `APP_LOGO_URL`, `APP_ACCENT_HEX` (migration 0155 · `/admin/marca`),
`GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` (0201 · `/admin/google`),
`SIGNUP_MODE` (`platform_settings` · `/admin/cadastro`). Fora do schema de `lib/env.ts`,
`META_APP_SECRET` e `META_WEBHOOK_VERIFY_TOKEN` (0257 · `/admin/meta`).

### As órfãs — campo que o painel ofereceria sem efeito

**7 chaves do schema têm ZERO leitores em código de produção.** O comando:

```bash
# para cada chave K do schema, procurar env.K / process.env.K fora de lib/env.ts,
# tests/, scripts/, evidence/ e arquivos .test./.spec.
# → CPF_ENCRYPTION_KEY, NUVEMSHOP_OAUTH_ENCRYPTION_KEY, WAHA_BYO_ENCRYPTION_KEY,
#   SUPABASE_DB_ADMIN_URL, WAHA_WEBHOOK_BASE_URL, VERCEL_AI_GATEWAY_URL,
#   NEXT_PUBLIC_ADMIN_URL
```

Três delas **têm consumidor fora do TypeScript**, e portanto não são órfãs de verdade —
são de outra jurisdição:

| chave | quem consome | onde |
|---|---|---|
| `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` | o **Postgres** | `hostgator-setup-kit/_common.sh:1034` semeia em `private.app_secrets`; `private.fn_oauth_key()` a lê |
| `SUPABASE_DB_ADMIN_URL` | o **kit** (DDL) | `hostgator-setup-kit/_common.sh:434`; o app é PROIBIDO de lê-la por `tests/unit/env-ddl-fora-do-app.test.ts` |
| `WAHA_WEBHOOK_BASE_URL` | o **compose** | `docker-compose.prod.yml:138` monta `WHATSAPP_HOOK_URL` do contêiner WAHA |

**Quatro são órfãs de verdade — ninguém, em lugar nenhum, as lê:**

```bash
rg -n "VERCEL_AI_GATEWAY_URL" -g '!node_modules' .   # → só .env.example:129 e docs/SETUP.md:274
rg -n "CPF_ENCRYPTION_KEY"    -g '!node_modules' . | grep -vE "^\./(tests|docs|scripts)/"
# → .env.example, .env.hostgator.example, install.sh (gera e grava). Nenhum leitor.
```

E duas delas são piores que inertes: **`CPF_ENCRYPTION_KEY` e `WAHA_BYO_ENCRYPTION_KEY`
são `required()`** (`lib/env.ts:117` e `lib/env.ts:120`), ou seja, **toda instalação de
produção se recusa a subir sem duas chaves de cifra que nenhuma linha de código usa** —
e os dois contêineres (app e worker) validam as mesmas 64. `NEXT_PUBLIC_ADMIN_URL` é a
quarta, e é também o único exemplar puro de BUILD-TIME: `ARG` + `ENV` no estágio de
build (`Dockerfile:28` e `:37`), assada no bundle, lida por ninguém.

---

## 3. BUILD-TIME neste repo — a prova, porque o conhecimento geral MENTE aqui

A regra geral ("`NEXT_PUBLIC_*` é build-time") **não descreve este repo**, e tratá-la
como verdade classificaria 5 chaves errado. O que foi medido:

**(a) O estágio `runner` do Dockerfile NÃO define nenhuma `NEXT_PUBLIC_*`.**

```bash
awk '/FROM node:22-alpine AS runner/,0' Dockerfile | grep -cE "NEXT_PUBLIC"
# → 0
```

As `ARG`/`ENV NEXT_PUBLIC_*` existem só no estágio `build` (`Dockerfile:28-37`), e com
valores **placeholder** (`https://placeholder.supabase.co`, `https://placeholder.invalid`).

**(b) O que salva o app é o `safeParse` sobre o objeto inteiro.**
`lib/env.ts:392` faz `schema.safeParse(process.env)` — acesso ao OBJETO, que a
substituição estática do compilador não alcança. Por isso `env.NEXT_PUBLIC_APP_URL` é o
valor de **runtime**, vindo do `env_file`. O comentário de `app/public-env-script.tsx:22-25`
diz isso com a medição ao lado.

**(c) O acesso DIRETO continua sendo dobrado — e há a cicatriz no repo.**
`app/public-env-script.tsx:14-20` registra a medição: `lib/branding/logo.ts` acessava
`process.env.NEXT_PUBLIC_SUPABASE_URL` de forma estática e o compilador dobrou a função
inteira em `function n(){return"https://placeholder.supabase.co".trim()}` — logo quebrado
em toda instalação Docker. Hoje `lib/branding/logo.ts:137-169` lê
`window.__PUBLIC_ENV__` no browser e o `process.env` **inteiro** no servidor, com o
motivo escrito. O gate é `tests/unit/marca-nao-pode-assar-o-dominio.test.ts`.

**(d) O único acesso direto que sobrou em produção está consciente disso.**

```bash
rg -n "process\.env\.NEXT_PUBLIC_APP_URL" --glob '!tests/**' --glob '!scripts/**' .
# → app/app/webhooks/_components/SourceDetail.tsx:57  (client component; cai em
#   window.location.origin quando há window — o comentário nas linhas 50-53 explica)
```

> **Regra que o painel deve herdar:** `NEXT_PUBLIC_*` só é build-time quando lido por
> `process.env.NOME` literal. Lido via `env.*` (objeto inteiro) ou via
> `window.__PUBLIC_ENV__`, é runtime. Um campo de painel sobre uma dessas chaves
> funciona — desde que nenhum consumidor a acesse pelo nome literal.

---

## 4. O padrão de "tela que configura" que já passou pelo CI

São **quatro** instâncias do mesmo molde, e a terceira e a quarta se declaram clones da
primeira no próprio cabeçalho. Copiar este molde é a decisão barata.

| tela | tabela | migration | escritor | leitor/resolvedor |
|---|---|---|---|---|
| `app/admin/(protected)/marca` | `platform_branding` | `0155` | `app/actions/settings/updateBranding.ts` | `lib/branding/instalacao.ts` |
| `app/admin/(protected)/google` | `platform_google_oauth` | `0201` | `app/actions/settings/updateGoogleOAuth.ts` | `lib/agenda/google/config.ts` |
| `app/admin/(protected)/meta` | `platform_meta_app` | `0257` | `app/actions/settings/updateMetaApp.ts` | `lib/channels/meta/app.ts` |
| `app/admin/(protected)/cadastro` | `platform_settings` | — | `app/actions/settings/updateSignupMode.ts` | `lib/auth/politica-de-cadastro.ts` |

### As sete propriedades do molde (todas com evidência)

1. **Singleton por construção.** `id smallint primary key default 1` +
   `constraint …_singleton check (id = 1)` (`0201:44-49`). A segunda linha é recusada
   pelo banco, não pela disciplina de quem escreve a query.

2. **RLS LIGADA com ZERO policies, e grants revogados.**
   ```sql
   alter table public.platform_google_oauth enable row level security;
   revoke all on public.platform_google_oauth from anon, authenticated;
   grant select, insert, update on public.platform_google_oauth to service_role;
   ```
   (`0201:57-60`) — o raciocínio está no cabeçalho da migration: a anon key vai para o
   browser; uma tabela "protegida por policy" depende de a policy estar certa, uma
   tabela sem policy nenhuma e sem grants **não é servida pelo PostgREST de jeito nenhum**.

3. **Banco PRIMEIRO, `.env` como PISO DE ROLLBACK — nunca o contrário.**
   `configuracaoDoGoogle()` (`lib/agenda/google/config.ts:166-184`) lê a linha, e só cai
   em `configuracaoDoAmbiente()` quando ela não existe ou não decifra. O motivo escrito:
   *"no contrário, um env esquecido silenciaria a configuração feita pela tela e o
   operador não entenderia por que nada mudou."*
   E o `.env` continua sendo escrito porque `agent.sh` reverte **só a imagem**, nunca o
   schema: o rollback põe código antigo sobre banco novo **por construção**.

4. **As duas fontes NÃO se misturam.** Se o segredo do banco não decifra,
   `configuracaoDoGoogle()` cai para o ambiente **inteiro**, e não usa o `client_id` do
   banco com o secret do `.env` (`config.ts:174-180`). `lib/channels/meta/app.ts:31-37`
   mede a consequência de misturar: handshake aceito e **toda** entrega morrendo em
   `401 invalid_signature`.

5. **Cache = memo de PROCESSO com TTL de 30 s, no `globalThis`, invalidado pela escrita.**
   ```ts
   const TTL_MS = 30_000;
   declare global { var __memoDoAppDoGoogle: {...} | null | undefined }
   export function invalidarCredencialDoGoogle(): void { globalThis.__memoDoAppDoGoogle = null; }
   ```
   (`config.ts:104-119`). **No `globalThis` e não num `let` de módulo** porque o Turbopack
   instancia o mesmo módulo duas vezes no mesmo processo — já medido neste repo. Nada de
   `unstable_cache`/`revalidateTag`: `lib/branding/instalacao.ts:25-33` registra que
   `unstable_cache` tem **zero** ocorrências no repo, com `revalidatePath` (9 arquivos)
   como controle positivo.

6. **O resolvedor NUNCA lança.** `config.ts:141-148` e o cabeçalho de
   `lib/branding/instalacao.ts`: um throw ali é 500 na tela inteira (o resolvedor de
   marca roda em `app/layout.tsx`). Clone que não aplicou a migration devolve `42P01`,
   e isso é tratado como *"o banco não falou"*, com `logger.info`, não como erro.

7. **Gate `requirePlatformAdmin()` + `audit()` fire-and-forget, sem organização.**
   `updateGoogleOAuth.ts:68` e `:108-130`. Três detalhes que o molde já pagou:
   `resourceId: null` (a chave natural do singleton é `1`, e `api_audit_log.resource_id`
   é `uuid` — `"1"` estouraria em `22P02` num write fire-and-forget, sem sintoma);
   `metadata.campos` registra **o quê** mudou, **nunca o valor**; e sem `organizationId`,
   porque a credencial da instalação não pertence a tenant nenhum.

8. **`upsert`, jamais `update`.** `updateGoogleOAuth.ts:95-100`: a linha não existe numa
   instalação que nunca configurou, e um `update` casaria zero linhas **devolvendo
   sucesso** — a tela diria "salvo" e nada seria gravado (o modo de falha da issue #144).

---

## 5. A cifragem em vigor

**Há duas cifras no repo, e a 0201 escolheu a primeira explicitamente** (`0201:33-41`).

### Cifra A — `pgcrypto` no banco (a que a 0201 usa)

- **Como é guardado:** coluna `client_secret_encrypted bytea` (`0201:46`).
- **Por quem:** `public.fn_encrypt_oauth(plaintext text) returns bytea`, `security definer`,
  `search_path` fixo em `'public','private','extensions','pg_temp'`
  (`supabase/migrations/20260718150000_0041_webhook_secret_encryption.sql:43-55`).
  O corpo é `pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256')`.
- **De onde vem a chave `k`:** `private.fn_oauth_key()` (`0041:32-41`) —
  `coalesce( nullif(current_setting('app.nuvemshop_oauth_key', true),''),
             (select value from private.app_secrets where name='nuvemshop_oauth_key') )`.
  A GUC é override (VPS/psql/testes); a fonte normal é a tabela, porque **o Supabase
  cloud não permite `ALTER DATABASE … SET` de GUC custom (42501)**.
- **Quem semeia:** o kit, não o app —
  `hostgator-setup-kit/_common.sh:1034` faz `insert into private.app_secrets … on conflict do update`,
  a partir de `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` do `.env`.
- **Guarda:** `k` com menos de 32 caracteres → `raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente'`
  (`0041:46-52`). `revoke all … from public` nas duas funções, `grant execute … to service_role`
  (`0041:66-70`).
- **Como o TypeScript fala com ela:** `lib/webhooks/secrets.ts:16-38` —
  `admin.rpc("fn_encrypt_oauth", { plaintext })` e `admin.rpc("fn_decrypt_oauth", …)`,
  **sempre pelo admin client**. Contrato de erro declarado: encrypt sem chave devolve
  `null` (quem chama decide), decrypt que falha devolve `null` (nunca 500).
- **E o save RECUSA em vez de degradar:** `updateGoogleOAuth.ts:83-89` — se a cifra não
  está disponível, a resposta é `ok:false`. O argumento está escrito na linha 46-49:
  cair para texto puro trocaria *"não dá para configurar"* por *"está configurado e
  desprotegido"*, **e o segundo não tem sintoma**.

### Cifra B — AES-256-GCM em Node (a que a 0201 RECUSOU)

`lib/crypto/aes_gcm.ts`, chave em `AI_CRED_AES_KEY` (32 bytes base64), grava ciphertext
+ IV(12) + tag(16) como três `bytea` em `ai_provider_credentials`. A 0201 recusou usá-la
com dois motivos escritos: **é de escopo de ORGANIZAÇÃO e é exposta por view**
(`ai_provider_credentials_safe`), e adotá-la seria um **terceiro caminho de cifra** num
módulo que já usa o primeiro.

> **Recomendação medida para o painel:** credencial de INSTALAÇÃO → cifra A
> (`fn_encrypt_oauth`, `bytea`, `service_role`, save que recusa sem chave).
> Credencial de ORGANIZAÇÃO → cifra B, que já existe para isso. Não abrir uma terceira.
> E note o efeito colateral bom: adotar a cifra A **dá leitor** à
> `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`, hoje invisível de dentro do TypeScript.

---

## 6. O que eu NÃO medi

1. **A classificação em 5 categorias é minha, em prosa.** Não há classificador
   versionado que a reproduza, e ela é o único conteúdo deste relatório que não sai de
   um comando. Três chaves em especial **não cabem em nenhuma das cinco** e foram postas
   em BOOTSTRAP com a definição alargada ("pré-condição estabelecida antes de qualquer
   código rodar"): `INTERNAL_SECRET`, `WAHA_API_KEY`/`WAHA_HMAC_SECRET` e
   `UPSTASH_REDIS_REST_TOKEN`/`WACALLS_API_TOKEN`. O motivo real delas é outro: **o par
   mora no `environment:` de OUTRO contêiner**, e o banco não alcança contêiner. Se essa
   for uma categoria de verdade, ela deveria se chamar *PAREADA-COM-CONTÊINER* e tem
   6 membros.

2. **Não rodei nada.** Nenhum `pnpm typecheck`, `test:unit`, `test:db` ou `e2e`. Todo o
   relatório é leitura estática do SHA `b264bd2d6`. Nenhuma afirmação aqui foi observada
   em execução.

3. **O grafo de módulos é estático e pode SUPERESTIMAR.** Ele segue `import`/`export
   from`/`import()`/`require()` e resolve `@/` e `./`. Não distingue `import type`
   (apagado na compilação) de import de valor, não conhece `"use client"` (um módulo pode
   estar no grafo do app e nunca executar no servidor), e não conhece code splitting.
   Um módulo no grafo é um módulo **alcançável**, não necessariamente **executado**.

4. **O grafo pode SUBESTIMAR.** Import dinâmico com caminho computado, e leitura por
   alias (`source.META_APP_SECRET`) escapam das duas sondas. Achei 2 casos por acaso;
   não varri a classe inteira.

5. **Não medi os 84 knobs do worker um a um.** Contei-os e medi a interseção (12), mas a
   classificação por migrabilidade só cobre as 64 do `lib/env.ts`. Os `QUEUE_*`,
   `CRON_*`, `TOOL_BREAKER_*`, `LEAD_RECALL_*` etc. são exatamente o tipo de coisa que um
   painel gostaria de expor **e que é lida no `loadEnv()` do boot** — isto é, a
   superfície onde o modo de falha silenciosa é a regra, não a exceção.

6. **Não medi o `.env.example` nem o `install.sh`.** O censo é do schema; o conjunto de
   chaves que o instalador **escreve** no `.env` do cliente é outro conjunto, e é ele que
   define o que o painel tem de saber preservar. `install.sh` escreve o `.env` com
   truncamento (`} > .env`), o que já custou uma chave posta à mão (ver o cabeçalho de
   `RESEND_API_KEY` em `lib/env.ts:259-271`).

7. **Não medi o caminho de rollback.** A afirmação "o `.env` é piso de rollback" está
   citada dos cabeçalhos de 0155/0201, não verificada rodando `agent.sh`.

8. **Não medi se as tabelas `platform_*` estão no `supabase/baseline.sql`.** A doutrina
   exige migration **+** apêndice idempotente no baseline; conferi a migration, não o
   apêndice. Comando para conferir:
   `grep -n "platform_google_oauth\|platform_branding\|platform_meta_app" supabase/baseline.sql`

9. **Não medi `lint:channels`.** `lib/agenda/google/config.ts:156-162` avisa que ele
   proíbe nomear provider fora de `lib/channels/` e que **lê comentário como lê código**.
   Um painel que liste provedores de IA pelo nome pode esbarrar nele.

10. **Não conferi a lista de leitores contra uma sonda independente.** O número da coluna
    "nº leitores" vem de UMA regex. Não há controle cruzado, e a memória
    `feedback_sonda_cega_repetida` diz exatamente o que isso vale.

### O comando das 20 chaves fora do schema (seção 0)

```bash
python3 - <<'PY'
import os,re,subprocess
keys=set(re.findall(r"^  ([A-Z][A-Z0-9_]*):",
    re.sub(r"^\s*//.*$","",re.sub(r"/\*.*?\*/","",
      open("lib/env.ts",encoding="utf-8").read(),flags=re.S),flags=re.M),flags=re.M))
pat=re.compile(r"process\.env\.([A-Z][A-Z0-9_]{2,})\b|process\.env\[['\"]([A-Z][A-Z0-9_]{2,})['\"]\]")
out={}
for f in subprocess.run(["git","ls-files"],capture_output=True,text=True).stdout.split():
    if os.path.splitext(f)[1] not in (".ts",".tsx"): continue
    if f.startswith(("tests/","scripts/","evidence/")) or ".test." in f or ".spec." in f: continue
    for m in pat.finditer(open(f,encoding="utf-8").read()):
        k=m.group(1) or m.group(2)
        if k not in keys: out.setdefault(k,set()).add(f)
for k in sorted(out): print(k, sorted(out[k])[0])
print("TOTAL:", len(out))
PY
```
