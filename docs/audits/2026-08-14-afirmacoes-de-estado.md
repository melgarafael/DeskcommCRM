# Auditoria — afirmações de estado na documentação

**Data:** 2026-08-14 · **Medido contra:** `origin/main` @ `840917ed`

**Método:** 11 agentes em paralelo, um por grupo de documento, cada um extraindo toda
frase que afirma como o mundo *está* e medindo-a contra a fonte com um comando real.
Depois dois passes adversariais: um tentando derrubar os vereditos "VERDADEIRA", outro
caçando o que ninguém olhou.

**Resultado:** 393 afirmações medidas · 166 confirmadas · 227 com problema ·
4 vereditos "VERDADEIRA" derrubados · 19 achados em documentos não cobertos.

---

## Como usar este documento

**Cada achado traz o comando que o mede. É o comando que vale, não o veredito.** Este
relatório é uma fotografia de 2026-08-14 e envelhece exatamente como o que ele critica —
quem for tratar um achado **roda o comando de novo** antes de confiar na linha.

A triagem é **por tipo de documento**, não por gravidade:

| Tipo | O que fazer |
|---|---|
| **Autoridade** — doutrina, ADR, runbooks, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, READMEs | Consertar. E onde a afirmação puder virar **comando**, trocar em vez de corrigir: número corrigido envelhece de novo, `rode isto para saber` não envelhece. |
| **Retrato** — `docs/current-state.md`, `docs/harness-audit.md` | **Não corrigir as contagens.** Carimbar no topo o SHA e a data contra os quais os números conferem, e parar de manter. Documento honestamente datado nunca mente; documento atualizado uma vez volta a mentir. |
| **Registro** — `CHANGELOG.md` | Cada seção descreve uma versão e é histórica por natureza. Só se corrige o que afirma sobre **aquela** versão e é falso. |
| **Planejamento** — `docs/stories/`, `docs/handoffs/`, `docs/specs/` | Deixar como está. Registro histórico pode apontar para o que nunca existiu; os 385 ponteiros mortos do repo vivem aí, e o gate os exclui de propósito. |

O gate `tests/unit/documentacao-aponta-para-o-que-existe.test.ts` impede a reincidência
das duas piores formas (ponteiro morto e nota de pendência sobrevivente) nos documentos
de autoridade. O resto é dívida que decai sozinha se ninguém alimentar.

---


# AUTORIDADE — 152 achados


## `AGENTS.md` — 22

### L24 · FALSA · gravidade alta · sobre-o-codigo

> WAHA Plus (engine NOWEB)

**Mede com:**

```bash
sed -n '110,152p' docker-compose.prod.yml
```

**Deu:**

```
image: ${WAHA_IMAGE:-devlikeapro/waha:latest-2026.7.2}
# Core grátis por padrão; troque para devlikeapro/waha-plus via WAHA_IMAGE se
# precisar de multi-número/retry/S3 (licença paga).
WHATSAPP_DEFAULT_ENGINE: ${WHATSAPP_DEFAULT_ENGINE:-NOWEB}
```

**Sugestão:** WAHA (engine NOWEB; o `docker-compose.prod.yml` entrega **Core** por padrão — `devlikeapro/waha`. Plus é opt-in por `WAHA_IMAGE=devlikeapro/waha-plus`, e é o que habilita multi-número/retry/S3). Confira: `grep -n 'WAHA_IMAGE' docker-compose.prod.yml`.

**Vira teste:** tests/unit: o default de WAHA_IMAGE em docker-compose.prod.yml e a palavra usada em AGENTS.md/CLAUDE.md concordam (Core vs Plus)

### L26 · FALSA · gravidade alta · pendencia

> o job `ci` roda 22, mas o `perf` ainda builda em 20 — divergência com `engines`, registrada como bug

**Mede com:**

```bash
grep -rn "node-version" .github/workflows/
```

**Deu:**

```
.github/workflows/perf.yml:22:          node-version: 22
.github/workflows/ci.yml:19:          node-version: 22
.github/workflows/ci.yml:69:          node-version: 22
.github/workflows/e2e.yml:164:          node-version: 22

(perf.yml traz o comentário: "# 22 como o job `ci` e o `.nvmrc`. Buildar numa versão que o `engines` (>=22) não suporta esconde quebra ou inventa falha.")
```

**Sugestão:** Runtime: **Node ≥22** (`.nvmrc` = 22; todos os jobs de CI fixam a mesma versão). Confira: `grep -rn 'node-version' .github/workflows/`.

**Vira teste:** tests/unit: todo `node-version:` em .github/workflows/ é igual ao conteúdo de .nvmrc

### L28 · FALSA · gravidade alta · data-versao

> Versão do produto: **1.0.0** (`CHANGELOG.md`, SemVer — mudança que afeta quem roda VPS entra lá).

**Mede com:**

```bash
grep -nE '^## \[' CHANGELOG.md | head -6 ; git tag --list | tail -6 ; node -e "console.log(require('./package.json').version)"
```

**Deu:**

```
9:## [Não lançado]
11:## [1.3.0] — 2026-08-13
72:## [1.2.1] — 2026-08-12
117:## [1.2.0] — 2026-08-11
258:## [1.1.0] — 2026-07-30
280:## [1.0.0] — 2026-07-27

tags: v1.0.0 v1.1.0 v1.1.1-jmpo.1 v1.2.0 v1.2.1 v1.3.0
package.json version: 0.1.0
```

**Sugestão:** Versão do produto: a última **lançada** é o topo de `CHANGELOG.md` (`grep -m2 -E '^## \[' CHANGELOG.md`) e tem tag git correspondente (`git tag --list 'v*' | tail -1`). SemVer — mudança que afeta quem roda VPS entra lá. (`package.json` segue em `0.1.0` e **não** é a fonte da versão do produto.)

**Vira teste:** tests/unit: a versão do topo de CHANGELOG.md tem uma tag git `v<versão>` correspondente

### L34 · FALSA · gravidade media · contagem

> 166 route handlers REST (versionado por path) — 169 contando `app/api/**`

**Mede com:**

```bash
git ls-files 'app/api/v1/**/route.ts' | wc -l ; git ls-files 'app/api/**/route.ts' | wc -l ; git ls-tree -r 741c4ec8 --name-only | grep -cE '^app/api/v1/.*/route\.ts$'
```

**Deu:**

```
201
203
(no SHA 741c4ec8 que o doc cita noutro bloco: 200)
```

**Sugestão:** route handlers REST versionados por path — reconte com `git ls-files 'app/api/v1/**/route.ts' | wc -l` (e `git ls-files 'app/api/**/route.ts' | wc -l` para o total de `app/api/**`).

### L54 · FRAGIL · gravidade baixa · sobre-o-codigo

> pnpm test:unit        # vitest — EXCLUI tests/invariants e tests/e2e

**Mede com:**

```bash
sed -n '25,33p' vitest.config.ts
```

**Deu:**

```
exclude: [
  "**/node_modules/**", ".next", "dist", ".claude/**",
  "tests/e2e/**", "tests/invariants/**", "tests/journeys/**",
]
```

**Sugestão:** pnpm test:unit        # vitest — EXCLUI tests/invariants, tests/e2e e tests/journeys (lista viva em `vitest.config.ts → exclude`)

### L57 · FALSA · gravidade media · sobre-o-codigo

> pnpm gov:verify       # typecheck + lint + test:unit  ← verificação única atual

**Mede com:**

```bash
node -e "console.log(require('./package.json').scripts['gov:verify'])"
```

**Deu:**

```
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit
```

**Sugestão:** pnpm gov:verify       # typecheck + lint + lint:channels + test:unit  ← verificação única atual # (confira o encadeamento real: `node -e \"console.log(require('./package.json').scripts['gov:verify'])\"`)

**Vira teste:** tests/unit: a lista de passos descrita em AGENTS.md/CLAUDE.md para `gov:verify` bate com o script em package.json

### L64 · FALSA · gravidade alta · sobre-o-codigo

> `.github/workflows/ci.yml`: `verify` = typecheck + lint + test:unit

**Mede com:**

```bash
sed -n '9,58p' .github/workflows/ci.yml
```

**Deu:**

```
Steps do job `verify`: Typecheck (pnpm typecheck) · Lint (pnpm lint) · Channel provider leak (pnpm lint:channels) · Unit tests (pnpm test:unit) · Kit self-host (bash) (pnpm test:shell) — cinco passos, não três.
```

**Sugestão:** `.github/workflows/ci.yml`: `verify` = typecheck + lint + lint:channels + test:unit + test:shell (**cinco** passos — `pnpm lint` sozinho não cobre `lint:channels` nem o kit self-host). Reconfira com `awk '/^  verify:/,/^  invariants:/' .github/workflows/ci.yml | grep -A1 'name:'`.

**Vira teste:** tests/unit: os passos `run:` do job verify de ci.yml estão todos citados no bloco de CI de AGENTS.md

### L67 · FALSA · gravidade alta · contagem

> roda **45 das 46 specs** Playwright contra um Supabase local de verdade

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; awk '/^      SPECS_PARTE_1:/{f=1;next} /^      SPECS_PARTE_2:/{f=0} f' .github/workflows/e2e.yml | grep -coE '[a-z0-9-]+\.spec\.ts' ; awk '/^      SPECS_PARTE_2:/{f=1;next} /^      # Cada item aqui/{f=0} f' .github/workflows/e2e.yml | grep -coE '[a-z0-9-]+\.spec\.ts'
```

**Deu:**

```
disco = 48
SPECS_PARTE_1 = 25
SPECS_PARTE_2 = 22
FORA_DO_CI = 1
rodam = 47, soma = 48 (bate com o disco)
```

**Sugestão:** roda **todas as specs Playwright menos as declaradas em `FORA_DO_CI`** contra um Supabase local de verdade com o `baseline.sql` aplicado. O número não vai escrito aqui de propósito — ele já apodreceu quatro vezes. Meça: `ls tests/e2e/*.spec.ts | wc -l` (disco) e `echo $SPECS_PARTE_1 $SPECS_PARTE_2 | wc -w` nas listas de `.github/workflows/e2e.yml`.

**Vira teste:** tests/unit: SPECS_PARTE_1 + SPECS_PARTE_2 + FORA_DO_CI == ls tests/e2e/*.spec.ts (o repo já tem tests/unit/e2e-cobertura-completa.test.ts para a soma; falta o gate sobre o NÚMERO citado nos docs)

### L69 · FRAGIL · gravidade media · ativo-obrigatorio

> **É check obrigatório desde 2026-08-08.**

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; sed -n '10,17p' .github/workflows/e2e.yml
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok

(mas o cabeçalho do PRÓPRIO e2e.yml ainda afirma o contrário: "# NÃO-BLOQUEANTE por ausência, não por mordaça: `e2e` não está na lista de checks obrigatórios da branch protection, então falhar aqui não segura merge.")
```

**Sugestão:** É check obrigatório — confirme antes de citar: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`. (A data de ativação não é auditável pelo repo; e o cabeçalho de `.github/workflows/e2e.yml` ainda diz que o `e2e` NÃO é obrigatório — esse comentário está podre e contradiz a branch protection.)

**Vira teste:** tests/unit: nenhum comentário em .github/workflows/ afirma que um check está fora dos obrigatórios sem bater com a lista da branch protection (ou, mais simples: o texto 'não está na lista de checks obrigatórios' não aparece em e2e.yml)

### L114 · FALSA · gravidade media · contagem

> **`lib/supabase/admin.ts`** — service role **bypassa RLS**. 89 rotas o usam

**Mede com:**

```bash
grep -rl "createAdminClient" app/api --include='route.ts' | wc -l ; git ls-files 'app/api/**/route.ts' | wc -l
```

**Deu:**

```
119
203
```

**Sugestão:** **`lib/supabase/admin.ts`** — service role **bypassa RLS**. Boa parte dos handlers de `app/api/**` o usa (reconte: `grep -rl createAdminClient app/api --include=route.ts | wc -l` contra `git ls-files 'app/api/**/route.ts' | wc -l`); toda query precisa filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **nunca do body**.

### L130 · FALSA · gravidade baixa · contagem

> `lib/database.types.ts` (6.1k linhas — gerado do schema Supabase)

**Mede com:**

```bash
wc -l < lib/database.types.ts
```

**Deu:**

```
7023
```

**Sugestão:** `lib/database.types.ts` (gerado do schema Supabase — `wc -l lib/database.types.ts` se quiser o tamanho de hoje)

### L131 · FRAGIL · gravidade baixa · ponteiro

> `graphify-out/` (grafo de conhecimento; regenerado por `/graphify .`)

**Mede com:**

```bash
test -d graphify-out && echo existe || echo ausente ; grep -n graphify .gitignore
```

**Deu:**

```
ausente
100:# graphify (análise local de knowledge graph)
101:graphify-out/
```

**Sugestão:** `graphify-out/` (grafo de conhecimento local; ignorado pelo git e **ausente num clone fresco** — só existe depois de rodar `/graphify .`)

### L153 · FRAGIL · gravidade media · contagem

> **257** arquivos de teste unitário em `tests/unit/` ... O repo tem **491** arquivos `*.test.ts(x)` no total

**Mede com:**

```bash
git ls-files 'tests/unit/*.test.ts' 'tests/unit/*.test.tsx' | wc -l ; git ls-files '*.test.ts' '*.test.tsx' | wc -l ; git ls-tree -r 741c4ec8 --name-only | grep -cE '^tests/unit/.*\.test\.tsx?$' ; git rev-list --count 741c4ec8..HEAD
```

**Deu:**

```
HEAD (840917ed): 264 e 511
741c4ec8 (o SHA declarado): 257 e 491
commits desde o SHA declarado: 45
```

**Sugestão:** Arquivos de teste unitário em `tests/unit/` e no repo inteiro — **conte, não cite**: `git ls-files 'tests/unit/*.test.ts' 'tests/unit/*.test.tsx' | wc -l` e `git ls-files '*.test.ts' '*.test.tsx' | wc -l`. A diferença vive junto ao código, fora de `tests/`, e também roda em `test:unit`.

### L154 · FRAGIL · gravidade baixa · contagem

> **102** arquivos de invariante de banco em `tests/invariants/`

**Mede com:**

```bash
git ls-files 'tests/invariants/*.test.ts' | wc -l ; git ls-tree -r 741c4ec8 --name-only | grep -cE '^tests/invariants/.*\.test\.ts$'
```

**Deu:**

```
HEAD: 103
741c4ec8: 102
```

**Sugestão:** Arquivos de invariante de banco em `tests/invariants/` (`git ls-files 'tests/invariants/*.test.ts' | wc -l`) — RLS/isolamento cross-tenant, RBAC, governança (G1–G6). Excluídos do `test:unit` de propósito; rodam via `pnpm test:db` **e no job `invariants` do CI**.

### L157 · FALSA · gravidade alta · contagem

> **46** specs Playwright em `tests/e2e/` (`ls tests/e2e/*.spec.ts | wc -l`). **45 rodam no CI**

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; awk '/^      FORA_DO_CI:/{f=1;next} /^    steps:/{f=0} f' .github/workflows/e2e.yml | grep -oE '[a-z0-9-]+\.spec\.ts'
```

**Deu:**

```
48 no disco; 47 nas listas de execução; FORA_DO_CI = vps-fresh-onboarding.spec.ts (1)
```

**Sugestão:** Specs Playwright em `tests/e2e/` — **reconte antes de citar** (`ls tests/e2e/*.spec.ts | wc -l`), e o quanto disso roda no CI sai de `echo $SPECS_PARTE_1 $SPECS_PARTE_2 | wc -w` em `.github/workflows/e2e.yml` (**check obrigatório**). A única de fora está declarada em `FORA_DO_CI` — hoje `vps-fresh-onboarding`, por dependência de serviço externo (WAHA/Redis/Resend/Nuvemshop).

**Vira teste:** tests/unit: nenhum número literal de specs e2e sobrevive em AGENTS.md/CLAUDE.md sem bater com `ls tests/e2e/*.spec.ts | wc -l`

### L159 · FRAGIL · gravidade media · ponteiro

> Ver issue #63.

**Mede com:**

```bash
gh issue view 63 --repo melgarafael/SonghaiCRM --json number,title,state
```

**Deu:**

```
{"number":63,"state":"CLOSED","title":"E2E: 3 das 33 specs fora do CI (inclui a vps-fresh-onboarding, P0) + e2e ainda não é gate"}
```

**Sugestão:** A exclusão e o motivo medido vivem no bloco `FORA_DO_CI` de `.github/workflows/e2e.yml` — a issue #63, que originou a discussão, está **fechada** e seu título descreve um estado que já não vale ("3 das 33 specs", "e2e ainda não é gate").

### L161 · FRAGIL · gravidade media · data-versao

> ## Limitações conhecidas (estado em 2026-07-29, contra `origin/main` @ 789dfa6)

**Mede com:**

```bash
git log --oneline -1 789dfa6 ; git rev-list --count 789dfa6..HEAD
```

**Deu:**

```
789dfa6f fix(audit): nenhuma acao via MCP era auditada, e o silencio escondia isso
(o cabeçalho declara 2026-07-29, mas o próprio bloco traz uma correção datada de 2026-08-14 na linha 166 — o SHA declarado não descreve o conteúdo do bloco)
```

**Sugestão:** ## Limitações conhecidas  > Cada item abaixo carrega o comando que o mede. Um item sem comando é suspeito de estar podre — meça antes de repassar. A régua de datar o bloco inteiro num SHA foi abandonada: os itens envelhecem em ritmos diferentes e o cabeçalho passava a mentir por todos eles.

### L163 · FALSA · gravidade media · contagem

> **1 das 46 specs E2E segue fora do CI** (`vps-fresh-onboarding`), e o `e2e` **é** check obrigatório desde 2026-08-08

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
48
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** **Exatamente 1 spec E2E segue fora do CI** (`vps-fresh-onboarding` — a lista viva é `FORA_DO_CI` em `.github/workflows/e2e.yml`), e o `e2e` **é** check obrigatório. Ou seja: um PR que quebre o `e2e` não entra — mas a jornada de instalação fresca, que é o produto que se vende, continua sem gate. Se você mexeu nela, a prova é sua.

### L168 · FALSA · gravidade alta · pendencia

> Rate limit HTTP existe em **2** pontos do código (webhook de captação e dispatcher de IA); login, signup, aceite de convite, crons e MCP estão sem. Não há lockout por conta no login.

**Mede com:**

```bash
grep -rn 'auth/rate-limit' app/ lib/ proxy.ts --include='*.ts' --include='*.tsx' | grep -v '\.test\.' ; grep -n 'contaBloqueadaPorFalhas\|registrarFalhaDeLogin' app/actions/auth/signInWithPassword.ts ; sed -n '136,142p' lib/auth/rate-limit.ts
```

**Deu:**

```
app/team/accept-invite/[token]/page.tsx:14:import { authRateLimited, AUTH_LIMITS }
app/actions/auth/signUp.ts:14:import { authRateLimited, AUTH_LIMITS }
app/actions/auth/requestPasswordReset.ts:8:import { authRateLimited, AUTH_LIMITS }
app/actions/auth/signInWithPassword.ts:13: contaBloqueadaPorFalhas / 14: registrarFalhaDeLogin / 58: (await authRateLimited("login", null, AUTH_LIMITS.login)) || (await contaBloqueadaPorFalhas(...)) / 78: await registrarFalhaDeLogin(...)

AUTH_LIMITS = { login: {ip: loginIpLimit(), id: 5, windowSec: 300}, signup: {ip:20, windowSec:3600}, reset: {ip:30, id:3, windowSec:3600}, invite_accept: {ip:60, windowSec:3600} }

(além disso: app/api/v1/webhooks/in/[token]/
```

**Sugestão:** Rate limit HTTP cobre hoje o webhook de captação, o dispatcher de IA e as quatro portas de auth — login, signup, recuperação de senha e aceite de convite (`AUTH_LIMITS` em `lib/auth/rate-limit.ts`). **Há** lockout por conta no login: 5 senhas erradas na mesma conta em 5 min trancam a janela, inclusive contra ataque distribuído por muitos IPs (`contaBloqueadaPorFalhas` / `registrarFalhaDeLogin`, chamados em `app/actions/auth/signInWithPassword.ts`). Continuam sem limitador: crons e MCP. Reconfira quem importa o módulo: `grep -rn 'auth/rate-limit' app/ lib/ --include='*.ts*' | grep -v '\.test\.'`.

**Vira teste:** tests/unit: signInWithPassword chama contaBloqueadaPorFalhas antes do provedor e registrarFalhaDeLogin depois de senha errada (guarda o comportamento, não o nome)

### L170 · FRAGIL · gravidade media · sobre-o-codigo

> Fallback do rate limit é **em memória** — sem Upstash configurado o limite é por processo.

**Mede com:**

```bash
grep -n 'UPSTASH' lib/env.ts ; sed -n '44,62p' lib/ai/dispatcher/rate-limit.ts
```

**Deu:**

```
lib/env.ts:83:  UPSTASH_REDIS_REST_URL: required("UPSTASH_REDIS_REST_URL"),
lib/env.ts:84:  UPSTASH_REDIS_REST_TOKEN: required("UPSTASH_REDIS_REST_TOKEN"),

comentário do próprio módulo: "A versão anterior dizia que as duas variáveis do Upstash são 'opcionais no kit self-host, então sem elas este é o caminho normal': falso, e medido — `lib/env.ts:83-84` as declara `required()`, o app não sobe sem elas. O que de fato leva para cá é Redis INALCANÇÁVEL com a variável presente"
```

**Sugestão:** Fallback do rate limit é **em memória** — mas o gatilho não é "sem Upstash configurado": `lib/env.ts` declara as duas variáveis do Upstash como `required()` e o app não sobe sem elas. O que cai para a memória é **Redis inalcançável com a variável presente** (contêiner `srh` parado, rede caída, URL errada) — e aí o limite passa a ser por processo.

### L172 · FALSA · gravidade alta · pendencia

> **6 vars de `lib/env.ts` faltam no `.env.example`**, incluindo 3 secrets.

**Mede com:**

```bash
comm -23 <(grep -oE '^\s{2}[A-Z][A-Z0-9_]+:' lib/env.ts | tr -d ' :' | sort -u) <(grep -oE '^[A-Z][A-Z0-9_]+' .env.example | sort -u)
```

**Deu:**

```
NODE_ENV

(45 chaves em lib/env.ts; 54 no .env.example; única ausente é NODE_ENV, que não é secret nem var de configuração do operador. Spot-check dos secrets: AI_CRED_AES_KEY:40, CPF_ENCRYPTION_KEY:33, LGPD_SIGNING_KEY:132, IMPERSONATE_COOKIE_SECRET:124, NUVEMSHOP_OAUTH_ENCRYPTION_KEY:35, WAHA_BYO_ENCRYPTION_KEY:37, INTERNAL_SECRET:18, INTERNAL_CRON_SECRET:20, WAHA_HMAC_SECRET:50 — todos presentes)
```

**Sugestão:** Toda var de `lib/env.ts` está no `.env.example` exceto `NODE_ENV` (que o runtime define, não o operador). Se você adicionar env var, adicione nos dois lugares (item 9 do DoD) — e confira com `comm -23 <(grep -oE '^\s{2}[A-Z][A-Z0-9_]+:' lib/env.ts | tr -d ' :' | sort -u) <(grep -oE '^[A-Z][A-Z0-9_]+' .env.example | sort -u)`.

**Vira teste:** tests/unit: toda chave do schema de lib/env.ts aparece em .env.example (allowlist explícita para NODE_ENV) — gate que substitui a contagem em prosa

### L176 · FALSA · gravidade media · contagem

> **89 dos 169 handlers de `app/api/**` usam service role** — sem gate automático para o filtro de `organization_id`

**Mede com:**

```bash
grep -rl "createAdminClient" app/api --include='route.ts' | wc -l ; git ls-files 'app/api/**/route.ts' | wc -l
```

**Deu:**

```
119
203
```

**Sugestão:** Boa parte dos handlers de `app/api/**` usa service role — **sem gate automático** para o filtro de `organization_id`. Meça hoje: `grep -rl createAdminClient app/api --include=route.ts | wc -l` de `git ls-files 'app/api/**/route.ts' | wc -l`. Escrevendo handler novo, o filtro é responsabilidade sua.


## `CLAUDE.md` — 14

### L8 · FALSA · gravidade media · contagem

> índice dos 149 docs

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && git ls-files 'docs/**/*.md' | wc -l && git ls-files 'docs/*.md' 'docs/**/*.md' | sort -u | wc -l && sed -n '13p' docs/index.md
```

**Deu:**

```
Régua declarada pelo próprio índice (`git ls-files 'docs/**/*.md' | wc -l`): 151. Contando também os 10 `.md` da raiz de docs/ (`git ls-files 'docs/*.md' 'docs/**/*.md' | sort -u | wc -l`): 161. docs/index.md:13 ainda diz "Mapa dos **149** arquivos `.md` de `docs/`, espalhados por **24** subpastas" — e `find docs -mindepth 1 -type d | wc -l` devolve 30. O cabeçalho do índice declara `audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)`.
```

**Sugestão:** - [`docs/index.md`]\(docs/index.md\) — índice dos docs de `docs/`, com regra de precedência quando dois docs discordam. Use antes de sair varrendo `docs/`. **O total citado lá dentro está congelado em 2026-07-27** — se precisar do número, conte: `git ls-files 'docs/*.md' 'docs/**/*.md' | sort -u | wc -l`.

**Vira teste:** tests/unit/doc-index.test.ts: extrair o número em negrito de docs/index.md:13 e comparar com a régua que a própria linha declara; reprovar na divergência.

### L31 · FALSA · gravidade media · sobre-o-codigo

> **Rate limit:** Upstash Redis sliding window

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && sed -n '17,20p' lib/auth/rate-limit.ts && sed -n '4p' lib/ai/dispatcher/rate-limit.ts
```

**Deu:**

```
lib/auth/rate-limit.ts:17-19: "Janela FIXA (é o que `checkRateLimit` implementa: `INCR` + `EXPIRE`), então uma rajada na virada da janela passa em dobro." lib/ai/dispatcher/rate-limit.ts:4: "Fixed-window counter on Upstash Redis: `ai-runs:<org>:<window-start>` with …". Nenhuma implementação de sliding window na superfície de rate limit.
```

**Sugestão:** - **Rate limit:** contador de **janela fixa** em Upstash Redis (`INCR` + `EXPIRE`, `lib/ai/dispatcher/rate-limit.ts`), com degradação para contador em memória do processo quando Upstash não está configurado. Janela fixa deixa passar rajada na virada — é limite de abuso, não de precisão. Sliding window nunca foi implementado; onde os docs antigos dizem isso, eles copiaram o PRD.

### L32 · FRAGIL · gravidade baixa · data-versao

> strings tipo `"anthropic/claude-sonnet-4-6"`

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && sed -n '24,34p' lib/ai/gateway.ts
```

**Deu:**

```
lib/ai/gateway.ts:24-33 — `export type ModelId = "anthropic/claude-sonnet-5" | "anthropic/claude-opus-5" | "anthropic/claude-haiku-4-5" | "openai/text-embedding-3-small" | (string & {})`; `DEFAULT_BOT_MODEL = "anthropic/claude-sonnet-5"`. O ID citado no doc (`claude-sonnet-4-6`) não está mais na união canônica — sobrevive só em fixtures de teste (lib/followup/plano-de-tempo.test.ts) e no comentário do próprio gateway.ts:5.
```

**Sugestão:** - **AI:** Vercel AI Gateway (Anthropic primário; OpenAI backup pra embeddings). Os IDs canônicos vivem na união `ModelId` de `lib/ai/gateway.ts` — leia lá em vez de copiar um exemplo daqui; hoje o default de chat é `DEFAULT_BOT_MODEL`.

### L49 · FALSA · gravidade alta · sobre-o-codigo

> POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h via Upstash)

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rln 'export async function POST' app/api/v1/ | wc -l && grep -rln 'Idempotency-Key' app/api/v1/ && grep -rn 'redis|upstash' 'app/api/v1/lgpd/requests/[id]/approve/route.ts'
```

**Deu:**

```
95 arquivos de rota declaram POST em app/api/v1/. Exatamente 1 lê o header: app/api/v1/lgpd/requests/[id]/approve/route.ts (linhas 41-45). E ele NÃO usa Upstash — persiste na tabela Postgres `idempotency_keys` (linha 81: `.from("idempotency_keys")`). Grep por redis/upstash nesse arquivo: 0 ocorrências.
```

**Sugestão:** - Idempotência de POST **não é geral**: hoje só `POST /api/v1/lgpd/requests/{id}/approve` exige `Idempotency-Key`, e ele grava na tabela Postgres `idempotency_keys` (não em Upstash). Antes de assumir que sua rota nova herda isso, meça: `grep -rln 'Idempotency-Key' app/api/v1/`. Estender para os demais POSTs de criação é trabalho em aberto, não estado atual.

### L56 · FALSA · gravidade alta · sobre-o-codigo

> Paginação: cursor opaco base64+HMAC por default

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rn 'base64url' app/api/v1/leads/_handler.ts app/api/v1/messages/_handler.ts && for f in app/api/v1/messages/_handler.ts app/api/v1/leads/_handler.ts app/api/v1/admin/inbox/conversations/route.ts; do printf '%s createHmac=' $f; grep -c createHmac $f; done && grep -rln createHmac app/api/v1/
```

**Deu:**

```
leads/_handler.ts:125 e messages/_handler.ts:143 decodificam com `JSON.parse(Buffer.from(raw,"base64url").toString("utf8"))` — JSON em base64url, sem assinatura. createHmac = 0 nos três handlers de cursor. Em toda a app/api/v1 só 3 arquivos usam createHmac, e os três são webhooks da Nuvemshop (store-redact, customer-data-request, customer-redact).
```

**Sugestão:** - Paginação: cursor opaco em **base64url de um JSON** — hoje **sem HMAC**. O cursor é adivinhável e forjável; trate-o como entrada não confiável e valide o payload decodificado antes de usar. Assinar o cursor é dívida aberta, não o estado do código: `grep -rln createHmac app/api/v1/` devolve só os webhooks da Nuvemshop.

**Vira teste:** tests/unit/cursor-assinado.test.ts: montar um cursor com base64url(JSON) alterado à mão e afirmar que o handler o REJEITA. Hoje ele nasce vermelho — é a catraca que segura a correção.

### L60 · FALSA · gravidade media · sobre-o-codigo

> Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rin 'x-ratelimit' --include='*.ts' --include='*.tsx' . | grep -v node_modules && grep -rn 'Retry-After' --include='*.ts' lib/ app/ | grep -v test
```

**Deu:**

```
`X-RateLimit` não aparece em NENHUM arquivo .ts/.tsx do repo — só em CLAUDE.md:60, docs/prd, docs/specs, docs/business-rules e lib/api/README.md. `Retry-After` é emitido em exatamente 1 rota: app/api/v1/webhooks/in/[token]/route.ts:62 (`"Retry-After": "60"`); lib/api/client.ts:152 só o LÊ. Bônus: lib/api/README.md:25 aponta para um `rate-limit.ts` que não existe em lib/api/ (o diretório tem client, errors, handlers, recusa, types, wrappers).
```

**Sugestão:** - Rate limit: hoje o produto devolve `Retry-After` em **uma** rota (`app/api/v1/webhooks/in/[token]`) e **nenhum** header `X-RateLimit-*` — a família inteira só existe nos PRDs/specs. Se for implementar, faça no `fail()` de `lib/api/wrappers.ts` para valer em todas as rotas de uma vez; até lá não prometa o header a integrador. Confira: `grep -rin 'x-ratelimit' --include='*.ts' .`

**Vira teste:** tests/unit/wrappers.test.ts: afirmar que `fail("rate_limited", …, { status: 429 })` responde com `Retry-After` e `X-RateLimit-Limit`. Nasce vermelho e vira a catraca.

### L61 · FRAGIL · gravidade baixa · sobre-o-codigo

> `X-Request-Id` em toda response (correlaciona com audit log)

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rln 'NextResponse.json' app/api/v1/ && grep -rln 'from "@/lib/api/wrappers"' app/api/v1/ | wc -l && grep -n 'X-Request-Id' lib/api/wrappers.ts
```

**Deu:**

```
lib/api/wrappers.ts seta o header em 3 pontos (linhas 56, 81, 91) — ok()/fail(). 211 arquivos de app/api/v1 importam os wrappers. Mas 3 rotas respondem por fora deles: app/api/v1/health/route.ts, app/api/v1/webhooks/meta/[token]/route.ts, app/api/v1/onboarding/whatsapp/session/route.ts — essas saem sem X-Request-Id.
```

**Sugestão:** - `X-Request-Id` em toda response **que passa por `ok()`/`fail()`** (é o wrapper que o injeta). Três rotas respondem com `NextResponse.json` direto e escapam — `health`, `webhooks/meta/[token]` e `onboarding/whatsapp/session`. Rota nova usa o wrapper; se não usar, não é correlacionável.

**Vira teste:** tests/unit/rotas-usam-wrappers.test.ts: varrer app/api/v1/**/route.ts, reprovar `NextResponse.json` fora de uma allowlist nomeada (catraca que só encolhe).

### L76 · FALSA · gravidade media · pendencia

> Retenção 5 anos. Hot 90 dias, cold (S3) o resto

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rin 's3' --include='*.ts' --include='*.sql' lib/ app/api/v1/cron/ supabase/baseline.sql | grep -i 'audit\|cold\|arquiv' && grep -rn 'Retencao 5 anos' supabase/baseline.sql
```

**Deu:**

```
Zero ocorrências de arquivamento em S3 ligado ao audit log. O único vestígio da política é um COMMENT: supabase/baseline.sql:1276 — `COMMENT ON TABLE "public"."api_audit_log" IS 'L-10: Append-only. Retencao 5 anos.'`. Nenhum cron/worker de expurgo ou de cold storage existe (nada em app/api/v1/cron/ toca retenção de audit).
```

**Sugestão:** - Retenção pretendida: 5 anos (registrada como COMMENT em `api_audit_log`). **Nada disso é executado hoje**: não há expurgo de 90 dias nem arquivamento cold em S3 — a tabela só cresce. Tratar como pendência declarada, não como comportamento; quem dimensionar disco de VPS precisa saber disso.

### L92 · FRAGIL · gravidade media · sobre-o-codigo

> STOP detection: regex `/STOP|PARAR|SAIR|UNSUBSCRIBE/i` no inbound → `is_blocked=true` automaticamente

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -rn 'UNSUBSCRIBE' --include='*.ts' lib/ app/ workers/
```

**Deu:**

```
lib/channels/pos-entrada.ts:73 — `export const STOP_RX = /(?<![\p{L}\p{N}])(STOP|PARAR|SAIR|UNSUBSCRIBE)(?![\p{L}\p{N}])/iu;`. A regex real tem lookarounds de borda unicode que a do doc não tem: a do doc casa dentro de palavra ("PARARIA", "SAIRAM", "desistop") e bloquearia o contato por engano.
```

**Sugestão:** - STOP detection: `STOP_RX` em `lib/channels/pos-entrada.ts` — as palavras STOP/PARAR/SAIR/UNSUBSCRIBE **com borda de palavra unicode** (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`), senão "PARARIA" e "SAIRAM" bloqueiam o contato. Importe a constante; **nunca** redigite a regex.

**Vira teste:** tests/unit/pos-entrada.test.ts: afirmar que STOP_RX NÃO casa 'PARARIA'/'SAIRAM'/'desistop' e casa 'PARAR'/'stop'.

### L250 · FRAGIL · gravidade baixa · sobre-o-codigo

> pnpm typecheck   # tsc --noEmit (estrito)

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && python3 -c "import json;print(json.load(open('package.json'))['scripts']['typecheck'])" && ls tsconfig*.json
```

**Deu:**

```
typecheck = `tsc --noEmit -p tsconfig.typecheck.json`. Existem DOIS tsconfig: tsconfig.json (com `"strict": true`, linha 11) e tsconfig.typecheck.json — o gate roda contra o segundo, não contra o default.
```

**Sugestão:** pnpm typecheck   # tsc --noEmit -p tsconfig.typecheck.json (projeto próprio, não o tsconfig.json default)

### L253 · FALSA · gravidade media · contagem

> pnpm test:db     # Postgres efêmero + baseline install/update + 364 invariantes

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && gh run view --job 94858059457 --log | grep -a 'Test Files\|Tests '
```

**Deu:**

```
Job `invariants` do run 31828419528 (ci.yml, main, HEAD 840917ed, 2026-08-14T18:26): "Test Files 103 passed (103)" e "Tests 760 passed | 1 expected fail | 1 skipped (762)". Controle local: `ls tests/invariants/*.ts | wc -l` = 107 arquivos.
```

**Sugestão:** pnpm test:db     # Postgres efêmero + baseline install/update + a suíte de invariantes (conte: o job `invariants` imprime "Test Files"/"Tests" no fim do log)

### L254 · FALSA · gravidade media · sobre-o-codigo

> pnpm test:e2e    # Playwright (requer dev server)

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && sed -n '118,140p' playwright.config.ts
```

**Deu:**

```
playwright.config.ts:118-138 — `webServer: { command: \`pnpm exec next start --port ${PORT}\`, …, reuseExistingServer: false }`, com o comentário: "Produção (`next build` antes!): dev-server compila por rota (40-80s) e Turbopack dev quebra cookies() fora do request scope — inviável p/ e2e." Ou seja: a suíte SOBE o próprio servidor de produção e recusa reusar qualquer processo na porta. Contradiz o próprio CLAUDE.md:303, que manda usar `next build` + `next start`.
```

**Sugestão:** pnpm test:e2e    # Playwright — exige `pnpm build` antes; ele sobe o próprio `next start` (nunca reusa servidor na porta)

### L261 · FALSA · gravidade alta · ativo-obrigatorio

> - **`verify`** (`ci.yml`) — typecheck + lint + test:unit.

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && grep -n '      - name:' .github/workflows/ci.yml
```

**Deu:**

```
verify tem 5 passos executáveis: 'Typecheck' (pnpm typecheck), 'Lint' (pnpm lint), 'Channel provider leak' (pnpm lint:channels, ci.yml:35), 'Unit tests' (pnpm test:unit, ci.yml:38), 'Kit self-host (bash)' (pnpm test:shell, ci.yml:50). A descrição do CLAUDE.md nomeia 3 de 5.
```

**Sugestão:** - **`verify`** (`ci.yml`) — cinco passos, não três: `typecheck`, `lint`, `lint:channels`, `test:unit` e `test:shell` (o kit self-host em bash). Confira a lista na fonte, que é onde ela muda: `grep -n '      - name:' .github/workflows/ci.yml`.

**Vira teste:** tests/unit/doutrina-ci.test.ts: ler .github/workflows/ci.yml, extrair os `- name:` do job `verify`, e reprovar quando um passo existir no workflow e não estiver citado no bloco 'Testes' do CLAUDE.md

### L264 · FALSA · gravidade media · contagem

> roda **45 das 46 specs** Playwright (medido em 2026-08-14 @ `741c4ec8`; **reconte antes de citar**

**Mede com:**

```bash
cd "$(git rev-parse --show-toplevel)" && ls tests/e2e/*.spec.ts | wc -l && python3 -c "import yaml;e=yaml.safe_load(open('.github/workflows/e2e.yml'))['jobs']['e2e']['env'];print('RODOU',len(e['SPECS_PARTE_1'].split())+len(e['SPECS_PARTE_2'].split()),'FORA',len(e['FORA_DO_CI'].split()))"
```

**Deu:**

```
48 specs no disco. SPECS_PARTE_1 = 25, SPECS_PARTE_2 = 22 → RODOU 47; FORA_DO_CI = 1 (vps-fresh-onboarding.spec.ts). Ou seja: 47 de 48, não 45 de 46. Nenhuma spec fora das três listas (a soma fecha).
```

**Sugestão:** - **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda todas as specs de `tests/e2e/` menos as declaradas em `FORA_DO_CI`. **Não cite o número aqui** — ele já apodreceu quatro vezes. Meça: `ls tests/e2e/*.spec.ts | wc -l` para o disco, e o passo "Declarar o que este job ainda NÃO cobre" do próprio job, que CONTA em vez de afirmar. A exclusão de hoje é `vps-fresh-onboarding` (precisa de WAHA + Redis + Resend + Nuvemshop) — e ela é a **P0** da doutrina de QA Visual, ou seja, `e2e` verde **não** prova a jornada de instalação fresca, que é o produto que se vende.

**Vira teste:** tests/unit/e2e-cobertura-completa.test.ts já garante a SOMA das três listas. Falta o complemento: reprovar quando o CLAUDE.md contiver a string 'das NN specs' — o número não deve existir na doutrina.


## `CONTRIBUTING.md` — 11

### L7 · FRAGIL · gravidade media · ponteiro

> Identifique o epic de origem em [`docs/stories/epics/MASTER.md`]\(docs/stories/epics/MASTER.md\).

**Mede com:**

```bash
git log -1 --format='%h %ad %s' --date=short -- docs/stories/epics/ ; git log --since="2026-05-14" --oneline -- docs/stories/epics/ | wc -l ; git log -1 --format=%ad --date=short
```

**Deu:**

```
Último toque: `3eb57cf4 2026-05-06 feat(epic-13): UI Lista agentes + Credentials [wave 10]`. Commits nos últimos 3 meses: **0**. HEAD é de 2026-08-14 — o diretório está parado há 3 meses e 8 dias. O arquivo EXISTE (257 linhas), mas o processo que ele descreve morreu.
```

**Sugestão:** 3. Se a sua mudança nasce de uma issue, cite o número dela no PR. (`docs/stories/epics/` é registro histórico da construção do MVP — último commit em 2026-05-06; não é mais o ponto de partida de contribuição.)

**Vira teste:** assertar que CONTRIBUTING.md não manda "identificar o epic de origem" se `git log -1 --format=%ct -- docs/stories/epics/` for mais velho que N dias — ou, mais simples, marcar o diretório como histórico e proibir a instrução

### L22 · FALSA · gravidade media · sobre-o-codigo

> Conventional commits + escopo `EPIC-XX`

**Mede com:**

```bash
git log -60 --format=%s | grep -oE '^[a-z]+\(([^)]+)\)' | sed -E 's/^[a-z]+\(//;s/\)$//' | sort | uniq -c | sort -rn | head -12
```

**Deu:**

```
15 marca / 12 onboarding / 3 kit / 2 runbook / 2 ci / 2 auth / 1 vocabulário / 1 u6c / 1 u6b / 1 p4 / 1 merge / 1 J1.21 — **zero** commits com escopo `EPIC-XX` nos últimos 60.
```

**Sugestão:** Conventional commits. O escopo é o **assunto real da mudança** — a área (`marca`, `onboarding`, `kit`, `ci`, `auth`) ou o número da issue (`#184`). Exemplos do que está na `main`:  ``` fix(#184): o gate de idempotência deixa de ser decorativo feat(packaging): o worker e o scheduler viram imagem publicada docs(runbook): deploy com os dois arquivos de compose ```  Confira o padrão vigente antes de copiar daqui: `git log -30 --format=%s`.

### L30 · FALSA · gravidade baixa · sobre-o-codigo

> O assunto deve ser imperativo e ≤72 chars.

**Mede com:**

```bash
git log -60 --format=%s | awk 'length($0)>72' | wc -l
```

**Deu:**

```
35 (de 60 commits, 58% estouram os 72 chars — inclusive os da própria `main` recente)
```

**Sugestão:** Mensagens em PT-BR são aceitas e o assunto deve ser imperativo. **Não há teto de caracteres imposto** — a `main` tem assuntos longos de propósito, porque a frase que explica a mudança vale mais que a coluna 72. Se quiser conferir a prática atual: `git log -30 --format=%s | awk '{print length($0)}' | sort -n | tail -1`.

### L34 · FRAGIL · gravidade media · ponteiro

> O `epic-executor` consome o frontmatter (`epic_id`, `priority`, `depends_on`, `status`) e executa wave-by-wave com validação E2E continuous.

**Mede com:**

```bash
ls .claude/skills/ ; test -e .claude/skills/epic-executor && echo existe || echo AUSENTE_NO_REPO ; grep -rn 'epic_id\|priority\|depends_on' ~/.claude/skills/epic-executor/scripts/*.py | head -5
```

**Deu:**

```
`.claude/skills/` do repo contém apenas `SonghaiCRM` e `sistema-vivo` → `AUSENTE_NO_REPO`. A skill só existe em `~/.claude/skills/epic-executor/` (instalação pessoal do mantenedor); os campos são de fato lidos lá (`init_epic_state.py:29,54,87,144`). Frontmatter: 15/15 arquivos `EPIC-*.md` têm `epic_id`, `priority`, `depends_on` e `status`.
```

**Sugestão:** Remover a seção `### epic-executor`. Ela descreve uma ferramenta que **não está no repositório** (`.claude/skills/` só traz `SonghaiCRM` e `sistema-vivo`) e um fluxo parado desde 2026-05-06 — quem vem de fora não tem como executá-la e vai gastar tempo procurando. Se ficar, precisa dizer em uma linha: "ferramenta interna do mantenedor, não distribuída no clone".

**Vira teste:** para cada ferramenta citada como parte do fluxo em CONTRIBUTING.md, assertar que ela existe no repositório (`.claude/skills/<nome>` ou `package.json` scripts)

### L38 · FRAGIL · gravidade baixa · pendencia

> Ao finalizar um epic: 1. Atualizar frontmatter `status: pending → completed (partial: ...)` ... 3. Atualizar a row correspondente em `docs/stories/epics/MASTER.md`.

**Mede com:**

```bash
git log --since="2026-05-14" --oneline -- docs/stories/epics/ | wc -l
```

**Deu:**

```
0 — nenhum commit atualizou frontmatter ou MASTER.md em 3 meses, apesar de a `main` ter recebido dezenas de features nesse período (packaging, marca própria, onboarding, MFA opcional).
```

**Sugestão:** Remover junto com a seção `### epic-executor` (mesmo processo, mesma morte). Se houver intenção de reviver, o passo é uma issue com dono — não um parágrafo num doc que ninguém executa.

### L50 · FRAGIL · gravidade media · ativo-obrigatorio

> **O que o CI reprova sozinho** — rode antes de abrir o PR e não terá surpresa:

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; grep -n 'run: pnpm' .github/workflows/ci.yml .github/workflows/perf.yml
```

**Deu:**

```
Obrigatórios: verify, build-and-size, invariants, e2e, imagens-ok. O bloco local cobre `verify` (typecheck, lint, lint:channels, test:unit, test:shell), `build-and-size` (pnpm build) e `invariants` (pnpm test:db) — **3 dos 5**. `e2e` e `imagens-ok` não são exercitados por nenhum comando desse bloco.
```

**Sugestão:** **O que você consegue reproduzir na sua máquina** — cobre 3 dos 5 checks obrigatórios (`verify`, `build-and-size`, `invariants`):  ```bash pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build pnpm test:db   # precisa de Docker; sobe um Postgres limpo e aplica o baseline ```  Os outros dois — `e2e` e `imagens-ok` — só rodam no CI e podem te surpreender no PR: o `e2e` sobe Supabase local, e o `imagens-ok` constrói as três imagens Docker (o `next build` de dentro da imagem não enxerga `tests/`, então ele pega coisa que o `pnpm build` daqui não pega).

### L69 · FALSA · gravidade media · ativo-obrigatorio

> Nenhum job de CI confere isso

**Mede com:**

```bash
pnpm vitest run tests/unit/manifest-x-migrations.test.ts 2>&1 | tail -5 ; grep -n 'run: pnpm test:unit' .github/workflows/ci.yml
```

**Deu:**

```
Test Files 1 passed (1) / Tests 6 passed (6) — e `.github/workflows/ci.yml:38: run: pnpm test:unit` dentro do job `verify` (required check). O arquivo guarda os DOIS sentidos: linha do MANIFEST sem arquivo e arquivo sem linha no MANIFEST.
```

**Sugestão:** O CI confere DUAS das três pernas: `tests/unit/manifest-x-migrations.test.ts` (roda no `verify`) reprova migration sem linha no MANIFEST e linha no MANIFEST sem arquivo. A perna que **nenhum job confere** é o baseline: migration sem apêndice em `supabase/baseline.sql` passa verde e simplesmente não chega em quem instalou numa VPS. Confira com `pnpm vitest run tests/unit/manifest-x-migrations.test.ts`

**Vira teste:** grep em CONTRIBUTING.md por "Nenhum job de CI confere" cruzado com a existência de tests/unit/manifest-x-migrations.test.ts — se o teste existe, a frase é falsa

### L72 · FALSA · gravidade alta · pendencia

> O CI reprova serviço `build:`-only e instalação em tag móvel (imagem quebrada ainda não bloqueia merge)

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; sed -n '70,79p' CONTRIBUTING.md
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
(e, 5 linhas abaixo, o próprio CONTRIBUTING.md já lista imagens-ok como obrigatório: "Obrigatórios: `verify`, `invariants` (isolamento RLS), `build-and-size`, `e2e` e `imagens-ok`.")
```

**Sugestão:** O CI reprova serviço `build:`-only, instalação em tag móvel e imagem quebrada (`imagens-ok` é required check da `main`);

**Vira teste:** o mesmo teste textual do achado da linha 390 — a frase foi replantada no irmão, e o arquivo se contradiz cinco linhas abaixo

### L72 · FALSA · gravidade alta · pendencia

> O CI reprova serviço `build:`-only e instalação em tag móvel (imagem quebrada ainda não bloqueia merge)

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** O CI reprova serviço `build:`-only, instalação em tag móvel **e imagem que não constrói** — as três coisas bloqueiam merge. Confira a lista viva com `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'`;

**Vira teste:** expect(contexts).toContain('imagens-ok') — assertar que o parêntese "ainda não bloqueia" não sobrevive à ativação do check; ou um teste de doc que proíba a string "ainda não bloqueia merge" em CONTRIBUTING.md enquanto imagens-ok estiver na branch protection

### L82 · FRAGIL · gravidade baixa · ponteiro

> O `imagens-ok` (em `.github/workflows/publish-image.yml`) constrói as três imagens que o self-hoster instala

**Mede com:**

```bash
grep -rn 'imagens-ok' .github/workflows/ ; sed -n '160,180p' .github/workflows/publish-image.yml ; sed -n '58,90p' .github/workflows/publish-image.yml | grep 'name:\|dockerfile:'
```

**Deu:**

```
`.github/workflows/publish-image.yml:160:  imagens-ok:` — existe e o path está certo. Mas o job é fachada: `needs: [build-and-push]`, `permissions: {}`, e o único step roda `[ "${{ needs.build-and-push.result }}" = "success" ]`. Quem constrói é `build-and-push`, matriz de 3: deskcommcrm/Dockerfile, deskcomm-worker/Dockerfile.worker, deskcomm-scheduler/Dockerfile.scheduler.
```

**Sugestão:** O `publish-image.yml` constrói as três imagens que o self-hoster instala (`deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler`); o check `imagens-ok` é o job de fachada que reprova quando qualquer uma delas falha. Roda em PR e **bloqueia** desde 2026-08-13.

**Vira teste:** assertar que o job `imagens-ok` existe em .github/workflows/publish-image.yml e que sua lista `needs` cobre o job da matriz de 3 imagens

### L139 · FALSA · gravidade media · ponteiro

> Veja [`README.md`]\(README.md\) §Como rodar local.

**Mede com:**

```bash
grep -n 'Como rodar local' README.md ; grep -n '^#' README.md
```

**Deu:**

```
grep 'Como rodar local' → sem saída (0 ocorrências). Seções reais do README: `## ⚡ Instalar na sua VPS`, `## 🔄 Atualizar`, `## 🧑‍💻 Desenvolvimento (só pra contribuir com o código)` (linha 265), `## 🧪 Testes` (321).
```

**Sugestão:** Veja [`README.md`]\(README.md\) §🧑‍💻 Desenvolvimento — inclui a receita de schema (aplique o `baseline.sql`, **não** as `migrations/`).

**Vira teste:** para cada link markdown com âncora `§<texto>` num doc, assertar que `<texto>` aparece como heading no arquivo apontado


## `README.en.md` — 14

### L123 · FALSA · gravidade alta · ativo-obrigatorio

> have **Google Authenticator** or **Authy** at hand — the first admin login requires MFA

**Mede com:**

```bash
npx tsx <chama exigeCadastroDeMfa({role:'admin',isPlatformAdmin:true,plataformaExige:false,empresaExige:false})> ; grep -n 'mfa_required' scripts/bootstrap-owner.ts
```

**Deu:**

```
dono do install.sh exige MFA? false
scripts/bootstrap-owner.ts:215: mfa_required: false,
```

**Sugestão:** (pt-br: mesma correção do README.md, traduzida.) Texto pronto: "Open `https://<your-domain>` (the padlock takes ~1 min to appear) and sign in as the admin. **Two-factor authentication is not required by default** — `install.sh` creates the owner with `mfa_required = false`, on purpose: a full-screen blocker right after onboarding was where fresh installs died. Want to enforce it? Turn it on under **Settings › Security** (the rule lives in `lib/auth/politica-mfa.ts`). During onboarding, scan the QR code with your WhatsApp number."

**Vira teste:** o mesmo teste do achado do README.md, varrendo os três arquivos

### L167 · FALSA · gravidade media · data-versao

> **The target is the latest published release** (`v1.2.3`), not the tip of `main`

**Mede com:**

```bash
git tag -l 'v*' --sort=-v:refname | head -1 ; grep -n '1.3.0' CHANGELOG.md
```

**Deu:**

```
v1.3.0 ; CHANGELOG.md:11 "## [1.3.0] — 2026-08-13" ; nenhuma tag nem seção v1.2.3 existe
```

**Sugestão:** (pt-br: apagar o número inventado.) Texto pronto: "**The target is the latest published release** — the newest tag, the same one `git tag -l 'v*' --sort=-v:refname | head -1` returns — not the tip of `main`."

### L174 · FRAGIL · gravidade baixa · sobre-o-codigo

> If you see `⚠ avisos que não são os esperados`, that one is worth keeping.

**Mede com:**

```bash
grep -rn 'avisos que' hostgator-setup-kit/ ; sed -n '144,151p' hostgator-setup-kit/update.sh
```

**Deu:**

```
ZERO ocorrências de 'avisos que'. A string real é update.sh:146 "⚠ Apareceram avisos no banco que NÃO são os esperados:"
```

**Sugestão:** (pt-br: citar a string literal do script.) Texto pronto: "If you see `⚠ Apareceram avisos no banco que NÃO são os esperados:`, that one is worth keeping."

### L234 · FALSA · gravidade media · sobre-o-codigo

> | **CRM** | **Kanban** (where each deal sits in the funnel) · **Contacts** · **Pipelines** (stages, business vocabulary and loss reasons) |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts ; sed -n '166,210p' lib/navigation/registry.ts
```

**Deu:**

```
grupo crm: "Funis" (/app/kanban), "Contatos", "Etapas do funil" (/app/settings/tenant/pipelines). Comentário no registry: "ERA Kanban ... o produto tinha CINCO vocabulários para a mesma coisa"; e "Pipeline é palavra de quem construiu o sistema; funil de vendas é palavra de quem vende".
```

**Sugestão:** (pt-br: o produto baniu "Kanban"/"Pipeline" da interface; o README ensina o vocabulário errado.) Texto pronto: "| **CRM** | **Funis** / Funnels (your sales funnels — click one to open its board) · **Contacts** · **Etapas do funil** / Funnel stages (each funnel's columns, business vocabulary and loss reasons) |"

**Vira teste:** tests/unit/readme-telas.test.ts cobrindo os três arquivos

### L238 · FALSA · gravidade baixa · contagem

> | **Organization** | **Team** · **Support distribution** · **Organization** · **LGPD** · **API Tokens** · **Security** ... |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts | sed 's/label: //'
```

**Deu:**

```
... "Equipe" "Distribuição de atendimento" "Organização" "Marca" "Billing" "LGPD" "API Tokens" => a tela "Marca" (/app/settings/marca) falta na tabela
```

**Sugestão:** (pt-br: acrescentar a tela Marca.) Texto pronto: "| **Organization** | **Team** · **Support distribution** · **Organization** · **Marca** (white-label: name, logo and accent of the installation) · **LGPD** · **API Tokens** · **Security** (MFA, recovery codes, sessions) · Profile, Notifications, Billing |"

### L240 · FRAGIL · gravidade baixa · ativo-obrigatorio

> Every screen has a door in the navigation — CI fails a screen that exists but can only be reached by typing its URL.

**Mede com:**

```bash
npx vitest run tests/unit/navegacao-completude.test.ts ; sed -n '19,46p' tests/unit/navegacao-completude.test.ts
```

**Deu:**

```
Tests 6 passed (6). ESCOPO declarado: "só app/app/** ... O admin de plataforma (app/admin/), o onboarding e as páginas públicas têm navegação própria". NAV_ALLOWLIST com 7 rotas isentas.
```

**Sugestão:** (pt-br: declarar o escopo e a allowlist.) Texto pronto: "Every `app/app/**` screen has a door in the navigation — or an entry in the allowlist of `tests/unit/navegacao-completude.test.ts` with a written justification. CI fails a new screen that has neither."

### L308 · FALSA · gravidade alta · ativo-obrigatorio

> **Four checks are required** to merge into `main` — all verified in branch protection, not just on paper

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** (pt-br: trocar o numeral pela régua e acrescentar a linha do `imagens-ok`.) Texto pronto: "**The required checks** to merge into `main` are whatever branch protection says — that is the ruler, not this table: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(\", \")'`" + nova linha da tabela: "| `imagens-ok` | fails when any of the three published Docker images (`app`, `worker`, `scheduler`) does not build — job `imagens-ok` in `.github/workflows/publish-image.yml` |"

**Vira teste:** tests/unit/readme-checks-obrigatorios.test.ts cobrindo os três arquivos

### L313 · FALSA · gravidade media · contagem

> runs **618 invariants across 98 files**

**Mede com:**

```bash
TEST_DB_CONTAINER=fake npx vitest list --config vitest.db.config.ts | grep -c ' > ' ; ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
761 ; 103
```

**Sugestão:** (pt-br: trocar o número pelo comando.) Texto pronto: "...and runs the `tests/invariants/**` suite — RBAC, assignment, scoping, routing, follow-up, webhooks and automations. For today's number: `TEST_DB_CONTAINER=x npx vitest list --config vitest.db.config.ts | grep -c ' > '`"

### L315 · FALSA · gravidade media · contagem

> runs **44 of the 45** Playwright specs through the frontend

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; python3 <soma SPECS_PARTE_1+SPECS_PARTE_2+FORA_DO_CI>
```

**Deu:**

```
disco: 48 ; rodam 47 (25+22) ; fora 1 (vps-fresh-onboarding) ; nao listadas: []
```

**Sugestão:** (pt-br: tirar o par de números.) Texto pronto: "| `e2e` | boots a local Supabase, applies `baseline.sql` and runs **every spec in `tests/e2e/` but one** through the frontend — the job itself fails if a spec on disk is in none of the three lists. Recount with `ls tests/e2e/*.spec.ts | wc -l` |"

### L319 · FRAGIL · gravidade baixa · sobre-o-codigo

> proves a user of org A sees **zero rows** of org B in `conversations`, `messages`, `contacts` and `crm_leads`. A control case first proves org B's rows actually exist

**Mede com:**

```bash
sed -n '200,258p' tests/invariants/rls-isolation.test.ts
```

**Deu:**

```
TABLES tem 12 entradas (conversations ... org_guardrail_layers), não 4. O caso "superuser sees both orgs (seed sanity)" roda DEPOIS do laço, não antes.
```

**Sugestão:** (pt-br: 12 tabelas e o controle vem depois.) Texto pronto: "...proves a user of org A sees **zero rows** of org B in every table of the `TABLES` list in `tests/invariants/rls-isolation.test.ts` — 12 today, from `conversations` to `org_guardrail_layers`. Each table carries a positive control (user A still reads their own org's rows), and the suite closes by checking both orgs' rows really exist — without that, the test would pass against an empty table."

### L336 · FALSA · gravidade media · contagem

> Index of all 157 documents, with a precedence rule

**Mede com:**

```bash
git ls-files 'docs/**/*.md' | wc -l ; find docs -name '*.md' | wc -l ; grep -n '149' docs/index.md
```

**Deu:**

```
151 ; 161 ; docs/index.md:13 "Mapa dos **149** arquivos .md de docs/ ... régua: git ls-files 'docs/**/*.md' | wc -l"
```

**Sugestão:** (pt-br: trocar o total pela régua.) Texto pronto: "| [`docs/index.md`]\(docs/index.md\) | Index of the `docs/` documents, with a precedence rule for when two docs disagree (the index itself carries the ruler: `git ls-files 'docs/**/*.md' | wc -l`) |"

### L361 · FALSA · gravidade alta · ativo-obrigatorio

> That line is the **complete** list of required gates on purpose

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; sed -n '356,358p' README.en.md
```

**Deu:**

```
protection: verify, build-and-size, invariants, e2e, imagens-ok
README.en.md:356: pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
README.en.md:357: pnpm test:db
=> cobre verify + build-and-size + invariants; NÃO cobre e2e nem imagens-ok.
```

**Sugestão:** (pt-br: dizer que a linha é só o que roda local.) Texto pronto: "That line is everything you can run on **your own machine**, on purpose: running half of them and discovering the rest as a red surprise after hours of waiting is the worst first experience this repository knows how to deliver. It covers `verify`, `build-and-size` and `invariants`; the other two required checks (`e2e` and `imagens-ok`) only run in CI. The live list comes from `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(\", \")'`."

### L379 · FRAGIL · gravidade baixa · pendencia

> **Foundation & platform** — auth (MFA for admins), multi-tenancy with RLS + isolation test

**Mede com:**

```bash
npx tsx <exigeCadastroDeMfa com o estado do install.sh> ; grep -n mfa_required scripts/bootstrap-owner.ts
```

**Deu:**

```
dono do install.sh exige MFA? false ; bootstrap-owner.ts:215 mfa_required: false
```

**Sugestão:** (pt-br: MFA virou opcional.) Texto pronto: "**Foundation & platform** — auth (**optional** two-factor, enforceable per organization or platform-wide under Settings › Security), multi-tenancy with RLS + isolation test, 4-role RBAC, append-only audit log, tenant onboarding."

### L422 · FRAGIL · gravidade media · sobre-o-codigo

> **no** performance tracing and **no** session replay, both pinned to 0 on that path

**Mede com:**

```bash
cat instrumentation-client.ts
```

**Deu:**

```
tracesSampleRate: community ? 0 : 1 ; replaysSessionSampleRate: community ? 0 : 0.1 ; replaysOnErrorSampleRate: 1.0  <-- não depende de `community`
```

**Sugestão:** (pt-br: o replay DE ERRO continua ligado — omitir isso num parágrafo de privacidade é o pior lugar para omitir.) Texto pronto: "— **no** performance tracing and **no** session replay (both pinned to 0 on that path). Error replay stays on, deliberately: it only records when there is an error, it is what explains the stack trace, and it ships with `maskAllText`/`blockAllMedia`."


## `README.es.md` — 14

### L124 · FALSA · gravidade alta · ativo-obrigatorio

> mano **Google Authenticator** o **Authy** — el primer inicio de sesión de admin exige MFA

**Mede com:**

```bash
npx tsx <chama exigeCadastroDeMfa({role:'admin',isPlatformAdmin:true,plataformaExige:false,empresaExige:false})> ; grep -n 'mfa_required' scripts/bootstrap-owner.ts
```

**Deu:**

```
dono do install.sh exige MFA? false
scripts/bootstrap-owner.ts:215: mfa_required: false,
```

**Sugestão:** (pt-br: mesma correção do README.md, traduzida.) Texto pronto: "Abre `https://<tu-dominio>` (el candado tarda ~1 min en aparecer) y entra con el admin. La **verificación en dos pasos no se exige por defecto** — el `install.sh` crea al dueño con `mfa_required = false`, a propósito: un bloqueador de pantalla completa justo después del onboarding era donde moría la instalación nueva. ¿Quieres exigirla? Actívala en **Configuración › Seguridad** (la regla vive en `lib/auth/politica-mfa.ts`). En el onboarding, escanea el código QR con el WhatsApp de tu número."

**Vira teste:** o mesmo teste do achado do README.md, varrendo os três arquivos

### L167 · FALSA · gravidade media · data-versao

> **El objetivo es la última versión publicada** (`v1.2.3`), no la punta de `main`

**Mede com:**

```bash
git tag -l 'v*' --sort=-v:refname | head -1 ; grep -n '1.3.0' CHANGELOG.md
```

**Deu:**

```
v1.3.0 ; CHANGELOG.md:11 "## [1.3.0] — 2026-08-13" ; nenhuma tag nem seção v1.2.3 existe
```

**Sugestão:** (pt-br: apagar o número inventado.) Texto pronto: "**El objetivo es la última versión publicada** — la tag más nueva, la misma que devuelve `git tag -l 'v*' --sort=-v:refname | head -1` —, no la punta de `main`."

### L174 · FRAGIL · gravidade baixa · sobre-o-codigo

> Si aparece `⚠ avisos que não são os esperados`, ahí sí guarda el mensaje.

**Mede com:**

```bash
grep -rn 'avisos que' hostgator-setup-kit/ ; sed -n '144,151p' hostgator-setup-kit/update.sh
```

**Deu:**

```
ZERO ocorrências de 'avisos que'. A string real é update.sh:146 "⚠ Apareceram avisos no banco que NÃO são os esperados:"
```

**Sugestão:** (pt-br: citar a string literal do script.) Texto pronto: "Si aparece `⚠ Apareceram avisos no banco que NÃO são os esperados:`, ahí sí guarda el mensaje."

### L235 · FALSA · gravidade media · sobre-o-codigo

> | **CRM** | **Kanban** (dónde está cada negocio en el embudo) · **Contactos** · **Embudos** (etapas, vocabulario del negocio y motivos de pérdida) |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts ; sed -n '166,210p' lib/navigation/registry.ts
```

**Deu:**

```
grupo crm: "Funis" (/app/kanban), "Contatos", "Etapas do funil" (/app/settings/tenant/pipelines). Comentário: "ERA Kanban ... o nome saiu da interface"
```

**Sugestão:** (pt-br: o produto baniu "Kanban" da interface e separou "Funis" de "Etapas do funil".) Texto pronto: "| **CRM** | **Funis** / Embudos (tus embudos de venta — haz clic en uno para abrir su tablero) · **Contactos** · **Etapas do funil** / Etapas del embudo (las columnas de cada embudo, el vocabulario del negocio y los motivos de pérdida) |"

**Vira teste:** tests/unit/readme-telas.test.ts cobrindo os três arquivos

### L239 · FALSA · gravidade baixa · contagem

> | **Organización** | **Equipo** · **Distribución de atención** · **Organización** · **LGPD** · **API Tokens** · **Seguridad** ... |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts | sed 's/label: //'
```

**Deu:**

```
... "Equipe" "Distribuição de atendimento" "Organização" "Marca" "Billing" "LGPD" "API Tokens" => a tela "Marca" (/app/settings/marca) falta na tabela
```

**Sugestão:** (pt-br: acrescentar a tela Marca.) Texto pronto: "| **Organización** | **Equipo** · **Distribución de atención** · **Organización** · **Marca** (white-label: nombre, logo y color de la instalación) · **LGPD** · **API Tokens** · **Seguridad** (MFA, códigos de recuperación, sesiones) · Perfil, Notificaciones, Billing |"

### L241 · FRAGIL · gravidade baixa · ativo-obrigatorio

> Toda pantalla tiene puerta en la navegación — el CI reprueba una pantalla que existe pero a la que solo se llega escribiendo la URL.

**Mede com:**

```bash
npx vitest run tests/unit/navegacao-completude.test.ts ; sed -n '19,46p' tests/unit/navegacao-completude.test.ts
```

**Deu:**

```
Tests 6 passed (6). ESCOPO: "só app/app/**"; NAV_ALLOWLIST com 7 rotas isentas.
```

**Sugestão:** (pt-br: declarar o escopo e a allowlist.) Texto pronto: "Toda pantalla de `app/app/**` tiene puerta en la navegación — o una entrada en la allowlist de `tests/unit/navegacao-completude.test.ts` con la justificación escrita. El CI reprueba una pantalla nueva que no tenga ni una cosa ni la otra."

### L309 · FALSA · gravidade alta · ativo-obrigatorio

> **Cuatro checks son obligatorios** para mergear en `main` — todos verificados en la branch protection, no solo en el papel

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** (pt-br: trocar o numeral pela régua e acrescentar a linha do `imagens-ok`.) Texto pronto: "**Los checks obligatorios** para mergear en `main` son los de la branch protection — esa es la regla, no esta tabla: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(\", \")'`" + nueva fila: "| `imagens-ok` | reprueba cuando alguna de las tres imágenes Docker publicadas (`app`, `worker`, `scheduler`) no construye — job `imagens-ok` en `.github/workflows/publish-image.yml` |"

**Vira teste:** tests/unit/readme-checks-obrigatorios.test.ts cobrindo os três arquivos

### L314 · FALSA · gravidade media · contagem

> corre **618 invariantes en 98 archivos**

**Mede com:**

```bash
TEST_DB_CONTAINER=fake npx vitest list --config vitest.db.config.ts | grep -c ' > ' ; ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
761 ; 103
```

**Sugestão:** (pt-br: trocar o número pelo comando.) Texto pronto: "...y corre la suite de `tests/invariants/**` — RBAC, asignación, alcance, enrutamiento, follow-up, webhooks y automatizaciones. Para el número del día: `TEST_DB_CONTAINER=x npx vitest list --config vitest.db.config.ts | grep -c ' > '`"

### L316 · FALSA · gravidade media · contagem

> corre **44 de las 45** specs de Playwright por el frontend

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; python3 <soma SPECS_PARTE_1+SPECS_PARTE_2+FORA_DO_CI>
```

**Deu:**

```
disco: 48 ; rodam 47 (25+22) ; fora 1 (vps-fresh-onboarding) ; nao listadas: []
```

**Sugestão:** (pt-br: tirar o par de números.) Texto pronto: "| `e2e` | levanta un Supabase local, aplica `baseline.sql` y corre **todas las specs de `tests/e2e/` menos una** por el frontend — el propio job reprueba si una spec del disco no está en ninguna de las tres listas. Recuenta con `ls tests/e2e/*.spec.ts | wc -l` |"

### L320 · FRAGIL · gravidade baixa · sobre-o-codigo

> prueba que un usuario de la org A ve **cero filas** de la org B en `conversations`, `messages`, `contacts` y `crm_leads`. Antes, un caso de control prueba que las filas de la org B realmente existen

**Mede com:**

```bash
sed -n '200,258p' tests/invariants/rls-isolation.test.ts
```

**Deu:**

```
TABLES tem 12 entradas (conversations ... org_guardrail_layers), não 4. O caso "superuser sees both orgs (seed sanity)" roda DEPOIS do laço, não antes.
```

**Sugestão:** (pt-br: 12 tabelas e o controle vem depois.) Texto pronto: "...prueba que un usuario de la org A ve **cero filas** de la org B en cada tabla de la lista `TABLES` de `tests/invariants/rls-isolation.test.ts` — hoy 12, de `conversations` a `org_guardrail_layers`. Cada tabla lleva su control positivo (el usuario A sigue leyendo las filas de su propia org), y la suite cierra comprobando que las filas de ambas orgs realmente existen — sin eso, el test pasaría con la tabla vacía."

### L337 · FALSA · gravidade media · contagem

> Índice de los 157 documentos, con regla de precedencia

**Mede com:**

```bash
git ls-files 'docs/**/*.md' | wc -l ; find docs -name '*.md' | wc -l ; grep -n '149' docs/index.md
```

**Deu:**

```
151 ; 161 ; docs/index.md:13 "Mapa dos **149** arquivos .md de docs/ ... régua: git ls-files 'docs/**/*.md' | wc -l"
```

**Sugestão:** (pt-br: trocar o total pela régua.) Texto pronto: "| [`docs/index.md`]\(docs/index.md\) | Índice de los documentos de `docs/`, con regla de precedencia cuando dos docs discrepan (el propio índice trae la regla: `git ls-files 'docs/**/*.md' | wc -l`) |"

### L362 · FALSA · gravidade alta · ativo-obrigatorio

> Esa línea es la lista **completa** de los gates obligatorios, a propósito

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; sed -n '357,358p' README.es.md
```

**Deu:**

```
protection: verify, build-and-size, invariants, e2e, imagens-ok
README.es.md:357: pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
README.es.md:358: pnpm test:db
=> cobre verify + build-and-size + invariants; NÃO cobre e2e nem imagens-ok.
```

**Sugestão:** (pt-br: dizer que a linha é só o que roda local.) Texto pronto: "Esa línea es todo lo que puedes correr en **tu propia máquina**, a propósito: correr solo la mitad y descubrir el resto como sorpresa roja después de horas de espera es la peor primera experiencia que este repositorio sabe entregar. Cubre `verify`, `build-and-size` e `invariants`; los otros dos checks obligatorios (`e2e` e `imagens-ok`) solo corren en el CI. La lista viva sale de `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(\", \")'`."

### L380 · FRAGIL · gravidade baixa · pendencia

> **Fundación y plataforma** — auth (MFA para admin), multi-tenancy con RLS + test de aislamiento

**Mede com:**

```bash
npx tsx <exigeCadastroDeMfa com o estado do install.sh> ; grep -n mfa_required scripts/bootstrap-owner.ts
```

**Deu:**

```
dono do install.sh exige MFA? false ; bootstrap-owner.ts:215 mfa_required: false
```

**Sugestão:** (pt-br: MFA virou opcional.) Texto pronto: "**Fundación y plataforma** — auth (verificación en dos pasos **opcional**, exigible por organización o por la plataforma en Configuración › Seguridad), multi-tenancy con RLS + test de aislamiento, RBAC de 4 roles, audit log append-only, onboarding de tenant."

### L423 · FRAGIL · gravidade media · sobre-o-codigo

> **sin** rastreo de performance y **sin** replay de sesión, que quedan en 0 en ese camino

**Mede com:**

```bash
cat instrumentation-client.ts
```

**Deu:**

```
tracesSampleRate: community ? 0 : 1 ; replaysSessionSampleRate: community ? 0 : 0.1 ; replaysOnErrorSampleRate: 1.0  <-- não depende de `community`
```

**Sugestão:** (pt-br: o replay DE ERRO continua ligado.) Texto pronto: "— **sin** rastreo de performance y **sin** replay de sesión (los dos en 0 en ese camino). El replay **de error** sigue activo, a propósito: solo graba cuando hay un error, es lo que explica el stack trace, y ya sube con `maskAllText`/`blockAllMedia`."


## `README.md` — 15

### L121 · FALSA · gravidade alta · ativo-obrigatorio

> o primeiro login de admin exige MFA

**Mede com:**

```bash
cat lib/auth/politica-mfa.ts; sed -n '195,225p' scripts/bootstrap-owner.ts; npx tsx <script que chama exigeCadastroDeMfa({role:'admin', isPlatformAdmin:true, plataformaExige:false, empresaExige:empresaExigeMfa(null)})>
```

**Deu:**

```
dono do install.sh exige MFA? false

scripts/bootstrap-owner.ts:215:    mfa_required: false,   (comentario acima: "`mfa_required: false` EXPLICITO, contra o default `true` da coluna ... deixa-la em `true` significaria ... TODA instalacao nova voltaria a receber o bloqueador de tela cheia")

lib/auth/politica-mfa.ts:67 exigeCadastroDeMfa: `if (p.isPlatformAdmin && p.plataformaExige === true) return true; if (p.role === "admin" && p.empresaExige) return true; return false;`
lib/auth/server.ts:176 requiresMfa() consulta essa politica.
```

**Sugestão:** Abra `https://<seu-domínio>` (o cadeado leva ~1 min pra aparecer) e entre com o admin. A **verificação em duas etapas não é exigida por padrão** — o `install.sh` cria o dono com `mfa_required = false`, de propósito: um bloqueador de tela cheia logo depois do onboarding é onde a instalação nova morria. Quer exigi-la? Ligue em **Configurações › Segurança** (a regra vive em `lib/auth/politica-mfa.ts`). No onboarding, escaneie o QR code com o WhatsApp do seu número.

**Vira teste:** tests/unit/readme-x-politica-mfa.test.ts: `expect(readFileSync('README.md','utf8')).not.toMatch(/exige MFA/)` enquanto `exigeCadastroDeMfa({role:'admin',isPlatformAdmin:true,plataformaExige:false,empresaExige:false}) === false`

### L164 · FALSA · gravidade media · data-versao

> **O alvo é a última versão publicada** (`v1.2.3`), não o topo da `main`

**Mede com:**

```bash
git tag -l 'v*' --sort=-v:refname | head -1 ; gh release list --limit 3 ; grep -n "TARGET_TAG=\"\$(git tag" hostgator-setup-kit/update.sh
```

**Deu:**

```
v1.3.0
v1.3.0 — o worker que nunca era atualizado	Latest	v1.3.0	2026-08-13T19:58:03Z
v1.2.1 — correções de segurança		v1.2.1	2026-08-12
hostgator-setup-kit/update.sh:39: [ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
=> o mecanismo ("tag mais nova") está CERTO; o número v1.2.3 nunca existiu — não há tag nem seção no CHANGELOG.
```

**Sugestão:** **O alvo é a última versão publicada** — a tag mais nova, a mesma que `git tag -l 'v*' --sort=-v:refname | head -1` devolve —, não o topo da `main`: atualizar leva sempre a uma versão marcada e descrita no [`CHANGELOG.md`]\(CHANGELOG.md\), nunca a um commit não testado.

**Vira teste:** tests/unit/readme-ponteiros.test.ts: toda string `v<x>.<y>.<z>` citada nos READMEs existe em `git tag -l`

### L171 · FRAGIL · gravidade baixa · sobre-o-codigo

> Se aparecer `⚠ avisos que não são os esperados`, aí sim guarde a mensagem.

**Mede com:**

```bash
grep -rn 'avisos que' hostgator-setup-kit/ ; sed -n '144,151p' hostgator-setup-kit/update.sh
```

**Deu:**

```
grep 'avisos que' em hostgator-setup-kit/: ZERO ocorrências.
update.sh:146: c_ylw "⚠ Apareceram avisos no banco que NÃO são os esperados:"
update.sh:149: c_grn "✓ banco atualizado (e conversas reorganizadas, se havia bagunça)."
```

**Sugestão:** O script filtra esse ruído e mostra `✓ banco atualizado`. Se aparecer `⚠ Apareceram avisos no banco que NÃO são os esperados:`, aí sim guarde a mensagem.

**Vira teste:** tests/shell/update-guard.test.sh: toda string entre crases nos READMEs que se apresente como saída do `update.sh` existe literalmente em `hostgator-setup-kit/update.sh`

### L233 · FALSA · gravidade media · sobre-o-codigo

> | **CRM** | **Kanban** (onde cada negócio está no funil) · **Contatos** · **Funis** (etapas, vocabulário do negócio e motivos de perda) |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts ; sed -n '166,210p' lib/navigation/registry.ts
```

**Deu:**

```
labels do grupo crm: "Funis" (href /app/kanban) e "Etapas do funil" (href /app/settings/tenant/pipelines) e "Contatos".
registry.ts:168 comentário: "⚠️ ERA \"Kanban\", e a URL continua sendo. O nome saiu da interface porque o produto tinha CINCO vocabulários para a mesma coisa ... Ficou \"Funis\" porque é o que esta tela É"
registry.ts:196 comentário: "⚠️ ERA \"Funis\" ... lá se ABRE o funil, aqui se CONFIGURA o que ele significa"
```

**Sugestão:** | **CRM** | **Funis** (seus funis de venda — clique num pra abrir o quadro de clientes) · **Contatos** · **Etapas do funil** (as colunas de cada funil, o vocabulário do negócio e os motivos de perda) |

**Vira teste:** tests/unit/readme-telas.test.ts: todo `label` de `NAV_DESTINATIONS` com `sidebar: true` aparece na tabela de telas dos três READMEs, e nenhum rótulo banido ("Kanban", "Pipeline") aparece

### L237 · FALSA · gravidade baixa · contagem

> | **Organização** | **Equipe** · **Distribuição de atendimento** · **Organização** · **LGPD** · **API Tokens** · **Segurança** ... |

**Mede com:**

```bash
grep -oE 'label: "[^"]+"' lib/navigation/registry.ts | sed 's/label: //'
```

**Deu:**

```
... "Equipe" "Distribuição de atendimento" "Organização" "Marca" "Billing" "LGPD" "API Tokens"
=> a tela **Marca** (href /app/settings/marca) está no registro de navegação e falta na tabela do README.
```

**Sugestão:** | **Organização** | **Equipe** · **Distribuição de atendimento** · **Organização** · **Marca** (white-label: nome, logo e cor da instalação) · **LGPD** · **API Tokens** · **Segurança** (MFA, códigos de recuperação, sessões) · Perfil, Notificações, Billing |

**Vira teste:** mesmo teste do achado anterior: todo label de `NAV_DESTINATIONS` aparece na tabela de telas

### L239 · FRAGIL · gravidade baixa · ativo-obrigatorio

> Toda tela tem porta na navegação — o CI reprova tela que existe mas em que só se chega digitando a URL.

**Mede com:**

```bash
npx vitest run tests/unit/navegacao-completude.test.ts ; sed -n '19,46p' tests/unit/navegacao-completude.test.ts
```

**Deu:**

```
Test Files 1 passed (1) / Tests 6 passed (6)
MAS: "ESCOPO: só `app/app/**` — a navegação do tenant. O admin de plataforma (`app/admin/`), o onboarding e as páginas públicas têm navegação própria."
E `const NAV_ALLOWLIST` tem 7 rotas isentas (/app, /app/ai/agents/new, /app/team/invite, /app/settings/tenant/whatsapp, /app/settings/canal-oficial, /app/settings/templates, /app/settings/atualizacao).
```

**Sugestão:** Toda tela de `app/app/**` tem porta na navegação — ou uma entrada na allowlist de `tests/unit/navegacao-completude.test.ts` com a justificativa escrita. O CI reprova tela nova que não tenha nem uma coisa nem outra.

### L307 · FALSA · gravidade baixa · contagem

> │   └── api/v1/             # API REST canônica (196 route handlers)

**Mede com:**

```bash
find app/api/v1 -name 'route.ts' | wc -l
```

**Deu:**

```
201
```

**Sugestão:** │   └── api/v1/             # API REST canônica (`find app/api/v1 -name route.ts | wc -l`)

### L331 · FALSA · gravidade alta · ativo-obrigatorio

> **Quatro checks são obrigatórios** pra mergear na `main` — todos verificados na branch protection, não só no papel

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** **Os checks obrigatórios** pra mergear na `main` são os da branch protection — e a régua é ela, não esta tabela:  ```console $ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' verify, build-and-size, invariants, e2e, imagens-ok ```  (e acrescentar a linha que falta na tabela) | `imagens-ok` | reprova quando qualquer uma das três imagens Docker publicadas (`app`, `worker`, `scheduler`) não constrói — job `imagens-ok` em `.github/workflows/publish-image.yml` |

**Vira teste:** tests/unit/readme-checks-obrigatorios.test.ts: para cada check citado na tabela do README, `expect(jobsDeWorkflows()).toContain(check)`; e o README não pode declarar um numeral ("Quatro"/"Four"/"Cuatro") de checks

### L336 · FALSA · gravidade media · contagem

> roda **618 invariantes em 98 arquivos**

**Mede com:**

```bash
TEST_DB_CONTAINER=fake npx vitest list --config vitest.db.config.ts 2>&1 | grep -c ' > ' ; TEST_DB_CONTAINER=fake npx vitest list --config vitest.db.config.ts 2>&1 | grep ' > ' | cut -d' ' -f1 | sort -u | wc -l ; ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
761
     103
     103
```

**Sugestão:** | `invariants` | sobe um Postgres limpo, aplica o `baseline.sql` em modo **install** (`ON_ERROR_STOP=1`) e depois em modo **update** (provando idempotência), e roda a suíte de `tests/invariants/**` — RBAC, atribuição, escopo, roteamento, follow-up, webhooks e automações. Para o número do dia: `TEST_DB_CONTAINER=x npx vitest list --config vitest.db.config.ts \| grep -c ' > '` |

**Vira teste:** tests/unit/readme-sem-contagem-podre.test.ts: o README não pode conter um literal de contagem de invariantes que divirja de `vitest list --config vitest.db.config.ts`

### L338 · FALSA · gravidade media · contagem

> roda **44 das 45 specs** Playwright pelo frontend

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l ; python3 -c "conta SPECS_PARTE_1 + SPECS_PARTE_2 + FORA_DO_CI de .github/workflows/e2e.yml"
```

**Deu:**

```
disco: 48
parte1 25  parte2 22  rodam 47  fora 1 ['vps-fresh-onboarding.spec.ts']
nao listadas: []
```

**Sugestão:** | `e2e` | sobe Supabase local, aplica o `baseline.sql` e roda **todas as specs de `tests/e2e/` menos uma** pelo frontend — o próprio job reprova se alguma spec do disco não estiver em nenhuma das três listas. Reconte com `ls tests/e2e/*.spec.ts \| wc -l` |

**Vira teste:** o gate já existe dentro de e2e.yml (compara NO_DISCO com as três listas); o teste novo é: o README não pode citar um par de números de spec — ou, se citar, ele bate com `ls tests/e2e/*.spec.ts | wc -l`

### L342 · FRAGIL · gravidade baixa · sobre-o-codigo

> prova que um usuário da org A enxerga **zero linhas** da org B em `conversations`, `messages`, `contacts` e `crm_leads`. Antes disso, um caso de controle prova que as linhas da org B realmente existem

**Mede com:**

```bash
sed -n '200,258p' tests/invariants/rls-isolation.test.ts
```

**Deu:**

```
const TABLES = [conversations, messages, contacts, crm_leads, org_memory_versions, org_memory_entries, skill_activations, ai_routers, ai_router_decisions, knowledge_searches, contact_field_proposals, org_guardrail_layers] => 12 tabelas, não 4.
O caso "superuser sees both orgs (seed sanity...)" está DEPOIS do laço, não antes; o controle por tabela é `user of org A still reads their own org rows in ${table} (positive control)`.
```

**Sugestão:** Entre os invariantes está o **teste de isolamento RLS**: cria 2 organizações, simula os claims JWT pelo mesmo caminho `auth.uid()` / `fn_user_org_ids()` que as policies de produção usam, e prova que um usuário da org A enxerga **zero linhas** da org B em cada tabela da lista `TABLES` de `tests/invariants/rls-isolation.test.ts` — hoje 12, de `conversations` a `org_guardrail_layers`. Cada tabela leva junto um controle positivo (o usuário A continua lendo as linhas da própria org) e a suíte fecha conferindo que as linhas das duas orgs realmente existem — sem isso, o teste passaria com a tabela vazia.

### L360 · FALSA · gravidade media · contagem

> Índice dos 157 documentos, com regra de precedência

**Mede com:**

```bash
git ls-files 'docs/**/*.md' | wc -l ; find docs -name '*.md' | wc -l ; grep -n '149' docs/index.md
```

**Deu:**

```
151   (régua declarada dentro do próprio docs/index.md)
161   (todos os .md de docs/, incluindo os 10 da raiz)
docs/index.md:13:Mapa dos **149** arquivos `.md` de `docs/` ... régua: `git ls-files 'docs/**/*.md' | wc -l`
=> 157 não é nenhum dos três números; o próprio índice diz 149 e a régua dele devolve 151.
```

**Sugestão:** | [`docs/index.md`]\(docs/index.md\) | Índice dos documentos de `docs/`, com regra de precedência quando dois docs discordam (o próprio índice traz a régua: `git ls-files 'docs/**/*.md' \| wc -l`) |

**Vira teste:** tests/unit/readme-ponteiros.test.ts: nenhum dos READMEs cita um total de docs; ou, se citar, ele é igual a `git ls-files('docs/**/*.md').length`

### L386 · FALSA · gravidade alta · ativo-obrigatorio

> Essa linha é a lista **completa** dos gates obrigatórios, de propósito

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'; grep -n 'pnpm typecheck && pnpm lint' README.md
```

**Deu:**

```
protection: verify, build-and-size, invariants, e2e, imagens-ok
README.md:380: pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
README.md:381: pnpm test:db
=> a linha cobre `verify` + `build-and-size` + `invariants`. NAO cobre `e2e` nem `imagens-ok`, que sao obrigatorios.
```

**Sugestão:** Essa linha é tudo o que dá pra rodar na **sua** máquina, de propósito: rodar só metade e descobrir o resto como surpresa vermelha depois de horas de espera é a pior primeira experiência que este repositório sabe entregar. Ela cobre `verify`, `build-and-size` e `invariants` — os outros dois checks obrigatórios (`e2e` e `imagens-ok`) só rodam no CI. A lista viva sai de `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`.

**Vira teste:** tests/unit/readme-checks-obrigatorios.test.ts: a frase "lista completa dos gates obrigatórios" só pode existir se o comando local cobrir TODOS os contexts da branch protection

### L406 · FRAGIL · gravidade baixa · pendencia

> **Fundação & plataforma** — auth (MFA pra admin), multi-tenancy com RLS + teste de isolamento

**Mede com:**

```bash
npx tsx <chama exigeCadastroDeMfa com o estado do install.sh> ; grep -n 'mfa_required' scripts/bootstrap-owner.ts
```

**Deu:**

```
dono do install.sh exige MFA? false
scripts/bootstrap-owner.ts:215: mfa_required: false,
lib/auth/politica-mfa.ts: "o cadastro passa a ser OPCIONAL e ligado numa tela de Configurações"
```

**Sugestão:** **Fundação & plataforma** — auth (verificação em duas etapas **opcional**, exigível por organização ou pela plataforma em Configurações › Segurança), multi-tenancy com RLS + teste de isolamento, RBAC 4 papéis, audit log append-only, onboarding de tenant.

### L465 · FRAGIL · gravidade media · sobre-o-codigo

> **sem** rastreamento de performance e **sem** replay de sessão, que ficam em 0 nesse caminho

**Mede com:**

```bash
cat instrumentation-client.ts ; grep -n 'tracesSampleRate' sentry.server.config.ts sentry.edge.config.ts
```

**Deu:**

```
instrumentation-client.ts:30  tracesSampleRate: community ? 0 : 1,
instrumentation-client.ts:33  replaysSessionSampleRate: community ? 0 : 0.1,
instrumentation-client.ts:34  replaysOnErrorSampleRate: 1.0,      <-- NÃO depende de `community`
sentry.server.config.ts:16 tracesSampleRate: community ? 0 : 1,
Comentário no próprio arquivo: "O replay DE ERRO continua, porque é o que explica o stack trace".
```

**Sugestão:** — **sem** rastreamento de performance e **sem** replay de sessão (os dois em 0 nesse caminho). O replay **de erro** continua ligado, de propósito: ele só grava quando há erro, é o que explica o stack trace, e já sobe com `maskAllText`/`blockAllMedia`.

**Vira teste:** tests/unit/sentry-comunidade.test.ts: com DSN da comunidade, `tracesSampleRate === 0 && replaysSessionSampleRate === 0 && replaysOnErrorSampleRate === 1`


## `SECURITY.md` — 4

### L5 · FALSA · gravidade media · sobre-o-codigo

> O SonghaiCRM é distribuído em rolling release a partir da branch `main`.

**Mede com:**

```bash
grep -n 'TARGET_TAG="$(git tag' hostgator-setup-kit/update.sh ; gh release list --limit 6 ; sed -n '163,164p' README.md
```

**Deu:**

```
update.sh:39 → `[ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"`. Releases: v1.3.0 (2026-08-13), v1.2.1, v1.2.0, v1.1.0, v1.0.0. README:163 → "**O alvo é a última versão publicada** (`v1.2.3`), não o topo da `main`".
```

**Sugestão:** O SonghaiCRM é distribuído por **versões marcadas** (`v1.x.y`), publicadas como release e descritas no [`CHANGELOG.md`]\(CHANGELOG.md\). O `update.sh` sempre aponta para a última versão publicada — nunca para o topo da `main`. Correções de segurança entram na próxima versão; mantenha sua instalação atualizada (`bash hostgator-setup-kit/update.sh` em self-host). Para saber qual é a última: `gh release list --limit 1`.

**Vira teste:** assertar que SECURITY.md não afirma "a partir da branch main" enquanto hostgator-setup-kit/update.sh resolver o alvo por `git tag -l 'v*'`

### L9 · FRAGIL · gravidade media · ativo-obrigatorio

> | `main` (mais recente) | ✅ |

**Mede com:**

```bash
gh release list --limit 6 ; grep -n 'TARGET_TAG=' hostgator-setup-kit/update.sh | head -3
```

**Deu:**

```
5 releases publicadas (v1.0.0 … v1.3.0, a última em 2026-08-13); o update.sh faz `git checkout "$TARGET_TAG"` da tag mais recente. Nenhuma instalação de cliente roda a `main`.
```

**Sugestão:** | Versão | Suportada | | --- | --- | | Última release publicada (`v1.x.y` mais recente) | ✅ | | Releases anteriores | ❌ |  Qual é a última hoje: `gh release list --limit 1` (ou a página de Releases).

### L20 · NAO_VERIFICAVEL · gravidade baixa · ativo-obrigatorio

> **Confirmação de recebimento** em até 7 dias. **Avaliação e resposta** em até 30 dias ... **Crédito** no advisory publicado

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/security-advisories --jq '.[] | "\(.ghsa_id) criado=\(.created_at) estado=\(.state)"'
```

**Deu:**

```
GHSA-cwqh-j5j7-prrm criado=2026-08-12 estado=triage; GHSA-87qq-3c7m-p22c criado=2026-08-12 estado=triage; GHSA-qmw2-qf85-57vf criado=2026-08-04 estado=triage. Três abertos, **zero publicados** — o mais velho tem 10 dias (dentro dos 30, então o SLA não está violado). O canal de confirmação (comentário no advisory) não é visível pela API.
```

### L29 · FRAGIL · gravidade baixa · sobre-o-codigo

> Bypass de autenticação/RBAC (roles `viewer`/`agent`/`manager`/`admin`, super-admin)

**Mede com:**

```bash
grep -n 'export type Role\|PAPEIS_HUMANOS' lib/auth/types.ts
```

**Deu:**

```
lib/auth/types.ts:20 → `export type Role = "viewer" | "agent" | "ai_operator" | "manager" | "admin";` (5 papéis). lib/auth/types.ts:30 → `PAPEIS_HUMANOS = ["viewer", "agent", "manager", "admin"]`. O `ai_operator` existe no tipo e não está listado no escopo.
```

**Sugestão:** Bypass de autenticação/RBAC (papéis do tenant — os humanos `viewer`/`agent`/`manager`/`admin` e o `ai_operator` do agente — e o super-admin de plataforma)

**Vira teste:** assertar que todo membro de `Role` em lib/auth/types.ts aparece citado em SECURITY.md §Escopo


## `docs/DEPLOY-CHECKLIST.md` — 4

### L8 · FRAGIL · gravidade baixa · sobre-o-codigo

> Supabase cloud provisionado pelo `install.sh`

**Mede com:**

```bash
grep -n 'SUPABASE_ACCESS_TOKEN\|Criando o projeto Supabase' hostgator-setup-kit/install.sh | head
```

**Deu:**

```
913:# Com SUPABASE_ACCESS_TOKEN no ambiente e as credenciais ainda vazias, o
916:if [ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
917:  step "Criando o projeto Supabase automaticamente"
919:  || die "Não consegui criar o projeto Supabase. Crie no painel e rode de novo sem SUPABASE_ACCESS_TOKEN."
```

**Sugestão:** | **A. VPS self-host** | **o produto** — o que o cliente compra e o que a doutrina rege | Supabase cloud: o `install.sh` provisiona sozinho **quando há `SUPABASE_ACCESS_TOKEN` no ambiente** (L916); sem o token, o projeto é criado no painel e o instalador só pede as credenciais |

### L46 · FALSA · gravidade alta · pendencia

> **Depois da release**, `stable` e `X.Y.Z` são o mesmo digest nas três imagens.

**Mede com:**

```bash
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do for t in 1.3.0 stable; do echo -n "$i:$t "; docker buildx imagetools inspect ghcr.io/melgarafael/$i:$t --format '{{.Manifest.Digest}}'; done; done
```

**Deu:**

```
os três pares divergem (fc10b029 vs c4bc70b6; 81e5af56 vs 3fe292ca; 4396263b vs a0d5c3ad). O texto narra a divergência como episódio de 19:53→19:58 e o commit 648df229 removeu o gatilho `release:` do workflow — mas NADA reparou a 1.3.0 no registry: a condição de `stable` no metadata-action exige `event_name=='push' && ref_type=='tag'`, então o rebuild das 19:58 moveu `1.3.0` e não moveu `stable`.
```

**Sugestão:** - [ ] **Depois da release**, `stable` e `X.Y.Z` são o mesmo digest nas três imagens.       Nesta ordem, e não antes: na v1.3.0 a conferência rodou antes do       `gh release create`, passou, e o próprio `release` republicou a versão em       cima — verde às 19:53, divergente às 19:58. **O gatilho foi removido, mas a       divergência da 1.3.0 NUNCA foi reparada no registry: `stable` segue no build       das 19:53 e `1.3.0` no das 19:58. Não instrua ninguém a usar `stable` como       "a 1.3.0" sem rodar o laço do item 10 da doutrina primeiro.**

### L63 · FALSA · gravidade media · sobre-o-codigo

> A versão anterior está anotada (é uma linha do `.env`: `APP_IMAGE`)

**Mede com:**

```bash
grep -rn 'APP_IMAGE\|WORKER_IMAGE\|SCHEDULER_IMAGE' hostgator-setup-kit/update.sh
```

**Deu:**

```
190:# antigo grava só `APP_IMAGE`, e o worker fica seguindo um canal móvel.
194:export APP_IMAGE="${IMG_APP}:${VERSAO_ALVO}"
195:export WORKER_IMAGE="${IMG_WORKER}:${VERSAO_ALVO}"
196:export SCHEDULER_IMAGE="${IMG_SCHEDULER}:${VERSAO_ALVO}"
```

**Sugestão:** - [ ] A versão anterior está anotada — são **três** linhas do `.env`: `APP_IMAGE`, `WORKER_IMAGE` e `SCHEDULER_IMAGE` (`update.sh` grava as três, L194-196). Anotar só a primeira é o defeito que o pin das três veio consertar: o rollback voltaria o app e deixaria worker e scheduler na versão nova

**Vira teste:** assert: toda variável `*_IMAGE` que hostgator-setup-kit/update.sh exporta aparece no bloco Rollback de docs/DEPLOY-CHECKLIST.md

### L77 · FRAGIL · gravidade baixa · sobre-o-codigo

> o pipeline da Vercel faz deploy a cada push na `main` e **não aplica migration nenhuma**

**Mede com:**

```bash
ls vercel.json ; grep -rn 'supabase db push\|db push\|migration' .github/workflows/*.yml
```

**Deu:**

```
ls: vercel.json: No such file or directory
.github/workflows/e2e.yml:181: - name: Subir Supabase local (sem a cadeia de migrations)
.github/workflows/e2e.yml:183: mv supabase/migrations /tmp/migrations-off
(nenhum workflow aplica migration em banco remoto)
```

**Sugestão:** - [ ] **Migrations aplicadas no banco da Vercel** — `supabase/migrations/`, e **confira**: nenhum artefato do repo aplica migration (`ls vercel.json` → ausente; `grep -rn 'db push' .github/workflows/` → vazio), e o gatilho de deploy é configuração da Vercel, fora do repo. Em 2026-08-04 a produção rodou código à frente do banco e o inbox devolveu 500 (`42703`)


## `docs/adr/0001-packaging-e-distribuicao.md` — 7

### L24 · FRAGIL · gravidade media · contagem

> ela existe desde 2026-07-02, com 258 execuções do workflow de publicação e 4 releases

**Mede com:**

```bash
gh run list --workflow=publish-image.yml --limit 500 --json conclusion --jq 'length' ; gh release list --limit 50 --json tagName --jq 'length'
```

**Deu:**

```
285
5
```

**Sugestão:** A investigação do repositório mostrou o contrário: ela existe desde 2026-07-02 (commit `7edd153f`, que criou `.github/workflows/publish-image.yml`), com centenas de execuções verdes e releases publicadas. Os números apodrecem a cada push, então a régua vai junto: `gh run list --workflow=publish-image.yml --limit 500 --json conclusion --jq 'length'` e `gh release list --limit 50 --json tagName --jq 'length'`. O que faltava não era o pipeline — era a **regra** que decide o que entra nele, e um gate que a exerça.

### L34 · FALSA · gravidade media · sobre-o-codigo

> é o namespace que o CI já publica (`IMAGE_NAME: ${{ github.repository }}`)

**Mede com:**

```bash
grep -rn 'IMAGE_NAME' .github/ ; grep -n 'images:' .github/workflows/publish-image.yml
```

**Deu:**

```
(grep IMAGE_NAME: zero linhas)
103:          images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.name }}
```

**Sugestão:** **Escolhido porque** é o namespace que o CI já publica (`images: ${{ env.REGISTRY }}/${{ github.repository_owner }}/${{ matrix.name }}`, em `.github/workflows/publish-image.yml`), que o compose já consome, e — decisivo — que está **gravado no `.env` de cada cliente instalado**, por `install.sh` e por `update.sh`, como string literal.

### L46 · FALSA · gravidade media · sobre-o-codigo

> os testes que casam a string (`tests/shell/update-guard.test.sh`, `hostgator-setup-kit/test-validators.sh`, `tests/unit/packaging-artefato-do-cliente.test.ts`)

**Mede com:**

```bash
grep -c 'melgarafael' tests/unit/packaging-artefato-do-cliente.test.ts ; grep -rln 'ghcr.io/melgarafael' --exclude-dir=node_modules . | grep -E 'tests/|hostgator-setup-kit/test'
```

**Deu:**

```
0
tests/shell/update-guard.test.sh
hostgator-setup-kit/test-validators.sh
```

**Sugestão:** ... os testes que casam a string (`tests/shell/update-guard.test.sh`, `hostgator-setup-kit/test-validators.sh`) e os docs — **mais** o `.env` de cada instalação viva, que é a parte que nenhum commit alcança. (`tests/unit/packaging-artefato-do-cliente.test.ts` entra no custo por outro motivo: ele guarda a forma do compose e os gatilhos do workflow, não a string do namespace.) Régua para reconferir antes de citar este parágrafo: `grep -rln "ghcr.io/melgarafael" --exclude-dir=node_modules .`

**Vira teste:** tests/unit/packaging-artefato-do-cliente.test.ts: it("o ADR só lista como guarda-namespace arquivos que contêm a string") — para cada path citado na §D1 como teste que 'casa a string', exigir grep('ghcr.io/melgarafael') > 0

### L126 · FALSA · gravidade alta · pendencia

> **Ainda não ganhamos:** o gate da imagem só reprova merge depois que `imagens-ok` entrar na branch protection ... Enquanto isso, o job roda em PR e informa, mas não bloqueia.

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** **Ganhamos também o gate:** `imagens-ok` é status check obrigatório da `main` — merge com imagem quebrada não passa. Régua, porque esta linha já ficou um dia inteiro afirmando o contrário depois de o check já bloquear:  ```console $ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' verify, build-and-size, invariants, e2e, imagens-ok ```  Em PR a imagem é construída e descartada: o gate é o build, não a publicação (`push: ${{ github.event_name != 'pull_request' }}`).

**Vira teste:** tests/unit/packaging-artefato-do-cliente.test.ts: it("o ADR não afirma que imagens-ok é não-bloqueante") — ler docs/adr/0001-packaging-e-distribuicao.md e reprovar se casar /imagens-ok[^\n]*(não bloqueia|ainda não|entrar na branch protection)/i, já que o job existe em .github/workflows/publish-image.yml

### L144 · FRAGIL · gravidade baixa · contagem

> 10 tags publicadas e públicas; `tags/list` anônimo responde, manifest de `latest` = 200

**Mede com:**

```bash
TOKEN=$(curl -s 'https://ghcr.io/token?scope=repository:melgarafael/deskcommcrm:pull&service=ghcr.io' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'); curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/melgarafael/deskcommcrm/tags/list | python3 -c 'import sys,json;t=json.load(sys.stdin)["tags"];print(len(t),sorted(t))' ; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/melgarafael/deskcommcrm/manifests/latest
```

**Deu:**

```
13 ['1.0', '1.0.0', '1.1', '1.1.0', '1.2', '1.2.0', '1.2.1', '1.3', '1.3.0', 'latest', 'main', 'quebrada-teste', 'stable']
200
```

**Sugestão:** tags publicadas e públicas — `tags/list` anônimo responde e o manifest de `latest` volta 200 (o número cresce a cada release; conte no registry, não aqui). Provável causa do erro: `gh api users/…/packages` devolve **403** sem escopo `read:packages` — instrumento cego lido como ausência

### L146 · FRAGIL · gravidade baixa · contagem

> existe desde 2026-07-02; 258 runs, 252 verdes

**Mede com:**

```bash
git log --diff-filter=A --format='%h %ad' --date=short -- .github/workflows/publish-image.yml ; gh run list --workflow=publish-image.yml --limit 500 --json conclusion --jq 'length, ([.[]|select(.conclusion=="success")]|length)'
```

**Deu:**

```
7edd153f 2026-07-02
285
278
```

**Sugestão:** existe desde 2026-07-02 (`7edd153f` criou o workflow); a esmagadora maioria dos runs é verde — reconte com `gh run list --workflow=publish-image.yml --limit 500 --json conclusion --jq 'length, ([.[]|select(.conclusion=="success")]|length)'` antes de citar um número

### L150 · FALSA · gravidade media · ponteiro

> o repo já documentava esse modo de falha em `_common.sh:294-299`

**Mede com:**

```bash
sed -n '294,299p' hostgator-setup-kit/_common.sh ; grep -n 'up -d` FALHA' hostgator-setup-kit/_common.sh
```

**Deu:**

```
294:    val="${val//\"'\\''\"/\"'\"}"
295:    ;;
296:  esac
297:  printf -v "$key" '%s' "$val"
298:  export "${key?}"
299:  done < "$file"
---
483:# referência, o `up -d` FALHA e o contêiner não sobe, mesmo com a imagem já no
```

**Sugestão:** ... O gatilho real é `up -d` — e o repo já documentava esse modo de falha no comentário de `gravar_imagens`, em `hostgator-setup-kit/_common.sh`. Número de linha apodrece a cada edição do script; a régua é `grep -n 'up -d\` FALHA' hostgator-setup-kit/_common.sh`.

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("ponteiro arquivo:linha do ADR aponta para o assunto certo") — para cada `<arquivo>:<n>-<m>` citado, exigir que o trecho contenha um termo do contexto ('up -d'), senão reprovar


## `docs/doctrine/packaging.md` — 10

### L42 · FRAGIL · gravidade baixa · contagem

> | Exemplos | `deskcommcrm`, `deskcomm-worker` |

**Mede com:**

```bash
grep -n -A12 'matrix:' .github/workflows/publish-image.yml | grep 'name:'
```

**Deu:**

```
- name: deskcommcrm
- name: deskcomm-worker
- name: deskcomm-scheduler
```

**Sugestão:** | Exemplos | `deskcommcrm`, `deskcomm-worker`, `deskcomm-scheduler` |

**Vira teste:** tests/unit/packaging-artefato-do-cliente.test.ts: toda `name:` da matriz de publish-image.yml aparece citada em docs/doctrine/packaging.md — uma quarta imagem, um dia, entra no gate e some da doutrina

### L51 · FRAGIL · gravidade media · sobre-o-codigo

> `waha` e `srh` — que tocam WhatsApp e rate limit — estão pinadas de verdade (tag exata e digest)

**Mede com:**

```bash
grep -n 'image:' docker-compose.prod.yml
```

**Deu:**

```
132: image: ${WAHA_IMAGE:-devlikeapro/waha:latest-2026.7.2}
153: image: redis:7-alpine
175: image: hiett/serverless-redis-http@sha256:5b0bb9239fce53abf87b2018a7a0deb9ec7bd900c5360738fe5fbeeb426f9150
212: image: caddy:2-alpine
```

**Sugestão:** `waha` e `srh` — que tocam WhatsApp e rate limit — estão pinadas de verdade: o WAHA por tag exata (`devlikeapro/waha:latest-2026.7.2`) e o `srh` por digest. Nenhuma das duas anda sozinha dentro de um major. Confira: `grep -n 'image:' docker-compose.prod.yml`.

### L133 · FRAGIL · gravidade baixa · data-versao

> gravam no `.env` do cliente uma **tag de versão** (`1.2.1`), nunca `latest`, `main` ou `stable`

**Mede com:**

```bash
ghcr_status deskcomm-worker 1.2.1 ; ghcr_status deskcomm-scheduler 1.2.1
```

**Deu:**

```
deskcomm-worker:1.2.1 -> 404
deskcomm-scheduler:1.2.1 -> 404
```

**Sugestão:** Trocar o exemplo por uma versão que exista nas três imagens: "gravam no `.env` do cliente uma **tag de versão** (`1.3.0`), nunca `latest`, `main` ou `stable`" — e o mesmo na primeira linha da tabela de canais (linha 254). Usar `1.2.1` como exemplo do estado desejado contradiz o parágrafo 13 linhas abaixo, que diz que `deskcomm-worker:1.2.1` nunca vai existir: nenhuma instalação pode nascer pinada nesse número.

### L136 · FALSA · gravidade alta · contagem

> Duas exceções, ambas deliberadas e ambas com aviso na tela

**Mede com:**

```bash
grep -n 'VERSAO_ALVO=\|trio_publicado' hostgator-setup-kit/install.sh | sed -n '1,12p' ; sed -n '1036,1060p' hostgator-setup-kit/install.sh
```

**Deu:**

```
1024: VERSAO_ALVO="$(ultima_versao_publicada …)"
1037: if [ -n "$VERSAO_ALVO" ] && trio_publicado "$VERSAO_ALVO"; then   # pina a versão
1039: elif trio_publicado "stable"; then
1042:   VERSAO_ALVO="stable"        <-- 3º caminho, grava TAG MÓVEL no .env
1045: elif [ -n "$VERSAO_ALVO" ]; then  # constrói worker/scheduler na VPS
1056:   VERSAO_ALVO="latest"
```

**Sugestão:** Três exceções, todas deliberadas e todas com aviso na tela — porque falhar fechado aqui seria recusar instalar por não conseguir resolver um número:  1. **A versão mais recente ainda não tem as três imagens publicadas** (a tag do git nasce minutos antes delas): cai no canal `stable` e avisa. É o caminho mais provável nos primeiros minutos de uma release. 2. **Sem rede ou sem tag no remoto**, cai em `latest` e avisa. Trocar previsibilidade por disponibilidade é o negócio errado numa instalação que já começou. 3. **Quem preenche o `.env` à mão** a partir de `.env.hostgator.example` recebe `stable` — o piso seguro para quem não vai rodar a entrevista. `--yes` com o template preserva esse valor.  A cascata inteira está em `grep -n 'VERSAO_ALVO=' hostgator-setup-kit/install.sh` — leia lá antes de confiar nesta lista.

**Vira teste:** tests/shell: para cada atribuição de VERSAO_ALVO a uma tag móvel em install.sh, a doutrina precisa nomear a exceção — assert que o conjunto {stable, latest} extraído de `grep -oE 'VERSAO_ALVO="(stable|latest)"' install.sh` está integralmente citado no bloco de exceções do invariante 3

### L230 · FALSA · gravidade alta · pendencia

> **Vale a partir da próxima release.** Nenhuma imagem já publicada carrega `APP_VERSION` … Todo o parque instalado hoje responde `desconhecido`

**Mede com:**

```bash
# config blob das imagens no GHCR (docker daemon fora do ar; li o registry direto)
python3 scratchpad/ghcr_cfg.py deskcommcrm 1.2.1 ; python3 scratchpad/ghcr_cfg.py deskcommcrm 1.3.0 ; python3 scratchpad/ghcr_cfg.py deskcomm-worker 1.3.0 ; gh release list --limit 2
```

**Deu:**

```
deskcommcrm:1.2.1  APP_VERSION env: AUSENTE
deskcommcrm:1.3.0  APP_VERSION env: ['APP_VERSION=1.3.0']
deskcomm-worker:1.3.0  APP_VERSION env: ['APP_VERSION=1.3.0']
deskcommcrm:stable APP_VERSION=1.3.0 | deskcommcrm:latest APP_VERSION=840917e
gh release list: v1.3.0 … Latest … 2026-08-13T19:58:03Z
```

**Sugestão:** > **Onde já vale.** Toda imagem publicada a partir da v1.3.0 carrega `APP_VERSION` — medido em 2026-08-14 direto no registry: `deskcommcrm:1.3.0` e `deskcomm-worker:1.3.0` trazem `APP_VERSION=1.3.0`; a `1.2.1` não traz nenhuma. Quem ainda roda imagem anterior à 1.3.0 responde `desconhecido`, que é a resposta honesta e o motivo de o fallback não ser mais um número plausível. Para saber o que a SUA imagem carrega: `docker run --rm ghcr.io/melgarafael/deskcommcrm:<tag> node -e 'console.log(process.env.APP_VERSION)'`.

### L234 · FALSA · gravidade media · ponteiro

> O item 9 do checklist de release reprova contra a 1.2.1 de propósito.

**Mede com:**

```bash
grep -n '^\[ \] [0-9]' docs/doctrine/packaging.md | sed -n '8,10p'
```

**Deu:**

```
[ ] 8. A imagem reporta a versão certa: docker run … node -e 'console.log(process.env.APP_VERSION)' → X.Y.Z
[ ] 9. `gh release create vX.Y.Z` com as notas do CHANGELOG
[ ] 10. SÓ AGORA: `stable` e X.Y.Z são o MESMO digest
```

**Sugestão:** O item 8 do checklist de release reprova contra a 1.2.1 de propósito.

**Vira teste:** tests/unit: parsear os itens `[ ] N.` do checklist e assertar que o item citado no invariante 7 é o que contém `APP_VERSION` — ponteiro por número quebra em silêncio quando alguém insere um item no meio

### L256 · FRAGIL · gravidade media · data-versao

> | `stable` | implementador validando antes de atualizar clientes | sim | `always` | a **última release** publicada |

**Mede com:**

```bash
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do for t in 1.3.0 stable; do python3 scratchpad/ghcr_cfg.py $i $t | head -1; done; done
```

**Deu:**

```
deskcommcrm:1.3.0  top-digest=sha256:fc10b029…  | deskcommcrm:stable  top-digest=sha256:c4bc70b6…
deskcomm-worker:1.3.0 sha256:81e5af56… | deskcomm-worker:stable sha256:3fe292ca…
deskcomm-scheduler:1.3.0 sha256:4396263b… | deskcomm-scheduler:stable sha256:a0d5c3ad…
(os dois lados carregam revision=9bd59e9 e APP_VERSION=1.3.0 — builds distintos do mesmo commit)
```

**Sugestão:** Acrescentar à nota do item 10 (depois de "O gatilho foi removido…"): **A divergência da v1.3.0 continua viva no registry.** Medido em 2026-08-14, `stable` e `1.3.0` são digests DIFERENTES nas três imagens — mesmo `revision` (9bd59e9) e mesmo `APP_VERSION` (1.3.0), builds distintos. O conserto foi no gatilho, não no que já foi publicado: rodar o item 10 contra a 1.3.0 hoje reprova, e é o esperado. A primeira release em que o item 10 deve bater é a próxima.

### L350 · FRAGIL · gravidade baixa · data-versao

> Apagar tags de branch dos três pacotes — `docs-doutrina-packaging` e qualquer outra que tenha nascido de um `workflow_dispatch` de ensaio.

**Mede com:**

```bash
ghcr_status() { … }; for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do for t in docs-doutrina-packaging quebrada-teste; do echo "$i:$t -> $(ghcr_status $i $t)"; done; done
```

**Deu:**

```
deskcommcrm:docs-doutrina-packaging -> 404
deskcommcrm:quebrada-teste -> 200
deskcomm-worker:docs-doutrina-packaging -> 404 | quebrada-teste -> 404
deskcomm-scheduler:docs-doutrina-packaging -> 404 | quebrada-teste -> 404
```

**Sugestão:** Apagar tags de branch dos três pacotes — qualquer uma nascida de um `workflow_dispatch` de ensaio. Tag de branch é artefato de trabalho: se ficar, vira canal órfão que alguém pina por engano achando que é release, e ela nunca mais se move. Para listar o que existe: `ghcr_status <imagem> <tag>` acima, ou `gh api /user/packages/container/<imagem>/versions --jq '.[].metadata.container.tags'`. O registry ainda carrega `quebrada-teste` (só em `deskcommcrm`) como lembrete; a `docs-doutrina-packaging` já foi apagada — 404 nos três em 2026-08-14.

### L367 · FRAGIL · gravidade baixa · data-versao

> EXIGE ESCOPO QUE O TOKEN PADRÃO DO `gh` NÃO TEM. Medido no corte da 1.3.0: com `gist, read:org, repo, workflow` a API devolve 403

**Mede com:**

```bash
gh auth status 2>&1 | grep -i 'scopes'
```

**Deu:**

```
- Token scopes: 'delete:packages', 'gist', 'read:org', 'read:packages', 'repo', 'workflow'
```

**Sugestão:** EXIGE ESCOPO QUE O TOKEN PADRÃO DO `gh` NÃO TEM — no corte da 1.3.0, com `gist, read:org, repo, workflow`, a API devolveu 403 tanto para listar quanto para apagar versão de pacote. Confira o SEU token antes de chegar aqui: `gh auth status | grep -i scopes` precisa mostrar `read:packages` e `delete:packages`; se faltar, `gh auth refresh -h github.com -s read:packages,delete:packages`.

### L390 · FALSA · gravidade alta · pendencia

> imagem quebrada reprova — **assim que o check entrar na branch protection** (ver invariante 2)

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** | CI (mecânico) | `imagens-ok` em `publish-image.yml` | imagem quebrada reprova o merge — é required check da `main`. Confira na fonte antes de confiar nesta linha: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'` |

**Vira teste:** tests/unit/packaging-artefato-do-cliente.test.ts: o texto de docs/doctrine/packaging.md e de CONTRIBUTING.md não pode conter /assim que o check entrar|ainda não bloqueia merge|ainda não é obrigatório/ — congela a frase de pendência que já apodreceu duas vezes neste mesmo arquivo


## `docs/index.md` — 10

### L5 · FALSA · gravidade media · data-versao

> last_updated: 2026-07-29

**Mede com:**

```bash
git log -1 --format='%h %ad %s' --date=short -- docs/index.md
```

**Deu:**

```
64ff6f3e 2026-08-13 docs(incidente): runbook de remediação do worker congelado — declarado NÃO ENSAIADO
```

**Sugestão:** last_updated: 2026-08-13   # régua: git log -1 --format=%ad --date=short -- docs/index.md

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("last_updated do índice bate com o último commit que o tocou") — comparar o campo com git log -1 --format=%ad --date=short -- docs/index.md

### L8 · FALSA · gravidade media · data-versao

> audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)

**Mede com:**

```bash
git rev-list -n1 v1.0.0 ; git log -1 --format='%h %ad' --date=short 789dfa6
```

**Deu:**

```
3ae07056055b8a8a3ab00e53d641e954e10f3480
789dfa6f 2026-07-29
```

**Sugestão:** audited_against: origin/main @ 789dfa6 (2026-07-29 — dois dias e alguns commits DEPOIS da tag v1.0.0, que é 3ae07056 de 2026-07-27)

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("o front-matter do índice não rotula o SHA auditado com uma tag que não é dele") — se `audited_against` citar `vX.Y.Z`, exigir `git rev-list -n1 vX.Y.Z` == o SHA citado

### L13 · FALSA · gravidade media · contagem

> Mapa dos **149** arquivos `.md` de `docs/`, espalhados por **24** subpastas — régua: `git ls-files 'docs/**/*.md' | wc -l`.

**Mede com:**

```bash
git ls-files 'docs/**/*.md' | wc -l ; git ls-files -- docs/ | grep -c '\.md$' ; git ls-files 'docs/**/*.md' | xargs -n1 dirname | sort -u | wc -l
```

**Deu:**

```
151
161
24
```

**Sugestão:** Mapa dos arquivos `.md` de `docs/`. O número apodrece a cada doc novo, então ele não mora aqui — **conte**: `git ls-files 'docs/**/*.md' | wc -l` (subpastas com doc: `git ls-files 'docs/**/*.md' | xargs -n1 dirname | sort -u | wc -l`). Existe porque a documentação cresceu sem ponto de entrada: sem este índice, humano e agente não acham o que já foi decidido e reescrevem por cima.

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("o índice não fixa a contagem de docs") — reprovar se a linha 13 de docs/index.md contiver um literal numérico de 2+ dígitos antes de 'arquivos `.md`'

### L113 · FALSA · gravidade alta · pendencia

> impacto medido e as duas rotas de remediação. **Ainda não ensaiado**

**Mede com:**

```bash
sed -n '1,12p' docs/runbooks/remediar-worker-congelado.md; grep -c '\[ENSAIADO\]' docs/runbooks/remediar-worker-congelado.md
```

**Deu:**

```
> ## Estado do ensaio: **U6-b EXECUTADO em 2026-08-13, com uma ressalva que muda o procedimento**
> O ensaio rodou numa VPS real, com estado legado **reproduzido** (não simulado): clone no commit `ee520110` ... o worker migrou de imagem local (`2174fb4f`) para a publicada ... 69 → 73 tabelas
(marcadores [ENSAIADO] nas seções 5.0/A1/A3/A4/A5)
```

**Sugestão:** | [`runbooks/remediar-worker-congelado.md`]\(runbooks/remediar-worker-congelado.md\) | **Incidente: o worker congelado** — diagnóstico (`diagnostico.sh`), impacto medido e as duas rotas de remediação. **Ensaiado em VPS real (U6-b, 2026-08-13)**, com uma ressalva que muda o procedimento: a **primeira** execução do `update.sh` não troca o worker. Leia o cabeçalho do runbook antes de operar |

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("o índice não declara não-ensaiado um runbook que se declara ensaiado") — se docs/index.md casar /Ainda não ensaiado/ na linha que cita remediar-worker-congelado.md, reprovar quando o runbook contiver /EXECUTADO em \d{4}-\d{2}-\d{2}/

### L113 · FALSA · gravidade media · pendencia

> **Incidente: o worker congelado** — diagnóstico (`diagnostico.sh`), impacto medido e as duas rotas de remediação. **Ainda não ensaiado**

**Mede com:**

```bash
grep -n 'remediar-worker-congelado' docs/index.md docs/testing/user-journey-map.md
```

**Deu:**

```
docs/index.md:113  … **Ainda não ensaiado**
docs/testing/user-journey-map.md:585  | U6 `[P0]` | … | **EXECUTADO 2026-08-13** (U6-b, U6-c e **aplicado em produção**) …
```

**Sugestão:** | [`runbooks/remediar-worker-congelado.md`]\(runbooks/remediar-worker-congelado.md\) | **Incidente: o worker congelado** — diagnóstico (`diagnostico.sh`), impacto medido e as duas rotas de remediação. **Ensaiado (U6-b/U6-c) e aplicado na produção do projeto em 2026-08-13**; o que os ensaios não cobriram está no §6 |

### L114 · FALSA · gravidade media · pendencia

> **Ativação da doutrina de packaging** — os 3 passos que não cabem num PR (pacote público, check obrigatório, primeira release)

**Mede com:**

```bash
sed -n '1,13p' docs/runbooks/ativar-packaging.md
```

**Deu:**

```
> **CONCLUÍDO em 2026-08-14. Este runbook é histórico** — guardado porque descreve o procedimento e as armadilhas de cada passo, não porque haja algo a fazer.
> | 1–2. Pacotes públicos | feito | ... | 3. `imagens-ok` obrigatório | feito | ... | 4. Primeira release completa | feito | v1.3.0 | 5. Tag de ensaio apagada | feito |
```

**Sugestão:** | [`runbooks/ativar-packaging.md`]\(runbooks/ativar-packaging.md\) | **Ativação da doutrina de packaging — CONCLUÍDA em 2026-08-14.** Histórico: guarda o procedimento e as armadilhas dos passos que não cabiam num PR (pacote público, `imagens-ok` obrigatório, primeira release completa, tag de ensaio apagada) |

### L135 · FALSA · gravidade alta · contagem

> **Raiz (em voo):** `HANDOFF.md` (follow-up), `HANDOFF-harness-evolution.md`, `HANDOFF-operacao-visivel.md`

**Mede com:**

```bash
ls HANDOFF*.md
```

**Deu:**

```
HANDOFF-conversa-vira-lead.md  HANDOFF-followup-vivo.md  HANDOFF-fv-w1-fila.md  HANDOFF-harness-evolution.md  HANDOFF-ia-360.md  HANDOFF-marca-propria.md  HANDOFF-operacao-visivel.md  HANDOFF-sistema-vivo-consertos.md  HANDOFF-tres-papeis.md  HANDOFF.md   (10 arquivos; a lista do índice cita 3)
```

**Sugestão:** - **Raiz (em voo):** a lista não cabe aqui sem apodrecer — o sinal é o arquivo, não esta linha. Liste com `ls HANDOFF*.md`; tudo que aparecer está em voo, e o que foi encerrado migrou para [`handoffs/`]\(handoffs/\).

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("o índice não enumera HANDOFF da raiz") — reprovar se docs/index.md listar por nome um subconjunto próprio de ls('HANDOFF*.md') na seção 8

### L138 · FRAGIL · gravidade baixa · contagem

> [`superpowers/`]\(superpowers/\) — `plans/` e `specs/` datados por onda, mais `handoffs/`

**Mede com:**

```bash
ls docs/superpowers/
```

**Deu:**

```
handoffs  plans  reports  specs
```

**Sugestão:** - [`superpowers/`]\(superpowers/\) — `plans/`, `specs/` e `reports/` datados por onda, mais `handoffs/`

### L146 · FALSA · gravidade media · ponteiro

> `graphify-out/` — grafo do repositório (7310 nós, 17705 arestas, 538 comunidades na última geração).

**Mede com:**

```bash
ls graphify-out/ ; git ls-files | grep -c '^graphify-out/' ; grep -n graphify .gitignore
```

**Deu:**

```
ls: graphify-out/: No such file or directory
0
100:# graphify (análise local de knowledge graph)
101:graphify-out/
```

**Sugestão:** `graphify-out/` — grafo do repositório, **gerado localmente e fora do git** (`.gitignore:101`): num clone novo o diretório não existe. Gere com `/graphify .` antes de consultar; nós, arestas e comunidades saem do `GRAPH_REPORT.md` daquela geração, não deste índice — que não tem como medi-los. `GRAPH_REPORT.md` traz god nodes, hyperedges e comunidades. **Gerado — não editar.**

**Vira teste:** tests/unit/docs-ponteiros.test.ts: it("ponteiro de doc não aponta para caminho gitignored sem dizer isso") — se docs/index.md citar um path que `git check-ignore` resolve, exigir a palavra 'gerado'/'fora do git' na mesma linha

### L160 · FALSA · gravidade alta · pendencia

> `docs/architecture/` contém só o diagrama do agent-turn; a doutrina ... pede que o "mapa vivo" da arquitetura reflita toda peça nova com ≥2 arestas — **NÃO IDENTIFICADO** se isso está sendo cumprido, e é a lacuna documental mais relevante que sobrou.

**Mede com:**

```bash
ls docs/architecture/ && ls docs/architecture/*.architecture.json | wc -l
```

**Deu:**

```
agent-turn.html  agent-turn.workflow.json  atualizacao-self-service.architecture.json  crm-vivo.architecture.json  escalacao-ciclo-humano.architecture.json  followup-dossie.architecture.json  gestao-funis.architecture.json  ia-360-organizar.architecture.json  ia-360-retencao.architecture.json  indice-de-atrito.architecture.json  marca-propria.architecture.json  README.md
10
```

**Sugestão:** - `docs/architecture/` **deixou de ser lacuna**: além do diagrama do agent-turn, reúne os mapas vivos `*.architecture.json` exigidos pelo item 13 do DoD, com `README.md` próprio. Confira a cobertura antes de afirmar que a doutrina está ou não sendo cumprida: `ls docs/architecture/*.architecture.json | wc -l`.

**Vira teste:** tests/unit/mapas-de-arquitetura.test.ts (já existe): acrescentar it("o índice não declara docs/architecture/ vazio") — reprovar se docs/index.md casar /architecture\/` contém só/ enquanto houver >1 arquivo *.architecture.json


## `docs/runbooks/ativar-packaging.md` — 9

### L3 · FRAGIL · gravidade alta · pendencia

> **CONCLUÍDO em 2026-08-14. Este runbook é histórico** — guardado porque descreve o procedimento e as armadilhas de cada passo, não porque haja algo a fazer.

**Mede com:**

```bash
docker buildx imagetools inspect ghcr.io/melgarafael/deskcommcrm:stable --format '{{.Manifest.Digest}}' ; docker buildx imagetools inspect ghcr.io/melgarafael/deskcommcrm:1.3.0 --format '{{.Manifest.Digest}}'
```

**Deu:**

```
stable → sha256:c4bc70b606c8e63f3fc9557ed31b1a211b58beaac3b67509eb0c8acbc0dbaead
1.3.0  → sha256:fc10b029e326792e9972bb712b7392f9c7ba7014c749f2ba5e59f6a3b7a7f0ad
(item 10 do §Checklist de release, docs/doctrine/packaging.md:341, reprova)
```

**Sugestão:** > **Os cinco passos foram dados (o último em 2026-08-14). Este runbook é histórico** — > guardado porque descreve o procedimento e as armadilhas de cada passo. > **Ele não atesta que o estado continua valendo**, e um item segue aberto: o `stable` > e o `1.3.0` estão em digests diferentes nos três pacotes (§4). Reconfira cada linha > com o comando da seção correspondente antes de confiar nela.

### L10 · FRAGIL · gravidade alta · pendencia

> 4. Primeira release completa | feito | v1.3.0; `1.3.0` e `stable` nos três pacotes

**Mede com:**

```bash
for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do for t in 1.3.0 stable; do echo -n "$i:$t "; docker buildx imagetools inspect ghcr.io/melgarafael/$i:$t --format '{{.Manifest.Digest}}'; done; done
```

**Deu:**

```
deskcommcrm:1.3.0 sha256:fc10b029e326… / deskcommcrm:stable sha256:c4bc70b606c8…
deskcomm-worker:1.3.0 sha256:81e5af567cc8… / deskcomm-worker:stable sha256:3fe292cad2bd…
deskcomm-scheduler:1.3.0 sha256:4396263ba807… / deskcomm-scheduler:stable sha256:a0d5c3ad2296…
(pares divergentes nas TRÊS; até as camadas amd64 diferem: 42d064f0… vs 198c494e…)
```

**Sugestão:** > | 4. Primeira release completa | **parcial** | v1.3.0 publicada nos três pacotes; o **item 10** do checklist da doutrina (`stable` e `1.3.0` no MESMO digest) **não bate** — `stable` ainda aponta para o build das 19:53. Rode o laço do §Checklist de release antes de confiar no canal |

### L11 · FALSA · gravidade media · ponteiro

> | 5. Tag de ensaio apagada | feito | `docs-doutrina-packaging` → 404 nos três |

**Mede com:**

```bash
grep -n '^#\+ ' docs/runbooks/ativar-packaging.md
```

**Deu:**

```
52:## 1. Merge do PR na `main`
67:## 2. Tornar os dois pacotes novos PÚBLICOS
91:## 3. `imagens-ok` vira status check obrigatório
125:## 4. Primeira release completa
144:## 5. Ensaio numa VPS real
(a linha 5 da tabela NÃO é o §5 do corpo — "tag de ensaio apagada" é o item 11 do checklist da doutrina; o §5 do corpo, o ensaio na VPS, não tem linha nenhuma na tabela)
```

**Sugestão:** > | 5. Ensaio numa VPS real (§5) | feito | U6-c em 2026-08-13: `/api/v1/health` → `1.3.0` na instalação atualizada; evidência em [`remediar-worker-congelado.md`]\(remediar-worker-congelado.md\) §6 | > | Extra: tag de ensaio apagada (item 11 da doutrina) | feito | `docs-doutrina-packaging` → 404 nos três |

**Vira teste:** assert: cada linha numerada da tabela de estado do runbook casa com um heading `## N.` do próprio arquivo

### L19 · FALSA · gravidade media · pendencia

> Enquanto eles não forem dados, parte da doutrina é conselho, não gate — e o texto diz isso onde for o caso.

**Mede com:**

```bash
grep -rn 'Pendência de ativação' docs/doctrine/packaging.md CLAUDE.md CONTRIBUTING.md ; sed -n '112,116p' docs/doctrine/packaging.md
```

**Deu:**

```
(grep: nenhuma ocorrência)
112: > **Ativado.** `imagens-ok` **é** required check da `main`. Medido em 2026-08-14:
116: > verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** Este documento existe porque a entrega da [doutrina de packaging]\(../doctrine/packaging.md\) teve três passos que **não podiam estar dentro do PR**: dois dependiam de administração do repositório e um dependia de as imagens existirem. Os três foram dados, e o texto da doutrina já não carrega ressalva de pendência — o invariante 2 diz **Ativado** (confira com `grep -n 'Ativado' docs/doctrine/packaging.md`).

### L119 · FRAGIL · gravidade baixa · pendencia

> Feito isso, **remova a "Pendência de ativação"** do invariante 2 em [`../doctrine/packaging.md`]\(../doctrine/packaging.md\) e as ressalvas correspondentes em `CLAUDE.md` e `CONTRIBUTING.md`.

**Mede com:**

```bash
grep -rn 'Pendência de ativação' docs/doctrine/packaging.md CLAUDE.md CONTRIBUTING.md AGENTS.md
```

**Deu:**

```
(nenhuma ocorrência nos quatro arquivos)
```

**Sugestão:** Isso **já foi feito** — `grep -rn 'Pendência de ativação' docs/doctrine/packaging.md CLAUDE.md CONTRIBUTING.md` não devolve nada, e o invariante 2 hoje abre com **Ativado**. O parágrafo fica como registro do porquê: deixar a ressalva de pé depois de a pendência ter sido resolvida transforma a doutrina em documento que subestima a si mesmo — o defeito espelhado do que ela veio consertar.

### L145 · FALSA · gravidade media · ponteiro

> O item 11 do checklist de release, e o único que o CI não exercita.

**Mede com:**

```bash
grep -n '^\[ \] 1[12]\.' docs/doctrine/packaging.md ; grep -n 'O item 12 é o único' docs/doctrine/packaging.md
```

**Deu:**

```
341:[ ] 10. SÓ AGORA: `stable` e X.Y.Z são o MESMO digest, nas três imagens:
(item 11) "Apagar tags de branch dos três pacotes — `docs-doutrina-packaging` …"
(item 12) "Ensaio de atualização numa instalação real (não fresca): update.sh …"
+ packaging.md: "O item 12 é o único que exige VPS."
```

**Sugestão:** O item **12** do checklist de release — o único que exige VPS, e o único que a suíte de CI não exercita. (O item 11 é outra coisa: apagar as tags de branch dos três pacotes.)

**Vira teste:** assert: todo ponteiro do tipo "item N do checklist de release" em docs/ casa com a linha `[ ] N.` de docs/doctrine/packaging.md

### L159 · FALSA · gravidade alta · sobre-o-codigo

> É o caso U6 de [`../testing/user-journey-map.md`]\(../testing/user-journey-map.md\), declarado como não coberto de propósito.

**Mede com:**

```bash
grep -n "U6" docs/testing/user-journey-map.md | head -10
```

**Deu:**

```
585:| U6 `[P0]` | **Ensaio de atualização numa VPS real…** | **EXECUTADO 2026-08-13** (U6-b, U6-c e **aplicado em produção**) … |
587:U6 deixou de ser buraco em 2026-08-13, e o ensaio pagou o próprio custo
```

**Sugestão:** É o caso U6 de [`../testing/user-journey-map.md`]\(../testing/user-journey-map.md\), **executado em 2026-08-13** (U6-b, U6-c e aplicado em produção), com uma ressalva que só o ensaio podia revelar: a 1ª execução do `update.sh` não conserta o worker enquanto o canal `stable` não existir; a 2ª conserta. Evidência e limites em [`remediar-worker-congelado.md`]\(remediar-worker-congelado.md\) §6. Continua fora da cobertura do CI — o que o mapa registra é o ensaio feito à mão, não um gate.

### L164 · FALSA · gravidade alta · pendencia

> ## Enquanto os passos 1–4 não acontecem

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' ; ghcr_status deskcommcrm stable
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
deskcommcrm latest=200 stable=200 1.3.0=200 (idem worker e scheduler)
```

**Sugestão:** ## Como era enquanto os passos 1–4 não tinham acontecido (histórico — eles aconteceram em 2026-08-14)  Nada quebrava, e isso era por construção. **Nenhuma linha da tabela abaixo descreve o estado de hoje**: os quatro passos foram dados. Ela fica como registro do desenho — para o estado atual, rode os comandos de cada seção.

### L173 · FALSA · gravidade alta · ativo-obrigatorio

> | PR de contribuidor | `imagens-ok` roda e informa; não bloqueia até o passo 3 |

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** | PR de contribuidor | `imagens-ok` rodava e informava; não bloqueava. **Desde 2026-08-14 bloqueia** — é required check da `main` (`gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts\|join(", ")'`) |


## `docs/runbooks/deploy.md` — 7

### L12 · FALSA · gravidade media · ponteiro

> cd /var/www/crm

**Mede com:**

```bash
grep -n "REPO_DIR=\|git clone\|PROJECT_DIR=" hostgator-setup-kit/install.sh ; grep -rn "/var/www" hostgator-setup-kit/*.sh ; grep -rn "^cd " docs/runbooks/*.md
```

**Deu:**

```
install.sh:22: REPO_DIR="${REPO_DIR:-deskcommcrm}"
install.sh:728: git clone --depth 1 "$REPO_URL" "$REPO_DIR"  → cd "$REPO_DIR" ; PROJECT_DIR="$(pwd)"
/var/www no kit: só diagnostico.sh:46, como ÚLTIMO palpite de uma lista de 6 candidatos.
Runbook irmão: docs/runbooks/remediar-worker-congelado.md:81,101,110,218 usam `cd /caminho/do/projeto`.
```

**Sugestão:** ```bash cd /caminho/do/projeto      # o install.sh clona em ./deskcommcrm — normalmente /root/deskcommcrm.                             # Não sabe onde está? find /root /opt /home -maxdepth 4 -name docker-compose.prod.yml docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app ```

### L25 · FALSA · gravidade alta · ponteiro

> associa o contêiner à rede que o Traefik enxerga (`TRAEFIK_DOCKER_NETWORK`)

**Mede com:**

```bash
grep -rn "TRAEFIK_DOCKER_NETWORK" . --exclude-dir=node_modules --exclude-dir=.git ; grep -rln "TRAEFIK_NETWORK" . --exclude-dir=node_modules --exclude-dir=.git
```

**Deu:**

```
TRAEFIK_DOCKER_NETWORK -> 1 ocorrência em TODO o repo: docs/runbooks/deploy.md:25 (a própria frase).
TRAEFIK_NETWORK -> .env.hostgator.example, docker-compose.traefik.yml, hostgator-setup-kit/install.sh, _common.sh, test-validators.sh.
docker-compose.traefik.yml: traefik.docker.network: "${TRAEFIK_NETWORK:-traefik}" e networks.proxy.name: "${TRAEFIK_NETWORK:-traefik}".
.env.hostgator.example:75: #TRAEFIK_NETWORK=traefik
```

**Sugestão:** - associa o contêiner à rede onde o Traefik o encontra — `TRAEFIK_NETWORK` no `.env`, que o `install.sh` descobre e grava. O nome da variável está no próprio override, não confie nesta linha: `grep -n TRAEFIK docker-compose.traefik.yml`;

**Vira teste:** extrair de docs/runbooks/deploy.md todo token `[A-Z][A-Z0-9_]{3,}` entre crases e assertar que cada um aparece em docker-compose*.yml, .env.example ou .env.hostgator.example — expect(orfaos).toEqual([])

### L46 · NAO_VERIFICAVEL · gravidade baixa · sobre-o-codigo

> medido: com um -f ou com os dois, devolve o MESMO contêiner

**Mede com:**

```bash
docker version --format '{{.Server.Version}}'
```

**Deu:**

```
Sem resposta — o comando estourou 120s e foi para background; o daemon Docker não está de pé nesta máquina. `docker compose config` (que não precisa do daemon) roda, mas `ps -q` precisa. Afirmação NÃO reproduzida aqui.
```

**Sugestão:** O caminho que não depende da afirmação: use os dois `-f` também no `inspect` e apague a justificativa. Um runbook não precisa defender uma economia que não economiza nada.  ```bash docker inspect "$(docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml ps -q app)" \   --format '{{.Config.Labels}}' | grep -o 'traefik.enable:[^ ]*' # esperado: traefik.enable:true   (vazio = roteamento quebrado) ```

### L54 · FRAGIL · gravidade baixa · sobre-o-codigo

> # esperado: 307 (redireciona pro login)

**Mede com:**

```bash
cat lib/auth/public-paths.ts ; cat app/page.tsx ; sed -n '60,90p' proxy.ts
```

**Deu:**

```
lib/auth/public-paths.ts: PUBLIC_PATHS começa com /^\/$/ → a raiz É pública, o proxy a deixa passar sem checar sessão.
app/page.tsx: export default function HomePage() { redirect("/app"); }
proxy.ts:83-86: só depois, em /app, é que o não-autenticado vira NextResponse.redirect(/login?next=...).
app/app/layout.tsx:28: if (!user) redirect("/login");
```

**Sugestão:** # esperado: 307 — o primeiro salto vai para `/app` (`app/page.tsx`), porque a raiz é #           caminho público (`lib/auth/public-paths.ts`). Quem segue os redirects #           (`curl -L`) termina no `/login`. # 404      = labels perdidas, refaça o deploy com os dois -f

### L63 · FALSA · gravidade alta · sobre-o-codigo

> commit → push → PR → merge na main → CI publica imagem → VPS puxa

**Mede com:**

```bash
grep -n "TARGET_TAG" hostgator-setup-kit/update.sh | head -3 ; grep -n "stable" docker-compose.prod.yml ; grep -rn "gh release create" docs/ .github/
```

**Deu:**

```
update.sh:39: [ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
docker-compose.prod.yml:35 image: ${APP_IMAGE:-ghcr.io/melgarafael/deskcommcrm:stable} (idem worker:92 e scheduler:196)
docs/DEPLOY-CHECKLIST.md:45: - [ ] `gh release create vX.Y.Z` com as notas do CHANGELOG
docs/doctrine/packaging.md:340: [ ] 9. `gh release create vX.Y.Z`
Medido no GHCR: deskcommcrm:latest revision=840917ed (topo da main) vs deskcommcrm:stable version=1.3.0 revision=9bd59e9.
```

**Sugestão:** ``` commit → push → PR → merge na main → CI publica `latest`             → `gh release create vX.Y.Z` → CI publica a versão + `stable` → VPS puxa ```  O merge na `main` NÃO chega a instalação nenhuma. Ele publica `latest`, e ninguém consome `latest`: o `docker-compose.prod.yml` tem `:stable` como default nas três imagens, e o `update.sh` alveja a maior tag `v*` (`git tag -l 'v*' --sort=-v:refname | head -1`). Sem cortar a release, a correção fica parada no registry. O checklist da release está em [`../DEPLOY-CHECKLIST.md`]\(../DEPLOY-CHECKLIST.md\).

### L72 · FRAGIL · gravidade media · contagem

> publica **três** imagens — `deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler` — sempre na mesma versão

**Mede com:**

```bash
grep -n "fail-fast\|push: \|- name: deskcomm" .github/workflows/publish-image.yml ; grep -n -A8 'if ! dc pull' hostgator-setup-kit/update.sh
```

**Deu:**

```
publish-image.yml: strategy.fail-fast: false ; matrix com deskcommcrm, deskcomm-worker, deskcomm-scheduler ; push: ${{ github.event_name != 'pull_request' }} em cada job da matriz.
update.sh:200: "if ! dc pull; then ... se um run de publicação quebrou ... o compose ainda tem build: ao lado do image: do worker e do scheduler"
GHCR (medido agora): as três respondem HTTP 200 em :latest e :stable.
```

**Sugestão:** publica **três** imagens — `deskcommcrm`, `deskcomm-worker` e `deskcomm-scheduler` — sob a mesma tag de versão. Sob a mesma tag, não necessariamente as três: a matriz roda com `fail-fast: false` e cada job empurra a sua, então uma versão pode existir para duas imagens e faltar na terceira (é exatamente o caso que o `dc pull` do `update.sh` trata). Antes de anunciar uma versão, confirme as três: `for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do docker buildx imagetools inspect ghcr.io/melgarafael/$i:<versão> --format '{{.Manifest.Digest}}'; done`

### L108 · FRAGIL · gravidade media · contagem

> Requisitos: >= 4 GB de RAM **ou** swap (medido: ~4min num VPS de 3.8 GB com 4 GB de swap)

**Mede com:**

```bash
grep -rn "15-25min\|~4min" docker-compose.build.yml docs/
```

**Deu:**

```
docker-compose.build.yml:2: # Uso (avançado — requer VPS >=4GB RAM ou swap; build leva ~15-25min num VPS):
docs/runbooks/deploy.md:108: (medido: ~4min num VPS de 3.8 GB com 4 GB de swap)
docs/superpowers/specs/2026-07-02-hostgator-deploy-design.md:64: webpack 34min vs ~4min do turbopack  ← o ~4min ali é do `pnpm build`, não da imagem
docs/adr/0001-packaging-e-distribuicao.md:148: "4–34 min" não existe no repo
```

**Sugestão:** Requisitos: >= 4 GB de RAM **ou** swap. Quanto demora, meça na hora (`time docker compose ... build app`) — os dois números que o repo carrega não medem a mesma coisa: o `docker-compose.build.yml` fala em ~15-25min para a **imagem inteira**, e os ~4min de `docs/superpowers/specs/2026-07-02-hostgator-deploy-design.md` são só o `pnpm build` com turbopack, dentro dela. E isto é o requisito **deste caminho de exceção**, não da operação normal.


## `docs/runbooks/remediar-worker-congelado.md` — 11

### L17 · FRAGIL · gravidade media · ativo-obrigatorio

> **A ressalva, e ela é o motivo de este aviso continuar aqui:** a **primeira** execução do `update.sh` NÃO consertou o worker.

**Mede com:**

```bash
docker buildx imagetools inspect ghcr.io/melgarafael/deskcomm-worker:stable 2>&1 | awk '/^Digest:/{print $2; exit}'
```

**Deu:**

```
sha256:3fe292cad2bd8aa6ed0182e67a7bafd6e857e0fff14cedcb53694254dca0ef95  (o canal `stable` EXISTE — a precondição do U6-b não vale mais)
```

**Sugestão:** **A ressalva, e ela mudou de motivo:** com uma release publicada — o canal `stable` existe desde a v1.3.0 —, a **primeira** execução já troca a imagem do worker, mas a deixa **sem pin**, seguindo um canal móvel. Sem release publicada (o caso do U6-b), a primeira execução não troca nada. Nos dois casos a **segunda** execução é obrigatória: é ela que pina as três na mesma versão. Ver §5.0.

### L54 · FRAGIL · gravidade baixa · contagem

> Entre a data da imagem do worker e a versão instalada do app, **9 commits e 399 linhas** em `workers/` nunca chegaram.

**Mede com:**

```bash
git log --oneline --since=2026-07-31 --until=2026-08-13 -- workers/ | wc -l; git log --numstat --format='' --since=2026-07-31 --until=2026-08-13 -- workers/ | awk '{i+=$1;d+=$2} END{print i+d}'; git log --oneline ee520110..v1.2.1 -- workers/ | wc -l; git log --numstat --format='' ee520110..v1.2.1 -- workers/ | awk '{i+=$1;d+=$2} END{print i+d}'; git diff --shortstat ee520110 v1.2.1 -- workers/
```

**Deu:**

```
janela por data: 9 commits, 439 linhas (406+/33-)
ee520110..v1.2.1: 11 commits, 397 linhas (364+/33-)
diff líquido ee520110→v1.2.1: 4 files changed, 354 insertions(+), 23 deletions(-)
```

**Sugestão:** Entre a data da imagem do worker (31/07) e a versão instalada do app (1.2.1, de 12/08), os commits que tocaram `workers/` nunca chegaram. O número depende do recorte — reconte em vez de repassar:  ```bash git log --oneline --since=2026-07-31 --until=2026-08-13 -- workers/ | wc -l    # 9 git log --numstat --format='' ee520110..v1.2.1 -- workers/ \   | awk '{i+=$1;d+=$2} END{print i+d}'                                          # 397 ```

### L87 · FRAGIL · gravidade media · sobre-o-codigo

> até a versão que conserta isto, ele lê `npm_package_version`, que é `undefined` sob `CMD ["node","server.js"]`. Toda instalação responde `0.1.0` — afetada ou não.

**Mede com:**

```bash
git show v1.2.1:app/api/v1/health/route.ts | grep -n 'npm_package_version'; git show v1.3.0:app/api/v1/health/route.ts | grep -n 'APP_VERSION'; grep -n 'version:' app/api/v1/health/route.ts
```

**Deu:**

```
v1.2.1:227  version: process.env.npm_package_version ?? "0.1.0",
v1.3.0:236  version: process.env.APP_VERSION || "desconhecido",
HEAD  :236  version: process.env.APP_VERSION || "desconhecido",
```

**Sugestão:** **Por que não basta olhar o `/api/v1/health`:** numa instalação afetada (app ≤ 1.2.1) ele lê `npm_package_version`, que é `undefined` sob `CMD ["node","server.js"]` — então responde `0.1.0` esteja ela afetada ou não. Foi medido na produção. **Desde a 1.3.0** o campo vem de `APP_VERSION` (injetada no build) e o fallback é `desconhecido`, nunca um número plausível — por isso ele serve como conferência **depois** da remediação (A4), mas nunca como diagnóstico **antes**.

### L134 · FALSA · gravidade alta · sobre-o-codigo

> backup do banco antes, `baseline.sql` idempotente, healthcheck no fim, e rollback automático do app se ele não voltar.

**Mede com:**

```bash
sed -n '250,270p' hostgator-setup-kit/update.sh; grep -n 'set_env_var .env APP_IMAGE "$PREV_IMAGE"' hostgator-setup-kit/agent.sh
```

**Deu:**

```
update.sh:264  c_ylw "⚠ Atualizei, mas o app não respondeu 'ok'. Veja os logs:"
update.sh:266  # Código de saída != 0: é o que o agent.sh usa pra saber que precisa voltar
update.sh:269  exit 1
agent.sh:299        set_env_var .env APP_IMAGE "$PREV_IMAGE"
```

**Sugestão:** A Rota A é mais longa e é o caminho que o `update.sh` já percorre em toda atualização: backup do banco antes, `baseline.sql` idempotente e healthcheck no fim. **O rollback automático NÃO é do `update.sh`** — executado à mão ele só sai com código 1 se o app não voltar; quem guarda a imagem anterior e reverte é o `agent.sh` (o caminho do botão da tela). Rodando o `update.sh` à mão, o rollback é o manual do A3. (O próprio §5, passo A3, já diz isto — este parágrafo é que discordava dele.)

### L283 · FALSA · gravidade media · contagem

> O `update.sh` mexe em exatamente três chaves do `.env` (`APP_IMAGE`, `APP_PULL_POLICY` e — desde esta versão — as do worker e do scheduler)

**Mede com:**

```bash
grep -n -A 13 '^gravar_imagens()' hostgator-setup-kit/_common.sh; grep -n 'ensure_encryption_key\|NUVEMSHOP_OAUTH_ENCRYPTION_KEY' hostgator-setup-kit/update.sh hostgator-setup-kit/_common.sh
```

**Deu:**

```
_common.sh:495-500  set_env_var … APP_IMAGE / APP_PULL_POLICY / WORKER_IMAGE / WORKER_PULL_POLICY / SCHEDULER_IMAGE / SCHEDULER_PULL_POLICY   → 6 chaves
update.sh:274  ensure_encryption_key .env
_common.sh:638  printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$envfile"   → 7ª chave possível
```

**Sugestão:** O `update.sh` reescreve **seis** chaves de imagem no `.env` — `APP_IMAGE`, `APP_PULL_POLICY`, `WORKER_IMAGE`, `WORKER_PULL_POLICY`, `SCHEDULER_IMAGE`, `SCHEDULER_PULL_POLICY` (todas em `gravar_imagens`, `hostgator-setup-kit/_common.sh`) — e acrescenta `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` se ela faltar. Todo o resto fica intacto, inclusive o que o operador acrescentou à mão. Confira sem depender deste número: `diff /root/.env.antes-remediacao .env`.

**Vira teste:** tests/unit/packaging-artefato-do-cliente.test.ts: extrair as chaves que `gravar_imagens` grava em `_common.sh` e assertar `expect(chaves).toEqual(['APP_IMAGE','APP_PULL_POLICY','WORKER_IMAGE','WORKER_PULL_POLICY','SCHEDULER_IMAGE','SCHEDULER_PULL_POLICY'])` — quem acrescentar a quarta imagem reprova e vai atualizar o runbook.

### L286 · FALSA · gravidade media · pendencia

> **O `diff` do A5 é o que prova isso, e é uma das coisas que o U6-b precisa confirmar.**

**Mede com:**

```bash
sed -n '290,312p' docs/runbooks/remediar-worker-congelado.md; sed -n '372,376p' docs/runbooks/remediar-worker-congelado.md
```

**Deu:**

```
§6 (mesmo arquivo): "| customização do operador no `.env` | presente | **presente** | ✅ |"
P4 (mesmo arquivo): "**nenhuma** chave do `.env` sumiu (39 → 43: as 4 novas são as de imagem)"
```

**Sugestão:** **O `diff` do A5 é o que prova isso, e já foi confirmado duas vezes:** no U6-b a customização do operador sobreviveu ao ciclo (§6) e, na execução real, nenhuma chave do `.env` sumiu (39 → 43 — as 4 novas são as de imagem).

### L345 · FRAGIL · gravidade baixa · data-versao

> `revision=9bd59e93`, `version=1.3.0` — o digest bate com o da release

**Mede com:**

```bash
docker buildx imagetools inspect ghcr.io/melgarafael/deskcomm-worker:stable 2>&1 | awk '/^Digest:/{print $2;exit}'; docker buildx imagetools inspect ghcr.io/melgarafael/deskcomm-worker:1.3.0 2>&1 | awk '/^Digest:/{print $2;exit}'; git rev-parse v1.3.0^{commit}
```

**Deu:**

```
stable → sha256:3fe292cad2bd8aa6ed0182e67a7bafd6e857e0fff14cedcb53694254dca0ef95
1.3.0  → sha256:81e5af567cc8b72b6e0aa75295029b0c5b51d35d49a242827574a77b3c1b5cca
git    → 9bd59e9361811ad1609969a9887fa46e84db343d  (= label revision das DUAS imagens)
```

**Sugestão:** `revision=9bd59e93`, `version=1.3.0` — **a revision bate com o commit da tag `v1.3.0`** (`git rev-parse v1.3.0^{commit}` → `9bd59e9361811ad1…`), que é o que prova identidade de conteúdo. O digest do índice de `:stable` e o de `:1.3.0` são **diferentes** (pushes distintos do mesmo conteúdo), então comparar digest entre tags mede a coisa errada.

### L419 · FALSA · gravidade alta · data-versao

> As duas tags apontam para a **mesma imagem**. Aplicar o pin hoje não muda um byte do que roda

**Mede com:**

```bash
for t in latest latest-2026.7.2; do printf 'devlikeapro/waha:%-18s -> ' "$t"; docker buildx imagetools inspect devlikeapro/waha:$t 2>&1 | awk '/^Digest:/{print $2; exit}'; done; docker buildx imagetools inspect devlikeapro/waha:latest --format '{{json .Image}}' | head -c 60
```

**Deu:**

```
devlikeapro/waha:latest             -> sha256:d52ad4f394d2e48eb92d58e0f04924ff6c7621a883d08ff64176479ecd77c9ca
devlikeapro/waha:latest-2026.7.2    -> sha256:65e593e30bb702f891550b9da5d65e9e0eff8a926f5451fac6a582db84d3a323
{ "created": "2026-08-14T12:14:01.705395726Z", ...
```

**Sugestão:** **Ainda não consertado — e a janela FECHOU.** O upstream publicou uma `:latest` nova em 2026-08-14T12:14Z, e as duas tags deixaram de apontar para a mesma imagem. Meça antes de decidir, em vez de confiar neste parágrafo:  ```bash for t in latest latest-2026.7.2; do   printf 'devlikeapro/waha:%s -> ' "$t"   docker buildx imagetools inspect devlikeapro/waha:$t | awk '/^Digest:/{print $2; exit}' done ```  Enquanto os digests forem **iguais**, aplicar o pin é só um restart do WAHA — a string muda, o `config-hash` muda, o conteúdo não. Quando forem **diferentes** — como estão agora —, o próximo `update.sh` de qualquer instalação legada TROCA a versão do WhatsApp sem ninguém pedir, porque `dc pull` sem argumento inclui o `waha`.

### L435 · FALSA · gravidade alta · data-versao

> Um restart do WhatsApp, não uma troca de versão.

**Mede com:**

```bash
docker buildx imagetools inspect devlikeapro/waha:latest 2>&1 | awk '/^Digest:/{print $2; exit}'
```

**Deu:**

```
sha256:d52ad4f394d2e48eb92d58e0f04924ff6c7621a883d08ff64176479ecd77c9ca  (≠ latest-2026.7.2 = sha256:65e593e30bb7…)
```

**Sugestão:** O custo real de aplicar o pin tem duas partes, e a segunda mudou de sinal. (1) Mudar a **string** da imagem muda o `config-hash` do serviço, então o `up -d` recria o contêiner mesmo com digest idêntico — isso continua valendo, e está medido abaixo. (2) Desde 2026-08-14 os digests **não** são mais idênticos: aplicar o pin numa instalação legada agora TROCA a versão do WAHA, não só reinicia. **NÃO MEDIDO:** se uma sessão pareada volta `WORKING` depois de um restart — e menos ainda depois de uma troca de versão.

### L439 · FALSA · gravidade alta · ponteiro

> o enquadramento e as opções estão na issue do resíduo.

**Mede com:**

```bash
gh issue list --state all --limit 100 --json number,title | grep -i 'waha\|resíduo\|residuo\|pin'; gh issue list --state all --search 'created:>=2026-08-12' --json number,title
```

**Deu:**

```
nenhuma issue com WAHA/resíduo/pin no título; as 5 issues criadas desde 2026-08-12 são #235-#239 (Tailwind 4, pdf-parse, Zod em webhooks, credencial de canal, AGENTS.md) — nenhuma sobre o resíduo do WAHA
```

**Sugestão:** Segue não consertado porque a decisão é de quem opera. **Não existe issue aberta sobre isto** — quem for decidir abre uma primeiro, com as duas opções (reescrever `WAHA_IMAGE` no `.env` legado × deixar como está) e o custo medido de cada uma, e substitui esta frase pelo número dela.

**Vira teste:** tests/unit/evidencia-citada.test.ts (mesmo molde): varrer `docs/**/*.md` por referências a issue sem número ("a issue do …", "na issue de …") e reprovar — ponteiro sem alvo nomeável não é ponteiro.

### L460 · FRAGIL · gravidade media · sobre-o-codigo

> Nada aqui roda sozinho. Não existe atualização automática nem compulsória: o agente de atualização da tela só age quando alguém clica em "Atualizar agora"

**Mede com:**

```bash
grep -n 'PIN_CORRIGIDO=\|update_requested' hostgator-setup-kit/agent.sh; grep -n -A 5 '^completar_pin_ausente()' hostgator-setup-kit/_common.sh
```

**Deu:**

```
agent.sh:180  PIN_CORRIGIDO="$(completar_pin_ausente .env)" || PIN_CORRIGIDO=""     ← roda ANTES do heartbeat, sem clique
agent.sh:196  [ "$(json_field "$RESP" update_requested)" = "true" ] || exit 0   ← só o update.sh depende do clique
_common.sh:470  set_env_var "$envfile" "$chave" "${IMG_NS}/${repo}:${ver}"
```

**Sugestão:** Nada aqui **atualiza** sozinho: não existe atualização automática nem compulsória — o `update.sh` só roda quando alguém o executa, e o agente da tela só o dispara quando alguém clica em "Atualizar agora". A única escrita que o agente faz por conta própria é fechar a lacuna do pin (§5.0, item 2): se `WORKER_IMAGE`/`SCHEDULER_IMAGE` estiverem **ausentes**, ele grava a versão que o contêiner já roda. Valor que já existe no `.env` ele nunca toca.


# RETRATO — 60 achados


## `docs/current-state.md` — 40

### L5 · FALSA · gravidade media · data-versao

> last_updated: 2026-07-29

**Mede com:**

```bash
git log -1 --format='%ad' --date=short -- docs/current-state.md
```

**Deu:**

```
2026-08-14
```

**Sugestão:** `last_updated: 2026-08-14` — e, já que o corpo carrega blocos datados de 2026-08-13 e 2026-08-14 enquanto o frontmatter dizia 2026-07-29, vale a nota: o frontmatter é prazo de validade, e um que mente contra o próprio corpo é pior que nenhum. Régua: `git log -1 --format=%ad --date=short -- docs/current-state.md`.

**Vira teste:** tests/unit: o `last_updated` do frontmatter de docs/current-state.md e docs/harness-audit.md não pode ser anterior à data do último commit que tocou o arquivo.

### L8 · FALSA · gravidade media · data-versao

> audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)

**Mede com:**

```bash
git log --oneline -1; grep -m2 -E '^## \[[0-9]' CHANGELOG.md
```

**Deu:**

```
840917ed Merge pull request #251 from melgarafael/fix/canal-stable-divergente
## [1.3.0] — 2026-08-13
```

**Sugestão:** `audited_against: origin/main @ 840917ed (v1.3.0, 2026-08-13)` — e cada bloco que for remedido depois carrega o próprio SHA inline, como o §4.1 já faz. Um `audited_against` global num doc emendado em cinco datas diferentes descreve só a primeira.

### L33 · FALSA · gravidade media · data-versao

> **Versão:** `1.0.0`, marcada em 2026-07-27 (`CHANGELOG.md`). Primeira release versionada

**Mede com:**

```bash
grep -nE '^## ' CHANGELOG.md | head -4
```

**Deu:**

```
9:## [Não lançado]
11:## [1.3.0] — 2026-08-13
72:## [1.2.1] — 2026-08-12
117:## [1.2.0] — 2026-08-11
```

**Sugestão:** **Versão:** a última release está no topo do `CHANGELOG.md` (`grep -m2 -E '^## \[[0-9]' CHANGELOG.md`). A primeira release versionada foi a `1.0.0`, em 2026-07-27; o projeto vinha sendo desenvolvido publicamente desde abril de 2026 sem tags.

### L38 · FALSA · gravidade media · contagem

> | Arquivos TS/TSX em `app`+`lib`+`components`+`workers` | 987 |

**Mede com:**

```bash
find app lib components workers -name '*.ts' -o -name '*.tsx' | wc -l
```

**Deu:**

```
1305
```

**Sugestão:** Trocar a coluna "Valor" por "Régua": `find app lib components workers -name '*.ts' -o -name '*.tsx' \| wc -l`. Um doc que diz como contar não apodrece; um que diz o total apodrece no próximo merge — esta tabela inteira envelheceu num intervalo de duas semanas.

### L39 · FALSA · gravidade media · contagem

> | Route handlers (`app/api/**/route.ts`) | 169 |

**Mede com:**

```bash
find app/api -name 'route.ts' | wc -l
```

**Deu:**

```
203
```

**Sugestão:** | Route handlers | `find app/api -name 'route.ts' \| wc -l` |

### L40 · FALSA · gravidade media · contagem

> | Migrations em `supabase/migrations/` | 81 arquivos, até `0092_stage_names_acentos` |

**Mede com:**

```bash
ls supabase/migrations/*.sql | wc -l; ls supabase/migrations/*.sql | tail -1
```

**Deu:**

```
147
supabase/migrations/20260814090000_0157_marca_por_organizacao.sql
```

**Sugestão:** | Migrations | `ls supabase/migrations/*.sql \| wc -l`; a última é `ls supabase/migrations/*.sql \| tail -1` |

### L41 · FALSA · gravidade media · contagem

> | Testes unitários (`*.test.ts(x)`) | 221 arquivos |

**Mede com:**

```bash
git ls-files | grep -cE '\.test\.(ts|tsx)$'
```

**Deu:**

```
511
```

**Sugestão:** | Testes (`*.test.ts(x)`) | `git ls-files \| grep -cE '\\.test\\.(ts\|tsx)$'` |

### L42 · FALSA · gravidade media · contagem

> | Invariantes de banco (`tests/invariants/`) | 56 arquivos |

**Mede com:**

```bash
ls tests/invariants/*.test.ts | wc -l; ls tests/invariants/*.ts | wc -l
```

**Deu:**

```
103 (arquivos .test.ts)
107 (todos .ts)
```

**Sugestão:** | Invariantes de banco | `ls tests/invariants/*.test.ts \| wc -l` — e declare a régua junto, porque "arquivos" e "casos" divergem por uma ordem de grandeza (o `CLAUDE.md` cita casos) |

### L43 · FALSA · gravidade media · contagem

> | Specs E2E (`tests/e2e/`) | 19 |

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l
```

**Deu:**

```
48
```

**Sugestão:** | Specs E2E | `ls tests/e2e/*.spec.ts \| wc -l` — este número já apodreceu quatro vezes; nunca copie de outro doc |

### L44 · FALSA · gravidade media · contagem

> | Documentos `.md` em `docs/` | 119 (em 23 subpastas) |

**Mede com:**

```bash
git ls-files docs | grep -c '\.md$'; find docs -mindepth 1 -maxdepth 1 -type d | wc -l
```

**Deu:**

```
161
20 subpastas de 1º nível (30 contando aninhadas)
```

**Sugestão:** | Documentos `.md` em `docs/` | `git ls-files docs \| grep -c '\.md$'` — e declare a régua: `docs/index.md` usa `git ls-files 'docs/**/*.md'`, que **não** conta os `.md` do topo de `docs/` e devolve um número menor |

### L45 · NAO_VERIFICAVEL · gravidade media · contagem

> | Import cycles | **0** (graphify, medido em árvore anterior) |

**Mede com:**

```bash
ls -d graphify-out
```

**Deu:**

```
ls: graphify-out: No such file or directory — o artefato que produziu o número não está no repo, e o próprio texto admite "árvore anterior"
```

**Sugestão:** Remover a linha da tabela. O número veio de um `graphify-out/` que não existe mais neste repo e de uma árvore que não é esta; "0 ciclos medido noutra árvore" não é dado sobre o HEAD. Se o invariante importa, ele vira gate (`madge --circular` num step do `verify`), não linha de tabela.

**Vira teste:** CI: `npx madge --circular --extensions ts,tsx app lib components workers` reprovando em ciclo novo — aí o doc pode dizer "zero, e o gate garante".

### L47 · FALSA · gravidade baixa · contagem

> | `: any` / `as any` | 7 |

**Mede com:**

```bash
grep -rnE "(: any\b|as any\b)" app lib components workers --include='*.ts' --include='*.tsx' | wc -l
```

**Deu:**

```
12
```

**Sugestão:** | `: any` / `as any` | `grep -rnE '(: any\\b\|as any\\b)' app lib components workers --include='*.ts' --include='*.tsx' \| wc -l` |

### L54 · FALSA · gravidade media · contagem

> o apêndice idempotente de `baseline.sql` cobre até `migration 0092`, que é a última em `supabase/migrations/`

**Mede com:**

```bash
grep -oE 'migration [0-9]{4}' supabase/baseline.sql | sort -u | tail -3; ls supabase/migrations/*.sql | tail -1
```

**Deu:**

```
migration 0155 / migration 0156 / migration 0157
supabase/migrations/20260814090000_0157_marca_por_organizacao.sql
```

**Sugestão:** o apêndice idempotente de `baseline.sql` cobre até a **última** migration de `supabase/migrations/` — o invariante segue de pé. Confira sem citar número: `diff <(grep -oE 'migration [0-9]{4}' supabase/baseline.sql | sort -u | tail -1) <(ls supabase/migrations/*.sql | tail -1 | grep -oE '_[0-9]{4}_' | tr -d _ | sed 's/^/migration /')`.

**Vira teste:** tests/invariants: a maior migration de supabase/migrations/ tem apêndice correspondente no baseline.sql. É o invariante que o próprio parágrafo diz ser o mais fácil de quebrar.

### L66 · FALSA · gravidade media · sobre-o-codigo

> **Fundação & plataforma** — auth com MFA para admin, multi-tenancy com RLS + teste de isolamento

**Mede com:**

```bash
grep -n 'export function' lib/auth/politica-mfa.ts
```

**Deu:**

```
67:export function exigeCadastroDeMfa(p: PoliticaDeMfa): boolean;
81:export function empresaExigeMfa(settings: unknown): boolean — a política soma platform_admins.mfa_required e organizations.settings.security.mfa_required, ambas com padrão NÃO exigir
```

**Sugestão:** **Fundação & plataforma** — auth com MFA TOTP **opcional e ligado por quem administra** (duas políticas independentes que somam, ambas com padrão não-exigir; regra em `lib/auth/politica-mfa.ts`), multi-tenancy com RLS + teste de isolamento, RBAC de 4 papéis, audit log append-only, onboarding de tenant.

### L97 · FALSA · gravidade media · pendencia

> | **Follow-up inteligente** (`HANDOFF.md`) | Ondas 1–7 ✅; Onda 8 **em andamento** […] | gatilho `stage_change`, flywheel, e o fechamento do checklist DoD/PRD da 8.3 |

**Mede com:**

```bash
ls tests/e2e/gatilho-de-etapa.spec.ts tests/e2e/gatilho-de-caso.spec.ts
```

**Deu:**

```
tests/e2e/gatilho-de-etapa.spec.ts
tests/e2e/gatilho-de-caso.spec.ts — ambas nas listas de execução do e2e.yml (linha 128)
```

**Sugestão:** O gatilho de mudança de etapa deixou de ser pendência: `tests/e2e/gatilho-de-etapa.spec.ts` existe e roda no `e2e.yml`. Reescreva a linha listando só o que ainda falta (flywheel e o fechamento do checklist da 8.3), ou — melhor — troque a coluna "o que falta" por ponteiro ao HANDOFF, porque tabela de progresso num doc separado do épico apodrece por construção.

### L100 · NAO_VERIFICAVEL · gravidade media · pendencia

> | **Casos humanos** […] | Wave 7 (prova E2E) relatada PARCIAL […] | **A CONFIRMAR** se fechou |

**Sugestão:** As quatro entradas "A CONFIRMAR" da tabela §3 (Casos humanos, Inbox multimodal ondas 4–6, Fase FG, credencial Anthropic/Google) estão pendentes desde 2026-07-29 e nenhuma tem régua declarada. Ou cada uma ganha um comando que a responde, ou saem da tabela e viram issue com dono — "A CONFIRMAR" sem instrumento é pendência que ninguém pode fechar, e é o estado mais podre que um doc de estado pode carregar.

### L112 · FALSA · gravidade alta · pendencia

> **transbordo de layout a 390px em qualquer tela** e **não existe caminho de criação de funil** (só de etapas).

**Mede com:**

```bash
ls tests/e2e/pipelines-gestao.spec.ts docs/architecture/gestao-funis.architecture.json
```

**Deu:**

```
tests/e2e/pipelines-gestao.spec.ts
docs/architecture/gestao-funis.architecture.json
```

**Sugestão:** O achado de **criação de funil** foi endereçado: a gestão de funis pela tela existe, com mapa vivo (`docs/architecture/gestao-funis.architecture.json`) e spec E2E (`tests/e2e/pipelines-gestao.spec.ts`) que roda no `e2e.yml`. Continua registrado e **não** endereçado apenas o **transbordo de layout a 390px**, que é bug de primeira impressão em mobile.

### L147 · FALSA · gravidade alta · contagem

> `e2e.yml` roda **45 das 46 specs**, e o `e2e` **é check obrigatório** na branch protection desde 2026-08-08 (junto com `verify`, `build-and-size`, `invariants` e `imagens-ok` — **cinco**)

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l; awk '/SPECS_PARTE_1:/,/FORA_DO_CI:/' .github/workflows/e2e.yml | grep -v '^ *#' | grep -oE '[a-z0-9-]+\.spec\.ts' | wc -l; gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
48
47
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** `e2e.yml` roda **todas as specs menos uma**, e o `e2e` **é check obrigatório** na branch protection (junto com `verify`, `build-and-size`, `invariants` e `imagens-ok` — **cinco**). A única fora é `vps-fresh-onboarding`. Não copie o número daqui: `ls tests/e2e/*.spec.ts | wc -l` contra o `FORA_DO_CI` de `.github/workflows/e2e.yml`; a soma é conferida por `tests/unit/e2e-cobertura-completa.test.ts`. Este número já apodreceu **quatro** vezes — a quarta foi esta linha, escrita em 2026-08-14 e errada em dois dias.

### L163 · FALSA · gravidade media · contagem

> aplica `baseline.sql` em modo install e update, e roda os 56 arquivos de `tests/invariants/`

**Mede com:**

```bash
ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
103
```

**Sugestão:** aplica `baseline.sql` em modo install e update, e roda **todos** os arquivos de `tests/invariants/` (`ls tests/invariants/*.test.ts | wc -l`). Esse buraco está fechado.

### L165 · FALSA · gravidade media · contagem

> O que continua fora (2026-08-14): **1 das 46 specs Playwright**.

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l; grep -n 'FORA_DO_CI' -A2 .github/workflows/e2e.yml | tail -2
```

**Deu:**

```
48
      FORA_DO_CI: >-
        vps-fresh-onboarding.spec.ts
```

**Sugestão:** O que continua fora: **uma** spec Playwright — a `vps-fresh-onboarding.spec.ts`, a jornada que a doutrina de QA Visual classifica como o caminho mais crítico do produto, porque exige WAHA + Redis + Resend + Nuvemshop no runner. O total do disco muda toda semana; conte na hora (`ls tests/e2e/*.spec.ts | wc -l`).

### L174 · FALSA · gravidade baixa · ponteiro

> `vitest.config.ts:12` exclui `tests/invariants/**` e `tests/e2e/**` do `test:unit`.

**Mede com:**

```bash
grep -n 'invariants\|tests/e2e\|tests/journeys\|exclude' vitest.config.ts
```

**Deu:**

```
25:    exclude: [
30:      "tests/e2e/**",
31:      "tests/invariants/**",
32:      "tests/journeys/**"  — a linha 12 é comentário sobre testTimeout
```

**Sugestão:** O bloco `exclude` de `vitest.config.ts` tira `tests/e2e/**`, `tests/invariants/**` e `tests/journeys/**` do `test:unit` (`grep -n 'exclude' -A6 vitest.config.ts`). Número de linha em ponteiro envelhece a cada edição do arquivo — cite o símbolo, não a linha.

### L179 · FALSA · gravidade media · sobre-o-codigo

> `gov:verify` = `typecheck && lint && test:unit`. Omite `test:db` e `test:e2e`.

**Mede com:**

```bash
node -e "console.log(require('./package.json').scripts['gov:verify'])"; grep -n 'name: ' .github/workflows/ci.yml | head -8
```

**Deu:**

```
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit
— e o job `verify` do ci.yml roda CINCO passos: Typecheck, Lint, Channel provider leak, Unit tests, Kit self-host (bash / pnpm test:shell)
```

**Sugestão:** `gov:verify` = `typecheck && lint && lint:channels && test:unit`. Omite `test:db`, `test:e2e` **e `test:shell`** — este último é o único gate que exercita o `update.sh` do kit self-host, e o job `verify` do CI o roda. Ou seja: `gov:verify` verde é mais fraco que o próprio check `verify`. Um agente que trate `gov:verify` verde como "pronto" vai declarar concluída uma mudança de schema sem nunca ter testado RLS, e uma mudança de kit sem nunca ter rodado o instalador. Régua: `node -e "console.log(require('./package.json').scripts['gov:verify'])"`.

**Vira teste:** tests/unit: assertar que todo passo `run: pnpm <script>` do job verify do ci.yml está contido em gov:verify — ou que o doc declara a diferença.

### L187 · FALSA · gravidade alta · contagem

> `checkRateLimit` (`lib/ai/dispatcher/rate-limit.ts`) é chamado em **2** lugares: o webhook público de captação e o dispatcher de IA.

**Mede com:**

```bash
grep -rn "checkRateLimit" app lib workers --include='*.ts' | grep -v '\.test\.' | grep -v '^lib/ai/dispatcher/rate-limit.ts'
```

**Deu:**

```
app/api/v1/webhooks/in/[token]/route.ts:58 · lib/auth/rate-limit.ts:89, :94, :165 · lib/ai/dispatcher/index.ts:298 — 3 módulos de produção, 5 chamadas
```

**Sugestão:** `checkRateLimit` (`lib/ai/dispatcher/rate-limit.ts`) é chamado por três módulos de produção: o webhook público de captação, o dispatcher de IA e `lib/auth/rate-limit.ts` (que o aplica a login, signup, recuperação de senha e aceite de convite). Reconte antes de citar: `grep -rn "checkRateLimit" app lib workers --include='*.ts' | grep -v '\.test\.'`.

### L188 · FALSA · gravidade alta · ativo-obrigatorio

> Sem proteção: `/login`, `/signup`, `/team/accept-invite/:token`, os crons, `/api/internal/*`, `/api/mcp`, webhooks WAHA e Nuvemshop.

**Mede com:**

```bash
grep -rn "auth/rate-limit" app lib --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

**Deu:**

```
app/team/accept-invite/[token]/page.tsx:14:import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
app/actions/auth/requestPasswordReset.ts:8:import { authRateLimited, AUTH_LIMITS }...
app/actions/auth/signUp.ts:14:import { authRateLimited, AUTH_LIMITS }...
app/actions/auth/signInWithPassword.ts:16:} from "@/lib/auth/rate-limit";
```

**Sugestão:** Sem proteção: os crons, `/api/internal/*`, `/api/mcp`, webhooks WAHA e Nuvemshop. Já protegidos por `lib/auth/rate-limit.ts` (que embrulha o `checkRateLimit` com limite por IP **e** por identidade): `/login`, `/signup`, `/team/accept-invite/:token` e o pedido de recuperação de senha. Régua: `grep -rn "auth/rate-limit" app lib --include='*.ts' | grep -v '\.test\.'`.

**Vira teste:** tests/unit: para cada rota da lista "sem proteção", assertar que o módulo NÃO importa lib/auth/rate-limit — e o inverso para as protegidas. Assim a lista não pode ficar mentindo sem reprovar.

### L193 · FALSA · gravidade alta · sobre-o-codigo

> ### 4.4 `node_modules` deste checkout está incompleto 🟠  70 pacotes, sem `typescript` — `pnpm typecheck` falha com `MODULE_NOT_FOUND`.

**Mede com:**

```bash
ls -la node_modules/typescript | head -1; node_modules/.bin/tsc --version
```

**Deu:**

```
node_modules/typescript -> .pnpm/typescript@6.0.3/node_modules/typescript
Version 6.0.3
```

**Sugestão:** Remover a seção 4.4. Ela descrevia o disco de uma sessão de auditoria, não o projeto: neste checkout `node_modules/typescript` resolve para 6.0.3 e `node_modules/.bin/tsc --version` responde. Estado de `node_modules` é propriedade da máquina de quem lê, não achado do repositório — se voltar a faltar, o conserto é `pnpm install`, não uma linha de doc.

### L200 · FALSA · gravidade alta · pendencia

> 6 variáveis declaradas em `lib/env.ts` e ausentes do template — incluindo **três secrets**: `IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY`

**Mede com:**

```bash
for v in IMPERSONATE_COOKIE_SECRET INTERNAL_CRON_SECRET LGPD_SIGNING_KEY LGPD_DPO_EMAIL LGPD_EXPORT_EXPIRES_HOURS NUVEMSHOP_ENABLED; do printf "%s env.ts=%s .env.example=%s\n" $v $(grep -c $v lib/env.ts) $(grep -c $v .env.example); done
```

**Deu:**

```
IMPERSONATE_COOKIE_SECRET env.ts=3 .env.example=1
INTERNAL_CRON_SECRET env.ts=1 .env.example=1
LGPD_SIGNING_KEY env.ts=1 .env.example=1
LGPD_DPO_EMAIL env.ts=1 .env.example=1
LGPD_EXPORT_EXPIRES_HOURS env.ts=1 .env.example=1
NUVEMSHOP_ENABLED env.ts=3 .env.example=1
```

**Sugestão:** ### 4.5 ✅ `.env.example` — reconciliado  As 6 variáveis que faltavam (incluindo os três secrets `IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET` e `LGPD_SIGNING_KEY`) estão hoje no template. Fica registrado como fechado, não como pendência. Régua para reconferir: `for v in $(grep -oE '[A-Z_]{6,}' lib/env.ts | sort -u); do grep -q "$v" .env.example || echo "ausente: $v"; done`.  Inverso, e ainda aberto: `FLYWHEEL_*` e `WATCHDOG_*` estão no template (comentados) e não em `lib/env.ts` — lidos direto de `process.env`, portanto sem validação Zod.

**Vira teste:** tests/unit: toda var referenciada em lib/env.ts aparece em .env.example. É a única forma de o item 9 do DoD parar de apodrecer.

### L212 · FALSA · gravidade baixa · data-versao

> Corrigidas nesta auditoria: dizia Next.js 15 (é 16.2)

**Mede com:**

```bash
node -e "console.log(require('./package.json').dependencies.next)"
```

**Deu:**

```
^16.3.0
```

**Sugestão:** Corrigidas nesta auditoria: dizia Next.js 15 (a versão real está em `package.json → dependencies.next`), "rate limit sliding window" (é fixed-window) e "`Idempotency-Key` para POSTs de criação" (existe em **1** rota). Citar a minor de um framework num doc de estado é garantir que ele erre no próximo `pnpm up`.

### L225 · FALSA · gravidade baixa · contagem

> a evidência vive em `evidence/` (85, contando as subpastas), `docs/evidence/` (18) e `loop/checkpoints/evidence/` (13) — **116** no total.

**Mede com:**

```bash
git ls-files -- '*.png' | grep -v / | wc -l; git ls-files evidence | grep -c '\.png$'; git ls-files docs/evidence | grep -c '\.png$'; git ls-files loop/checkpoints/evidence | grep -c '\.png$'
```

**Deu:**

```
0 (PNGs na raiz)
239 (evidence/)
18 (docs/evidence/)
13 (loop/checkpoints/evidence/)
```

**Sugestão:** hoje há **zero** PNGs rastreados na raiz (`git ls-files -- '*.png' | grep -v / | wc -l`) — a evidência vive em `evidence/`, `docs/evidence/` e `loop/checkpoints/evidence/`. Os totais crescem a cada sessão de QA; conte na hora em vez de citar.

**Vira teste:** tests/unit ou CI: `git ls-files -- '*.png' | grep -v /` tem que devolver vazio. A raiz limpa vira gate em vez de nota.

### L228 · FALSA · gravidade media · contagem

> Restam 3 na raiz (`HANDOFF.md`, `-harness-evolution`, `-operacao-visivel`), o que é consistente com "épico vivo fica visível, épico encerrado é arquivado".

**Mede com:**

```bash
ls HANDOFF*.md
```

**Deu:**

```
HANDOFF-conversa-vira-lead.md HANDOFF-followup-vivo.md HANDOFF-fv-w1-fila.md HANDOFF-harness-evolution.md HANDOFF-ia-360.md HANDOFF-marca-propria.md HANDOFF-operacao-visivel.md HANDOFF-sistema-vivo-consertos.md HANDOFF-tres-papeis.md HANDOFF.md — 10 arquivos
```

**Sugestão:** Hoje são **dez** HANDOFFs na raiz (`ls HANDOFF*.md | wc -l`) contra dois arquivados em `docs/handoffs/`. A regra "épico vivo fica visível, épico encerrado é arquivado" deixou de ser descrição e virou intenção: a raiz acumula épicos encerrados (`ia-360`, `marca-propria`, `tres-papeis`, `followup-vivo`…) sem ninguém mover. É pendência, não conformidade.

### L234 · FALSA · gravidade media · contagem

> mas o repo já tem migrations até **0092**. São 34 migrations de deriva.

**Mede com:**

```bash
grep -n '0058\|Migration seguinte' HANDOFF.md | head -2; ls supabase/migrations/*.sql | tail -1
```

**Deu:**

```
33:- **Migration seguinte livre:** 0058.
supabase/migrations/20260814090000_0157_marca_por_organizacao.sql
```

**Sugestão:** `HANDOFF.md:33` ainda afirma "Migration seguinte livre: **0058**" — e o repo já passou de **0157** (`ls supabase/migrations/*.sql | tail -1`). A deriva quase triplicou desde a medição anterior, o que reforça a regra em vez de enfraquecê-la: **HANDOFF não é fonte da verdade de schema** — `supabase/migrations/` e `baseline.sql` são.

### L244 · FALSA · gravidade media · contagem

> **89 dos 169 handlers usam `createAdminClient`** (service role, bypassa RLS).

**Mede com:**

```bash
grep -rl 'createAdminClient' app/api --include='route.ts' | wc -l; find app/api -name route.ts | wc -l
```

**Deu:**

```
119
203
```

**Sugestão:** **Mais da metade dos handlers usa `createAdminClient`** (service role, bypassa RLS) — régua: `grep -rl 'createAdminClient' app/api --include='route.ts' | wc -l` sobre `find app/api -name route.ts | wc -l`. A regra "filtre `organization_id` manualmente, nunca do body" não tem *enforcement automático* na escrita. Os invariantes cobrem isolamento a sério e **rodam em CI** (`invariants` é check obrigatório), o que mitiga muito; o que falta é o gate que impede um handler novo de nascer errado.

**Vira teste:** lint rule ou teste de diff: route.ts novo que importa createAdminClient e não referencia organization_id reprova. É o gate que o próprio parágrafo diz faltar.

### L253 · FALSA · gravidade baixa · ponteiro

> `Dockerfile:55` faz `apk add --no-cache ffmpeg`

**Mede com:**

```bash
grep -n 'ffmpeg' Dockerfile
```

**Deu:**

```
69: # ffmpeg: a derivação de vídeo (Onda 3.1) roda no processo do app — o cron
72: RUN apk add --no-cache ffmpeg
```

**Sugestão:** o `Dockerfile` faz `apk add --no-cache ffmpeg` (`grep -n ffmpeg Dockerfile`), com comentário explicando que a derivação de vídeo roda no processo do app via o cron `event-log-drain`. Registrado como fechado.

### L258 · NAO_VERIFICAVEL · gravidade media · pendencia

> **Dependência de credencial de terceiro para provar IA**: se Anthropic segue com credencial placeholder e Google com chave de gateway inválida […] **A CONFIRMAR** se ainda vale.

**Sugestão:** Estado de credencial vive fora do repo; nenhum comando do checkout responde. Substituir por ponteiro ao lugar onde a resposta mora (painel de provedores, coberto por `tests/e2e/prova-painel-provedores.spec.ts`) e uma data de última verificação — ou remover do doc e virar issue. Risco sem instrumento de medição não é risco rastreado, é lembrete.

### L259 · FALSA · gravidade media · contagem

> **`lib/agent-engine/agent/inbound-turn.ts` com 1789 linhas** — 2,4× o segundo maior arquivo de lógica (`AgentForm.tsx`, 746)

**Mede com:**

```bash
find app lib components workers -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | head -5
```

**Deu:**

```
7023 lib/database.types.ts (gerado)
2449 lib/agent-engine/agent/inbound-turn.ts
1318 lib/followup/graph-schema.test.ts
960 app/app/ai/agents/[id]/_components/AgentForm.tsx
959 lib/agent-engine/guardrails/before-send.ts
```

**Sugestão:** **`lib/agent-engine/agent/inbound-turn.ts` é o maior arquivo de lógica escrita à mão do repo** (o único maior é `lib/database.types.ts`, gerado) e é o hot path do produto. Cresceu ~660 linhas desde a primeira medição desta auditoria — e o crescimento é o dado, não o total. Régua: `find app lib components workers -name '*.ts' -o -name '*.tsx' | xargs wc -l | sort -rn | head -5`.

### L266 · FALSA · gravidade baixa · contagem

> Os 14 crons do produto são agendados exclusivamente pelo `crond` do serviço `scheduler`

**Mede com:**

```bash
ls app/api/v1/cron/ | wc -l; ls -d vercel.json
```

**Deu:**

```
16
ls: vercel.json: No such file or directory
```

**Sugestão:** Os crons do produto (`ls app/api/v1/cron/ | wc -l`) são agendados exclusivamente pelo `crond` do serviço `scheduler` do `docker-compose.prod.yml` — a lista mora em `docker/scheduler/entrypoint.sh` — e **não existe `vercel.json` neste repo** (`ls vercel.json` → ausente). O resto do parágrafo segue valendo.

**Vira teste:** tests/unit: todo diretório de app/api/v1/cron/ tem entrada em docker/scheduler/entrypoint.sh. Cron sem agendador é evento sem consumer.

### L288 · FALSA · gravidade alta · pendencia

> 7. As branch protection rules exigem os dois checks do CI verdes para merge? Isso decide se o gate de RLS é bloqueante ou decorativo.

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** Apagar a pergunta 7. Está respondida: são cinco checks obrigatórios (`verify, build-and-size, invariants, e2e, imagens-ok`), e o gate de RLS (`invariants`) é bloqueante. A régua fica no lugar da resposta: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`.

### L295 · FALSA · gravidade alta · pendencia

> Se `pnpm typecheck` / `lint` / `test:unit` passam **hoje** — o `node_modules` deste checkout está incompleto e a auditoria não instala dependências.

**Mede com:**

```bash
node_modules/.bin/tsc --version; gh run list --workflow=ci.yml --branch=main --limit 5 --json conclusion --jq '.[].conclusion'
```

**Deu:**

```
Version 6.0.3
success
success
success
success
success
```

**Sugestão:** Trocar por: "Se `typecheck`/`lint`/`test:unit` passam hoje — **passam**: as cinco últimas execuções do `ci.yml` na `main` concluíram `success`. Régua: `gh run list --workflow=ci.yml --branch=main --limit 5 --json conclusion --jq '.[].conclusion'`." A razão declarada (`node_modules` incompleto) não vale mais.

### L296 · FALSA · gravidade media · pendencia

> Se o job `invariants` do CI está passando — sabemos que existe, não que está verde.

**Mede com:**

```bash
gh run list --workflow=ci.yml --branch=main --limit 5 --json conclusion,displayTitle --jq '.[]|"\(.conclusion) \(.displayTitle)"'
```

**Deu:**

```
success Merge pull request #251…
success Merge pull request #249…
success Merge pull request #250…
success Merge pull request #248…
success Merge pull request #247…
```

**Sugestão:** Remover do bloco "não pôde ser confirmado". O `ci.yml` (que carrega os jobs `verify` e `invariants`) está verde nas cinco últimas execuções da `main`, e é uma chamada só: `gh run list --workflow=ci.yml --branch=main --limit 5 --json conclusion --jq '.[].conclusion'`.

### L301 · FALSA · gravidade media · contagem

> Contei **221 arquivos** de teste unitário e **56** de invariante, compatível com mais de mil casos, mas não valida número específico.

**Mede com:**

```bash
git ls-files | grep -cE '\.test\.(ts|tsx)$'; ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
511
103
```

**Sugestão:** Os números de teste citados nos HANDOFFs são auto-relatados e não reconciliam entre si. Conte na hora, e declare a régua junto — arquivo e caso são coisas diferentes: `git ls-files | grep -cE '\.test\.(ts|tsx)$'` para arquivos, `ls tests/invariants/*.test.ts | wc -l` para invariantes.

### L304 · FALSA · gravidade media · sobre-o-codigo

> Se `docs/architecture/` cumpre o "mapa vivo" exigido pelo item 13 do DoD (contém só o diagrama do agent-turn).

**Mede com:**

```bash
ls docs/architecture/
```

**Deu:**

```
agent-turn.html · agent-turn.workflow.json · atualizacao-self-service · crm-vivo · escalacao-ciclo-humano · followup-dossie · gestao-funis · ia-360-organizar · ia-360-retencao · indice-de-atrito · marca-propria (.architecture.json) · README.md
```

**Sugestão:** Remover do bloco "não pôde ser confirmado". `docs/architecture/` tem hoje dez mapas vivos além do diagrama do agent-turn, um por épico (`ls docs/architecture/`) — o item 13 do DoD está sendo cumprido na prática. O que continua sem gate é a exigência de "≥2 arestas" para peça nova.


## `docs/harness-audit.md` — 20

### L5 · FALSA · gravidade media · data-versao

> last_updated: 2026-07-29

**Mede com:**

```bash
git log -1 --format='%ad' --date=short -- docs/harness-audit.md
```

**Deu:**

```
2026-08-14
```

**Sugestão:** `last_updated: 2026-08-14` e `audited_against: origin/main @ 840917ed (v1.3.0)`. O corpo já tem bloco datado de 2026-08-14 ("Números recontados em 2026-08-14 @ 741c4ec8"), então o frontmatter contradiz o próprio texto.

### L26 · FALSA · gravidade media · contagem

> 119 docs em `docs/`, README de 302 linhas em 3 idiomas

**Mede com:**

```bash
git ls-files docs | grep -c '\.md$'; wc -l README.md; ls README*.md
```

**Deu:**

```
161
490 README.md
README.en.md README.es.md README.md
```

**Sugestão:** Documentação farta em `docs/` (`git ls-files docs | grep -c '\.md$'`), README traduzido em 3 idiomas (`ls README*.md`), PRDs, specs, `CHANGELOG.md`. Sem número fixo: os dois já apodreceram.

### L29 · FALSA · gravidade media · ativo-obrigatorio

> | H3 — Verificável | ✅ | `lint` + `typecheck` + `test:unit` + `build`; CI roda os 3 primeiros em PR |

**Mede com:**

```bash
grep -n 'name: ' .github/workflows/ci.yml
```

**Deu:**

```
Typecheck / Lint / Channel provider leak / Unit tests / Kit self-host (bash) — cinco passos, não três
```

**Sugestão:** | H3 — Verificável | ✅ | `typecheck` + `lint` + `lint:channels` + `test:unit` + `test:shell` no job `verify`; `build` no `perf.yml`. Todos rodam em PR e são check obrigatório |

### L31 · FALSA · gravidade media · contagem

> Falta: **1 das 46 specs E2E fora do CI** (45 rodam via `e2e.yml`, **obrigatório desde 2026-08-08**; a de fora é `vps-fresh-onboarding`, que é justamente a P0)

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l; awk '/SPECS_PARTE_1:/,/FORA_DO_CI:/' .github/workflows/e2e.yml | grep -v '^ *#' | grep -oE '[a-z0-9-]+\.spec\.ts' | wc -l
```

**Deu:**

```
48
47
```

**Sugestão:** Falta: **uma** spec E2E fora do CI (`vps-fresh-onboarding`, a P0, por dependência de WAHA/Redis/Resend/Nuvemshop); `format:check` fora do CI; e o comando único local (`gov:verify`) não cobre `test:db`/`test:e2e`/`test:shell`. Não cite o total do disco aqui — ele muda toda semana e o `tests/unit/e2e-cobertura-completa.test.ts` já garante a soma.

### L39 · FALSA · gravidade alta · contagem

> O que separa de H5 é estreito: **16 dos 19 E2E não rodam em CI** (`e2e.yml` cobre `smoke`, `auth` e `error-pages` desde 2026-07-30)

**Mede com:**

```bash
grep -c 'spec.ts' <(awk '/SPECS_PARTE_1:/,/FORA_DO_CI:/' .github/workflows/e2e.yml | grep -v '^ *#'); ls tests/e2e/*.spec.ts | wc -l
```

**Deu:**

```
47 specs nas listas de execução; 48 no disco. `e2e.yml` cobre muito além de smoke/auth/error-pages.
```

**Sugestão:** O que separa de H5 é estreito: **1 spec E2E fora do CI** — a `vps-fresh-onboarding`, que protege justamente a primeira impressão que a doutrina classifica como o caminho mais crítico do produto. E `pnpm gov:verify`, o comando único que um agente naturalmente usa como critério de pronto, **não** inclui `test:db`, `test:e2e` nem `test:shell`: o CI pega o que ele deixa passar, mas só depois do push.

### L46 · FALSA · gravidade media · contagem

> doutrina escrita e específica (`CLAUDE.md`), Definition of Done de 13 itens, **56 arquivos de invariantes de banco**

**Mede com:**

```bash
awk '/^## Definition of Done/,/^Um staff engineer/' CLAUDE.md | grep -cE '^[0-9]+\.'; ls tests/invariants/*.test.ts | wc -l
```

**Deu:**

```
15 (itens do DoD)
103 (arquivos de invariante)
```

**Sugestão:** doutrina escrita e específica (`CLAUDE.md`), Definition of Done longo e checável (`awk '/^## Definition of Done/,/^Um staff engineer/' CLAUDE.md | grep -cE '^[0-9]+\.'`), invariantes de banco às centenas (`ls tests/invariants/*.test.ts | wc -l`), gate de install+update do `baseline.sql` num Postgres descartável rodando em CI…

### L59 · FALSA · gravidade baixa · contagem

> 302 linhas: o que é, quickstart de 5 min, stack, estrutura, testes, roadmap, suporte. Traduzido (EN/ES).

**Mede com:**

```bash
wc -l README.md
```

**Deu:**

```
490 README.md
```

**Sugestão:** | 1 | README útil | ✅ | O que é, quickstart de 5 min, stack, estrutura, testes, roadmap, suporte. Traduzido (EN/ES). Mais `CHANGELOG.md` com aviso de "⚠️ Requer atenção" por versão, voltado a quem roda VPS |

### L62 · FRAGIL · gravidade baixa · contagem

> `pnpm-lock.yaml`, e ambos os jobs do CI usam `--frozen-lockfile`

**Mede com:**

```bash
grep -rc 'frozen-lockfile' .github/workflows/*.yml
```

**Deu:**

```
ci.yml:2 · e2e.yml:1 · perf.yml:1 · publish-image.yml:0
```

**Sugestão:** | 4 | Lockfile | ✅ | `pnpm-lock.yaml`, e todo job que instala dependências usa `--frozen-lockfile` (`grep -rc 'frozen-lockfile' .github/workflows/*.yml`). "Ambos os jobs" descrevia um CI de dois jobs; hoje são cinco, em quatro workflows |

### L63 · FALSA · gravidade alta · pendencia

> Existe (+ `.env.hostgator.example`), mas **6 vars de `lib/env.ts` continuam ausentes**, entre elas 3 secrets

**Mede com:**

```bash
grep -c IMPERSONATE_COOKIE_SECRET .env.example; grep -c INTERNAL_CRON_SECRET .env.example; grep -c LGPD_SIGNING_KEY .env.example
```

**Deu:**

```
1
1
1 — as três presentes (idem LGPD_DPO_EMAIL, LGPD_EXPORT_EXPIRES_HOURS, NUVEMSHOP_ENABLED)
```

**Sugestão:** | 5 | `.env.example` | ✅ | Existe (+ `.env.hostgator.example`) e cobre as vars de `lib/env.ts`, secrets incluídos. Régua: `for v in $(grep -oE '[A-Z_]{6,}' lib/env.ts | sort -u); do grep -q "$v" .env.example || echo "ausente: $v"; done` |

### L68 · FRAGIL · gravidade baixa · sobre-o-codigo

> `pnpm typecheck` (`tsc --noEmit`, TS 6 estrito), roda no CI

**Mede com:**

```bash
node -e "console.log(require('./package.json').scripts.typecheck)"; node_modules/.bin/tsc --version
```

**Deu:**

```
tsc --noEmit -p tsconfig.typecheck.json
Version 6.0.3
```

**Sugestão:** | 10 | Checagem de tipos | ✅ | `pnpm typecheck` = `tsc --noEmit -p tsconfig.typecheck.json` (TS 6 estrito), roda no CI. O `-p` importa: o escopo verificado é o desse tsconfig, não o da raiz |

### L70 · FALSA · gravidade media · contagem

> **56 arquivos** de invariantes em `tests/invariants/` + `tests/api/`. Excluídos do `test:unit` de propósito (`vitest.config.ts:12`)

**Mede com:**

```bash
ls tests/invariants/*.test.ts | wc -l; grep -n 'exclude' vitest.config.ts
```

**Deu:**

```
103
25:    exclude: [  (não a linha 12)
```

**Sugestão:** | 12 | Testes de integração | ✅ | Invariantes em `tests/invariants/` (`ls tests/invariants/*.test.ts \| wc -l`) + `tests/api/`. Excluídos do `test:unit` de propósito (bloco `exclude` do `vitest.config.ts`) e rodados pelo job `invariants` do CI via `pnpm test:db` |

### L71 · FALSA · gravidade alta · contagem

> 20 specs Playwright. **10 rodam no CI** (`e2e.yml`, ainda não-obrigatório), incluindo o P0 `vps-webhook-outbound-ssrf`; o P0 `vps-fresh-onboarding` continua fora (issue #63)

**Mede com:**

```bash
ls tests/e2e/*.spec.ts | wc -l; awk '/SPECS_PARTE_1:/,/FORA_DO_CI:/' .github/workflows/e2e.yml | grep -v '^ *#' | grep -oE '[a-z0-9-]+\.spec\.ts' | wc -l; gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
48 (no disco)
47 (nas listas de execução)
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** | 13 | Testes E2E | ⚠️ | Todas as specs do disco menos uma rodam no `e2e.yml`, que **é check obrigatório**. A única de fora é o P0 `vps-fresh-onboarding` (precisa de WAHA + Redis + Resend + Nuvemshop) — logo, `e2e` verde **não** prova a instalação fresca. Reconte antes de citar número: `ls tests/e2e/*.spec.ts \| wc -l` contra `FORA_DO_CI` em `.github/workflows/e2e.yml`; a soma já é conferida por `tests/unit/e2e-cobertura-completa.test.ts` |

**Vira teste:** Já existe: tests/unit/e2e-cobertura-completa.test.ts reprova spec no disco fora das três listas. O que falta é o doc parar de repetir o número à mão.

### L72 · FALSA · gravidade media · sobre-o-codigo

> `pnpm gov:verify` = `typecheck && lint && test:unit`. **Omite `test:db` e `test:e2e`**

**Mede com:**

```bash
node -e "console.log(require('./package.json').scripts['gov:verify'])"
```

**Deu:**

```
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit
```

**Sugestão:** | 14 | Comando único de verificação | ⚠️ | `pnpm gov:verify` = `typecheck && lint && lint:channels && test:unit`. **Omite `test:db`, `test:e2e` e `test:shell`** — verde localmente é mais fraco até que o check `verify` do CI, que roda os cinco passos. Régua: `node -e "console.log(require('./package.json').scripts['gov:verify'])"` |

### L73 · FALSA · gravidade alta · ativo-obrigatorio

> `ci.yml` tem 2 jobs: `verify` (typecheck + lint + test:unit) e **`invariants`** […] Falta E2E e `format:check`. `perf.yml` faz build + bundle size; `publish-image.yml` publica no GHCR

**Mede com:**

```bash
grep -n 'name: ' .github/workflows/ci.yml; for f in .github/workflows/*.yml; do echo "-- $f"; awk '/^jobs:/{j=1;next} j && /^  [a-zA-Z0-9_-]+:/{print $0}' $f; done
```

**Deu:**

```
verify roda: Typecheck, Lint, Channel provider leak, Unit tests, Kit self-host (bash)
ci.yml: verify, invariants | e2e.yml: e2e | perf.yml: build-and-size | publish-image.yml: build-and-push, imagens-ok
```

**Sugestão:** | 15 | CI executando verificações | ✅ | `ci.yml` tem 2 jobs: `verify` (typecheck + lint + lint:channels + test:unit + **test:shell**, o único gate que exercita o `update.sh` do kit) e `invariants` (`pnpm test:db` — isolamento RLS + invariantes de governança, job paralelo, timeout 20min). `e2e.yml` roda os Playwright, `perf.yml` faz build + bundle size, `publish-image.yml` publica no GHCR **e carrega o job `imagens-ok`**. Falta só `format:check`. Os cinco checks obrigatórios: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts\|join(", ")'` |

### L75 · FALSA · gravidade media · ponteiro

> `ARCHITECTURE.md` (1 página) + `docs/specs/` (16 docs com schema e payloads) + `docs/architecture/agent-turn` + `graphify-out/`

**Mede com:**

```bash
ls -d graphify-out; git ls-files docs/specs | grep -c '\.md$'; ls docs/architecture/ | wc -l
```

**Deu:**

```
ls: graphify-out: No such file or directory
19
12
```

**Sugestão:** | 17 | Documentação arquitetural | ✅ | `ARCHITECTURE.md` (99 linhas) + `docs/specs/` (`git ls-files docs/specs \| grep -c '\.md$'`) + `docs/architecture/` com o diagrama do agent-turn e os mapas vivos por épico (`ls docs/architecture/`). **`graphify-out/` não existe neste repo** — o ponteiro anterior apontava para nada |

**Vira teste:** tests/unit: todo path citado em docs/harness-audit.md e docs/current-state.md existe no disco. Ponteiro morto é a falha mais barata de pegar e a mais cara de ler.

### L77 · FALSA · gravidade media · contagem

> Definition of Done de 13 itens em `CLAUDE.md`

**Mede com:**

```bash
awk '/^## Definition of Done/,/^Um staff engineer/' CLAUDE.md | grep -cE '^[0-9]+\.'
```

**Deu:**

```
15
```

**Sugestão:** | 19 | Critérios de conclusão de tarefa | ✅ | Definition of Done em `CLAUDE.md` (`awk '/^## Definition of Done/,/^Um staff engineer/' CLAUDE.md \| grep -cE '^[0-9]+\\.'`); `docs/doctrine/sistema-vivo.md` com o Living System Checklist; template de PR com o checklist |

### L78 · FALSA · gravidade media · contagem

> `Dockerfile` + `Dockerfile.worker`, `baseline.sql` auto-curativo cobrindo até a migration 0092

**Mede com:**

```bash
ls Dockerfile*; grep -oE 'migration [0-9]{4}' supabase/baseline.sql | sort -u | tail -1
```

**Deu:**

```
Dockerfile  Dockerfile.scheduler  Dockerfile.worker
migration 0157
```

**Sugestão:** | 20 | Ambiente reproduzível | ✅ | `docker-compose.yml` (dev), `.prod.yml`, **três Dockerfiles publicados** (`Dockerfile`, `Dockerfile.worker`, `Dockerfile.scheduler` — nenhum serviço de produção constrói na máquina do cliente), `baseline.sql` auto-curativo cobrindo até a última migration, `scripts/test-db.sh` com Postgres efêmero pg17 rodando em CI. ⚠️ A receita de ambiente fresco tem armadilhas que só existem em doc |

### L94 · FALSA · gravidade alta · pendencia

> ### 1. Adicionar os E2E ao CI (ou a um workflow nightly) 🔴 · custo: ~30 linhas  Maior buraco restante. […] `vps-webhook-outbound-ssrf.spec.ts` é a única prova automatizada do guard de SSRF.

**Mede com:**

```bash
grep -n 'vps-webhook-outbound-ssrf' .github/workflows/e2e.yml
```

**Deu:**

```
108:        degradacao-silenciosa.spec.ts vps-webhook-outbound-ssrf.spec.ts
```

**Sugestão:** ### ✅ JÁ FEITO (parcial) — E2E no CI  `e2e.yml` roda todas as specs menos uma e é check obrigatório na `main`; a `vps-webhook-outbound-ssrf.spec.ts` entrou. **Continua aberto** só o caso que exige infra externa: `vps-fresh-onboarding.spec.ts` (WAHA + Redis + Resend + Nuvemshop), que é a P0 da doutrina de QA Visual. Um workflow nightly com esses serviços é o que ainda falta.

### L108 · FALSA · gravidade alta · pendencia

> ### 3. Completar `.env.example` 🟠 · custo: 6 linhas  As 6 vars ausentes, com comentário sobre quais são obrigatórias. Os 3 secrets são o caso grave: quem instala não sabe que precisa gerá-los.

**Mede com:**

```bash
grep -cE 'IMPERSONATE_COOKIE_SECRET|INTERNAL_CRON_SECRET|LGPD_SIGNING_KEY|LGPD_DPO_EMAIL|LGPD_EXPORT_EXPIRES_HOURS|NUVEMSHOP_ENABLED' .env.example
```

**Deu:**

```
6 — todas as seis já estão no template
```

**Sugestão:** ### ✅ JÁ FEITO — `.env.example` reconciliado  As 6 vars (3 delas secrets) entraram no template. Sai do plano de correção e vira registro de item fechado.

### L133 · FALSA · gravidade alta · pendencia

> Se as branch protection rules do GitHub exigem os dois checks verdes para merge — é config de repositório remoto, invisível no checkout. **Isso decide se o gate de RLS é bloqueante ou apenas informativo**, e é a pergunta mais importante em aberto sobre o harness.

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** Remover deste bloco e registrar como respondido: a branch protection da `main` exige **cinco** checks — `verify, build-and-size, invariants, e2e, imagens-ok`. O gate de RLS (`invariants`) é **bloqueante**. Não é invisível no checkout: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'` responde em um comando, e é essa linha que deve ficar no doc no lugar da lista.


# REGISTRO — 15 achados


## `CHANGELOG.md` — 15

### L9 · FALSA · gravidade alta · pendencia

> ## [Não lançado]

**Mede com:**

```bash
git log --oneline v1.3.0..HEAD | wc -l ; git log --oneline v1.3.0..HEAD --no-merges -- app lib hostgator-setup-kit supabase workers | wc -l ; git diff --name-only --diff-filter=A v1.3.0 HEAD -- supabase/migrations/
```

**Deu:**

```
64 commits desde v1.3.0; 38 deles (sem merges) tocam app/lib/hostgator-setup-kit/supabase/workers; 3 migrations novas: 0155_marca_da_instalacao_no_banco.sql, 0156_quadro_do_onboarding.sql, 0157_marca_por_organizacao.sql. Entre os commits: e4963c6e 'feat(auth): a verificação em duas etapas vira escolha, não imposição', 11d87a11 'marca própria (whitelabel)', 6aabe750 'Pipeline e Kanban saem da interface', c2f88e83 'onboarding: sem chave de IA, o passo de treinar era um BECO'. `git tag --contains` de cada um devolve vazio.
```

**Sugestão:** ## [Não lançado]  ### Adicionado  - **Marca própria.** Nome, cor e logo da instalação e de cada organização passam a viver no banco, e alcançam também e-mail, PDF e o aplicativo autenticador. - **O onboarding monta o funcionário:** o quadro nasce pela IA, a chave é testada na hora, e o vocabulário do funil é escolhido no wizard.  ### Alterado  - **A verificação em duas etapas vira escolha, não imposição.** O cadastro deixa de ser obrigatório para administradores; quem exige agora é uma chave em Configurações › Segurança (na plataforma e na organização), e o padrão é não exigir. Quem JÁ tem o segundo fator continua provando-o na sessão. - **"Pipeline" e "Kanban" saem da interface** — na tela agora são "Funis" e "Etapas do funil".  ### ⚠️ Requer atenção  - **3 mudanças de banco** (migrations 0155 a 0157). O `update.sh` aplica sozinho.  > Esta seção não pode ficar vazia enquanto houver comm

**Vira teste:** tests/unit/changelog-nao-lancado.test.ts — dada a última tag `T` (`git describe --tags --abbrev=0`), se `git log T..HEAD --no-merges -- app lib hostgator-setup-kit supabase workers` tem ≥1 commit, então o bloco entre `## [Não lançado]` e o próximo `## [` deve ter ≥1 linha não vazia. Sabotagem que reprova: apagar o corpo da seção com commits de produto pendentes.

### L11 · FALSA · gravidade media · ponteiro

> ## [1.3.0] — 2026-08-13

**Mede com:**

```bash
grep -n '^## ' CHANGELOG.md ; grep -n '^\[' CHANGELOG.md
```

**Deu:**

```
Headings: Não lançado, 1.3.0, 1.2.1, 1.2.0, 1.1.0, 1.0.0. Definições de link: Não lançado, 1.2.1, 1.2.0, 1.1.0, 1.0.0. **Falta `[1.3.0]:`** — o único heading de versão sem destino. No GitHub ele renderiza como texto literal `[1.3.0]`, enquanto os vizinhos viram link para o diff.
```

**Sugestão:** Acrescentar, entre a linha de `[Não lançado]` e a de `[1.2.1]`:  [1.3.0]: https://github.com/melgarafael/DeskcommCRM/compare/v1.2.1...v1.3.0

**Vira teste:** tests/unit/changelog-links.test.ts — todo heading `## [X.Y.Z]` tem uma linha `[X.Y.Z]: https://…` correspondente. Sabotagem que reprova: apagar a definição de `[1.2.1]`.

### L32 · FRAGIL · gravidade baixa · data-versao

> o instalador grava o **número da versão** (ex.: `1.2.1`)

**Mede com:**

```bash
git tag --list | sort -V | tail -3 ; grep -n 'ultima_versao_publicada' hostgator-setup-kit/install.sh
```

**Deu:**

```
Tags: v1.2.0, v1.2.1, v1.3.0. install.sh:1025 resolve a última versão publicada — hoje uma instalação nova gravaria `1.3.0`, não `1.2.1`. O exemplo já era o número anterior no dia em que a 1.3.0 saiu.
```

**Sugestão:** Agora o instalador grava o **número da versão publicada mais recente** no seu `.env`, e é essa versão que fica no seu servidor até você decidir atualizar. Para ver qual é a sua: `grep APP_IMAGE .env`.

### L44 · FALSA · gravidade alta · sobre-o-codigo

> O WhatsApp (WAHA) e o serviço de limites deixaram de acompanhar automaticamente qualquer versão nova publicada por terceiros. Passam a mudar só quando nós testamos e lançamos.

**Mede com:**

```bash
grep -n 'WAHA_IMAGE' hostgator-setup-kit/*.sh ; grep -nE 'image:|pull_policy' docker-compose.prod.yml ; sed -n '405,440p' docs/runbooks/remediar-worker-congelado.md
```

**Deu:**

```
`WAHA_IMAGE` só aparece em install.sh:1427 (`envq WAHA_IMAGE "${WAHA_IMAGE:-devlikeapro/waha:latest-2026.7.2}"`) e em test-validators.sh. NENHUMA ocorrência em update.sh, agent.sh ou _common.sh — nada reescreve um `.env` legado. O compose pina (`waha:latest-2026.7.2`, srh por digest sha256:5b0bb923…), mas o runbook, medido em 2026-08-14, diz: "o install gravava `WAHA_IMAGE=devlikeapro/waha` (sem tag, isto é `:latest`) por cima: o pin existia e não alcançava ninguém" e "**Ainda não consertado** … no dia em que o devlikeapro publicar, o próximo `update.sh` de qualquer instalação legada troca a versão do WhatsApp sem ninguém pedir".
```

**Sugestão:** - O WhatsApp (WAHA) e o serviço de limites passam a nascer numa versão fixa **em instalação nova**. Numa instalação que já existia, a linha `WAHA_IMAGE` do seu `.env` continua como estava e nenhum script a reescreve — o WhatsApp segue acompanhando o que o fornecedor publicar. Para ver em que pé está o seu: `grep WAHA_IMAGE .env`. Sem `:` na linha, é `:latest`, e o procedimento para fixar (com o custo medido: recria o contêiner do WhatsApp) está em `docs/runbooks/remediar-worker-congelado.md`.

**Vira teste:** tests/shell — o gate de packaging hoje só mede o `.env` de instalação FRESCA (test-validators.sh:1380). Um caso irmão que parte de um `.env` legado com `WAHA_IMAGE=devlikeapro/waha`, roda `update.sh` e afirma o estado da linha depois transforma esta frase em fato verificável em vez de promessa.

### L51 · FALSA · gravidade alta · ativo-obrigatorio

> A partir desta versão o agente de atualização corrige parte disso sozinho, em até 5 minutos, sem você fazer nada — ele fixa a versão que já está rodando.

**Mede com:**

```bash
git show v1.3.0:hostgator-setup-kit/agent.sh | grep -n 'completar_pin_ausente\|pin_incompleto' ; grep -n 'completar_pin_ausente' hostgator-setup-kit/_common.sh ; git log --oneline -S 'o agente de atualização corrige parte disso sozinho' -- CHANGELOG.md ; git tag --contains 81b3bd5d ; git diff v1.3.0 HEAD -- CHANGELOG.md
```

**Deu:**

```
Em v1.3.0 o agent.sh NÃO tem `completar_pin_ausente` nem `pin_incompleto` (grep vazio). No HEAD: _common.sh:448 `completar_pin_ausente()`. O parágrafo entrou em 81b3bd5d 'feat(kit): o agente completa o pin sozinho', e `git tag --contains 81b3bd5d` devolve VAZIO — o commit não está em release nenhuma. O `git diff v1.3.0 HEAD -- CHANGELOG.md` mostra que a ÚNICA alteração no arquivo desde a tag foi reescrever este bloco de uma seção já publicada.
```

**Sugestão:** Mover o parágrafo inteiro para `## [Não lançado] → ### Alterado`, e devolver à seção 1.3.0 o texto que a tag realmente carrega:  **Se o seu servidor foi instalado antes desta versão, rode o `update.sh` DUAS vezes.** Medido em ensaio numa VPS: a primeira execução traz o agente novo, mas deixa a versão dele "solta" — acompanhando o canal em vez de ficar fixa, como o resto do sistema. Isso faria o agente saltar sozinho para a versão seguinte num reinício futuro, enquanto o resto do servidor continuaria onde está. A segunda execução fixa tudo na mesma versão.  E, em Não lançado:  - **O agente de atualização completa a versão que ficou solta sozinho**, em até 5 minutos, sem você fazer nada. O que ele **nunca** faz é mexer numa configuração que você escreveu à mão: se você escolheu acompanhar um canal de propósito, ele respeita e só avisa.

**Vira teste:** tests/unit/changelog-secao-publicada-e-imutavel.test.ts — para cada tag `vX.Y.Z`, o bloco `## [X.Y.Z]` no CHANGELOG do HEAD deve ser byte-idêntico ao do `git show vX.Y.Z:CHANGELOG.md`. Reprova qualquer reescrita retroativa de seção já publicada.

### L69 · FRAGIL · gravidade media · pendencia

> Fora isso, nada exige ação sua. Um `.env` antigo continua funcionando

**Mede com:**

```bash
grep -n 'WAHA_IMAGE' hostgator-setup-kit/update.sh hostgator-setup-kit/agent.sh hostgator-setup-kit/_common.sh ; grep -n 'Ainda não consertado' docs/runbooks/remediar-worker-congelado.md
```

**Deu:**

```
grep em update.sh/agent.sh/_common.sh: nenhuma ocorrência de WAHA_IMAGE. O runbook traz "**Ainda não consertado — mas a razão que escrevi aqui estava errada, e a medição a derrubou.**" e conclui: "Segue não consertado porque a decisão é de quem opera e a janela ainda está aberta". Existe, portanto, um item que o operador legado precisa decidir e que esta frase manda ele parar de procurar.
```

**Sugestão:** Fora isso, o `update.sh` faz o resto sozinho: um `.env` antigo continua funcionando, as configurações novas têm valor padrão e o próprio script as acrescenta. **Uma linha ele não toca de propósito:** a do WhatsApp (`WAHA_IMAGE`). Se o seu `.env` a tem sem número de versão, o WhatsApp segue acompanhando o que o fornecedor publicar — o `diagnostico.sh` aponta isso, e o procedimento (com o custo: recria o contêiner do WhatsApp) está no runbook.

### L239 · FRAGIL · gravidade baixa · ativo-obrigatorio

> Todas fechadas, com uma varredura que reprova a próxima.

**Mede com:**

```bash
ls -la tests/invariants/hardening-definer-varredura.test.ts ; grep -ciE 'security definer' supabase/baseline.sql
```

**Deu:**

```
tests/invariants/hardening-definer-varredura.test.ts existe (8831 bytes) e está na suíte `invariants`, que é required check na `main`. O baseline tem 51 ocorrências de `security definer`. O "8 de 25" da mesma frase é medição histórica contra a árvore da 1.2.0 e não é reproduzível sem subir o Postgres daquele momento — a varredura, que é a parte que protege daqui pra frente, está de pé.
```

### L254 · FALSA · gravidade media · sobre-o-codigo

> seu servidor já roda este código (a instalação acompanha a `main`)

**Mede com:**

```bash
sed -n '1025,1060p;1310,1340p' hostgator-setup-kit/install.sh
```

**Deu:**

```
install.sh:1025 `VERSAO_ALVO="$(ultima_versao_publicada "$REPO_URL")"`; 1330-1339 grava `APP_IMAGE`, `WORKER_IMAGE`, `SCHEDULER_IMAGE` na tag resolvida e `*_PULL_POLICY` derivada (`latest|main|stable → always`, versão fixa → `missing`). A instalação NÃO acompanha mais a `main` — foi exatamente o que a 1.3.0 corrigiu (linhas 28-32 do próprio arquivo).
```

**Sugestão:** Se você instalou entre 30/07 e 11/08, seu servidor já roda este código — naquela época a instalação nova nascia acompanhando a `main`. (A partir da 1.3.0 não nasce mais: o instalador grava o número da versão.) Esta tag existe para que a atualização pela tela e o `update.sh` voltem a ter um alvo publicado para comparar.

### L288 · FALSA · gravidade media · sobre-o-codigo

> Autenticação via Supabase Auth com MFA TOTP obrigatório para administradores.

**Mede com:**

```bash
sed -n '1,40p' lib/auth/politica-mfa.ts ; git tag --contains e4963c6e
```

**Deu:**

```
lib/auth/politica-mfa.ts (existe no HEAD, 3896 bytes): "A regra era uma linha sem opção: `isPlatformAdmin || role === \"admin\"` … o cadastro passa a ser OPCIONAL e ligado numa tela de Configurações". Duas políticas independentes que somam (`platform_admins.mfa_required`, `organizations.settings.security.mfa_required`), padrão não-exigir. `git tag --contains e4963c6e` (o commit que fez a troca) devolve VAZIO — a mudança não está em nenhuma release nem no CHANGELOG.
```

**Sugestão:** Não reescrever a linha da 1.0.0 — ela é registro correto daquela versão. O conserto é a entrada que falta em `## [Não lançado] → ### Alterado`:  - **A verificação em duas etapas do administrador vira escolha, não imposição.** Até aqui toda instalação forçava o dono a cadastrar TOTP logo depois do onboarding — um sétimo passo que o assistente nunca anunciou. Agora o cadastro é ligado por quem administra, em Configurações › Segurança, e o padrão é não exigir. **Quem já tem o segundo fator continua provando-o ao entrar** — desligar a exigição não desliga o fator de quem o ativou por vontade própria.

### L311 · FALSA · gravidade media · contagem

> Cadeia de 7 verificações antes de cada envio, em ordem fixa: descadastro, LGPD, anti-banimento, variação de texto, promessa determinística, promessa semântica e disclosure.

**Mede com:**

```bash
node -e "...conta nome: em CONFERENCIAS_DE_SAIDA..." ; npx vitest run tests/unit/seguranca-lista-casa-com-a-cadeia.test.ts ; git show v1.0.0:lib/agent-engine/guardrails/before-send.ts | head -20
```

**Deu:**

```
HEAD: 10 conferências, nesta ordem — stop, lgpd, pacing, messaging_window, spinning, promise, semantic_promise, case_promise, internal_vocabulary, disclosure. O teste que prova que a lista casa com a cadeia real passa: `Test Files 1 passed (1) / Tests 8 passed (8)`. Em v1.0.0 o cabeçalho de before-send.ts já descrevia OITO gates — os 7 citados mais "(6.5) case promise", que a frase omitiu. A tela não repete o número: `PainelDeSeguranca.tsx:142` imprime `{CONFERENCIAS_DE_SAIDA.length}`.
```

**Sugestão:** - Cadeia de verificações determinísticas antes de cada envio, em ordem fixa e versionada — a primeira que veta interrompe as demais. A lista viva (e o número) está em `lib/ai/guardrails/lista-de-conferencia.ts` e é o que a tela do agente mostra; um teste reprova quando a lista e a cadeia real divergem. Cada avaliação vira registro durável e auditável — inclusive as que barram o envio.

**Vira teste:** Não vale um teste novo: `tests/unit/seguranca-lista-casa-com-a-cadeia.test.ts` já guarda a cadeia. O conserto é a prosa parar de repetir o número que o código já publica.

### L336 · FALSA · gravidade baixa · contagem

> 8 scripts de operação: `install`, `update`, `backup`, `restore`, `reset-password`, `reset-mfa`, `healthcheck` e o assistente de instalação em IA.

**Mede com:**

```bash
git ls-tree -r --name-only v1.0.0 hostgator-setup-kit/ ; git show v1.0.0:hostgator-setup-kit/README.md | sed -n '44,52p' ; ls hostgator-setup-kit/*.sh | wc -l
```

**Deu:**

```
v1.0.0 tinha 8 arquivos `.sh`, mas um deles é `_common.sh` (biblioteca compartilhada, não operação); o README da tag documenta exatamente **7** scripts. O "assistente de instalação em IA" é `hostgator-setup-kit/CLAUDE.md` — um markdown ("# Você é o assistente de instalação do SonghaiCRM"), não um script. Portanto: 7 scripts + 1 documento, contados como 8 scripts. No HEAD a pasta tem 14 `.sh` (entram agent, comecar, diagnostico, marca-emails, supabase-provision, test-validators).
```

**Sugestão:** - 7 scripts de operação — `install`, `update`, `backup`, `restore`, `reset-password`, `reset-mfa` e `healthcheck` — mais `CLAUDE.md`, o roteiro que faz uma IA conduzir a instalação de ponta a ponta para quem não programa.

**Vira teste:** tests/shell ou tests/unit/kit-readme-casa-com-a-pasta.test.ts — todo `.sh` executável da pasta `hostgator-setup-kit/` que não comece com `_` aparece na tabela do README do kit. Hoje 6 dos 14 estão fora dela, incluindo o `diagnostico.sh` que o próprio CHANGELOG manda o cliente rodar.

### L337 · FALSA · gravidade alta · sobre-o-codigo

> Imagem publicada em `ghcr.io/melgarafael/deskcommcrm` — a VPS não compila nada.

**Mede com:**

```bash
git show v1.0.0:docker-compose.prod.yml | grep -nE '^  [a-z0-9_-]+:|image:|build:'
```

**Deu:**

```
Em v1.0.0: `app` (linha 19) tem `image: ${APP_IMAGE:-ghcr.io/melgarafael/deskcommcrm:latest}`; `worker` (linha 42) tem **`build:`** e NENHUM `image:`; `scheduler` (linha 112) é `alpine:3.20` com `apk add` no `command:`. Ou seja, na própria v1.0.0 a VPS compilava o worker. O mesmo arquivo admite isso na linha 22: "O worker … era compilado dentro do seu servidor no dia da instalação".
```

**Sugestão:** - Imagem publicada em `ghcr.io/melgarafael/deskcommcrm` — a VPS não compila **o app**. (O worker ainda era compilado no seu servidor nesta versão; isso só foi corrigido na 1.3.0.)

**Vira teste:** tests/unit/packaging-sem-build-only.test.ts (se ainda não existir com este alcance) — todo serviço de `docker-compose.prod.yml` declara `image:`; serviço com `build:` e sem `image:` reprova. Sabotagem que reprova: remover o `image:` do `worker`.

### L341 · FALSA · gravidade media · ativo-obrigatorio

> CI com dois portões obrigatórios: `verify` (typecheck, lint, testes unitários) e `invariants`.

**Mede com:**

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

**Deu:**

```
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** - CI com portões obrigatórios na `main` — na 1.0.0 eram dois, `verify` (typecheck, lint, testes unitários) e `invariants`. A lista em vigor hoje é sempre esta, medida na fonte: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`.

**Vira teste:** Não é caso de teste no CHANGELOG (proteção de branch não tem histórico consultável). O padrão certo é o que o CLAUDE.md já usa: publicar o comando, não o resultado.

### L342 · FRAGIL · gravidade media · contagem

> roda **364 testes de invariante** em 56 arquivos

**Mede com:**

```bash
git ls-tree -r --name-only v1.0.0 tests/invariants/ | grep -c '\.test\.ts$' ; ls tests/invariants/*.test.ts | wc -l ; grep -rhoE '^\s*(it|test)(\.\w+)?\(' tests/invariants/ | wc -l
```

**Deu:**

```
v1.0.0: 56 arquivos (o número da frase confere na tag). HEAD: 103 arquivos, 682 casos `it(`/`test(` declarados. O número 364 é repassado como VIVO em CLAUDE.md:253 e em docs/growth/lp-plano.md:300 — nos dois lugares ele já está velho por um fator de quase 2.
```

**Sugestão:** - O portão `invariants` sobe um Postgres limpo, aplica o `baseline.sql` em modo install e update, e roda a suíte de invariantes — 56 arquivos nesta versão — incluindo o teste de isolamento entre organizações, que prova que um usuário de uma organização não enxerga nenhuma linha de outra. (Para o número de hoje: `ls tests/invariants/*.test.ts | wc -l`.)

### L349 · FALSA · gravidade media · ponteiro

> [Não lançado]: https://github.com/melgarafael/DeskcommCRM/compare/v1.2.1...HEAD

**Mede com:**

```bash
grep -n '^\[' CHANGELOG.md ; git tag --list | sort -V | tail -3
```

**Deu:**

```
Definições presentes: Não lançado (v1.2.1...HEAD), 1.2.1, 1.2.0, 1.1.0, 1.0.0. Tags existentes: v1.2.0, v1.2.1, **v1.3.0**. O comparador de "Não lançado" ainda parte da v1.2.1, então o link mostra a 1.3.0 inteira como se fosse trabalho não lançado.
```

**Sugestão:** [Não lançado]: https://github.com/melgarafael/DeskcommCRM/compare/v1.3.0...HEAD

**Vira teste:** tests/unit/changelog-links.test.ts — a definição de `[Não lançado]` deve comparar contra a MAIOR tag existente (`git tag --sort=-v:refname | head -1`). Sabotagem que reprova: publicar uma tag nova sem atualizar a linha.


---

# Vereditos "VERDADEIRA" derrubados no passe adversarial

De 69 reexaminadas, 4 caíram. Duas eram frases escritas na mesma sessão da varredura.


## `docs/runbooks/remediar-worker-congelado.md`:196 → FALSA

> **Desde a 1.3.0, o agente completa parte disso sozinho — em até 5 minutos.** O `agent.sh` (cron do host) … preenche a chave que faltou usando **a versão que o contêiner já está rodando**

**Por que caiu:** O varredor grepou a ÁRVORE DE TRABALHO (main @ 840917ed) — `_common.sh:464/466` e `cron_line` — para provar uma afirmação que é ESCOPADA POR VERSÃO ("desde a 1.3.0"). O kit que roda na VPS do cliente é o da tag: `update.sh` faz `git checkout "$TARGET_TAG"` (update.sh:119) e só depois o cron chama o `agent.sh` do disco. Na tag v1.3.0 a função `completar_pin_ausente` NÃO EXISTE — nem em `_common.sh`, nem chamada no `agent.sh`. Ela entrou em `81b3bd5d` (2026-08-14), um dia DEPOIS do commit da v1.3.0 (2026-08-13 16:52), e não está em tag nenhuma: v1.3.0 é a mais recente. Ou seja: nenhuma instalação existente hoje tem esse comportamento. Presença de string na main != comportamento na versão publicada. Pior: quem lê este runbook para atender um cliente afetado vai dizer a ele "espere 5 minutos que o pin se completa sozinho" — e nada acontece, para sempre.

```bash
git show v1.3.0:hostgator-setup-kit/_common.sh | grep -c completar_pin_ausente ; git show v1.3.0:hostgator-setup-kit/agent.sh | grep -c completar_pin_ausente ; grep -n completar_pin_ausente hostgator-setup-kit/agent.sh ; git log --oneline -S completar_pin_ausente -- hostgator-setup-kit/_common.sh ; git log -1 --format='%h %ad' --date=short 81b3bd5d ; git merge-base --is-ancestor 81b3bd5d v1.3.0 && echo 'SIM (está na v1.3.0)' || echo 'NAO — posterior a v1.3.0' ; git tag -l 'v*' --sort=-v:refname | head -1 ; git log -1 --format='%ad' --date=iso v1.3.0
```

```
$ git show v1.3.0:hostgator-setup-kit/_common.sh | grep -c completar_pin_ausente
0
$ git show v1.3.0:hostgator-setup-kit/agent.sh | grep -c completar_pin_ausente
0
$ grep -n completar_pin_ausente hostgator-setup-kit/agent.sh          # HEAD 840917ed
180:PIN_CORRIGIDO="$(completar_pin_ausente .env)" || PIN_CORRIGIDO=""
$ git log --oneline -S completar_pin_ausente -- hostgator-setup-kit/_common.sh
81b3bd5d feat(kit): o agente completa o pin sozinho — só a lacuna, nunca a decisão
$ git log -1 --format='%h %ad' --date=short 81b3bd5d
81b3bd5d 2026-08-14
$ git merge-base --is-ancestor 81b3bd5d v1.3.0 && echo SIM || echo 'NAO — posterior a v1.3.0'
NAO — posterior a v1.3.0
$ git tag -l 'v*' --sort=-v:refname | head -1
v1.3.0
$ git log -1 --format='%ad' --date=iso v1.3.0
2026-08-13 16:52:52 -0300
(controle de que a sonda estava viva: o mesmo grep na main devolve a linha 180 do agent.sh, e `bash t
```


## `docs/runbooks/remediar-worker-congelado.md`:22 → FRAGIL

> **Ainda não coberto:** o app não subiu contra um Supabase real (o ensaio usou um Postgres em contêiner como `SUPABASE_DB_URL`) … e a sessão do WhatsApp foi representada por um arquivo marcador no volume, não por um número pareado de verdade.

**Por que caiu:** O comando do varredor (`grep -rln 'U6-b|U6-c|remediar-worker-congelado'` no repo) é sonda cega para a categoria que importa: ele procurou um ENSAIO POSTERIOR em outros arquivos e concluiu "nenhum registro". A refutação está 340 linhas abaixo, DENTRO DO MESMO ARQUIVO: o §P4 ("a execução real, na produção do projeto", 2026-08-13) documenta o app rodando contra o Supabase de produção (`/api/v1/health` → `1.3.0, healthy`, com `supabase: ok`) e uma sessão de WhatsApp pareada de verdade (volume com 48.607 arquivos, sessão `noweb` presente, `waha: ok`). O aviso de topo — que é a primeira coisa que qualquer leitor vê — declara não coberto exatamente o que o próprio documento depois mede. O §441 ("O que estes ensaios NÃO cobriram") repete a lista com escopo correto ("ensaios"), o que torna o de cima o único que mente por falta de escopo.

```bash
sed -n '361,385p' docs/runbooks/remediar-worker-congelado.md
```

```
### P4 — a execução real, na produção do projeto (2026-08-13)

Primeira aplicação em instalação de verdade, com dados de verdade. **A produção reproduziu o
U6-c com exatidão** …
| `/api/v1/health` | `0.1.0` | — | **`1.3.0`, healthy** |
…
**Nada se perdeu, medido item a item:** volume WAHA com **48.607 arquivos** antes e depois,
sessão `noweb` presente, 4 volumes intactos, **nenhuma** chave do `.env` sumiu (39 → 43 …).
De fora da VPS: `HTTP 307`, e o health com `supabase: ok`, `redis: ok`, `waha: ok`.
```


## `docs/runbooks/deploy.md`:110 → NAO_VERIFICAVEL

> A régua de operação (7 contêineres, ~150 MB por número de WhatsApp, `mem_limit` somando 2560m entre app+worker+waha)

**Por que caiu:** O comando mediu duas das três parcelas (7 serviços, 768+512+1280 = 2560m) e passou batido pela terceira — o `~150 MB por número de WhatsApp`, que é justamente a que sustenta a recomendação comercial de 4 GB e o limiar de aviso do `install.sh`. Nenhum comando da varredura, e nenhum artefato do repo, mede consumo por sessão WAHA: o número só existe em prosa, em 7 lugares que se citam entre si, e a ocorrência mais antiga é herdada da síntese do curso WAHA (`docs/research/reference-synthesis.md`, "NOWEB … ~150MB"), não de uma medição deste projeto. É número que pega carona: contar de novo os contêineres não calibra a parcela que ninguém mediu.

```bash
grep -rn '150 MB\|150MB' --include='*.md' . | grep -v node_modules ; git log --format='%h %ad %s' --date=short -S '150 MB' -- docs/ hostgator-setup-kit/ CHANGELOG.md | tail -3
```

```
CHANGELOG.md:18 · docs/white-label.md:183 · docs/research/reference-synthesis.md:117 · docs/runbooks/waha-hostgator.md:20 · docs/runbooks/deploy.md:110 · docs/doctrine/packaging.md:413 · hostgator-setup-kit/README.md:93   → 7 ocorrências, TODAS prosa; zero teste, zero saída de `docker stats`, zero anexo de medição
$ git log -S '150 MB' … | tail -3
efe82e50 2026-08-03 feat(kit): porta de entrada para quem ainda não tem servidor
fb103fad 2026-07-28 fix(vps): a recomendação passa a ser 4 GB, e o kit para de dizer que 2 GB bastam
8cd723b8 2026-05-05 docs(waha): switch production hosting recommendation Hetzner → Hostgator   ← origem: prosa herdada, não medição
```


## `docs/index.md`:29 → NAO_VERIFICAVEL

> todos os links relativos da tabela de entrada (README, VISION, ARCHITECTURE, AGENTS, CLAUDE, CONTRIBUTING, CHANGELOG, current-state e os 74 demais)

**Por que caiu:** A citação não existe no arquivo. `docs/index.md:29` é uma linha de tabela ("| [`README.md`](../README.md) | O que é, quickstart de 5 min… |") — a frase citada foi sintetizada pelo varredor, então a linha do relatório não é auditável por quem for reconferir: abre o arquivo, não acha a frase, e não sabe se a divergência é do doc ou do relatório. Pior, a aritmética da própria citação não fecha com a própria medição: 8 nomeados + "os 74 demais" = 82 alvos, e o repo tem 75 links relativos com repetição / 74 únicos. O que É verdade (e eu reproduzi) é a propriedade medida — nenhum link relativo quebrado; o que cai é a afirmação como está escrita e ancorada.

```bash
sed -n '29p' docs/index.md ; python3 -c "import re,os;s=open('docs/index.md').read();ls=[l for l in re.findall(r'\]\(([^)]+)\)',s) if not l.startswith(('http','mailto'))];print('totais:',len(ls),'unicos:',len(set(ls)));print('QUEBRADOS:',[l for l in set(ls) if not os.path.exists(os.path.normpath(os.path.join('docs',l.split('#')[0])))])"
```

```
$ sed -n '29p' docs/index.md
| [`README.md`](../README.md) | O que é, quickstart de 5 min, stack, roadmap. Também em [EN](../README.en.md) / [ES](../README.es.md) |
$ python3 …
totais: 75 unicos: 74
QUEBRADOS: []
```


---

# Documentos que a varredura NÃO cobriu

- ARCHITECTURE.md — visão de arquitetura de 1 página, linkada por README/CLAUDE; densa em contagens e afirmações de gate. Nenhum varredor a leu. É o doc que um dev abre ANTES de codar.
- docs/threat-model.md — inventário da superfície de ataque; citado como autoridade por CLAUDE.md e ARCHITECTURE.md. O front-matter declara `audited_against: origin/main @ 789dfa6 (2026-07-27)`, mas o corpo fala em presente e 4 itens já foram fechados no código.
- triagem/TRIAGEM.md — o procedimento de triagem de PR (o próprio workflow que rodou esta varredura). Lista os checks obrigatórios da branch protection. CLAUDE.md avisa que medir contra a régua errada é 'o modo de falha nº 1 do procedimento de triagem'.
- triagem/references/complemento-do-ci.md — anexo do TRIAGEM.md com 'o que os gates não provam'.
- docs/deploy-hostgator/README.md — guia de compra + instalação para leigo (P0 de primeira impressão). Nomeia plano de VPS e ensina um passo de MFA que não existe mais.
- docs/testing/user-journey-map.md — o mapa de jornadas que o DoD 12 manda atualizar; fonte da verdade do QA de produto.
- tests/invariants/README.md — contrato do harness de invariantes que todo contribuidor lê antes de adicionar um.
- tests/e2e/README.md e tests/unit/README.md — listas de 'suítes a criar' escritas antes da implementação.
- lib/waha/README.md, lib/ai/README.md, lib/api/README.md — READMEs de módulo marcados 'Placeholder'.
- supabase/migrations/MANIFEST.md — o ledger obrigatório do item 11 do Definition of Done.
- docs/deploy-selfhost/README.md — AUDITADO SEM ACHADO: os 10 paths e as 12 env vars que cita existem; o fluxo bate com update.sh.
- docs/ATUALIZANDO.md — AUDITADO SEM ACHADO: conferido contra hostgator-setup-kit/update.sh linha a linha; os 6 passos, o backup e os 3 scripts citados conferem.
- docs/architecture/README.md — AUDITADO SEM ACHADO: a tabela de 10 mapas bate com `ls docs/architecture/*.json` (10).
- docs/doctrine/sistema-vivo.md — AUDITADO SEM ACHADO: '10 gates before-send' bate com BEFORE_SEND_GATES (10 entradas).
- docs/white-label.md — AUDITADO SEM ACHADO: /admin/marca, /app/settings/marca, X-Deskcomm-Signature e 'o alarme de orçamento não tem cron' conferem.
- docs/SETUP.md, docs/runbooks/waha-hostgator.md, docs/runbooks/ai-credentials-rotation.md, VISION.md, docs/business-rules/, docs/doctrine/restricao-de-canal.md, docs/doctrine/separacao-fala-e-operacao.md — varridos por existência de path e por contagem; zero path morto, zero contagem. O runbook de rotação cita `scripts/rotate-ai-cred-aes-key.ts` mas DECLARA que ele não existe — honesto, não é achado.
- Fora do escopo literal do brief (não são raiz nem docs/) mas não cobertos e com afirmação de estado: .claude/agents/triagem-medidor.md, .claude/skills/sistema-vivo/SKILL.md, hostgator-setup-kit/README.md, hostgator-setup-kit/CLAUDE.md, plan/progress.md, tasks/todo.md.
- NÃO SÃO ACHADO, e é deliberado: docs/specs/* e docs/stories/epics/* citam 324 paths inexistentes (medido). São planos — afirmam futuro, não estado. Excluí-los foi decisão minha, não omissão.

# Achados nesses documentos (19)


## `triagem/TRIAGEM.md`:101 · FALSA · gravidade alta

> Obrigatórios no merge: `verify`, `build-and-size`, `invariants`.

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '{contexts:.required_status_checks.contexts, strict:.required_status_checks.strict, reviews:.required_pull_request_reviews}'
```

```
{"contexts":["verify","build-and-size","invariants","e2e","imagens-ok"],"reviews":null,"strict":false}
```

**Sugestão:** São CINCO: verify, build-and-size, invariants, e2e, imagens-ok. As outras duas afirmações da mesma seção (`strict=false` na linha 89, sem review humano obrigatório na linha 15) foram medidas e CONFEREM — só a lista está velha. É o pior lugar possível para esse erro: CLAUDE.md registra que medir contra a régua errada é 'o modo de falha nº 1 do procedimento de triagem', e este é o arquivo que define o procedimento. Um triador que leia esta linha declara 'passou os obrigatórios' tendo rodado 3 de 5 — e os dois que faltam (`e2e`, `imagens-ok`) são justamente os que cobrem o artefato que o self-hoster instala.


## `docs/deploy-hostgator/README.md`:177 · FALSA · gravidade alta

> 3. **Segurança em 2 etapas (MFA):** no primeiro login o CRM pede pra configurar um código de 6 dígitos. Tenha o app **Google Authenticator** ou **Authy** no celular, escaneie o QR e digite o código. (Isso protege a conta de admin.)

```bash
grep -n 'mfa_required' scripts/bootstrap-owner.ts; grep -rn 'exigeCadastroDeMfa' --include='*.ts' app lib | grep -v test
```

```
scripts/bootstrap-owner.ts:215:    mfa_required: false,
  (comentario na linha 201: "`mfa_required: false` EXPLICITO, contra o default `true` da coluna")
lib/auth/politica-mfa.ts:67:export function exigeCadastroDeMfa(p) -> if (p.isPlatformAdmin && p.plataformaExige === true) return true; if (p.role === "admin" && p.empresaExige) return true; return false;
app/actions/auth/politicaDeMfa.ts:120 e lib/auth/server.ts:205  (os dois call sites reais)
```

**Sugestão:** O install.sh chama bootstrap-owner.ts, que grava `mfa_required: false` explícito, e o gate agora LÊ essa coluna. O dono de uma instalação nova NÃO recebe o bloqueador. Este é o guia P0 de primeira impressão: o comprador leigo é instruído a baixar um autenticador e esperar um QR que nunca aparece — e quando não aparece, ele conclui que a instalação falhou. Reescrever como passo opcional apontando para Configurações › Segurança.


## `ARCHITECTURE.md`:11 · FALSA · gravidade alta

> - **Auth (Supabase Auth + `@supabase/ssr`)**: cookie SameSite=Strict, MFA TOTP forçado pra admin/super-admin. Sempre `getUser()` no server.

```bash
sed -n '60,72p' lib/auth/politica-mfa.ts
```

```
export function exigeCadastroDeMfa(p: PoliticaDeMfa): boolean {
  if (p.isPlatformAdmin && p.plataformaExige === true) return true;
  if (p.role === "admin" && p.empresaExige) return true;
  return false;
}
// empresaExigeMfa(): "AUSENTE e `false`, E ISSO E A DECISAO" — toda org existente chega sem a chave
```

**Sugestão:** CLAUDE.md já carrega a doutrina nova ('MFA TOTP é opcional e ligado por quem administra'); ARCHITECTURE.md, que é a porta de entrada linkada pelo README, ficou na regra antiga `isPlatformAdmin || role === "admin"`. Trocar por: duas políticas independentes que SOMAM (platform_admins.mfa_required e organizations.settings.security.mfa_required), padrão de ambas NÃO exigir, e registrar a distinção cadastrar≠provar (mfaEmDivida() não consulta a política).


## `docs/threat-model.md`:56 · FALSA · gravidade alta

> `checkRateLimit` existe (`lib/ai/dispatcher/rate-limit.ts`) e é chamado em **2** pontos do código: `/api/v1/webhooks/in/:token` e o dispatcher de IA. Nada mais. / Não há **nenhum** limite de tentativa em: **`/login`** … **`/signup`** … **`/team/accept-invite/:token`**

```bash
grep -rn 'auth/rate-limit' --include='*.ts' --include='*.tsx' app lib | grep -v '\.test\.'; grep -rn 'checkRateLimit(' --include='*.ts' app lib | grep -v '\.test\.'
```

```
app/actions/auth/signUp.ts:14:import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
app/actions/auth/requestPasswordReset.ts:8:import { authRateLimited, AUTH_LIMITS } ...
app/actions/auth/signInWithPassword.ts:16:} from "@/lib/auth/rate-limit";
app/team/accept-invite/[token]/page.tsx:14:import { authRateLimited, AUTH_LIMITS } ...
--- call sites de checkRateLimit ---
app/api/v1/webhooks/in/[token]/route.ts:58
lib/auth/rate-limit.ts:89 (por IP)
lib/auth/rate-limit.ts:94 (por identificador)
lib/auth/rate-limit.ts:165 (login_fail por conta)
lib/ai/dispatcher/index.ts:298
```

**Sugestão:** T1 é o único risco vermelho do documento, e a 'Conclusão honesta' inteira se apoia nele ('O que falta é estreito e específico: limite de tentativa na frente dos guards'). lib/auth/rate-limit.ts foi escrito para fechar exatamente isto — o cabeçalho dele cita a issue #64 e nomeia login, signup, recuperação e aceite de convite. RESSALVA HONESTA: sobrevive a sub-afirmação 'não existe lockout por conta' — rodei a MESMA sonda do doc (grep -rn 'lockout|failed_attempts' app lib supabase workers) e ela devolve ZERO. Mas rate-limit.ts:165 conta falha de login POR CONTA (chave auth:login_fail:id:<hash>), então a sonda do doc é cega para o mecanismo que existe. Rebaixar T1 e reescrever a conclusão.


## `docs/threat-model.md`:139 · FALSA · gravidade media

> ### T5 — Secrets ausentes do `.env.example` 🟠 CONFIRMADO — `IMPERSONATE_COOKIE_SECRET`, `INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY` estão em `lib/env.ts` e **não** no template. O operador não sabe que precisa gerá-los.

```bash
grep -n 'IMPERSONATE_COOKIE_SECRET\|INTERNAL_CRON_SECRET\|LGPD_SIGNING_KEY' .env.example .env.hostgator.example
```

```
.env.example:20:INTERNAL_CRON_SECRET=
.env.example:124:IMPERSONATE_COOKIE_SECRET=
.env.example:132:LGPD_SIGNING_KEY=
.env.hostgator.example:129:INTERNAL_CRON_SECRET=                    # opcional; vazio = usa INTERNAL_SECRET
.env.hostgator.example:133:IMPERSONATE_COOKIE_SECRET=               # openssl rand -hex 32  (>=32 chars)
.env.hostgator.example:134:LGPD_SIGNING_KEY=                        # openssl rand -hex 32
```

**Sugestão:** Os TRÊS estão nos DOIS templates, e o de produção ainda traz o comando de geração ao lado. T5 está fechado; sai do corpo e da tabela de prioridade (linha 195). Deixar risco resolvido marcado 🟠 CONFIRMADO gasta atenção no lugar errado e faz duvidar dos itens que ainda valem — T4 continua VERDADEIRO e merece a atenção que T5 rouba (medido: lib/auth/invite-token.ts:16 ainda tem o literal "dev-fallback", e INVITE_TOKEN_SECRET dá 0 ocorrências em lib/env.ts, .env.example E .env.hostgator.example).


## `docs/threat-model.md`:153 · FALSA · gravidade media

> **Ressalva:** esse E2E **não roda no CI** — e é a única prova automatizada do guard. … | T6 | Guard de SSRF existe; o E2E que o prova não roda no CI | 🟢 |

```bash
grep -n 'vps-webhook-outbound-ssrf' .github/workflows/e2e.yml; gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
```

```
.github/workflows/e2e.yml:108:        degradacao-silenciosa.spec.ts vps-webhook-outbound-ssrf.spec.ts
verify, build-and-size, invariants, e2e, imagens-ok
```

**Sugestão:** A spec está na lista de EXECUÇÃO do e2e.yml (não na FORA_DO_CI, que contém exatamente um item: vps-fresh-onboarding.spec.ts), e o job `e2e` é check obrigatório. A ressalva inteira caiu — e hoje ela desencoraja confiar na única defesa que o próprio documento chama de 'a defesa mais bem feita do repo'. Repete na tabela de prioridade, linha 197.


## `docs/threat-model.md`:91 · FALSA · gravidade media

> `createAdminClient` (service role, **bypassa RLS**) é importado em **89 dos 169** route handlers de `app/api/**` (dos quais 166 estão sob `/api/v1/`). … os **56 arquivos de invariante em `tests/invariants/` rodam no CI**

```bash
find app/api -name route.ts | wc -l; grep -rl 'createAdminClient' app/api --include=route.ts | wc -l; find app/api/v1 -name route.ts | wc -l; ls tests/invariants/*.test.ts | wc -l
```

```
203   (route.ts em app/api/**)
119   (destes, importam createAdminClient)
201   (sob /api/v1/)
103   (arquivos *.test.ts em tests/invariants/)
```

**Sugestão:** Os quatro números envelheceram na mesma direção, então a LEITURA não muda de sinal — mas a magnitude sim: 30 handlers novos com service role entraram desde a auditoria, num documento que diz que a mitigação é 'revisão humana', sem lint rule. O '56 arquivos de invariante' reaparece na linha 202, dentro da 'Conclusão honesta' — é o número que sustenta o rebaixamento de T3 de 🔴 para 🟠. Recontar e recarimbar o `audited_against` do front-matter (hoje 789dfa6, 2026-07-27).


## `docs/threat-model.md`:40 · FALSA · gravidade media

> | `/api/v1/cron/*` (9 rotas) | `Bearer INTERNAL_CRON_SECRET\|INTERNAL_SECRET`, **fail-closed** | ❌ | … **Os 9 crons e `/api/internal/*`**

```bash
find app/api/v1/cron -mindepth 1 -maxdepth 1 -type d | wc -l; grep -oE 'api/v1/cron/[a-z-]+' docker/scheduler/entrypoint.sh | sort -u | wc -l
```

```
16   (diretorios de rota em app/api/v1/cron)
16   (crons agendados em docker/scheduler/entrypoint.sh)
```

**Sugestão:** São 16, não 9 — e as duas medições independentes (disco e agendador) concordam, o que de quebra confirma que tests/unit/cron-routes-scheduled.test.ts está fazendo o trabalho dele. A contagem errada aparece duas vezes (tabela §1 e bullet de T1). O MESMO erro está em ARCHITECTURE.md:65 ('drenados pelos **10** endpoints em `app/api/v1/cron/`') — duas fontes, dois números, nenhum certo. Quem consertar um precisa grepar o outro.


## `ARCHITECTURE.md`:37 · FALSA · gravidade media

> **Rota autenticada de tenant** (`/api/v1/*`, 166 handlers):

```bash
find app/api/v1 -name route.ts | wc -l; find app/api/v1 -name route.ts -not -path 'app/api/v1/cron/*' | wc -l; find app/api/v1 -name route.ts -not -path 'app/api/v1/cron/*' -not -path 'app/api/v1/webhooks/*' | wc -l; git log -1 --format='%h %ad %s' --date=short -S'166 handlers' -- ARCHITECTURE.md
```

```
201  (todos os route.ts sob /api/v1)
185  (excluindo cron)
176  (excluindo cron e webhooks — a regua mais generosa para o texto "rota autenticada de tenant")
9152ab27 2026-07-30 docs(auditoria): remede os numeros e declara a regua de cada um
```

**Sugestão:** Medi com três réguas porque o doc não declara a dele; até a mais generosa (176) fica 10 acima de 166. O número foi escrito em 2026-07-30 pelo commit 9152ab27, cujo título é literalmente 'remede os numeros e declara a regua de cada um' — ou seja, uma recontagem deliberada apodreceu em duas semanas. O conserto que dura é declarar a régua NO texto e citar o comando, como CLAUDE.md já faz para as specs e2e.


## `ARCHITECTURE.md`:16 · FALSA · gravidade media

> ⚠️ Aplicado hoje em apenas 2 pontos (webhook de captação e dispatcher de IA) — o surface público de auth está sem.

```bash
grep -rn 'auth/rate-limit' --include='*.ts' --include='*.tsx' app | grep -v '\.test\.'
```

```
app/actions/auth/signUp.ts:14
app/actions/auth/requestPasswordReset.ts:8
app/actions/auth/signInWithPassword.ts:16
app/team/accept-invite/[token]/page.tsx:14
```

**Sugestão:** Mesma família do T1 do threat-model, propagada para o doc irmão. 'O surface público de auth está sem' é exatamente o que lib/auth/rate-limit.ts fechou, nos quatro pontos. É o caso 'onde mais eu fiz isto': quem consertar o threat-model precisa grepar 'rate limit' nos demais .md, senão a frase errada sobrevive aqui.


## `docs/testing/user-journey-map.md`:28 · FALSA · gravidade media

> Gate: `organizations.onboarded_at`. MFA obrigatório pra admin logo após o wizard.

```bash
sed -n '65p;73p' docs/testing/user-journey-map.md | cut -c1-200
```

```
linha 65: | J1.33 | A verificacao em duas etapas deixa de ser imposta | ... ambos com padrao nao-exigir - **PASS** (`tests/e2e/mfa-opcional.spec.ts`, `lib/auth/politica-mfa.test.ts`) |
linha 73: > **Achado ABERTO (nao e regressao, e primeira impressao):** ... O MFA obrigatorio para `admin` e decisao de produto e esta correto; o que esta errado e ele aparecer como surpresa ...
```

**Sugestão:** O documento se contradiz internamente em três lugares: a linha 28 (cabeçalho da jornada J1) e a linha 73 ('Achado ABERTO … o MFA obrigatório para admin é decisão de produto e está correto') afirmam o oposto do que a linha 65 (J1.33, marcada PASS) documenta ter mudado. Quem lê o mapa de cima para baixo — que é como se lê um mapa de jornadas — encontra a versão velha primeiro e para ali. O 'Achado ABERTO' da linha 73 foi fechado pelo próprio J1.33 e precisa virar 'resolvido em', não seguir aberto.


## `docs/testing/user-journey-map.md`:17 · FALSA · gravidade media

> - Evidência: screenshot/trace em `.superpowers/evidence/vps-qa/`.

```bash
grep -n 'superpowers' .gitignore; git ls-files .superpowers | wc -l; ls -d .superpowers/evidence/vps-qa
```

```
.gitignore:98:.superpowers/
.gitignore:106:.superpowers/evidence/
0   (arquivos rastreados sob .superpowers/)
ls: .superpowers/evidence/vps-qa: No such file or directory
```

**Sugestão:** O doc aponta a evidência de TODAS as jornadas para um diretório que o .gitignore exclui duas vezes, que tem zero arquivos rastreados e que não existe nem no disco desta árvore. Ponteiro morto se lê como prova: quem audita conclui 'a evidência existe, só não abri'. Mesmo problema nas linhas 198 e 214. A evidência versionada do projeto mora em `evidence/` (239 PNGs rastreados) — é para lá que as três linhas devem apontar.


## `triagem/references/complemento-do-ci.md`:178 · FALSA · gravidade alta

> **Falta um passo do mantenedor:** incluir `build-and-push` na branch protection. Enquanto não estiver lá, o check informa mas não barra.

```bash
gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'; sed -n '155,178p' .github/workflows/publish-image.yml
```

```
verify, build-and-size, invariants, e2e, imagens-ok
--- publish-image.yml ---
  # Job de fachada: da UM nome estavel para a branch protection exigir.
  imagens-ok:
    needs: [build-and-push]
    steps:
      - name: Falhar se qualquer imagem nao construiu
        run: [ "${{ needs.build-and-push.result }}" = "success" ]
```

**Sugestão:** A pendência foi resolvida por outro caminho: em vez de exigir `build-and-push` direto, criou-se o job de fachada `imagens-ok`, que depende dele, falha junto, e É check obrigatório. O nome literal 'build-and-push' de fato não está na protection — então quem confere pelo NOME conclui que a pendência continua. Mas a CONSEQUÊNCIA afirmada ('informa mas não barra') é falsa, e é a consequência que decide se um triador deixa passar um PR que quebra a imagem. Na mesma página, linha 171 diz 'os quatro obrigatórios' — são cinco.


## `docs/deploy-hostgator/README.md`:49 · FRAGIL · gravidade media

> **Plano recomendado: VPS NVMe 4** (2 vCPU / 4 GB / 100 GB NVMe) — é exatamente o mínimo que o runbook de produção declara. A stack sobe num NVMe 2, mas opera no limite.

```bash
grep -rniE 'turing|cartesius|nvme 4|nvme 2' --include='*.md' --include='*.sh' . | grep -v node_modules; grep -niE 'vcpu|RAM|GB|mínimo|swap' docs/runbooks/deploy.md
```

```
hostgator-setup-kit/comecar.sh:125:    - Plano VPS Turing (ou superior) - 2 vCPU e 4 GB de RAM
hostgator-setup-kit/comecar.sh:126:      O plano Cartesius (1 vCPU / 2 GB) NAO da conta
hostgator-setup-kit/README.md:7 -> Turing
docs/runbooks/waha-hostgator.md:18 -> Turing
docs/specs/03-spec-whatsapp-waha.md:61 e :1940 -> Turing
docs/specs/08-spec-deploy-observability.md:80 e :1367 -> Turing
docs/prd/03-prd-whatsapp-waha.md:369 -> Turing
docs/presentation/{pitch-deck,HANDOFF}.md -> Turing
docs/deploy-hostgator/README.md:49 -> "VPS NVMe 4"   <-- unica ocorrencia no repo
--- runbook ---
docs/runbook
```

**Sugestão:** 'VPS NVMe 4' aparece UMA vez no repo inteiro; o artefato executável (comecar.sh:125 — o script que este mesmo guia manda o comprador rodar) e outros 9 documentos nomeiam 'VPS Turing'. O comprador leigo é mandado a uma caixinha com nome que o resto do produto não conhece, e o script que ele roda em seguida lhe diz outro nome. FRAGIL e não FALSA porque não consigo decidir qual está certo sem o catálogo atual da HostGator — mas os dois não podem estar certos, e a régua natural é o script. A segunda metade da frase também não se sustenta: docs/runbooks/deploy.md:108 declara '>= 4 GB de RAM ou swap' e diz explicitamente que é requisito do CAMINHO DE EXCEÇÃO (build na VPS), 'não da operação'.


## `tests/invariants/README.md`:35 · FALSA · gravidade media

> ## O que a suíte prova hoje\n\n- `rls-isolation.test.ts` — cria 2 orgs + 1 usuário em cada e prova que o usuário da org A lê **0 rows** da org B …

```bash
ls tests/invariants/*.test.ts | wc -l
```

```
103
```

**Sugestão:** O cabeçalho promete o inventário do que a suíte prova e lista 1 de 103 arquivos. É o README que todo contribuidor abre antes de escrever invariante novo — a seção seguinte é literalmente 'Regras pra adicionar invariante novo' — então ele decide o escopo do test:db com base numa foto de quando a suíte tinha um arquivo. Trocar a lista fixa por 'rode `ls tests/invariants/*.test.ts`' mais os 3-4 invariantes estruturais que merecem destaque; listar 103 à mão só recria o problema daqui a um mês.


## `tests/e2e/README.md`:5 · FALSA · gravidade media

> ## Suítes a criar\n\n- `auth.spec.ts` — login com MFA, refresh, logout\n- `tenant-isolation.spec.ts` — **GATE OBRIGATÓRIO**: cria 2 tenants e valida que A não vê dados de B em nenhum endpoint\n- `lgpd.spec.ts` … `whatsapp-inbox.spec.ts` … `kanban.spec.ts` … `super-admin.spec.ts`

```bash
ls tests/e2e/*.spec.ts | wc -l; for p in auth tenant-isolation lgpd whatsapp-inbox kanban super-admin; do printf '%-22s ' $p; [ -e tests/e2e/$p.spec.ts ] && echo OK || echo AUSENTE; done
```

```
48   (specs no disco)
auth                   OK
tenant-isolation       AUSENTE
lgpd                   AUSENTE
whatsapp-inbox         AUSENTE
kanban                 AUSENTE
super-admin            AUSENTE
```

**Sugestão:** 48 specs existem; 5 das 6 'a criar' nunca foram criadas com esses nomes (a cobertura veio com outros). O pior item é `tenant-isolation.spec.ts`, marcado **GATE OBRIGATÓRIO** — um contribuidor lê isso e conclui que existe um gate e2e de isolamento que não existe: o isolamento é provado por tests/invariants/, no job `invariants`, não por Playwright. O doc também manda `npm run test:e2e` num repo padronizado em pnpm. tests/unit/README.md tem o mesmo defeito: medi os 7 arquivos de 'Foco' que ele lista e os 7 estão ausentes.


## `lib/waha/README.md`:3 · FALSA · gravidade baixa

> > Placeholder. Cliente real virá da Spec 03 — WhatsApp via WAHA Plus.

```bash
ls lib/waha/*.ts | wc -l; ls lib/waha/; ls lib/ai/ | wc -l; for p in auth idempotency rate-limit pagination audit cors; do printf '%-24s ' lib/api/$p.ts; [ -e lib/api/$p.ts ] && echo OK || echo AUSENTE; done
```

```
10   (arquivos .ts em lib/waha/)
client.ts  ingest.ts  media-send.ts  message-id.ts  send.ts  webhook-auth.ts  (+4 .test.ts)
37   (entradas em lib/ai/: dispatcher, rag, guardrails, runtime, skills, agents, budget, ...)
lib/api/auth.ts          AUSENTE
lib/api/idempotency.ts   AUSENTE
lib/api/rate-limit.ts    AUSENTE
lib/api/pagination.ts    AUSENTE
lib/api/audit.ts         AUSENTE
lib/api/cors.ts          AUSENTE
```

**Sugestão:** lib/waha/ é o caminho de ingestão de WhatsApp em produção — ingest.ts é citado por CLAUDE.md e pelo threat-model como o guard HMAC da borda — e continua rotulado 'Placeholder'. Idem lib/ai/README.md:3 ('Placeholder. Implementação real virá da Spec 05') com 37 entradas no diretório. Gravidade baixa porque ninguém decide errado por causa disso, mas é ruído que ensina a ignorar rótulo. IMPORTANTE, no sentido oposto: lib/api/README.md:21 ('A adicionar (próximas specs)') parece o mesmo caso e NÃO é — medi os 6 arquivos listados e os 6 realmente não existem. Essa seção está certa e não deve ser 'corrigida' junto.


## `supabase/migrations/MANIFEST.md`:63 · FALSA · gravidade media

> | `20260428000000` | `0016_lgpd_emergency_scope` | EPIC-08 wave 3: lgpd_requests.emergency (boolean, default false) + scope (text check 'contact'/'tenant', default 'contact') + partial index lgpd_requests_emergency_idx …

```bash
ls supabase/migrations/ | grep -c 0016_lgpd; find supabase -name '*lgpd_emergency*'; grep -in 'emergency' supabase/baseline.sql | head -2
```

```
0   (nenhum arquivo *_0016_lgpd_emergency_scope.sql)
(find: nenhum resultado)
baseline.sql:1626:    "emergency" boolean DEFAULT false NOT NULL,
baseline.sql:2544:CREATE INDEX "lgpd_requests_emergency_idx" ON "public"."lgpd_requests" ...
```

**Sugestão:** O MANIFEST declara a 0016 na tabela 'Applied', mas o arquivo de migration não existe em lugar nenhum. O efeito ESTÁ no baseline.sql, então o self-hoster recebe — mas a doutrina do CLAUDE.md diz que 'quem clonou uma versão antiga do banco precisa conseguir atualizar aplicando as migrations em ordem', e por esse caminho a 0016 nunca chega. É o modo de falha do item 11 do DoD, invertido. Diffei os 147 arquivos contra as 145 linhas: este é o ÚNICO caso. Os outros dois desencontros são inofensivos e não devem ser 'consertados' — 0013_ai_faq_items e 0021_incidents estão no MANIFEST com a coluna de timestamp preenchida como *(wave 5)* / *(wave 11)* em vez do carimbo de 14 dígitos, e 00001_initial_schema.sql (só extensions) não tem linha.


## `docs/handoffs/HANDOFF-indice-de-atrito.md`:571 · FALSA · gravidade baixa

> Evidência: [caminho feliz]\(passo4-inbox-demandas.png\) · [sob falha]\(passo4-inbox-demandas-falha.png\).

```bash
python3 checklinks.py  (resolve todo link markdown relativo de `git ls-files '*.md'` contra o diretorio do arquivo); find . -name passo4-inbox-demandas.png; sed -n '188p' tests/unit/evidencia-citada.test.ts
```

```
docs/handoffs/HANDOFF-indice-de-atrito.md:571,572,637,638,731,732,918  ->  7 links .png
resolvem para docs/handoffs/<nome>.png  ->  NAO EXISTEM
os arquivos existem em ./evidence/<nome>.png
--- guarda ---
tests/unit/evidencia-citada.test.ts:188:  if (!limpa.includes("/")) return path.posix.join(base, limpa);   // base = "evidence"
--- varredura completa: 18 links relativos quebrados no repo ---
```

**Sugestão:** Ponto cego do guarda, não ausência de guarda: tests/unit/evidencia-citada.test.ts resolve nome sem barra como evidence/<nome> e por isso considera os 7 links válidos. Ele prova que o ARQUIVO existe, nunca que o LINK resolve. Renderizado no GitHub, cada um aponta para docs/handoffs/<nome>.png e dá 404 para quem clica em 'Evidência'. Total da varredura em todo o repo: 18 links relativos quebrados — 2 são falso positivo MEU (docs/handoffs/BRIEFING-crm-vivo.md:1293 e HANDOFF-crm-vivo.md:3019 usam a palavra 'caminho' como placeholder ao EXPLICAR sintaxe de link), 7 são estes, 8 são .md dentro de evidence/ que escrevem o caminho a partir da raiz do repo estando já em evidence/ (os alvos existem; a resolução é que erra), e 1 é ausência real: evidence/ia-360-w4/medicao-vazamento/RELATORIO.md:126 a
