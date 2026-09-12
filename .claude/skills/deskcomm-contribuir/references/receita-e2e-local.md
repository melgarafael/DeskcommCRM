# Rodar uma spec de tela na sua máquina — a receita do CI, passo a passo

O CI (`.github/workflows/e2e.yml`) sobe um Supabase local, aplica o `baseline.sql` (o mesmo que o
`install.sh` aplica numa VPS), constrói o app em modo produção e roda as specs Playwright em três
partes. Esta página é a mesma receita, para uma pessoa, uma spec de cada vez. Nenhum documento do
repositório a descrevia fora do próprio workflow — se algo aqui divergir do `e2e.yml`, vale o
workflow.

## O que precisa estar instalado

- Docker de pé (`docker ps` responde);
- Supabase CLI (`supabase --version`; ou `npx supabase`, mais lento);
- Node 22 (`.nvmrc`), pnpm 9.15.9 (`packageManager` do `package.json`), `psql`;
- Chromium do Playwright: `pnpm exec playwright install --with-deps chromium`.

Tempo medido no runner do GitHub: ~8-9 min de preparação e 18-26 min por parte. Na sua máquina,
uma spec isolada costuma levar 1-3 min depois da preparação.

## 1. Um worktree só para isso, fora de `/tmp`, com `node_modules` de verdade

```bash
git worktree add ../deskcomm-e2e HEAD && cd ../deskcomm-e2e && pnpm install
```

Symlink de `node_modules` o Turbopack recusa; `/tmp` é limpo no meio da sessão.

## 2. Supabase local (a cadeia de migrations não sobe do zero — o baseline sim)

```bash
mv supabase/migrations /tmp/migrations-off && mkdir -p supabase/migrations   # a cadeia quebra na 0010; o baseline é a fonte
supabase start
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
SQL
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -q -f supabase/baseline.sql
docker restart $(docker ps -q --filter name=supabase_realtime)     # a publication nasceu no passo anterior
mv /tmp/migrations-off/* supabase/migrations/ && rmdir /tmp/migrations-off  # devolva: 4 testes de unit reprovam com a pasta vazia
```

`supabase/config.toml` fixa a major do Postgres; o `baseline.sql` usa privilégios que exigem
pg15+ — não troque a versão.

## 3. O ambiente da suíte — nunca o `.env.local`

```bash
pnpm e2e:env        # gera .env.e2e apontado para o Supabase LOCAL (recusa qualquer outro host)
pnpm e2e:build      # next build com as NEXT_PUBLIC_* do e2e embutidas no bundle
cp .env.e2e .env.local && pnpm exec tsx scripts/seed-e2e-credentials.ts
```

Por que isso existe: em 2026-08-06 a suíte escrevia organizações e agentes de teste **no banco de
produção**, porque o app sob teste carregava o `.env.local` do dev. O `playwright.config.ts`
recusa um `.env.e2e` que não aponte para `localhost`. Os scripts de seed leem `.env.local` do disco —
por isso a cópia.

Algumas specs precisam de fixtures que elas não semeiam sozinhas (o CI roda estes três):

```bash
pnpm exec tsx scripts/seed-e2e-escalacao.ts
pnpm exec tsx --env-file=.env.local scripts/seed-e2e-capacidades-ausentes.ts
pnpm exec tsx scripts/seed-e2e-followup-agent.ts
```

Outros seeds por spec estão em `scripts/seed-e2e-*.ts`; o cabeçalho de cada spec diz qual ela usa.

## 4. Rodar UMA spec

```bash
pnpm exec playwright test tests/e2e/<sua-spec>.spec.ts --reporter=list
```

O `playwright.config.ts` sobe o app (`next start`) sozinho. Falhou? `--trace on` grava o trace;
`pnpm exec playwright show-trace test-results/<pasta>/trace.zip` abre.

## 5. Escrever a spec (o molde do repo)

- Cabeçalho explicando o defeito ou a jornada que ela prova (como toda spec recente em `tests/e2e/`).
- Login pelo helper que as outras specs usam; sufixo único nos dados que cria; limpeza no fim.
- **Asserção no valor, não na presença**: medir com `getBoundingClientRect`/`getComputedStyle`, texto
  exato, contagem — "o elemento existe" não prova nada.
- Evidência versionada em `evidence/` (não em `.superpowers/`, que é ignorado pelo git).
- Registre a jornada em `docs/testing/user-journey-map.md` com prioridade (`[P0]` primeira impressão).
- A spec nova entra em `SPECS_PARTE_N` do `.github/workflows/e2e.yml` — ou em `FORA_DO_CI` com o
  motivo escrito, se depender de WAHA/Resend/Nuvemshop/Redis reais. O teste
  `tests/unit/e2e-cobertura-completa.test.ts` reprova spec órfã.
- `pnpm typecheck` depois de escrever (a spec é TypeScript e o typecheck cobre `tests/`).

## 6. Quando não dá

Sem Docker, sem tempo, sem máquina: mande o que conseguiu provar (unit + o que testou na mão,
passo a passo, com o que viu) e escreva no PR "prova de tela não medida: <motivo>". A prova fica
com o mantenedor — é o combinado do `CONTRIBUTING.md` e do template de PR, não uma falha sua.
