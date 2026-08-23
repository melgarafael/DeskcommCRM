# CLAUDE.md — DeskcommCRM

> **Doutrina de código deste repositório.** Autoridade final sobre convenção, schema e
> anti-pattern. Leitura obrigatória antes de qualquer task de código.

## Precedência — qual documento vence

| #   | Documento                                    | Papel                                                                                                                           |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [`.ai/AI_BOOTSTRAP.md`](.ai/AI_BOOTSTRAP.md) | Porta de entrada: o que ler, nesta ordem, e as regras que evitam dano                                                           |
| 2   | **`CLAUDE.md`** (este)                       | Doutrina. Vence qualquer outro documento em conflito de regra                                                                   |
| 3   | [`AGENTS.md`](AGENTS.md)                     | O mesmo contrato em forma portável (Codex, Cursor, Copilot, Amp). É derivado deste arquivo — ao mudar doutrina aqui, atualize-o |
| 4   | [`docs/index.md`](docs/index.md)             | Índice dos documentos, com a regra de precedência interna de `docs/`                                                            |

Acima dos quatro está **o repositório**: código, `package.json`, workflows e `gh api` medem o
estado; a prosa apenas o descreve. Onde os dois discordarem, a prosa está errada — corrija-a.

**Por isso este arquivo evita número volátil.** Contagem de rota, de teste e de spec envelhece
entre um PR e o próximo, e uma triagem que a use como régua mede contra o número errado. Onde a
afirmação puder virar comando, ela vira comando.

Complementos por assunto:

- [`docs/current-state.md`](docs/current-state.md) — o que está pronto, incompleto e quebrado. Leia antes de estimar ou prometer.
- [`docs/harness-audit.md`](docs/harness-audit.md) — onde a verificação tem buraco.
- [`docs/threat-model.md`](docs/threat-model.md) — superfície de ataque real do self-host.
- [`VISION.md`](VISION.md) — posicionamento, nicho e monetização.

---

## Visão

DeskcommCRM é um sistema operacional de vendas open source com agentes de IA nativos —
multi-nicho (e-commerce, clínicas, imobiliárias, infoprodutos, serviços), com WhatsApp como canal
primário (via WAHA). Agentes com RAG por tenant atendem, qualificam e movem o funil junto com
humanos; o CRM inteiro é exposto via MCP. Monetização = self-host em VPS (parceria HostGator),
não assinatura. Multi-tenant com RLS desde o dia 1; LGPD nativa.

**A consequência que muda como você trabalha:** o produto é distribuído como código, e quem
instala numa VPS **é** o usuário. Mudança que funciona na sua máquina e quebra no clone fresco é
bug de produto, não detalhe de ambiente.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router · React 19 · TypeScript 6 estrito · Tailwind 3 · shadcn/ui (style `new-york`, neutral)
- **Backend:** Route Handlers no mesmo repo; workers via tabela `event_log` + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie `SameSite=Strict`, `HttpOnly`, `Secure`
- **Realtime:** Supabase Realtime (`postgres_changes` + broadcast) · **Storage:** bucket `whatsapp-media` privado, URLs assinadas
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** tabela `event_log` + workers (sem Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; OpenAI backup para embeddings); modelos como `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod 4 em todo input externo (body, webhook, env)
- **Testes:** Vitest 4 · Playwright 1 · **Observability:** Sentry 10 com `beforeSend` sanitizado
- **Runtime:** Node ≥22 (`.nvmrc`) · **Gerenciador:** pnpm (campo `packageManager` do `package.json`)

Só a **major** é declarada, aqui e no `AGENTS.md`: é onde o idioma da biblioteca muda, e é o que
`tests/unit/agents-md-versoes.test.ts` cobra contra o `package.json`. Para a versão exata, a fonte
é o `package.json`. **Versão do produto** é a do topo do `CHANGELOG.md`
(`grep -m2 -E '^## \[' CHANGELOG.md`), com tag git correspondente — o campo `version` do
`package.json` não é fonte de nada e não é lido em runtime.

---

## Como rodar local

O passo a passo completo (extensões do Postgres, `.env.local`, WAHA) está no
[`README.md`](README.md) e em [`docs/SETUP.md`](docs/SETUP.md). O essencial:

```bash
nvm use                      # Node 22
npm install -g pnpm && pnpm install
cp .env.example .env.local   # guia em docs/SETUP.md
docker compose up -d         # WAHA local (opcional em dev sem WhatsApp)
pnpm dev                     # http://localhost:3000
```

**Schema local: aplique `supabase/baseline.sql`, NUNCA a cadeia de `supabase/migrations/`.**
Migrations antigas são stubs `SELECT 1;` — a cadeia não sobe do zero, `supabase db push` "passa" e
deixa o banco vazio. O baseline é o mesmo artefato que o `install.sh` aplica na VPS.

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy

- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all`, aplicada via helper `fn_user_org_ids()`
- Service role **bypassa RLS**: handler que usa o admin client **DEVE** filtrar `organization_id`
  manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token) e **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (2 tenants, prova de não-vazamento) é obrigatório antes do merge — roda no check `invariants`

Quais handlers usam o admin client hoje:
`grep -rl 'supabase/admin\|createAdminClient' app/api --include='route.ts'`

### Idempotência & event sourcing leve

- Mensagem de WhatsApp e evento externo: `unique (organization_id, external_id)` + captura de `code === '23505'` no INSERT
- POST de criação aceita `Idempotency-Key: <uuid>` (TTL 24h via Upstash). **A adoção é parcial** —
  o contrato promete em todo POST de criação e a implementação não chegou lá. Meça antes de
  afirmar cobertura: `grep -rln 'Idempotency-Key' app/api --include='*.ts'`
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron ou listener
  de Realtime) consome e dispara o side effect

### API REST `/api/v1/`

- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Sucesso: `{ data, meta?: { cursor, has_more, total } }` · Erro: `{ error: { code, message, details? } }`
- Use sempre `ok()` / `fail()` de `lib/api/wrappers.ts` com código de `lib/api/errors.ts`. Nunca
  monte `Response` na mão nem deixe `throw` cru na borda
- Paginação: cursor opaco base64+HMAC por default
- Auth dual: cookie de sessão (frontend) **ou** `Authorization: Bearer tok_...` (server-to-server)
- **API key NUNCA em query string** (vaza em log de proxy/CDN) — sempre header
- Plaintext do bearer é mostrado **uma vez**, na criação; no banco só hash SHA256
- `X-RateLimit-*` + `Retry-After` no 429 · `X-Request-Id` em toda response (correlaciona com o audit log)

### Auth & RBAC

- Sempre `getUser()` (valida o JWT no backend). **NUNCA `getSession()`** (confia no cookie local)
- 4 papéis dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4). Guard
  canônico: `requireRole()` em `lib/auth/require-role.ts`
- Super-admin de plataforma é papel transversal — `is_platform_admin`
- Permissão por pipeline (`user_pipeline_access`) **não** entra no MVP
- **MFA TOTP é opcional e ligado por quem administra.** Quem exige são duas políticas
  independentes que somam: `platform_admins.mfa_required` (super-admin) e
  `organizations.settings.security.mfa_required` (admin do tenant). O default de ambas é **não
  exigir**, e `scripts/bootstrap-owner.ts` grava `false` explícito. A regra pura vive em
  `lib/auth/politica-mfa.ts`
  - **Por quê:** o gate era `isPlatformAdmin || role === "admin"`, sem opção, e o `install.sh` cria
    o dono como platform admin — então toda instalação self-host recebia um bloqueador de tela
    cheia logo depois do onboarding, um passo que o wizard nunca anunciou. Segurança que expulsa o
    usuário na primeira tela não protege ninguém
  - **CADASTRAR e PROVAR são perguntas diferentes.** A política decide o cadastro. O 403
    `mfa_required` das rotas (`mfaEmDivida()`) **não** consulta a política: quem TEM fator prova na
    sessão, sempre. Ligá-lo à política faria quem ativou a verificação por vontade própria ter o
    fator ignorado
  - O liga/desliga vive em **Configurações › Segurança**; desligar o próprio fator exige sessão
    `aal2` — senão uma sessão roubada desliga a proteção com um clique

### Audit log

- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- Falha de escrita no audit gera alerta no Sentry; **não** bloqueia a mutação principal
- **Rodada de cron que não fez nada NÃO é mutação e não audita** — e a que fez, audita. Auditar
  incondicionalmente enchia o log com batida vazia (numa VPS real, a maior parte do audit log). A
  guarda certa é _auditar quando houve efeito_, nunca _parar de auditar_; as duas direções são
  medidas por `tests/unit/cron-audita-so-quando-ha-efeito.test.ts`, que varre o AST de **toda**
  rota de `app/api/v1/cron/`
- **Append-only é do SCHEMA, não da prosa:** nenhum papel tem GRANT de UPDATE/DELETE em
  `api_audit_log` — nem `service_role`. Confira na fonte:

  ```bash
  psql "$SUPABASE_DB_URL" -c "select grantee, privilege_type from information_schema.role_table_grants
    where table_name='api_audit_log' and privilege_type in ('DELETE','UPDATE','TRUNCATE');"
  ```

  **`TRUNCATE` entra na consulta de propósito, e o resultado não vem vazio:** ele está concedido a
  `anon`, `authenticated` e `service_role`, resíduo de o dump enumerar os privilégios desta tabela.
  Não é alcançável pela REST (o PostgREST não emite `TRUNCATE`), então não é buraco de superfície —
  mas uma sonda que pergunte só por `DELETE`/`UPDATE` devolve zero linhas e deixa quem leu
  concluindo que a tabela não pode ser esvaziada, quando o privilégio que a esvazia INTEIRA está lá

- **Retenção default de 5 anos, configurável e executada.** O expurgo é
  `public.fn_expurgar_auditoria_vencida` (`security definer`, **piso de 90 dias dentro do corpo**,
  revogada de anon/authenticated), chamada em lotes pelo cron `app/api/v1/cron/data-retention`
  (diário). O knob é `AUDIT_LOG_RETENTION_DAYS`; a regra em vigor:
  `grep -n "RETENCAO_AUDITORIA_DIAS" lib/retencao/politica.ts`
- **Não há camada cold/S3.** Um self-host não tem para onde arquivar: o Storage do cliente é a
  MESMA cota, já dividida com `whatsapp-media`
- Por que uma `security definer` de expurgo não é porta de adulteração: ela **não tem seletor de
  linha** — nenhum parâmetro de org, ator, ação ou id, e o único predicado é
  `created_at < now() - N dias`; o piso mora **no corpo**, não em quem chama; não é alcançável pela
  REST; não amplia o raio de quem já tem a service key; e **registra a própria erosão**
  (`retention.sweep_run`, com a contagem, numa linha nova demais para a chamada seguinte alcançar).
  Argumento completo no cabeçalho da migration 0167

### LGPD

- Anonimização é preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: `data_request` entregue em D+7; redact executado em D+15
- Audit obrigatório: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### WhatsApp / WAHA

- WAHA **Plus** obrigatório (o Core não suporta multi-tenant, não tem retry nem S3). Engine NOWEB
  default; WEBJS só se precisar de sticker animado / botão
- Auth: o env do WAHA recebe **hash SHA512 hex** da api key; o cliente envia o plaintext em `X-Api-Key`
- Webhook: HMAC SHA512 com `crypto.timingSafeEqual`, fail-closed quando o secret falta
- Anti-banimento: throttle 1 msg/1,2s + jitter ≤800ms; campanha 1 msg/5s; warm-up 7–14 dias;
  spinning de copy; janela 7h–22h (domingo liberado por default; a janela é knob por canal)
- **Opt-out (STOP):** a regra mora em `lib/opt-out/deteccao.ts` e é a MESMA nos dois lados — a
  ingestão (que grava `is_blocked=true`) e o runtime do agente. **Não é palavra solta:** bloqueia
  palavra ISOLADA (a mensagem inteira é a palavra) ou verbo de cessação com OBJETO DE COMUNICAÇÃO
  ("parar de me mandar", "sair da lista"). Enquanto eram duas regras, a ingestão bloqueava paciente
  que perguntou "tem como parar a dor?". Vocabulário em vigor:
  `grep -n 'PALAVRAS_DE_OPT_OUT' -A20 lib/opt-out/deteccao.ts`; frases de controle em
  `tests/unit/opt-out-deteccao.test.ts`. **Espanhol ainda não é coberto** (`baja`, `salir`, `no quiero recibir`)
- Mídia: sobe para o Supabase Storage primeiro e passa a URL ao WAHA (nunca base64 inline)
- Multi-device: assine `message.any` (não só `message`); trate `fromMe=true` sem duplicar
- Grupos: pule o binding com o CRM se `chatId.endsWith('@g.us')`. O remetente é `p.author`, não `p.from`
- O cron `app/api/v1/cron/recover-stuck-messages/route.ts` marca `status='sending'` há >5min como
  `failed` **e abre aviso na Central** (`agent_inbox_items`, kind `message_send_stuck`). Não toca em
  `queued` — esse estado tem dono (o agent-engine reagenda por `SEND_QUEUED_RETRY_MS`) e falhá-lo
  perderia mensagem que ia sair. Não reenvia: envio em dobro é pior que não-envio

### Marca própria (white-label)

O produto é revendido, e o nome não é seu.

- **Nunca escreva "Deskcomm"/"DeskcommCRM" em código que alcança o usuário.**
  `tests/unit/branding.test.ts` varre `app|components|lib|workers|hooks` e reprova; a allowlist **só encolhe**
- **Uma imagem Docker serve todas as marcas.** Nada de `NEXT_PUBLIC_*` para marca, nada de
  `public/favicon.ico`, nada de imagem por revendedor
- **O banco está ACIMA do `.env`:** `platform_branding` (instalação) e
  `organizations.settings.branding` (organização) são a fonte; `APP_NAME` / `APP_LOGO_URL` /
  `APP_ACCENT_HEX` são **semente e piso de rollback** (o `agent.sh` reverte a imagem, nunca o banco)
- **O resolvedor NUNCA lança:** `lib/branding/instalacao.ts` e `lib/branding/saida.ts` degradam para
  o padrão do produto e seguem. `branding()` roda em `app/layout.tsx`, e um throw ali é 500 em todas as telas
- **Saída sem DOM usa `marcaDaSaida()`** (`lib/branding/saida.ts`) — e-mail, remetente, ícone,
  `issuer` do MFA: um hex e uma frente legível, tema claro sempre. Nunca passe `MarcaResolvida` a
  template de e-mail
- **O PDF de LGPD NUNCA leva marca.** Ele nomeia o **controlador** (`organizations.legal_name`) e o
  DPO resolvido. Nomear ali o revendedor — que é operador — inverteria papéis num documento que
  responde a direito legal. Vigiado em `tests/unit/mapas-de-arquitetura.test.ts`
- Contexto de venda em [`docs/white-label.md`](docs/white-label.md); mapa em `docs/architecture/marca-propria.architecture.json`

### Doutrina DIRC (antes de adicionar campo)

**D**uplicar — vive aqui mesmo? · **I**ntegrar — vem de outra tabela via FK? ·
**R**eferenciar — só ponteiro? · **C**alcular — dá para computar on-demand?

### Modelagem

- 5 tabelas core de CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`
  (timeline polimórfica), `crm_lead_links` (vínculos polimórficos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound em `sending` ainda não tem ID do WAHA)
- `type` é `text` + check constraint, **não enum** (enum é difícil de estender)
  - **Exceção deliberada — coluna de vocabulário ABERTO:** onde um clone pode ter linha com valor
    legado (ex.: `crm_lead_activities.type`), o CHECK **não** entra: a constraint quebraria o
    `update.sh` do clone, e a doutrina de migrations proíbe. Nesses casos o vocabulário vive só no
    TypeScript, o emissor usa **constante compartilhada, nunca string literal**, e a coluna fica
    **fora** do invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre
    apenas colunas que JÁ têm CHECK. Leia o cabeçalho desse arquivo antes de "completar" o schema
- `tags text[]` + índice GIN; promove para coluna gerada só quando virar hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` no pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente,
  deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (`owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto, sem schema central)
7. Cascade fantasma (deletar contact em cascade nas messages perde histórico)
8. Polimórfico sem padronização (`target_kind` gravado diferente em cada lugar)
9. **Trigger Postgres fazendo HTTP** (letal — espera rede dentro da transação)
10. Service role em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no banco (deve ser hash SHA256)
14. `console.log` em código merged (use `lib/logger.ts` ou breadcrumb do Sentry)

---

## Paths importantes

| Path                                                                         | Conteúdo                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app/api/v1/`                                                                | Route handlers REST (versionado por path)                              |
| `app/api/internal/`, `app/api/mcp/`, `app/api/v1/cron/`                      | Superfícies não-cookie (secret / bearer próprio)                       |
| `app/app/`, `app/admin/`                                                     | UI autenticada do tenant · UI de plataforma                            |
| `app/actions/`                                                               | Server Actions (auth, onboarding, team, settings)                      |
| `lib/agent-engine/`, `lib/ai/`                                               | Runtime do agente, guardrails, RAG, dispatcher                         |
| `lib/api/wrappers.ts`                                                        | `ok()` / `fail()` e os tipos `ApiSuccess<T>` / `ApiError`              |
| `lib/api/errors.ts`                                                          | Códigos de erro canônicos                                              |
| `lib/auth/require-role.ts`                                                   | `requireRole()` — guard canônico de RBAC                               |
| `lib/env.ts`                                                                 | Validação Zod das env vars (lança no startup se faltar crítica)        |
| `lib/supabase/browser.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts` | Clients canônicos                                                      |
| `lib/navigation/registry.ts`                                                 | Registro de telas — é o que dá porta a uma tela nova                   |
| `workers/`                                                                   | Workers de `event_log` + crons                                         |
| `proxy.ts`                                                                   | Middleware do Next 16 (auth de borda, `X-Request-Id`)                  |
| `supabase/migrations/`                                                       | Schema versionado · `supabase/baseline.sql` = o que o self-host aplica |
| `docs/prd/00-prd-master.md`                                                  | Visão geral, escopo do MVP, KPIs                                       |
| `docs/specs/`                                                                | Specs técnicas (schema SQL, payloads exatos)                           |
| `docs/business-rules/`                                                       | Regras de negócio fora do código                                       |
| `docs/runbooks/deploy.md`                                                    | **Deploy em produção — leia ANTES de mexer na VPS**                    |

### Arquivos e diretórios SENSÍVEIS

- **`supabase/baseline.sql`** — é o que o `install.sh`/`update.sh` aplicam. Mudança de schema que
  não aparece aqui **não chega a quem instalou**
- **`supabase/migrations/`, arquivos já aplicados** — nunca edite; corrija com migration nova
- **`lib/supabase/admin.ts`** — service role bypassa RLS; o filtro de `organization_id` é sua responsabilidade
- **`lib/auth/public-paths.ts`** — adicionar path aqui remove a checagem de auth de borda. Só com
  guard próprio dentro da rota
- **`.env*`** — não abra, não copie valor, não logue. Só `.env.example` é template
- **`docker-compose.traefik.yml`** — o único lugar que dá ao contêiner `app` as labels de roteamento (ver Deploy)

### Arquivos GERADOS — não editar à mão

`lib/database.types.ts` (gerado do schema Supabase) · `graphify-out/` · `pnpm-lock.yaml` ·
`tsconfig.tsbuildinfo` · `next-env.d.ts` · `.next/`

---

## Testes e gates

```bash
pnpm typecheck     # tsc --noEmit (estrito)
pnpm lint          # eslint
pnpm lint:channels # invariante 1 de docs/doctrine/restricao-de-canal.md: nenhuma feature nomeia um provider
pnpm test:unit     # Vitest — EXCLUI tests/invariants/** e tests/e2e/**
pnpm test:db       # Postgres efêmero + baseline em install E update + invariantes (PRECISA de Docker)
pnpm test:e2e      # Playwright (PRECISA de app rodando + banco semeado)
pnpm test:shell    # kit self-host (update.sh, entrypoint do scheduler, validadores do install.sh)
pnpm gov:verify    # atalho local = typecheck + lint + lint:channels + test:unit
```

**Os invariantes não estão no `test:unit`.** `vitest.config.ts` exclui `tests/invariants/**` de
propósito: a suíte precisa de um Postgres real e roda via `vitest.db.config.ts`, orquestrada por
`scripts/test-db.sh`. Rodar só `pnpm test:unit` e concluir "está tudo verde" é falso verde — o
isolamento de RLS não foi exercitado.

⚠️ **`pnpm gov:verify` não cobre tudo:** omite `test:db`, `test:e2e` e `test:shell`. Se sua mudança
toca schema, RLS, UI ou o kit, verde ali **não é prova**. Ver [`docs/harness-audit.md`](docs/harness-audit.md).

### O que o CI cobre

| Check            | Workflow                              | O que roda                                                                                                     |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `verify`         | `.github/workflows/ci.yml`            | `typecheck` + `lint` + `lint:channels` + `test:unit` + `test:shell`                                            |
| `invariants`     | `.github/workflows/ci.yml`            | `pnpm test:db` — `pgvector/pgvector:pg17`, `baseline.sql` em install **e** update, isolamento RLS + governança |
| `build-and-size` | `.github/workflows/perf.yml`          | `pnpm build` em Node 22                                                                                        |
| `e2e`            | `.github/workflows/e2e.yml`           | Playwright contra Supabase local com o `baseline.sql` aplicado                                                 |
| `imagens-ok`     | `.github/workflows/publish-image.yml` | As três imagens Docker constroem                                                                               |

**Os cinco são checks obrigatórios na branch protection da `main`.** Confira na fonte em vez de
confiar nesta tabela:

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**O `e2e` roda todas as specs de `tests/e2e/`, menos as declaradas em `FORA_DO_CI`** — hoje só
`vps-fresh-onboarding`, que precisa de WAHA + Redis + Resend + Nuvemshop. Ou seja: **`e2e` verde não
prova a jornada de instalação fresca**, que é a P0 da doutrina de QA Visual e o produto que se
vende. Quem está dentro e quem está fora é enumerável, e
`tests/unit/e2e-cobertura-completa.test.ts` reprova spec que sumiu de todas as listas:

```bash
ls tests/e2e/*.spec.ts | wc -l                       # specs no disco
grep -A20 'FORA_DO_CI: >-' .github/workflows/e2e.yml # o que o CI declara não cobrir
```

Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento, follow-up, webhooks ou automações:
rode `pnpm test:db` **localmente** antes de abrir PR. É o único caminho que exercita o
`baseline.sql` que o self-hoster realmente aplica.

---

## QA Visual com recursos reais — DOUTRINA

**O DeskcommCRM é distribuído open-source: a experiência de quem instala numa VPS É o produto.**
Toda feature nova (ou fix de comportamento visível) DEVE ser provada como um usuário leigo a usaria
de verdade — pelo frontend, num ambiente que imita a instalação fresca — antes de "pronto".

O que conta como recurso real:

- **Prova pela tela**, dirigindo o browser (Playwright), com conta de teste real. `curl` e chamada
  de API **não** provam UX — validam o backend. Use curl só como diagnóstico
- **Banco fresco estilo VPS:** Postgres limpo com `supabase/baseline.sql` (não a cadeia de
  migrations) + `scripts/bootstrap-owner.ts` — o que o `install.sh` faz
- **Dependências como na VPS:** WAHA local, Redis local (`redis` + `serverless-redis-http`), cron
  drenado por endpoint. E **teste com os envs opcionais AUSENTES** (ex.: sem `RESEND_API_KEY`): é o
  estado real de um primeiro deploy, e é onde moram os piores bugs de primeira impressão
- **Efeito colateral externo provado com receiver real** (webhook outbound, envio). Mock não
  estressa o egress real — anti-SSRF, projeção de payload, https em prod
- **Medida de front-end por ferramenta, nunca a olho:** `getBoundingClientRect` / `getComputedStyle`
  no Playwright

**Prioridade: primeira impressão acima de tudo.** Onboarding e as primeiras ações (criar conta,
conectar canal, primeiro lead, primeiro convite) são a primeira impressão — bug ali é abandono.

Registro obrigatório, senão o progresso é invisível: mapa de jornadas em
[`docs/testing/user-journey-map.md`](docs/testing/user-journey-map.md) (casos, prioridade `[P0]`,
achados), spec em `tests/e2e/` que dirige o **frontend**, evidência visual em
`.superpowers/evidence/`. Bug achado executando → conserta na causa raiz, com migration versionada
se tocar schema, commit próprio e re-teste verde como prova.

**Receita de ambiente fresco (não-óbvia):** banco = `baseline.sql` num Supabase local **pg17**
(`config.toml major_version = 17`; o baseline usa `GRANT MAINTAIN`, privilégio pg17+);
`next build` + `next start` (produção — `next dev` compila lento demais e o Turbopack quebra
`cookies()`); **worktree com `node_modules` real, nunca symlink** (o Turbopack rejeita symlink "out
of filesystem root") e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco).

---

## Migrations & banco — DOUTRINA

**Este projeto é open-source: toda mudança de schema DEVE sair como migration versionada.** Quem
clonou uma versão antiga precisa conseguir atualizar aplicando as migrations em ordem. **Nunca**
aplique `ALTER`/`CREATE` solto no banco sem o arquivo correspondente.

1. **Arquivo versionado** em `supabase/migrations/`, no padrão `<timestamp>_<NNNN>_<slug>.sql`.
   `NNNN` é o próximo sequencial (`ls supabase/migrations/ | tail -3`)
2. **Idempotente sempre que possível:** `add column if not exists`, `create ... if not exists`,
   `create or replace function`. Reaplicar não pode quebrar nem duplicar efeito
3. **Portável em `psql` puro** (clones podem não usar o CLI/MCP do Supabase): sem
   `create temporary table ... on commit drop` fora de transação explícita; sem `BEGIN`/`COMMIT`
   explícito (o runner já envolve em transação). Prefira CTEs, subqueries de janela e colunas-mapa
4. **Data migration genérica:** se corrige ou deduplica dados, escreva pensando em QUALQUER banco de
   clone (não hardcode IDs do seu tenant). Repointe FKs conferindo o catálogo (`information_schema`)
   para não perder histórico
5. **Registre no MANIFEST:** uma linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") com
   versão, nome e o QUÊ/PORQUÊ
6. **Reflita no `supabase/baseline.sql` — OBRIGATÓRIO.** O baseline é um dump `--schema-only` mais
   um **apêndice idempotente** no fim do arquivo (blocos rotulados
   `-- ---- <coisa> (migration NNNN) ----`). O kit aplica **só o baseline**: no `install.sh` (banco
   novo, `ON_ERROR_STOP=1`) e no `update.sh` (re-aplica em banco existente, **sem** a flag). Toda
   mudança pós-snapshot entra no apêndice, idempotente e auto-curativa. Migration que só existe em
   `supabase/migrations/` **não chega ao self-hoster**
7. **Aplique e prove:** capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem que não
   pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Valide o baseline num
   Postgres descartável (`pgvector/pgvector:pg17`) em modo install **e** update — ambos têm que passar
8. **Backfill antes da constraint:** constraint nova falha se os dados atuais a violam. Deduplique ou
   corrija ANTES de criar — na migration **e** no apêndice do baseline
9. **Função nova em `public` nasce EXPOSTA — revogue as DUAS origens:**

   ```sql
   revoke execute on function public.fn_x(...) from public, anon;
   grant  execute on function public.fn_x(...) to <só quem precisa>;
   ```

   São origens distintas de `EXECUTE`, e tratar só uma deixa a função exposta com o gate verde:
   **(A)** o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`
   do baseline, que vale para toda função criada depois dele — isto é, para todo apêndice novo — e
   que `revoke from public` **não** remove; **(B)** o grant a `PUBLIC` que o Postgres dá a qualquer
   função ao criá-la, que `revoke from anon` **não** remove. Sem os dois, o PostgREST expõe a função
   como RPC alcançável pela anon key, que vai para o browser. Vigiado por
   `tests/invariants/hardening-definer-varredura.test.ts`

**Resumo:** arquivo em `supabase/migrations/` **+** apêndice idempotente no `supabase/baseline.sql`
**+** linha no MANIFEST. Os três andam juntos. Nunca edite migration já aplicada — corrija com
forward-fix.

---

## Deploy em produção — NÃO NEGOCIÁVEL

**Numa VPS que já tem proxy reverso próprio (Hostinger, Coolify, Dokploy…), todo `up -d` leva os
DOIS arquivos de compose:**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Omitir `-f docker-compose.traefik.yml` recria o contêiner sem as labels de roteamento; o Traefik da
hospedagem deixa de enxergá-lo e **o domínio inteiro responde `404 page not found`** — com o
contêiner `healthy`, porque o healthcheck é um probe TCP interno e não sabe nada de roteamento.

Depois de qualquer deploy, confirme que o domínio responde **307** (redireciona para o login) e não 404. Verificações e o caso de build local em [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md).

O caminho normal **não constrói nada na VPS**: commit → push → PR → merge na `main` → o CI publica
no GHCR → a VPS puxa. Imagem construída na VPS é exceção de emergência e é dívida: existe só naquele
disco, e qualquer `up -d` sem `APP_PULL_POLICY=never` a substitui em silêncio.

---

## Packaging e distribuição — DOUTRINA

Lei completa em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md); decisões estruturais e o
que foi recusado em [`docs/adr/0001-packaging-e-distribuicao.md`](docs/adr/0001-packaging-e-distribuicao.md).
O não-negociável, em quatro linhas:

1. **Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do cliente.** Todo serviço
   declara `image:` de uma imagem publicada; `build:` só existe **ao lado**, como escape. Serviço
   `build:`-only é invisível para `docker compose pull` e imune a `up -d` sem `--build` — ele não é
   só caro de instalar, ele **nunca é atualizado**. Os três serviços nossos (`app`, `worker`,
   `scheduler`) são imagens publicadas, e um teste reprova o retorno do padrão
2. **Publicação é ato do CI**, nunca da sua máquina: build ARM local não roda na VPS amd64 do
   cliente, e a falha só aparece no `up -d` dele
3. **Instalação de cliente aponta para número de versão, nunca para tag móvel.** Aqui `latest`
   significa **topo da `main`**, não última release — quem quer a última release usa `stable`.
   `pull_policy` acompanha a mutabilidade da tag: imutável → `missing`, móvel → `always`
4. **Dependência upstream é referenciada com tag fixa, nunca republicada** — WAHA (licenciado;
   republicar é passivo jurídico), Redis, Caddy e `serverless-redis-http`

Bump de versão **não pode** exigir que o operador da VPS edite `.env`, compose ou qualquer arquivo à
mão. Se exigir, não entra: vira issue com plano de migração e vai para uma major.

---

## Higiene de branches — DOUTRINA

**`main` é produção e é a fonte da verdade. Toda branch começa e se mantém atualizada com ela.**
Trabalho iniciado numa branch atrasada gera conflito e retrabalho — é a causa número um de estrago
em ambiente multi-sessão.

1. **ANTES de começar qualquer trabalho, atualize a branch:**
   `git fetch origin && git merge origin/main`. Se a branch ainda não tem commits próprios, é
   fast-forward puro (`git merge --ff-only origin/main`)
2. **NUNCA `reset --hard` ou force para "atualizar"** — apaga trabalho. Só dois caminhos:
   fast-forward, ou merge da `main` para dentro. A `main` nunca é reescrita
3. **NUNCA toque em branch/worktree com working tree sujo que não é seu.** Cheque `git status` e
   `git worktree list` antes; se está suja e é de outra sessão, deixe quieto e avise
4. **Quando uma feature entra na `main`, todas as outras branches ficam atrasadas na hora.** Ao fim
   de uma feature, considere propagar a `main` para as branches vivas e limpas
5. **Conflito ao atualizar = pare e resolva com cabeça** (ou escale). Nunca escolha um lado no
   automático numa branch que não é sua. Preservar trabalho > branch verde rápido

---

## Regra final — não invente

Este repositório tem PRDs, specs, regras de negócio e doutrina escritos (`docs/prd/`, `docs/specs/`,
`docs/business-rules/`, `docs/doctrine/`). **Nunca invente regra de negócio, número, SLA ou
comportamento de produto.** Se a regra não está escrita, diga que não está e pergunte — não preencha
a lacuna com suposição plausível. Ao documentar, marque o que é `CONFIRMADO` (provado por código) e
o que é `INFERIDO`.

---

## Skills relevantes (Claude Code)

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — task com mais de uma etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bug reportado
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `supabase:supabase` · `vercel:nextjs` · `vercel:ai-gateway` · `frontend-design` · `tomik-db-doctrine`

---

## Definition of Done

1. `pnpm typecheck` zerado
2. `pnpm lint` zerado
3. `pnpm lint:channels` zerado (nenhuma feature nomeia um provider de canal)
4. Testes unit/e2e relevantes existem e passam
5. RLS testada se a feature toca tabela tenant-aware
6. Audit log emitido se há mutação relevante
7. Rate limit aplicado se a rota é pública
8. Zod valida todo input externo
9. Sem `console.log` esquecido
10. Env var nova adicionada em `.env.example` **e** `lib/env.ts`
11. Doc atualizada se mudou contrato (PRD/spec)
12. **Mudança de schema saiu como migration versionada + apêndice no baseline + linha no MANIFEST** — clones conseguem atualizar
13. **Se tocou UI ou fluxo de usuário: provado pela tela como um leigo faria**, em ambiente fresco estilo VPS, com evidência visual — curl não conta
14. **Living System Checklist respondido** (lei em [`docs/doctrine/sistema-vivo.md`](docs/doctrine/sistema-vivo.md)) — a feature não é ilha: tem entrada e saída, emite atividade/log, aparece na tela, tem porta na navegação, tem mecanismo anti-morte, **declara seu laço de retorno** (o que muda no sistema quando ela erra), e o mapa vivo (`docs/architecture/`) reflete a peça nova com ≥2 arestas. Resposta que não **nomeia o artefato concreto** (consumidor real, tela real, log real) não conta
15. **Tela nova tem porta** — declarada em `lib/navigation/registry.ts` com seu grupo, ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes
16. **Se tocou Dockerfile, compose ou o kit: a mudança chega a quem já instalou** — nenhum serviço de produção ficou `build:`-only; variável nova tem default que não quebra `.env` antigo; a atualização não pede edição manual de arquivo. Rode `pnpm test:shell`
17. **Se o PR muda comportamento, procure a afirmação de estado sobre esse comportamento** — só sobre o que você mudou, e só nos documentos de autoridade. Onde a afirmação puder virar **comando**, troque em vez de corrigir: um número corrigido envelhece de novo; um `rode isto para saber` não envelhece nunca

Um staff engineer aprovaria? Se não, itera.
