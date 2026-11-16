# CLAUDE.md — DeskcommCRM

> Instruções pra futuras sessões Claude trabalhando neste repo. Leitura obrigatória antes de qualquer task de código.

**Este arquivo é a doutrina — a autoridade final sobre convenção e anti-pattern.** Complementos, na ordem em que ajudam:

- [`AGENTS.md`](AGENTS.md) — mesmo contrato em forma portável (para Codex/Cursor/Copilot e afins). É derivado deste arquivo, não o substitui. **Ao mudar doutrina aqui, verifique se `AGENTS.md` desatualizou.**
- [`docs/index.md`](docs/index.md) — índice dos 149 docs, com regra de precedência quando dois docs discordam. Use antes de sair varrendo `docs/`.
- [`docs/current-state.md`](docs/current-state.md) — o que está pronto, incompleto e quebrado. **Leia antes de estimar ou prometer qualquer coisa.**
- [`docs/harness-audit.md`](docs/harness-audit.md) — onde a verificação tem buraco. Importante: `pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` — verde ali não é prova para mudança de schema ou de UI.
- [`docs/threat-model.md`](docs/threat-model.md) — superfície de ataque real do self-host.

---

## Visão (1 parágrafo)

DeskcommCRM é um sistema operacional de vendas open source com agentes de IA nativos — multi-nicho (e-commerce, clínicas, imobiliárias, infoprodutos, serviços), com WhatsApp como canal primário (via WAHA). Agentes com RAG por tenant atendem, qualificam e movem o funil junto com humanos; CRM inteiro exposto via MCP. Monetização = self-host em VPS (parceria HostGator), não assinatura. Arquitetura multi-tenant com RLS desde o dia 1; LGPD nativa. Posicionamento completo: `VISION.md`.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind 4 (config em CSS — ver abaixo) + shadcn/ui (style: `new-york`, neutral)
- **Backend:** Next.js Route Handlers (mesmo repo); workers via `event_log` table + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie SameSite=Strict, HttpOnly, Secure
- **Realtime:** Supabase Realtime (postgres_changes + broadcast)
- **Storage:** Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas)
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** `event_log` table + workers (não usar Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; embeddings pela OpenAI ou, por escolha da organização, pelo Google — `lib/ai/embeddings/chave.ts`); strings tipo `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod em todo input externo (request body, webhook payload, env)
- **Observability:** Sentry com `beforeSend` sanitizado

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all` aplicada via helper `fn_user_org_ids()`
- Service role bypassa RLS — handlers que usam admin client **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (cria 2 tenants, verifica não-vazamento) é obrigatório no CI antes de merge

### Idempotência & event sourcing leve
- Mensagens WhatsApp e eventos externos: `unique (organization_id, external_id)` + captura `code === '23505'` no INSERT
- POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h). O recibo mora no **Postgres** (`public.idempotency_keys`, único por organização + chave + endpoint), não no Upstash — ver `lib/api/idempotency.ts`. Quais rotas leem o header: `grep -rln 'Idempotency-Key' app/api/v1 --include='route.ts'`
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron / Realtime listener) consome e dispara side effect

### API REST `/api/v1/`
- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Wrapper sucesso: `{ data, meta?: { cursor, has_more, total } }`
- Wrapper erro: `{ error: { code, message, details? } }` — usar helpers `ok()` / `fail()` de `lib/api/wrappers.ts`
- Paginação: cursor opaco base64+HMAC por default
- **Auth dual é a direção do produto, e ela se cumpre rota por rota.** Cookie de sessão para o
  frontend; `Authorization: Bearer dsk_...` (linha de `api_tokens`, resolvida no servidor) para
  chamada de servidor. O prefixo é **`dsk_`**, e quem o exige é `lib/mcp/auth.ts` — `tok_` nunca
  existiu no código e estava escrito aqui, em `AGENTS.md` e na Spec 09 até 17/09/2026
  - O helper é `lib/api/auth-dual.ts`, e habilitar uma rota é **por rota**: não há chave geral.
    Para saber quais já aceitam bearer — o número muda, o comando não:
    `git grep -ln "auth-dual" -- app/api/v1` (mais `app/api/v1/contacts/route.ts`, que implementou
    o padrão inline e deu origem ao helper)
  - **Chamar o helper na rota não basta:** o `proxy.ts` global roda antes de qualquer handler e só
    reconhece cookie. Sem uma entrada em `lib/auth/public-paths.ts` para o caminho, todo bearer
    recebe 401 do proxy antes de chegar ao handler. "Público" ali quer dizer "o proxy não decide",
    nunca "sem autenticação"
  - Decisão do dono do produto em 17/09/2026: **converter as rotas que cada integração precisar**,
    conforme aparecerem, em vez de namespace paralelo por cliente. Uma rota convertida serve a todo
    integrador. Contexto: PR #1008, que escreveu 26 rotas paralelas porque não achou por onde entrar
- **API key NUNCA em query string** (vaza em logs Vercel/CF). Sempre header
- Plaintext de bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429
- Toda resposta de `ok()`/`fail()` leva o `X-Request-Id`, e é o mesmo do registro e da auditoria; as rotas que montam resposta à mão estão sendo migradas (issue #4107)

### Auth & RBAC
- Sempre `getUser()` (valida JWT no backend). NUNCA `getSession()` (confia no cookie local)
- 4 roles dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4)
- Super-admin de plataforma é uma role transversal — `is_platform_admin` (decisão final na Spec 01)
- MFA TOTP é **opcional e ligado por quem administra** — não é mais forçado por papel. Quem exige são duas políticas independentes que SOMAM: `platform_admins.mfa_required` (para o super-admin) e `organizations.settings.security.mfa_required` (com `mfa_required_min_role` escolhendo o nível mínimo — `admin` quando só o booleano legado existe — e `mfa_grace_days` de carência). O padrão de ambas é **não exigir**, e o `bootstrap-owner.ts` grava `false` explícito. Regra pura em `lib/auth/politica-mfa.ts`
  - **Por que mudou:** o gate era `isPlatformAdmin || role === "admin"`, sem opção, e o `install.sh` cria o dono como platform admin — então TODA instalação self-host recebia um bloqueador de tela cheia logo depois do onboarding, um passo que o wizard nunca anunciou. Decisão do dono do produto; segurança que expulsa o usuário na primeira tela não protege ninguém
  - **⚠️ CADASTRAR e PROVAR são perguntas diferentes.** A política decide o cadastro. Já `mfaEmDivida()` — o 403 `mfa_required` das rotas — NÃO consulta a política: quem TEM fator prova na sessão, sempre. Ligá-lo à política faria quem ativa a verificação por vontade própria ter o fator ignorado
  - Ligar/desligar vive em **Configurações › Segurança**; desligar o próprio fator exige sessão `aal2` (senão uma sessão roubada desliga a proteção com um clique)
- Permissão por pipeline (`user_pipeline_access`) **NÃO** entra no MVP
- Suporte temporário: todo handler mutante de `app/api/v1` declara `requireSupportWrite(`
  de `lib/impersonate/support.ts` **antes do efeito**. É guarda de efeito, não de papel — não substitui
  `requireRole`/RBAC/MFA — e é cobrada pelo gate `tests/unit/suporte-cobertura-de-efeitos.test.ts`

### Audit log
- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget). Cron que não fez nada **não** audita; o que fez, audita (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`)
- Append-only **no schema**: `anon`, `authenticated` e `service_role` sem GRANT de UPDATE/DELETE/TRUNCATE (migration 0258). Enumerar privilégio no dump não protege no Supabase real; só `revoke` explícito no apêndice
- Retenção default 5 anos (`AUDIT_LOG_RETENTION_DAYS`), executada por `fn_expurgar_auditoria_vencida` (piso de 90 dias no corpo), via cron `data-retention`. Não há camada cold/S3
- Falha de write em audit gera alerta Sentry, não bloqueia a mutação
- Os comandos de conferência, o histórico e o argumento de por que o expurgo não é porta de adulteração: [`docs/doctrine/auditoria.md`](docs/doctrine/auditoria.md)

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WAHA
- Imagem NOWEB pinada por arquitetura (`latest-2026.7.2` x86, `noweb-arm-2026.7.2` ARM64); engine NOWEB default
- Auth: env do WAHA recebe **hash SHA512 hex**; cliente envia plaintext em `X-Api-Key`. Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms; campanha 1 msg/5s; janela de disparo 7h-22h (knob por canal)
- STOP detection: uma regra só, em `lib/opt-out/deteccao.ts`, usada pela ingestão e pelo runtime. O Jev nunca bloqueia
- Mídia: Storage primeiro, URL ao WAHA. Multi-device: assinar `message.any`. Grupos: só os ligados em Conexões › Grupos
- Cron `recover-stuck-messages`: `sending` >5min vira `failed` + aviso na Central; **não toca `queued`** e não reenvia (envio em dobro é pior que não-envio)
- Detalhe, motivos e medições: [`docs/doctrine/waha.md`](docs/doctrine/waha.md)

### Marca própria (white-label)
- **Uma imagem Docker serve todas as marcas.** Nada de `NEXT_PUBLIC_*` para marca, nada de `public/favicon.ico`, nada de imagem por revendedor — a imagem é pré-buildada e o `update.sh` regrava `APP_IMAGE` incondicionalmente
- **O banco está ACIMA do `.env`.** `platform_branding` (instalação) e `organizations.settings.branding` (organização) são a fonte; `APP_NAME`/`APP_LOGO_URL`/`APP_ACCENT_HEX` são **semente e piso de rollback** (o `agent.sh` reverte a imagem, nunca o banco)
- **Resolvedor NUNCA lança.** `lib/branding/instalacao.ts` e `lib/branding/saida.ts` degradam para o padrão do produto e seguem: `branding()` roda em `app/layout.tsx`, e um throw ali é 500 em todas as telas
- **Saída sem DOM usa `marcaDaSaida()`** (`lib/branding/saida.ts`) — e-mail, remetente, ícone, `issuer` do MFA. Um hex e uma frente legível, tema **claro** sempre. Nunca passe `MarcaResolvida` a template de e-mail
- **O PDF de LGPD NUNCA leva marca.** Ele nomeia o **controlador** (`organizations.legal_name`) e o DPO resolvido. Nomear ali o revendedor — que é operador — inverteria papéis num documento que responde a direito legal. Vigiado em `tests/unit/mapas-de-arquitetura.test.ts`
- Vazamento de marca no código é vigiado por `tests/unit/branding.test.ts` (varre `app|components|lib|workers|hooks`), com allowlist que **só encolhe**. Contexto de venda em [`docs/white-label.md`](docs/white-label.md); mapa em `docs/architecture/marca-propria.architecture.json`

### Doutrina DIRC (antes de adicionar campo)
- **D**uplicar — vive aqui mesmo?
- **I**ntegrar — vem de outra tabela via FK?
- **R**eferenciar — só ponteiro?
- **C**alcular — pode ser computado on-demand?

### Modelagem
- 5 tabelas core CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` (polimórfica timeline), `crm_lead_links` (polimórficos vínculos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound `sending` ainda não tem ID WAHA)
- `type` é `text` + `check constraint`, **não enum** (enum é difícil de estender)
  - **Exceção deliberada — colunas de vocabulário ABERTO:** onde um clone pode ter linhas com valor
    legado (ex.: `crm_lead_activities.type`), o CHECK **não** entra: a constraint faria o `update.sh`
    do clone quebrar, e a doutrina de migrations proíbe. Nesses casos o vocabulário vive só no
    TypeScript, o emissor usa **constante compartilhada, nunca string literal**, e a coluna fica
    **fora** do invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre
    apenas colunas que JÁ têm CHECK. Ver o cabeçalho desse arquivo antes de "completar" o schema.
- **Exceção deliberada ao anti-pattern 4 — lista de ids sem FK (`uuid[]`):** aceita só quando as TRÊS
  condições valem — conjunto pequeno e com teto na rota (≤ 20), sempre lido e escrito JUNTO com a
  linha dona (nunca consultado por item), e o handler confere que todo id é membro da organização
  antes de gravar (recusa 422 nomeando quem ficou de fora) e o consumidor confere de novo ao usar.
  Caso aceito: `calendar_appointments.team_guest_user_ids` (migration 9209, doc de decisão 272) —
  quem publica no Google é um gatilho NA LINHA do compromisso, e tabela à parte exigiria um segundo
  mecanismo só para avisar a linha. O custo, conhecido e aceito: quem perde o acesso à organização
  segue na lista até a próxima edição (a publicação o descarta). Precedente anterior:
  `ai_agent_versions.pipeline_ids` e `knowledge_source_ids`. Faltando uma das três condições, é
  tabela com FK.
- `tags text[]` + GIN index; promove pra coluna gerada apenas quando vira hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` em pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger Postgres faz HTTP** (letal — espera rede dentro da transação)
10. Service role usado em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no DB (deve ser hash SHA256)
14. `console.log` deixado em código merged (use logger estruturado ou Sentry breadcrumb)

---

## Paths importantes

| Path | Conteúdo |
|---|---|
| `docs/prd/00-prd-master.md` | Visão geral, escopo MVP, KPIs |
| `docs/prd/01-prd-platform-base.md` | Auth, tenancy, RBAC, LGPD framework |
| `docs/prd/02-...06-` | Customer 360, WhatsApp, Pipeline, IA-RAG, Nuvemshop |
| `docs/specs/` | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| `docs/business-rules/` | Regras de negócio fora do código |
| `docs/research/reference-synthesis.md` | Arquitetura herdada do curso WAHA |
| `tasks/todo.md` | Workflow de construção atual |
| `app/globals.css` | **Tailwind 4 é CSS-first: não existe `tailwind.config.ts`.** Tokens em `:root` / `[data-theme]`, ponte token → utilitário no `@theme inline`, alcance do scanner nos `@source`. Vigiado por `tests/unit/tailwind-tokens.test.ts` |
| `lib/api/wrappers.ts` | `ok()`, `fail()`, tipos `ApiSuccess<T>` / `ApiError` |
| `lib/api/errors.ts` | Códigos de erro canônicos |
| `lib/env.ts` | Validação Zod das env vars (lança no startup se faltar crítica) |
| `lib/supabase/{browser,server,admin}.ts` | Clients canônicos |
| `app/api/v1/health/route.ts` | Health check (Supabase + Redis + WAHA) |
| `supabase/migrations/` | Schema versionado |
| `docs/runbooks/deploy.md` | **Deploy em produção — leia ANTES de mexer na VPS** |

---

## Deploy em produção (NÃO NEGOCIÁVEL)

**Numa VPS que já tem proxy reverso próprio (Hostinger, Coolify, Dokploy…), todo
`up -d` leva os DOIS arquivos de compose:**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Omitir `-f docker-compose.traefik.yml` recria o contêiner sem as labels de
roteamento; o Traefik da hospedagem deixa de enxergá-lo e **o domínio inteiro
responde `404 page not found`** — com o contêiner `healthy`, porque o
healthcheck é um probe TCP interno e não sabe nada de roteamento. Atrás do
Coolify a cara é outra: `503` com `no available server` no `https` (medido,
ver `docs/runbooks/deploy.md`).

**Numa VPS atrás de NAT (ou CGNAT, ou rede sem entrada), `REVERSE_PROXY=cloudflared`
entra o `docker-compose.cloudflared.yml`:** desliga o Caddy e sobe o `cloudflared`, que
publica por `app:3000` num túnel *remotely-managed* (só `CLOUDFLARE_TUNNEL_TOKEN` no
`.env`; hostnames e TLS no painel da Cloudflare). Nenhuma porta é publicada. O webhook
global do WAHA perde o 403 do Caddy; quem recusa o que chega pela borda é o próprio app
(`chegouPelaBorda`, `lib/http/ip-do-cliente.ts`). A assinatura do remetente é opcional e
desligada de fábrica (`/admin/sistema`). Não é suportado no single-server — o
instalador recusa. Ver `docs/runbooks/deploy.md` §5.

Depois de qualquer deploy, confirme que `/` responde **200** (a página inicial
pública) e `/app` responde **307** (redireciona pro login), e não 404. O 200
sozinho não prova que é o app: qualquer coisa no domínio responderia 200; o 307
de `/app` é o sinal específico. Verificações e o caso de build local em
`docs/runbooks/deploy.md`.

O caminho normal **não constrói nada na VPS**: commit → push → PR → merge na
`main` → o CI publica no GHCR → a VPS puxa. Imagem construída na VPS é exceção
de emergência e é dívida: existe só naquele disco e qualquer `up -d` sem
`APP_PULL_POLICY=never` a substitui em silêncio.

Essa frase já foi meia-verdade: valia para o `app` e era falsa para o produto,
porque o serviço `worker` não tinha `image:` — era construído na VPS de todo
cliente e nunca reconstruído por nenhum `update.sh`. Hoje os três serviços
nossos (`app`, `worker`, `scheduler`) são imagens publicadas, e um teste
reprova o retorno do padrão. Ver a doutrina abaixo.

---

## Packaging e distribuição — DOUTRINA (NÃO NEGOCIÁVEL)

Lei completa em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md);
decisões estruturais e o que foi recusado em
[`docs/adr/0001-packaging-e-distribuicao.md`](docs/adr/0001-packaging-e-distribuicao.md).
O não-negociável, em quatro linhas:

1. **Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do
   cliente.** Todo serviço declara `image:` de uma imagem publicada; `build:`
   só existe **ao lado**, como escape. Serviço `build:`-only é invisível para
   `docker compose pull` e imune a `up -d` sem `--build` — ele não é só caro de
   instalar, ele **nunca é atualizado**.
2. **Publicação é ato do CI.** Nunca da sua máquina: o CI publica as imagens
   nativas para linux/amd64 e linux/arm64, e a falha de arquitetura precisa
   aparecer antes do `up -d` do cliente. O job
   `imagens-ok` reprova quando qualquer uma das três imagens não constrói, e
   **é status check obrigatório desde 2026-08-13** — a branch protection tem
   `verify, build-and-size, invariants, e2e, imagens-ok`. (Este parágrafo dizia
   "ainda não é obrigatório" até 2026-08-14; a ativação era o passo final do
   merge da doutrina e aconteceu.) Confira na fonte antes de confiar nesta linha.
3. **Instalação de cliente aponta para número de versão, nunca para tag móvel.**
   `latest` aqui significa **topo da `main`**, não última release — quem quer a
   última release usa `stable`. `pull_policy` acompanha a mutabilidade da tag:
   imutável → `missing`, móvel → `always`.
4. **Dependência upstream é referenciada com tag fixa, nunca republicada.**
   Vale para WAHA (licenciado — republicar é passivo jurídico), Redis, Caddy e
   `serverless-redis-http`.

Bump de versão **não pode** exigir que o operador da VPS edite `.env`, compose
ou qualquer arquivo à mão. Se exigir, não entra: vira issue com plano de
migração e vai para uma major.
---

## Extensões — DOUTRINA (NÃO NEGOCIÁVEL)

Lei completa em [`docs/doctrine/extensoes.md`](docs/doctrine/extensoes.md); o
contrato que existe hoje em
[`docs/specs/extensoes-declarativas-v1.md`](docs/specs/extensoes-declarativas-v1.md).
A pergunta que decide o destino de uma mudança não é "isto serve a muita gente?",
e sim **"se nenhuma organização ativar isto, a operação comum continua inteira?"**.
O não-negociável:

1. **O núcleo continua útil com zero extensões.** Identidade, autorização,
   isolamento, auditoria, contratos e cadeia de envio são núcleo; jornada de nicho,
   aparência e integração com dados e manutenção próprios podem ser extensão.
2. **Extensão pede capacidade nomeada; não importa código interno nem lê o banco.**
   Instalar não concede autoridade: toda escrita revalida ator, organização e papel
   atuais no banco.
3. **A instância decide o pacote; a organização decide o uso.** Instalar, atualizar,
   desfazer e remover são do administrador da instalação; ativar e configurar, do
   administrador da organização. A plataforma não reativa decisão da organização.
4. **Toda operação é recibo idempotente com saída pela tela, e toda troca de
   ponteiro exige a revisão que a tela viu.** Tirar é lógico e preserva dados.
5. **Não anunciar o que não existe** (SDK, código isolado, marketplace público), e
   não extrair do núcleo recurso já distribuído sem equivalência e migração.
6. **Módulo oficial com dados não põe tabela no baseline para todos**
   ([ADR-0002](docs/adr/0002-tabelas-de-modulo-num-banco-so.md), aceita em 17/09/2026). Um banco
   só, schema `public`; as tabelas nascem por função provisionadora fixa do módulo, quando ele é
   **instalado na instância**. Ninguém opera segundo banco — é decisão do dono, e seria impossível
   com chave estrangeira para o núcleo.

---

## Como rodar local

```bash
nvm use                    # node 22
pnpm install               # o gerenciador é pnpm (packageManager no package.json), não npm
cp .env.example .env.local  # preencher
docker compose up -d        # WAHA local
pnpm dev                    # http://localhost:3000
pnpm worker                 # agent-worker (processo separado do Next)
pnpm dev:crons              # chama localmente só os crons de PATHS em scripts/dev-crons.ts (não todos)
```

Schema: aplique `supabase/baseline.sql`, **não** as migrations (a cadeia não sobe do zero).
Stack local completa (Supabase via `scripts/local-supabase.sh`; app, worker, scheduler, WAHA e Redis via `docker-compose.local.yml`), depois de rodar
`./ubuntu-local-installer.sh` uma vez: `pnpm local:up | local:down | local:status | local:logs`.
Ver `README.md` pra detalhes de setup.

---

## Testes

```bash
pnpm typecheck   # tsc --noEmit (inclui tests/)
pnpm lint        # eslint
pnpm test:unit   # Vitest — SEM caminho (alcança o repo inteiro; NÃO inclui tests/invariants/**)
pnpm test:db     # Postgres efêmero + baseline install/update + invariantes (RLS)
pnpm test:e2e    # Playwright (requer dev server)
pnpm gov:verify  # typecheck + lint + lint:channels + lint:role-rank + test:unit
pnpm cercas | test:journeys | format:check
pnpm vitest run lib/foo/bar.test.ts   # um arquivo; -t "nome" um caso; pnpm test:db tests/invariants/x.test.ts
```

- **`test:unit` não é `tests/unit/`.** `vitest run tests/unit` é um verde menor. Rode `pnpm test:unit`, sem caminho
- **Gate escolhido não é suíte.** Antes de abrir PR, rode a suíte inteira
- **Não corte a saída com `tail`.** `> /tmp/vt.log 2>&1; echo exit=$?`; o **exit code é a autoridade**, o rodapé e o `grep FAIL` o explicam (e a linha `Errors` pode reprovar com 0 falhas)
- **Invariantes não estão no `test:unit`:** rodar só `test:unit` e concluir "verde" é falso verde para RLS. Mexeu em schema/RLS/RBAC/roteamento/webhooks? Rode `pnpm test:db` local
- **Checks obrigatórios da `main`:** `verify, build-and-size, invariants, e2e, imagens-ok`. Reconfira na fonte: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`
- Em PR que pula partes do e2e, o verde **não prova tela nenhuma**
- Vermelho conhecido que não é seu: `lib/ai/dispatcher/rate-limit.test.ts` com `UPSTASH_*` no `.env.local` e Redis fora do ar
- Procedimento completo (reconciliar falhas, e2e `FORA_DO_CI`, executor próprio, fila de merge): [`docs/doctrine/testes-e-gates.md`](docs/doctrine/testes-e-gates.md)

## QA Visual com Recursos Reais — DOUTRINA (produto self-host)

**A experiência de quem instala numa VPS É o produto.** Toda feature nova ou fix visível é provada pela **tela**, como um leigo usaria, antes de "pronto" (`curl` valida backend, não UX):

- Prova dirigindo o browser (Playwright) com conta de teste real; banco fresco do `supabase/baseline.sql` + `scripts/bootstrap-owner.ts`; dependências como na VPS; **envs opcionais AUSENTES**; efeito externo provado com receiver real
- Prioridade: onboarding e primeiras ações (`[P0]`). Registro em `docs/testing/user-journey-map.md`; evidência em `evidence/<entrega>/` (versionada)
- Bug achado → conserta na causa raiz, com migration se tocar schema. Medidas de front-end por ferramenta, nunca a olho
- Receita de ambiente fresco (pg15, `next build` + `next start`, worktree com `node_modules` real fora de `/tmp`): [`docs/doctrine/qa-visual.md`](docs/doctrine/qa-visual.md)

## Higiene de branches — DOUTRINA (NÃO NEGOCIÁVEL)

**`main` é produção e é a fonte da verdade. Toda branch começa e se mantém atualizada com a `main`.** Trabalho iniciado numa branch atrasada gera conflito e retrabalho — é a causa número um de "cagada" em ambiente multi-sessão. Regra:

1. **ANTES de começar QUALQUER trabalho numa branch, atualize-a com a `main`:** `git fetch origin && git merge origin/main` (traz produção pra dentro). Se a branch ainda não tem commits próprios, é fast-forward puro (`git merge --ff-only origin/main`). Não codar antes disso.
2. **NUNCA `reset --hard`/force pra "atualizar"** — apaga trabalho. Só dois caminhos: **fast-forward** (branch sem commits próprios) ou **merge da `main` pra dentro** (preserva os dois lados). `main` nunca é reescrita.
3. **NUNCA toque numa branch/worktree com working tree sujo que não é seu.** Antes de atualizar qualquer branch, cheque `git status` e `git worktree list` — se está suja e é de outra sessão, **deixe quieto** e avise. Merge só entra em árvore limpa.
4. **Quando uma feature entra na `main`, todas as outras branches ficam atrasadas na hora.** Quem for retomar qualquer uma delas aplica a regra 1 primeiro. Ao fim de uma feature, considere propagar a `main` para as branches vivas limpas (FF as sem trabalho próprio; merge nas divergentes limpas; pular as sujas/conflitantes e reportar).
5. **Conflito ao atualizar = pare e resolva com cabeça** (ou escale), nunca escolha um lado no automático numa branch que não é sua. Preservar trabalho > branch "verde rápido".

---

## Migrations & Banco — DOUTRINA (projeto open-source)

**Toda mudança de schema sai como migration versionada** — quem clonou uma versão antiga precisa atualizar aplicando em ordem. Nunca `ALTER`/`CREATE` solto. O fluxo, em resumo:

1. Arquivo `supabase/migrations/<timestamp>_<NNNN>_<slug>.sql`. `NNNN` é o teto da `main` **mais tudo em voo** — meça com `pnpm checar:colisao-de-migration`, nunca pelo `ls`. Quem mescla primeiro fica com o número
2. Idempotente (`if not exists`, `create or replace`), portável em `psql` puro, **sem** `BEGIN`/`COMMIT` nem temp table
3. Linha `-- manifest: <o quê e o porquê>` no cabeçalho do `.sql` (o `MANIFEST.md` é histórico: não recebe linha nova)
4. **Apêndice idempotente e auto-curativo no `supabase/baseline.sql`** — é o único que chega ao self-hoster. Constraint nova: deduplicar/corrigir os dados ANTES
5. Função nova em `public` nasce exposta: `revoke execute ... from public, anon` (**as duas origens**) e grant só a quem precisa
6. No baseline, a definição que vale é a **última** (`rfind`, nunca `find`); melhor ainda, perguntar ao banco com `pg_get_functiondef`
7. Aplique e prove num Postgres descartável (install com `ON_ERROR_STOP=1` + update); regenere `lib/database.types.ts` se mexeu em contrato. Nunca edite migration já aplicada: forward-fix

Receita completa, com os motivos e as medições: [`docs/doctrine/migrations.md`](docs/doctrine/migrations.md)

## Skills relevantes a usar (Claude Code)

**Guias embutidos neste repositório** (`.claude/skills/`, espelho gerado de `.agents/skills/` — a
mesma tabela vale para Codex, Cursor, OpenCode e Antigravity; ver `AGENTS.md`). Para tê-los em
qualquer pasta, `bash scripts/instalar-guias.sh`; editando um guia numa branch, rode com `--fonte .`
naquele clone — no Claude Code a skill GLOBAL vence a do projeto com o mesmo nome:

- `deskcomm-instalar` — instalar, atualizar ou consertar a instalação numa VPS
- `deskcomm-operacao` — usar o CRM no dia a dia, encontrar telas, fluxos e configurações pela interface
- `deskcomm-curso` — atualizar aulas, traduções e capturas do curso a partir das mudanças do produto
- `deskcomm-cliente-novo` — configurar o CRM para um cliente ou nicho (agentes, roteadores, follow-ups, conhecimento)
- `deskcomm-saas` — revender o CRM como SaaS: planos, cobrança pela Stripe ou pelo Asaas, régua, contrato
- `deskcomm-metricas` — desempenho, conversão, custo de IA, funil, relatório
- `deskcomm-prompt` — afinar o prompt de um agente que não performa
- `deskcomm-contribuir` — o espelho da triagem, antes do PR; fica quieto para o mantenedor
- `deskcomm-extensao` — criar extensão em vez de PR no núcleo: régua de destino, contrato do pacote e envio
- `deskcomm-doutrina` — as três regras que mais custam, antes de escrever código

Os guias têm página pública em [deskcomm.com.br/guias](https://www.deskcomm.com.br/guias), escrita
à mão em `deskcomm-site/conteudo/guias.ts`: guia criado, renomeado ou com comando novo pede a mesma
mudança lá — senão a página ensina um guia que não existe. Ela e a de changelog saem do mesmo PR do
`deskcomm-site`; enquanto as duas não responderem 200, vale o `curl` que abre a seção "A vitrine" de
[`docs/doctrine/versionamento.md`](docs/doctrine/versionamento.md), não a frase acima.

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — pra task com mais de 1 etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bugs reportados
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `tomik-db-doctrine` — referência cruzada de doutrina de schema
- `supabase:supabase` — qualquer task com Supabase
- `vercel:nextjs` — App Router, Server Components, edge runtime
- `vercel:ai-gateway` — config de fallback de provider
- `frontend-design` — UI distinta (não cair em shadcn-default genérico)

---

## Definition of Done

Antes de declarar uma task pronta:

1. `pnpm typecheck` passa zerado
2. `pnpm lint` zerado
3. Testes unit/e2e relevantes existem e passam
4. RLS testada se feature toca tabela tenant-aware
5. Audit log emitido se há mutação relevante
6. Rate limit aplicado se rota é pública
7. Zod valida todo input externo
8. Sem `console.log` esquecido
9. Env vars novas adicionadas em `.env.example` + `lib/env.ts`
10. Doc atualizada se mudou contrato (PRD/spec)
11. **Mudança de schema saiu como migration versionada (com `-- manifest:` no cabeçalho) + apêndice no baseline** (ver Doutrina de Migrations) — clones conseguem atualizar
12. **Se tocou UI/fluxo de usuário: provado pela tela como um leigo faria**, em ambiente fresco estilo VPS, com evidência visual (ver Doutrina de QA Visual com Recursos Reais) — curl não conta. Quando o caminho passa por um agente de IA, o caso de aceite mede o **par** (a tela pelo agente + a ferramenta chamada direto, com o mesmo texto cru) e só conta como prova quando os dois concordam — emenda em [`docs/doctrine/prova-em-par.md`](docs/doctrine/prova-em-par.md) (#489)
13. **Living System Checklist respondido** (lei em `docs/doctrine/sistema-vivo.md`; racional no manual `docs/doctrine/sistema-vivo/`) — a feature não é ilha: tem entrada + saída, emite atividade/log, aparece na tela, tem porta na navegação, tem mecanismo anti-morte, **declara seu laço de retorno** (invariante 7 — o que muda no sistema quando ela erra), e o mapa vivo (`docs/architecture/`) reflete peça nova com ≥2 arestas. Resposta que não **nomeia o artefato concreto** (consumidor real, tela real, log real) não conta
14. **Tela nova tem porta** — declarada em **`lib/navigation/catalogo.ts`** (no `NAV_CATALOG`, com seu grupo), ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes: o CI reprova tela que existe mas em que só se chega digitando a URL.

    ⚠️ Esta linha dizia `lib/navigation/registry.ts`, e quem a seguisse abria um
    arquivo **sem um único lugar onde declarar**: o `registry.ts` só deriva
    (`NAV_DESTINATIONS` sai de `NAV_CATALOG`) e reexporta. Ele é a FACE do
    módulo — é dele que o teste importa, e por isso o engano é fácil. Quem
    declara é o catálogo. Para conferir sem acreditar nesta linha:

    ```bash
    grep -c 'href:' lib/navigation/catalogo.ts lib/navigation/registry.ts
    ```
15. **Se tocou Dockerfile, compose ou setup kit: a mudança chega a quem já instalou** (lei em `docs/doctrine/packaging.md`) — nenhum serviço de produção ficou `build:`-only; variável nova tem default que não quebra `.env` antigo; a atualização não pede edição manual de arquivo; e, se mudou o que a imagem contém, o `update.sh` alcança essa peça. Rode `pnpm test:shell` — é o único gate que exercita o kit
16. **Se o PR muda comportamento, procure a afirmação de estado sobre esse comportamento.** Só
    sobre o que você mudou, e só nos documentos de autoridade — não saia caçando pelo repo. A
    documentação afirma como o mundo *está*, e uma auditoria de 2026-08-14 achou **227
    afirmações desatualizadas em 393 medidas**
    ([`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md)).
    Onde a afirmação puder virar **comando**, troque em vez de corrigir: um número corrigido
    envelhece de novo; um `rode isto para saber` não envelhece nunca

17. **Se o PR muda comportamento visível a quem opera uma VPS, ele traz o seu fragmento em
    `.changes/`** (lei em [`docs/doctrine/versionamento.md`](docs/doctrine/versionamento.md)).
    O fragmento declara **o efeito no operador** — `nada_mudou` / `capacidade_nova` /
    `exige_acao` —, nunca o número: o número é calculado a partir do conjunto, e é por isso
    que duas sessões paralelas não colidem mais. Confira com `pnpm release:conferir`.
    O CI valida a FORMA de todo fragmento, mas **não** cobra a presença de um — cobrar
    presença num check obrigatório reprovaria PR de Dependabot, PR de fork, e o próprio PR
    de release, que consome os fragmentos e deixa o diretório vazio. A presença é cobrada
    aqui, e por quem revisa.
    **Toda versão publicada aparece na página de changelog da LP** (deskcomm.com.br/changelog,
    pt-BR/en/es). Ninguém escreve no site: a LP lê o `CHANGELOG.md` da `main`, e o último passo
    do corte (`release.yml`, job `cortar-tag`) reprova quando a versão não chegou. O texto do
    fragmento é, portanto, nota pública. Enquanto as três páginas não responderem 200 esse passo
    reprova TODO corte — a vitrine vem de um PR do `deskcomm-site`, e o `curl` que diz em que
    estado ela está abre a seção. Lei: seção "A vitrine" de `versionamento.md`.

18. **Se o PR muda comportamento, ele declara o destino: núcleo, extensão, ambos ou
    infraestrutura** (lei em [`docs/doctrine/extensoes.md`](docs/doctrine/extensoes.md)), com a razão
    medida pela pergunta "se nenhuma organização ativar isto, a operação comum continua inteira?".
    "Ambos" traz o consumidor real do ponto novo do núcleo e a prova dos dois lados. Classificar como
    extensão não autoriza remover nem desligar o que já foi distribuído.

Um staff engineer aprovaria? Se não, itera.
