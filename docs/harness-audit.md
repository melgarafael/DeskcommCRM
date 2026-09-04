---
type: harness-audit
project: DeskcommCRM
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code) — verificação de arquivos, CI e configs
confidence: alta (todos os itens verificados por leitura direta de arquivo/config; nenhum comando executado)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-29)
---

# Auditoria do harness — DeskcommCRM

> # ⚠️ ESTE DOCUMENTO É UM RETRATO, NÃO O ESTADO DE HOJE
>
> **Ele descreve `origin/main` no commit `789dfa6` (v1.0.0, 2026-07-29).** Os números,
> contagens e vereditos abaixo conferem **contra aquele commit** — não contra o que está na
> `main` agora. Entre um e outro há **1.014 commits e 71 migrations** (medido em 2026-08-14).
>
> **Nada aqui é mantido.** É deliberado, e é a alternativa honesta: um retrato datado nunca
> mente, enquanto um documento atualizado uma vez volta a mentir na semana seguinte — e sem
> aviso, porque a atualização recente faz o leitor confiar mais.
>
> **Antes de agir sobre qualquer linha, remeça.** Uma auditoria de 2026-08-14 encontrou
> 20 afirmações desatualizadas só neste arquivo — várias dizendo que falta algo que já foi
> feito. Os comandos de medição de cada uma estão em
> [`audits/2026-08-14-afirmacoes-de-estado.md`](audits/2026-08-14-afirmacoes-de-estado.md).
>
> Precisa do estado de agora? Meça na fonte. Para o que este documento mais cita:
>
> ```bash
> gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
>   --jq '.required_status_checks.contexts'      # os checks obrigatórios
> pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell
> ```



"Harness" = a infraestrutura que permite a um humano ou agente instalar, entender,
alterar e **verificar** o projeto com segurança. Um harness fraco não impede o trabalho;
ele torna o trabalho não-verificável, e é aí que a regressão entra sem ninguém ver.

Nada aqui foi executado — a auditoria é read-only por instrução. Todos os itens foram
verificados por leitura de arquivo, config e workflow.

---

## Nível de maturidade: **H4 — Preparado para agentes**

| Nível | Veredito | Evidência |
|---|---|---|
| H0 — Não documentado | superado | 119 docs em `docs/`, README de 302 linhas em 3 idiomas, PRDs, specs, `CHANGELOG.md` |
| H1 — Documentado | ✅ | `README.md`, `ARCHITECTURE.md`, `VISION.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (Keep a Changelog + SemVer) |
| H2 — Reproduzível | ✅ | Quickstart no README, `docs/SETUP.md`, `.nvmrc` (22), `packageManager` fixo, `pnpm-lock.yaml`, `docker-compose.yml`, `install.sh` do kit self-host, `baseline.sql` |
| H3 — Verificável | ✅ | `lint` + `typecheck` + `test:unit` + `build`; CI roda os 3 primeiros em PR |
| H4 — Preparado para agentes | ✅ | `CLAUDE.md` doutrinal forte; `AGENTS.md` **criado nesta auditoria**; documentação técnica extensa; **e o CI roda o gate de isolamento RLS** (job `invariants` → `pnpm test:db`) |
| H5 — Automação avançada | ⚠️ **parcial** | CI confiável e ambiente isolado ✅ (Postgres efêmero pg15, worktrees, gov-loop com maker≠checker e hash-check). Falta: **1 das 46 specs E2E fora do CI** (45 rodam via `e2e.yml`, **obrigatório desde 2026-08-08**; a de fora é `vps-fresh-onboarding`, que é justamente a P0), `format:check` fora do CI, e o comando único local (`gov:verify`) não cobre `test:db`/`test:e2e`. *(Números recontados em 2026-08-14 @ `741c4ec8`; a redação anterior — "4 das 32, não-obrigatório" — apodreceu.)* |

**Por que H4 e não H5:** a instrução da auditoria é explícita — não atribuir nível só
porque os arquivos existem, avaliar se o processo está implementado. Aqui está: o gate de
isolamento multi-tenant roda em CI como check nomeado, em job paralelo, aplicando
`baseline.sql` em modo install **e** update contra um Postgres descartável. Isso é o
processo funcionando, não a intenção.

O que separa de H5 é estreito: **16 dos 19 E2E não rodam em CI** (`e2e.yml` cobre `smoke`, `auth` e `error-pages` desde 2026-07-30) — de fora seguem
`vps-fresh-onboarding.spec.ts`, que protege a primeira impressão que a doutrina classifica
como o caminho mais crítico do produto. E `pnpm gov:verify`, o comando único que um agente
naturalmente usa como critério de pronto, **não** inclui `test:db` nem `test:e2e`: o CI
pega o que ele deixa passar, mas só depois do push.

**O que puxa este projeto para cima e é incomum num CRM open-source:** doutrina escrita e
específica (`CLAUDE.md`), Definition of Done de 13 itens, **56 arquivos de invariantes de
banco**, gate de install+update do `baseline.sql` num Postgres descartável rodando em CI,
doutrina de QA visual com ambiente fresco estilo VPS, e uma máquina de governança de
agentes (`loop/`) com maker≠checker e hash-check.

---

## Os 20 itens

Legenda: ✅ existente e funcional · ⚠️ existente mas incompleto · ❌ não identificado · 💡 recomendado

| # | Item | Status | Evidência / lacuna |
|---|---|---|---|
| 1 | README útil | ✅ | 302 linhas: o que é, quickstart de 5 min, stack, estrutura, testes, roadmap, suporte. Traduzido (EN/ES). Mais `CHANGELOG.md` com aviso de "⚠️ Requer atenção" por versão, voltado a quem roda VPS |
| 2 | Instruções de instalação | ✅ | README §Quickstart + `docs/SETUP.md` + `docs/deploy-selfhost/` + `docs/deploy-hostgator/` + `install.sh` |
| 3 | Versão de runtime definida | ✅ | `.nvmrc` = 22, `engines.node >=22`, `packageManager: pnpm@9.15.9`, e o CI usa `setup-node@v7` com Node 22 — alinhados |
| 4 | Lockfile | ✅ | `pnpm-lock.yaml`, e ambos os jobs do CI usam `--frozen-lockfile` |
| 5 | `.env.example` | ⚠️ | Existe (+ `.env.hostgator.example`), mas **6 vars de `lib/env.ts` continuam ausentes**, entre elas 3 secrets: `IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY` (+ `LGPD_DPO_EMAIL`, `LGPD_EXPORT_EXPIRES_HOURS`, `NUVEMSHOP_ENABLED`) |
| 6 | Comando de desenvolvimento | ✅ | `pnpm dev`. Nota: `docs/testing/` documenta que E2E fresco exige `build` + `start`, não `dev` |
| 7 | Comando de build | ✅ | `pnpm build`; exercitado no workflow `perf.yml` |
| 8 | Comando de lint | ✅ | `pnpm lint` (eslint), roda no CI |
| 9 | Comando de formatação | ✅ | `pnpm format` / `format:check` (Prettier). ⚠️ `format:check` **não está no CI** |
| 10 | Checagem de tipos | ✅ | `pnpm typecheck` (`tsc --noEmit`, TS 6 estrito), roda no CI |
| 11 | Testes unitários | ✅ | 221 arquivos `*.test.ts(x)`; `pnpm test:unit` no CI |
| 12 | Testes de integração | ✅ | **56 arquivos** de invariantes em `tests/invariants/` + `tests/api/`. Excluídos do `test:unit` de propósito (`vitest.config.ts:12`) e rodados pelo job `invariants` do CI via `pnpm test:db` |
| 13 | Testes E2E | ⚠️ | 20 specs Playwright. **10 rodam no CI** (`e2e.yml`, ainda não-obrigatório), incluindo o P0 `vps-webhook-outbound-ssrf`; o P0 `vps-fresh-onboarding` continua fora (issue #63) |
| 14 | Comando único de verificação | ⚠️ | `pnpm gov:verify` = `typecheck && lint && test:unit`. **Omite `test:db` e `test:e2e`** — verde localmente não significa verificado. O CI cobre `test:db`, mas só depois do push |
| 15 | CI executando verificações | ✅ | `ci.yml` tem 2 jobs: `verify` (typecheck + lint + test:unit) e **`invariants` (`pnpm test:db` — isolamento RLS + invariantes de governança, em job paralelo com timeout de 20min)**. Falta E2E e `format:check`. `perf.yml` faz build + bundle size; `publish-image.yml` publica no GHCR |
| 16 | Proteção contra secrets | ⚠️ | `.gitignore` cobre `.env*` (exceção só para os `.example`) e o Sentry tem `beforeSend` que higieniza PII. **Sem** gitleaks/trufflehog no CI, **sem** pre-commit hook |
| 17 | Documentação arquitetural | ✅ | `ARCHITECTURE.md` (1 página) + `docs/specs/` (16 docs com schema e payloads) + `docs/architecture/agent-turn` + `graphify-out/` |
| 18 | Regras para agentes de IA | ✅ | `CLAUDE.md` doutrinal (convenções não-negociáveis, anti-patterns, doutrinas de migration/QA/branch), `.claude/agents/` com frota especializada, `loop/` com maker≠checker. **`AGENTS.md` criado nesta auditoria** — antes, agentes não-Claude entravam sem contexto |
| 19 | Critérios de conclusão de tarefa | ✅ | Definition of Done de 13 itens em `CLAUDE.md`; `docs/doctrine/sistema-vivo.md` com o Living System Checklist; template de PR com o checklist |
| 20 | Ambiente reproduzível | ✅ | `docker-compose.yml` (dev), `.prod.yml`, `Dockerfile` + `Dockerfile.worker`, `baseline.sql` auto-curativo cobrindo até a migration 0092, `scripts/test-db.sh` com Postgres efêmero pg15 rodando em CI. ⚠️ A receita de ambiente fresco tem armadilhas que só existem em doc (`node_modules` real e não symlink, fora de `/tmp`) — reproduzível, mas com conhecimento tácito |

---

## Plano de correção, por relação custo × benefício

Ordenado por retorno. Nada aqui foi aplicado — a auditoria não altera CI, `package.json`
nem código.

### ✅ JÁ FEITO — `pnpm test:db` no CI

Era o achado principal da primeira passada desta auditoria, e estava **desatualizado**:
`origin/main` já traz o job `invariants` no `ci.yml` rodando `pnpm test:db` em paralelo ao
`verify`, com timeout de 20min e comentário explicando a escolha do job separado. Fica
registrado como corrigido, não como pendência.

### 1. Adicionar os E2E ao CI (ou a um workflow nightly) 🔴 · custo: ~30 linhas

Maior buraco restante. `vps-fresh-onboarding.spec.ts` protege a primeira impressão, que a
doutrina classifica como o caminho mais crítico do produto, e
`vps-webhook-outbound-ssrf.spec.ts` é a única prova automatizada do guard de SSRF. Rodar
em PR pode ser lento; um workflow nightly + trigger manual já elimina a regressão silenciosa.

### 2. Renomear/reforçar o comando único 🟠 · custo: 2 linhas

Duas opções: (a) `gov:verify` passa a incluir `test:db` (exige Docker em toda máquina de
dev), ou (b) mantém `gov:verify` como o loop rápido e cria `verify:full` =
`gov:verify && test:db`, com `AGENTS.md` e o DoD apontando para `verify:full` como
critério de merge. **Recomendo (b)** — preserva o loop rápido e torna a diferença explícita.

### 3. Completar `.env.example` 🟠 · custo: 6 linhas

As 6 vars ausentes, com comentário sobre quais são obrigatórias. Os 3 secrets são o caso
grave: quem instala não sabe que precisa gerá-los.

### 4. Adicionar scan de secret no CI 🟡 · custo: ~10 linhas

`gitleaks` como step. Projeto open-source com screenshots de evidência sendo commitados
tem risco real de vazamento acidental.

### 5. `format:check` no CI 🟡 · custo: 2 linhas

O script existe e não é exercitado.

---

## Não pôde ser confirmado

- Se `typecheck`/`lint`/`test:unit` **passam hoje** — o `node_modules` deste checkout está
  incompleto (70 pacotes, sem `typescript`) e a auditoria não instala dependências. Todo
  status "✅" nos itens 8, 10, 11 e 12 refere-se à *existência e configuração* do comando e
  do job de CI, **não** a uma execução verde observada.
- Taxa de sucesso histórica do CI — não consultamos a API do GitHub Actions. Sabemos que o
  job `invariants` existe; não sabemos se está passando.
- Cobertura de teste em % — configurada no Vitest (`provider: v8`), nunca coletada aqui.
- Se as branch protection rules do GitHub exigem os dois checks verdes para merge — é
  config de repositório remoto, invisível no checkout. **Isso decide se o gate de RLS é
  bloqueante ou apenas informativo**, e é a pergunta mais importante em aberto sobre o harness.

---

## Nota de método

A primeira passada desta auditoria rodou contra um checkout local **556 commits atrás** da
`origin/main`, e por isso reportou "gate de RLS fora do CI" como achado principal — quando
já estava corrigido em produção. Os números e vereditos acima foram todos recontados contra
`origin/main @ 789dfa6`. Registrado aqui porque a doutrina de higiene de branches
(`CLAUDE.md`) existe exatamente para evitar isso: **`git fetch` antes de auditar, não depois.**
