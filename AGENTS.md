# AGENTS.md — DeskcommCRM

> Contrato portável para **qualquer** agente de código (Codex, Cursor, Copilot, Amp, Claude Code).
> A doutrina completa e não-negociável vive em [`CLAUDE.md`](CLAUDE.md) — leia-o antes de tocar em
> código. Aqui está o mínimo para não causar dano.
>
> Precedência: repositório (código, `package.json`, workflows) > `CLAUDE.md` > este arquivo >
> [`docs/index.md`](docs/index.md). Toda afirmação daqui vem com o comando que a mede — **rode o
> comando, não confie no texto**.

---

## Objetivo do projeto

Sistema operacional de vendas open source com agentes de IA nativos, multi-nicho, WhatsApp como
canal primário (via WAHA). Multi-tenant com RLS desde o dia 1, LGPD nativa. Monetização = self-host
em VPS, não assinatura. Posicionamento: [`VISION.md`](VISION.md).

**Consequência que muda como você trabalha:** o produto é distribuído como código. Quem instala numa
VPS **é** o usuário. Uma mudança que funciona na máquina do dev e quebra no clone fresco é um bug de
produto, não um detalhe de ambiente.

## Stack (CONFIRMADO em `package.json`)

Next.js 16 (App Router) · React 19 · TypeScript 6 estrito · Tailwind 3 · shadcn/ui ·
Supabase (Postgres + Auth + Realtime + Storage) · Upstash Redis · Vercel AI Gateway
(`@ai-sdk/anthropic|openai|google`) · WAHA Plus (engine NOWEB) · Zod 4 · Vitest 4 · Playwright 1 ·
Sentry 10.

Só a **major**, de propósito: é onde o idioma muda, e é o que
`tests/unit/agents-md-versoes.test.ts` cobra contra o `package.json`. Declarar a minor aqui fazia
todo bump do Dependabot reprovar o `verify` sem cobrir nada que a major já não cobrisse (issue
#235). Para a versão exata, a fonte é o `package.json`.

- **Runtime:** Node ≥22 — `.nvmrc` e o `node-version` dos workflows.
- **Gerenciador:** pnpm, versão fixada no campo `packageManager` do `package.json`.
- **Versão do produto:** topo do `CHANGELOG.md` (`grep -m2 -E '^## \[' CHANGELOG.md`), SemVer, com
  tag git correspondente. Mudança que afeta quem roda VPS entra lá. O campo `version` do
  `package.json` **não** é a versão do produto e não é lido em runtime.

## Estrutura que importa

| Path                                                                         | O quê                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `app/api/v1/`                                                                | Route handlers REST, versionados por path                              |
| `app/api/internal/`, `app/api/mcp/`, `app/api/v1/cron/`                      | Superfícies não-cookie (secret / bearer próprio)                       |
| `app/app/`, `app/admin/`                                                     | UI autenticada do tenant · UI de plataforma                            |
| `app/actions/`                                                               | Server Actions (auth, onboarding, team, settings)                      |
| `lib/agent-engine/`, `lib/ai/`                                               | Runtime do agente, guardrails, RAG, dispatcher                         |
| `lib/api/wrappers.ts`                                                        | `ok()` / `fail()` — **use sempre**, não monte `Response` na mão        |
| `lib/auth/require-role.ts`                                                   | `requireRole()` — guard canônico de RBAC                               |
| `lib/supabase/browser.ts`, `lib/supabase/server.ts`, `lib/supabase/admin.ts` | Clients canônicos                                                      |
| `lib/navigation/registry.ts`                                                 | Registro de telas — é o que dá porta a uma tela nova                   |
| `workers/`                                                                   | Workers de `event_log` + crons                                         |
| `supabase/migrations/`                                                       | Schema versionado · `supabase/baseline.sql` = o que o self-host aplica |
| `proxy.ts`                                                                   | Middleware do Next 16 (auth de borda, `X-Request-Id`)                  |

## Comandos (CONFIRMADO em `package.json`)

```bash
pnpm install          # deps (frozen-lockfile no CI)
pnpm dev              # dev server
pnpm build            # next build
pnpm lint             # eslint
pnpm lint:channels    # nenhuma feature nomeia um provider de canal
pnpm typecheck        # tsc --noEmit (estrito)
pnpm test:unit        # vitest — EXCLUI tests/invariants e tests/e2e
pnpm test:db          # invariantes de banco + gate do baseline (PRECISA de Docker)
pnpm test:e2e         # Playwright (PRECISA de app rodando + banco semeado)
pnpm test:shell       # kit self-host (update.sh, scheduler, validadores do install.sh)
pnpm gov:verify       # atalho local = typecheck + lint + lint:channels + test:unit
```

⚠️ **`pnpm gov:verify` NÃO cobre tudo.** Ele omite `test:db`, `test:e2e` e `test:shell`. Se sua
mudança toca schema, RLS, UI ou o kit, `gov:verify` verde **não** é prova — rode as suítes que
faltam você mesmo. Ver [`docs/harness-audit.md`](docs/harness-audit.md).

## O que o CI cobre

| Check            | Workflow                              | O que roda                                                                                                  |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `verify`         | `.github/workflows/ci.yml`            | `typecheck` + `lint` + `lint:channels` + `test:unit` + `test:shell`                                         |
| `invariants`     | `.github/workflows/ci.yml`            | `pnpm test:db` — Postgres efêmero pg17, `baseline.sql` em install **e** update, isolamento RLS + governança |
| `build-and-size` | `.github/workflows/perf.yml`          | `pnpm build`                                                                                                |
| `e2e`            | `.github/workflows/e2e.yml`           | Playwright contra Supabase local com o `baseline.sql` aplicado — o mesmo banco que o self-hoster tem        |
| `imagens-ok`     | `.github/workflows/publish-image.yml` | As três imagens Docker constroem                                                                            |

**Os cinco são checks obrigatórios na branch protection da `main`.** Meça em vez de acreditar:

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

O `e2e` roda todas as specs de `tests/e2e/`, menos as declaradas em `FORA_DO_CI` — hoje só
`vps-fresh-onboarding` (precisa de WAHA + Redis + Resend + Nuvemshop). **Ou seja: `e2e` verde não
prova a jornada de instalação fresca**, que é a P0 da doutrina de QA Visual e o produto que se
vende; se você mexeu nela, a prova é sua. `tests/unit/e2e-cobertura-completa.test.ts` reprova spec
que sumiu de todas as listas:

```bash
ls tests/e2e/*.spec.ts | wc -l                       # specs no disco
grep -A20 'FORA_DO_CI: >-' .github/workflows/e2e.yml # o que o CI declara não cobrir
```

## Padrões de código (observados no repo, não inventados)

- **Route handler:** valida input com Zod → guard (`requireRole` / `requirePlatformAdmin` / secret)
  → query com `organization_id` explícito → `audit()` se mutação → `ok()` / `fail()`.
- Erro: `fail(code, message, status)` com código de `lib/api/errors.ts`. Nunca `throw` cru na borda.
- JSON **snake_case** na API. Dinheiro em `_cents` + `currency`. Datas ISO-8601 UTC.
- Log: `lib/logger.ts` (estruturado). **`console.log` é proibido** em código merged.
- Testes ao lado do código (`lib/foo/bar.test.ts`) ou em `tests/unit`, `tests/api`,
  `tests/invariants`, `tests/e2e`.
- Comentários em PT-BR são a norma neste repo — mantenha o idioma do arquivo que editar.

### Marca própria (white-label) — o produto é revendido, e o nome não é seu

- **Nunca escreva "Deskcomm"/"DeskcommCRM" em código que alcança o usuário.**
  `tests/unit/branding.test.ts` varre `app|components|lib|workers|hooks` e reprova; a allowlist
  **só encolhe**.
- A marca resolve do **banco** (`platform_branding` para a instalação,
  `organizations.settings.branding` para a organização). `APP_NAME` / `APP_LOGO_URL` /
  `APP_ACCENT_HEX` no `.env` são **semente e piso de rollback**, não a fonte.
- Precisa da marca **fora do DOM** (e-mail, remetente, ícone, `issuer` do MFA)? Use `marcaDaSaida()`
  de `lib/branding/saida.ts` — um hex e uma frente legível, tema claro. Nunca entregue
  `MarcaResolvida` a um template de e-mail.
- Resolvedor de marca **nunca lança**: ele roda em `app/layout.tsx`, e um throw ali é 500 em todas
  as telas.
- **O PDF de LGPD não leva marca** — ele nomeia o controlador (`organizations.legal_name`) e o DPO.
  É decisão, não omissão; há gate no mapa de arquitetura.
- Contexto de venda em [`docs/white-label.md`](docs/white-label.md); mapa em
  `docs/architecture/marca-propria.architecture.json`.

## Diretórios e arquivos SENSÍVEIS

- **`supabase/baseline.sql`** — é o que o `install.sh`/`update.sh` do self-host aplicam. Toda
  mudança de schema tem que aparecer aqui **como apêndice idempotente**, senão não chega em quem
  instalou. Ver a doutrina de Migrations em [`CLAUDE.md`](CLAUDE.md).
- **`supabase/migrations/`, arquivos já aplicados** — nunca edite. Corrija com migration nova.
- **`lib/supabase/admin.ts`** — service role **bypassa RLS**. Toda query precisa filtrar
  `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path
  token), **nunca do body**. Quem já o usa:
  `grep -rl 'supabase/admin\|createAdminClient' app/api --include='route.ts'`.
- **`lib/auth/public-paths.ts`** — adicionar path aqui remove a checagem de auth de borda. Só com
  guard próprio dentro da rota.
- **`.env*`** — não abra, não copie valor, não logue. Só `.env.example` é template.
- **`docker-compose.traefik.yml`** — numa VPS que já tem proxy reverso próprio (Hostinger, Coolify,
  Dokploy…), é o único lugar que dá ao contêiner `app` as labels de roteamento. Todo `up -d` leva os
  **dois** arquivos de compose:
  `docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app`.
  Esquecer o segundo `-f` recria o contêiner sem labels: o proxy deixa de enxergá-lo e o domínio
  inteiro responde `404`, com o contêiner `healthy` — o healthcheck é um probe TCP interno e não
  sabe nada de roteamento. Runbook: [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md).

## Arquivos GERADOS — não editar à mão

- `lib/database.types.ts` (gerado do schema Supabase)
- `graphify-out/` (grafo de conhecimento; regenerado por `/graphify .`)
- `pnpm-lock.yaml`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `.next/`

## Como validar uma alteração

1. `pnpm typecheck`, `pnpm lint` e `pnpm lint:channels` zerados.
2. `pnpm test:unit` verde.
3. Tocou schema/RLS/tabela tenant-aware → `pnpm test:db` (sobe Postgres efêmero via Docker, aplica
   `baseline.sql` em modo install **e** update, roda os invariantes).
4. Tocou UI ou fluxo de usuário → `pnpm test:e2e` com evidência visual. **`curl` não conta** como
   prova de UX (doutrina de QA Visual em [`CLAUDE.md`](CLAUDE.md)).
5. Mudou schema → migration versionada em `supabase/migrations/` **+** apêndice idempotente em
   `supabase/baseline.sql` **+** linha em `supabase/migrations/MANIFEST.md`. Os três juntos.
6. Criou função em `public` → `revoke execute on function ... from public, anon;` e depois `grant`
   só a quem precisa. São **duas** origens de `EXECUTE`, e revogar uma só deixa a função exposta
   como RPC alcançável pela anon key. Detalhe em [`CLAUDE.md`](CLAUDE.md), item 9 da doutrina de
   Migrations.
7. Tocou `Dockerfile*`, `docker-compose*.yml` ou `hostgator-setup-kit/` → `pnpm test:shell`.

## Testes existentes — meça, não cite de cabeça

Contagem de arquivo de teste envelhece a cada PR. Os comandos:

```bash
git ls-files 'tests/unit/*.test.ts' 'tests/unit/*.test.tsx' | wc -l  # suíte unitária central
git ls-files '*.test.ts' '*.test.tsx' | wc -l                        # total (inclui testes ao lado do código)
git ls-files 'tests/invariants/*.test.ts' | wc -l                    # invariantes de banco (RLS, RBAC, governança)
ls tests/e2e/*.spec.ts | wc -l                                       # specs Playwright
```

Os invariantes de `tests/invariants/` são excluídos do `test:unit` de propósito — precisam de um
Postgres real e rodam via `pnpm test:db`, no job `invariants` do CI.

## Limitações conhecidas

Nenhuma tem número fixo aqui: cada uma vem com a medição.

- **A jornada de instalação fresca não tem gate.** `vps-fresh-onboarding` está em `FORA_DO_CI` por
  depender de serviço externo (WAHA/Redis/Resend/Nuvemshop) — issue #63.
- **Rate limit HTTP é parcial.** `lib/auth/rate-limit.ts` cobre login, signup, recuperação de senha
  e aceite de convite (contando por IP **e** por identificador hasheado); `checkRateLimit` cobre o
  webhook de captação e o dispatcher de IA. **Crons e MCP seguem sem.** Meça antes de agir:
  `grep -rln 'authRateLimited\|checkRateLimit(' app lib --include='*.ts' --include='*.tsx'`.
- **O fallback do rate limit é em memória** — sem Upstash configurado, o limite é por processo.
- **`Idempotency-Key` tem adoção parcial**, apesar de o contrato prometer nos POSTs de criação:
  `grep -rln 'Idempotency-Key' app/api --include='*.ts'`.
- **`lib/auth/invite-token.ts` cai em `"dev-fallback"`** como secret HMAC se nenhum secret existir
  (inalcançável em produção: `INTERNAL_SECRET` é obrigatório e derruba o boot).
- **Handler com service role não tem gate automático** para o filtro de `organization_id`.
  Escrevendo handler novo, o filtro é responsabilidade sua.
- Prioridade e detalhe: [`docs/harness-audit.md`](docs/harness-audit.md),
  [`docs/current-state.md`](docs/current-state.md) e [`docs/threat-model.md`](docs/threat-model.md).

## Regras de segurança

- Sempre `getUser()` no backend. **Nunca `getSession()`** (confia no cookie sem revalidar).
- API key/token **nunca** em query string — só header. O plaintext do bearer é mostrado **uma vez**;
  no banco, só hash SHA256.
- HMAC de webhook com `crypto.timingSafeEqual`. Fail-closed quando o secret falta.
- Nunca logue segredo, token, CPF, telefone ou e-mail. O Sentry tem `beforeSend` que higieniza — não
  confie nele como única camada.
- Não commite screenshot ou dump com dado real de cliente.

## Packaging — se você tocou `Dockerfile*`, `docker-compose*.yml` ou `hostgator-setup-kit/`

Lei completa em [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md). O não-negociável:

- **Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do cliente.** Todo serviço
  declara `image:` de uma imagem publicada; `build:` só existe **ao lado**, como escape. Serviço
  `build:`-only é pulado por `docker compose pull` e imune a `up -d` sem `--build` — ele não é só
  caro de instalar, ele **nunca é atualizado**.
- **Publicação é ato do CI**, nunca da sua máquina: build ARM local não roda na VPS amd64.
- **Instalação de cliente aponta para número de versão**, nunca para tag móvel. Aqui `latest`
  significa **topo da `main`**, não última release — quem quer a última release usa `stable`.
- **Dependência upstream é referenciada com tag fixa, nunca republicada** (WAHA é licenciado).
- **Bump de versão não pode exigir que o operador da VPS edite arquivo à mão.**

`pnpm test:shell` é a única suíte que exercita o kit — ela roda dentro do check `verify`, e você
deve rodá-la localmente antes de abrir o PR.

## Critério de conclusão

Vale a **Definition of Done de [`CLAUDE.md`](CLAUDE.md)** — conte lá em vez de confiar num número
aqui:

```bash
sed -n '/^## Definition of Done/,/^Um staff engineer/p' CLAUDE.md | grep -cE '^[0-9]+\. '
```

A régua tem que DELIMITAR a seção: um `grep` no arquivo inteiro casa toda linha numerada de
anti-patterns, packaging e migrations, e perde os itens do próprio DoD. Não declare pronto sem:
typecheck/lint zerados, testes relevantes verdes, RLS testada se tocou tabela tenant-aware,
migration + baseline + MANIFEST se mudou schema, prova visual se mudou UI, e a regra de packaging
acima se mudou o artefato que o self-hoster instala.

## Regra final — não invente

Este repositório tem PRDs, specs, regras de negócio e doutrina escritos (`docs/prd/`, `docs/specs/`,
`docs/business-rules/`, `docs/doctrine/`). **Nunca invente regra de negócio, número, SLA ou
comportamento de produto.** Se a regra não está escrita, diga que não está e pergunte — não preencha
a lacuna com suposição plausível. Ao documentar, marque o que é `CONFIRMADO` (provado por código) e
o que é `INFERIDO`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
