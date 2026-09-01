# Onda 7 — Alarme de orçamento de IA: medição, risco e desenho da ligação

> **Régua desta medição.** Worktree `/Users/rafaelmelgaco/SonghaiCRM-marca`,
> branch `feat/marca-o-que-faltou`, SHA `8c7a8dc6`, working tree limpo no início
> da sessão. Tudo abaixo é leitura estática de código (grep/read).
>
> **Alvo em movimento, declarado:** durante a redação a branch avançou para
> `a875faa7`. `git diff --name-only 8c7a8dc6..a875faa7` devolve **um** arquivo,
> `HANDOFF-marca-propria.md` — nenhum arquivo medido nesta página mudou, e as
> citações de `HANDOFF-marca-propria.md:1038-1043` foram reconferidas no HEAD
> novo (seguem nessas linhas). A medição vale para os dois SHAs. Também apareceu
> `M tests/invariants/marca-logo.test.ts` no working tree, de outra sessão; não
> foi tocado aqui.
> **NÃO MEDIDO em banco:** nenhuma query foi executada, nenhum teste rodado — o
> daemon do Docker está fora do ar (é a mesma razão pela qual a onda 7 não foi
> feita). Toda afirmação sobre *comportamento em runtime* nesta página é
> inferência a partir do código lido, e está marcada como tal onde importa.

---

## (a) O que medi

### a.1 — A função morta e o que ela faz

`runBudgetChecker()` está em
`/Users/rafaelmelgaco/SonghaiCRM-marca/workers/ai-budget-checker.cron.ts:114`.

Ela faz **duas coisas distintas**, e a distinção é o eixo do desenho:

| # | O quê | Onde | Efeito |
|---|---|---|---|
| 1 | **Avisa** | `ai-budget-checker.cron.ts:147-198` | Emite `ai.budget_warning` no `event_log`, carimba `last_alarm_sent_at` (cooldown 24h, `:39` + `:145`) e dispara e-mail aos admins via `sendEmail` (`:179`) com o template `lib/email/templates/ai-budget-alarm` (`:20`) |
| 2 | **Bloqueia** | `ai-budget-checker.cron.ts:201-226` | Em `pct >= 100`, escreve `is_throttled: true` **ou** `is_disabled: true` conforme `action_at_100pct` (`:202-204`), e emite `ai.budget_throttled` |

Portanto: **avisa E bloqueia**, e o bloqueio é uma escrita de flag — não uma
recusa direta. Quem nega serviço é quem *lê* a flag. Isso é medido em a.3.

Confirmação de que não há chamador: `grep -rn "runBudgetChecker"` devolve apenas
a definição (`:114`), o comentário do cabeçalho (`:12`), duas chamadas em
`scripts/qa-wave-11.ts:404` e `:441`, e a linha de dívida em
`tests/unit/branding.test.ts:280`. Não há diretório em `app/api/v1/cron/` nem
linha em `docker/scheduler/entrypoint.sh`.

### a.2 — Quem grava o contador de gasto (a pergunta que decide tudo)

**O contador NÃO está travado em 0.** Ele é alimentado por gatilho Postgres,
e desde 2026-07-30 alcança o runtime que realmente gasta.

- Função do gatilho: `public.fn_update_budget_consumption()` —
  `supabase/migrations/20260429140000_0022_ai_budget_trigger.sql:37-53`, hoje em
  `supabase/baseline.sql:747-761`. Corpo: `insert ... on conflict do update set
  current_month_consumed_cents = current_month_consumed_cents + coalesce(NEW.cost_cents, 0)`.
- Pendurada em `ai_invocations` (0022, `:57-61`) **e** em `llm_calls`
  (`supabase/migrations/20260730180000_0095_budget_conta_llm_calls.sql:15-18`,
  espelhada em `baseline.sql:8640-8643`).
- A 0095 existe exatamente porque **antes dela** o contador ficava em zero: o
  gatilho só existia em `ai_invocations`, e o consumidor padrão
  (`AGENT_DISPATCH_CONSUMER=engine`) grava em `llm_calls`. Está escrito na
  própria migration, `0095:3-10`.

**Mas o contador não tem virada de mês.** Três medições, juntas:

1. O gatilho **soma e nunca zera**, e não olha data —
   `baseline.sql:751-760`. A 0140 diz isso com todas as letras:
   `supabase/migrations/20260808050000_0140_orcamento_nao_conta_backfill.sql:6-9`
   — *"soma `NEW.cost_cents` … **sem olhar a data da linha**"*.
2. Quem deveria virar o mês é `runBudgetReset()`, em
   `workers/ai-budget-reset.cron.ts:48` — que zera o contador (`:70`), avança
   `current_period_start` (`:71`) e baixa `is_throttled` (`:72`).
   **`runBudgetReset()` também está morto**: `grep -rn "runBudgetReset"` só
   encontra a definição e `scripts/qa-wave-11.ts:470`. Sem rota, sem linha no
   scheduler.
3. O único recomputo que roda em produção é o **apêndice do baseline** da 0140
   (`supabase/baseline.sql:10304-10318`), que **atribui** (não soma) o gasto real
   do mês corrente. Ele roda no `install.sh` e em **todo** `update.sh`.

Logo, a semântica real de `current_month_consumed_cents` hoje é:

> *gasto do mês corrente medido no instante do último `update.sh`, **mais** tudo
> o que o gatilho somou desde então — atravessando viradas de mês sem zerar.*

Ele é exato logo depois de um `update.sh` e **deriva para cima** com o tempo.
Quanto mais antiga a instalação, mais o número mente para mais.

`current_period_start` é pior: seu valor vem do DEFAULT da coluna no INSERT da
linha (`baseline.sql:1057`), e o recomputo da 0140 atualiza **apenas**
`current_month_consumed_cents` e `updated_at` (`baseline.sql:10315-10318`) —
nunca o period_start. Como o reset está morto, **`current_period_start` fica
congelado no mês em que a linha nasceu, para sempre.** A tela mostra esse valor
cru: `components/ai/BudgetCard.tsx:68-70`, *"Período iniciado em
{status.current_period_start}"*.

### a.3 — Quem LÊ `is_throttled` / `is_disabled` (o eixo do risco)

Quatro leitores. **Três estão mortos ou depreciados; o quarto é a tela.**

| Leitor | Onde | Está vivo? | Medição |
|---|---|---|---|
| `checkTenantBudget` | `lib/ai/dispatcher/budget.ts:20`, chamado só em `lib/ai/dispatcher/index.ts:280` | **NÃO** | `lib/ai/dispatcher/index.ts:1-4` é `@deprecated … fora do caminho quente`. A rota que o acionava, `app/api/v1/cron/agent-dispatcher/route.ts:41-43`, é **no-op permanente** e devolve `ok({ skipped: true, deprecated: true })` |
| `workers/ai-response-worker.ts:413` (`skip("budget_throttled")`) | worker legado | **NÃO** | `processMessageReceived` é importado **apenas** por testes (`tests/unit/ai-response-worker-*.test.ts`, `tests/unit/ai-response-bot-veto.test.ts`, `tests/unit/telemetria-diz-o-modelo-do-painel.test.ts`) e por `scripts/qa-wave-11.ts:499`. Nenhum chamador de produção |
| `isBudgetExhausted` | `lib/ai/budget/check.ts:52` | **NÃO** | **Zero chamadores.** O único outro hit do grep é a string dentro de um regex em `scripts/qa-wave-11.ts:524` |
| `BudgetCard` (badges) | `components/ai/BudgetCard.tsx:74-80` | **SIM** | Renderiza `<Badge>Desabilitado</Badge>` e `<Badge>Pausado</Badge>` a partir das flags, em `/app/ai/usage` |

O runtime de produção é o agent-engine: `AGENT_DISPATCH_CONSUMER` faz default
para `engine` (`.env.example:174`, `.env.hostgator.example:197`), e o cron nativo
é no-op **em qualquer valor** (`app/api/v1/cron/agent-dispatcher/route.test.ts:5`).

### a.4 — O enforcement que EXISTE e é vivo (sistema paralelo)

Há um **segundo** sistema de orçamento, independente do `ai_budgets`, e é ele
que de fato pausa a IA hoje:

`lib/agent-engine/edge/llm/run-model-call.ts:116-142` — `assertBudget()`:

- **Teto:** `organizations.settings.llm.monthly_budget_cents`
  (`credentials.ts:102`, `:199`). O default é **`null`** (`credentials.ts:110`),
  e `null` significa **sem limite**: `run-model-call.ts:117-119` retorna cedo.
- **Gasto:** recomputado a cada chamada, direto da fonte —
  `select coalesce(sum(cost_cents),0) from llm_calls where organization_id = $1
  and created_at >= date_trunc('month', now())` (`:121-124`). **Sem estado, sem
  deriva, sempre o mês corrente.**
- **Bloqueio:** lança `LlmBudgetExceededError` **antes de qualquer byte ao
  provider** (`:141`).
- **Aviso:** insere `agent_inbox_items` kind `budget_exceeded`, severity
  `critical`, deduplicado por item aberto (`:130-140`).

Ou seja: os dois sistemas discordam em **tudo** — teto diferente, fonte de gasto
diferente, default oposto (`null` = ilimitado vs `5000` = R$ 50).

### a.5 — `monthly_limit_cents`: definição, default e UI

- Coluna: `supabase/baseline.sql:1053` —
  `"monthly_limit_cents" integer DEFAULT 5000 NOT NULL`. **Default R$ 50,00,
  NOT NULL.** Ninguém "preenche" esse campo para ele existir: ele já vem
  preenchido.
- **Toda organização ganha uma linha** em `ai_budgets`: os blocos do apêndice
  fazem `insert into public.ai_budgets ... select o.id from public.organizations o`
  (`baseline.sql:8653-8657` e `:10304-10310`), no install **e** em todo update.
- O scan do checker é `.gt("monthly_limit_cents", 0)`
  (`ai-budget-checker.cron.ts:127`). Como o default é 5000 > 0, **toda
  organização está no escopo do alarme por construção.**
- UI: `/app/ai/usage` (`app/app/ai/usage/page.tsx`, gate `manager+` em `:26`) →
  `components/ai/BudgetCard.tsx` → `EditBudgetDialog` (`:80`) →
  `PATCH /api/v1/ai/budget` (`app/api/v1/ai/budget/route.ts:44`, gate `admin`
  em `:46`). O schema aceita `monthly_limit_cents`, `alarm_threshold_pct` e
  `action_at_100pct` (`:21-32`).
- Porta na navegação: `lib/navigation/registry.ts:338` → `/app/ai/usage`.
  A Central de avisos tem porta própria: `registry.ts:305` → `/app/ai/inbox`.

**Consequência medida:** a tela do tenant edita `ai_budgets.monthly_limit_cents`,
que **nenhum caminho vivo lê para decidir**; o enforcement vivo lê
`organizations.settings.llm.monthly_budget_cents`, que **não tem UI nenhuma** —
o único escritor é `scripts/smoke-llm.ts:168`. O próprio repo está confuso sobre
qual é canônico: `app/api/v1/admin/tenants/[id]/health/route.ts:184` comenta
*"`monthly_budget_cents` → `monthly_limit_cents`: mesmo dado, nome real"* e lê a
tabela.

### a.6 — Convenções de `app/api/v1/cron/` e do scheduler

- São 16 rotas. **Não existe helper de auth compartilhado** — o guard é
  copiado inline em todas, em 3 variantes sintáticas. As env vars são
  `lib/env.ts:47` (`INTERNAL_SECRET`, obrigatória) e `:49`
  (`INTERNAL_CRON_SECRET`, opcional, default `""`).
- Guard canônico (variante majoritária, 10 rotas), verbatim de
  `app/api/v1/cron/risk-watcher/route.ts:52-57`:
  ```ts
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  ```
- Todas as 16 declaram `export const dynamic = "force-dynamic"`; **nenhuma**
  declara `runtime`. Todas usam `ok()`/`fail()` de `lib/api/wrappers.ts` com
  `requestId = randomUUID()`.
- Padrão de robustez (`risk-watcher/route.ts:82-108`): teto de lote em
  constante de módulo, `try/catch` **por item** para que um tenant ruim não
  derrube a passada, contadores devolvidos no `ok()`, nunca `throw`.
- Middleware: `lib/auth/public-paths.ts:16` já isenta `/^\/api\/v1\/cron\//` por
  prefixo — rota nova não exige mudança lá.
- **Agendamento é obrigatório e vigiado, sem allowlist.**
  `tests/unit/cron-routes-scheduled.test.ts:58-66` compara *todo diretório* de
  `app/api/v1/cron/` com os literais `api/v1/cron/<rota>` de
  `docker/scheduler/entrypoint.sh`, nos dois sentidos. Não há mecanismo de
  exceção. `tests/shell/scheduler-entrypoint.test.sh:59-62` repete a checagem
  **contra o crontab gerado** (`pnpm test:shell`, gate `ci.yml:49-50`).
  Precedente: cada feature com cron ganha também um caso "está agendado" no seu
  próprio teste (`tests/unit/cron-contact-phones.test.ts:217-222`,
  `tests/unit/channel-health-aviso.test.ts:229-240`).

### a.7 — `agent_inbox_items`: o precedente que existe

- Vocabulário com `CHECK` reconstruído **num bloco único** —
  `supabase/baseline.sql:9100-9140+`. O comentário em `:9124-9130` explica por
  que é um bloco só: reconstruir a mesma constraint em N blocos quebra o
  `update.sh` de clones (issue #159).
- Espelho obrigatório em TypeScript: `lib/agent-engine/db/repository.ts:26-45`
  (`InboxKind`), vigiado por
  `tests/invariants/vocabulario-banco-x-typescript.test.ts` contra Postgres real
  (`repository.ts:16-19`).
- Rótulo leigo obrigatório: `lib/ai/agent-inbox-copy.ts:20` — `KIND_LABEL` é
  `satisfies Record<InboxKind, string>`, então **kind novo sem rótulo = erro de
  build** (`:12-19`).
- **`budget_exceeded` já existe** (`baseline.sql:9108`, `repository.ts:30`) com
  o rótulo *"O orçamento de IA foi atingido"* (`agent-inbox-copy.ts:24`). É
  escrito hoje, em produção, por `assertBudget`. **Não existe** um kind de
  *aviso* (80%) — só o de estouro.
- Padrão de dedup do repo: `insert ... select ... where not exists (select 1
  ... where kind = 'X' and status = 'open')` (`run-model-call.ts:130-140`).

### a.8 — Eventos e o gate de consumidor

`ai.budget_warning`, `ai.budget_throttled` e `ai.budget_reset` **não têm nenhum
leitor** fora de `scripts/qa-wave-11.ts`. Isso *não* reprova o gate:
`tests/unit/evento-comando-tem-consumidor.test.ts:20-30` só exige consumidor para
a família `*_requested` (comandos); estes são fatos. Mas pela doutrina do Sistema
Vivo (invariante 3), fato que ninguém lê e que não chega à tela é estoque morto —
tratado no desenho.

*Achado lateral, fora do escopo, registrado para não se perder:* o KPI do painel
de plataforma chama `admin.rpc("fn_admin_ai_budget_warning_count")`
(`app/api/v1/admin/dashboard/kpis/route.ts:93-96`), e **essa função não existe em
lugar nenhum do repositório** (grep global: 1 hit, a própria chamada). O código
tem fallback silencioso (`:98-102`).

---

## (b) O risco: o que se confirma e o que se desmente

O risco herdado (`HANDOFF-marca-propria.md:1038-1043`) diz:

> *"Numa instalação em que alguém preencheu `monthly_limit_cents` há meses — com
> o contador travado em 0 — o primeiro tick estrangula a IA da organização, e o
> cliente descobre por um agente que parou de responder no WhatsApp."*

Três afirmações. Medindo uma a uma:

### ❌ DESMENTIDO — "o contador travado em 0"

Falso desde a migration 0095 (2026-07-30). O gatilho alimenta o contador a partir
de `llm_calls`, que é a tabela do runtime de produção (a.2). O erro é **oposto**:
o contador **não zera na virada do mês** e **deriva para cima**. Uma instalação
que não roda `update.sh` há três meses compara ~três meses de gasto contra um
teto **mensal**.

Isso não torna o risco menor — torna-o **maior**, e por outra razão. A premissa
"o contador é 0, então nada dispara" levaria a subestimar o primeiro tick. O
número real é o que mais provavelmente está **acima** de 100%.

### ❌ DESMENTIDO — "alguém preencheu `monthly_limit_cents`"

Ninguém precisa preencher. `DEFAULT 5000 NOT NULL` (`baseline.sql:1053`), e todo
`install.sh`/`update.sh` cria a linha para **toda** organização
(`baseline.sql:10304-10310`). O escopo do alarme não é "quem configurou": é
**todo mundo**, contra um teto de R$ 50/mês que ninguém escolheu.

Um alarme a 80% de um número que o usuário nunca digitou é falso alarme **por
construção**. Esta é a restrição de desenho mais importante desta página.

### ❌ DESMENTIDO — "estrangula a IA / o agente para de responder no WhatsApp"

Como consequência do primeiro tick, **não acontece**. Escrever `is_throttled`
não nega serviço a ninguém numa instalação padrão: os três leitores que
transformavam a flag em recusa estão mortos ou depreciados (a.3). O agente
continua respondendo.

**Mas o dano real não é menor — é outro, e em parte é pior:**

1. **A tela passa a mentir.** `BudgetCard.tsx:76-77` pinta o badge **"Pausado"**
   a partir de `is_throttled`. O primeiro tick escreve "Pausado" na tela do
   tenant enquanto o agente atende normalmente. É o inverso do controle
   decorativo: um *estado* decorativo — e um estado falso é pior que ausente,
   porque quem o lê age sobre ele.
2. **O estado não tem saída.** O **único** escritor de `is_throttled: false` em
   todo o repositório é `workers/ai-budget-reset.cron.ts:72` — que também está
   morto. O apêndice do baseline não toca a flag. Logo: **ligar o checker sem
   ligar o reset cria um estado permanente do qual nada, nem o `update.sh`,
   tira a instalação.** Este é o achado que mais muda a decisão.
3. **E-mail crítico para todos os admins**, disparado de um contador que
   super-conta, contra um teto que ninguém escolheu (`:179`).
4. **Mina de efeito retardado.** No dia em que alguém reanimar
   `ai-response-worker` ou `lib/ai/dispatcher`, a flag — travada em `true`
   desde o primeiro tick — vira negação de serviço real e instantânea, sem que
   nenhuma mudança daquele PR pareça tocar em orçamento.

### Veredito

O risco é **real e merece o rótulo de maior do plano**, mas a causa declarada
está errada em todos os três termos. Corrigido:

> Ligar `runBudgetChecker()` como está escreveria, na primeira passada, um estado
> **permanente e falso** ("Pausado") na tela de praticamente toda organização —
> a partir de um contador que super-conta e de um teto que ninguém escolheu —
> sem nenhum caminho de volta, e deixando armada uma negação de serviço para
> quem reanimar qualquer um dos três leitores hoje mortos.

E há um defeito **pré-existente**, que a onda 7 não causou mas não pode ignorar
(a.5): a tela de orçamento do tenant já é decorativa — ela edita um teto que
nenhum caminho vivo consulta, enquanto o teto que realmente pausa a IA não tem
UI. Alarmar sobre o teto errado só aprofundaria isso.

---

## (c) O desenho escolhido

### c.0 — O princípio da escolha

Duas frases guiam tudo:

> **O que já está vivo e correto não se duplica: `assertBudget` já bloqueia, e
> bloqueia certo. O que falta não é bloqueio — é aviso ANTES, e um número
> honesto na tela.**

> **Não se agenda uma escrita que só pode produzir um estado falso e sem saída.**

### c.1 — A decisão central: o alarme NÃO escreve `is_throttled`/`is_disabled`

O bloco `ai-budget-checker.cron.ts:201-226` **sai**, não é agendado.

Defesa: uma escrita de flag só tem valor se alguém a lê para decidir. Medido
(a.3): ninguém lê. O que a escrita produz hoje é exatamente e apenas (i) um badge
falso e (ii) um estado sem volta. Agendá-la seria pagar o pior custo do
bloqueio sem colher nenhum benefício dele. E o benefício pretendido — não estourar
a fatura — **já existe e é melhor**: `assertBudget` recusa antes de qualquer byte
ao provider, com gasto recomputado da fonte.

Isto responde a pergunta do briefing "modo só observa numa primeira fase": sim,
observa-only — mas não como fase tímida de um bloqueio que virá. É a forma
**correta e final** desta peça, porque o bloqueio é responsabilidade de outra
peça que já o exerce.

### c.2 — A peça: um cron `ai-budget-watcher`, que também é o reset

Rota nova: `app/api/v1/cron/ai-budget-watcher/route.ts`, no padrão medido em a.6
(`dynamic = "force-dynamic"`, guard inline fail-closed, `ok()/fail()` com
`requestId`, teto de lote em constante, `try/catch` por organização, contadores
no `ok()`).

Cada passada, por organização:

1. **Recomputa o gasto do mês da FONTE**, com exatamente a mesma query que o
   enforcement vivo usa (`run-model-call.ts:121-124`):
   `sum(cost_cents) from llm_calls where organization_id = $1 and created_at >= date_trunc('month', now())`.
2. **Grava** o resultado em `current_month_consumed_cents` e ajusta
   `current_period_start` para `date_trunc('month', now())`.
3. **Decide o aviso** comparando com o teto (regra em c.3).
4. **Nunca** toca `is_throttled` / `is_disabled` — exceto uma vez, na migration
   de saneamento (c.6).

Por que o recomputo substitui o reset em vez de agendar `runBudgetReset()`:
`ai-budget-reset.cron.ts:70` zera o contador **incondicionalmente**. Rodando pela
primeira vez no meio de um mês (que é o caso de toda instalação existente, já que
`current_period_start` está congelado no mês da instalação — a.2), ele
**descartaria o gasto do mês em curso** e passaria a sub-contar. Trocar um erro
para-mais por um erro para-menos não é conserto. O recomputo derivado não tem
virada de mês para errar: ele é sempre o mês corrente.

Efeito colateral bom: o gatilho continua somando entre os ticks, **sobre uma base
correta**, então o número fica certo entre passadas e se re-ancora a cada tick. A
deriva de virada de mês fica limitada à cadência do cron.

`workers/ai-budget-reset.cron.ts` é **apagado** no mesmo commit. Deixá-lo seria
manter um segundo worker morto com semântica conflitante — a exata condição que
produziu esta onda.

**Cadência:** `23 * * * *` (de hora em hora, minuto deslocado para não competir
com os crons de minuto). Justificativa: o teto de deriva de virada de mês passa
a ser 1 hora, e a "regra do tempo" da doutrina não pede realtime aqui — não há
ação irreversível, só observação.

**Elegância considerada e recusada:** a solução mais bonita seria tornar
`current_month_consumed_cents` puramente derivada — `getBudgetStatus`
(`lib/ai/budget/check.ts:64`) recomputando na leitura, e a coluna deixando de
existir. Recusada nesta onda porque alcançaria três caminhos de leitura
(`app/app/ai/usage/page.tsx:7`, `app/api/v1/admin/dashboard/kpis/route.ts:210`,
`app/api/v1/admin/tenants/[id]/health/route.ts:185`) e um invariante
(`tests/invariants/orcamento-apos-backfill.test.ts`), trocando um raio de
impacto pequeno por um grande. Fica declarado como o passo seguinte natural, não
como dívida oculta.

### c.3 — O teto: alarme só sobre limite DELIBERADO

Este é o ponto que impede o falso alarme em massa.

**Regra:** o watcher só avisa quando a organização **escolheu** um teto. Como
`DEFAULT 5000 NOT NULL` torna "escolhido" e "nunca tocado" indistinguíveis pelo
valor, a escolha vira um fato explícito:

- Coluna nova `ai_budgets.limit_set_at timestamptz null`.
- Escrita **apenas** por `PATCH /api/v1/ai/budget`
  (`app/api/v1/ai/budget/route.ts:69-70`), quando `monthly_limit_cents` vem no
  payload — isto é, quando um `admin` salvou o valor pela tela.
- `limit_set_at is null` → **o watcher recomputa o gasto e não avisa nada.**

Alternativa considerada e recusada: usar o teto que já vincula
(`organizations.settings.llm.monthly_budget_cents`, default `null` = exatamente
"ninguém escolheu"). É mais elegante e resolveria o opt-in sem migration — mas
esse campo **não tem UI** (a.5), então o alarme falaria de um número que o
usuário não consegue ver nem mudar, violando o invariante 6. Reconciliar os dois
tetos é trabalho real e arriscado (fazer `assertBudget` ler
`monthly_limit_cents`, cujo default é R$ 50, ligaria negação de serviço de
verdade para todo mundo — exatamente a catástrofe temida). Fica **declarado como
item próprio**, fora desta onda, em c.7.

Portanto o alarme desta onda é honestamente **advisory**: *"você passou de X% do
teto que você definiu"*. Isso tem valor sozinho — o teto existe para evitar
surpresa na fatura, e avisar já evita a surpresa.

### c.4 — O destino do aviso: a Central, não o e-mail

Ordem de prioridade deliberada, seguindo a doutrina de QA Visual (envs opcionais
ausentes é o estado real de um primeiro deploy — `RESEND_API_KEY` não existe):

1. **`agent_inbox_items`, kind novo `budget_warning`** — o destino primário.
   Severity `warn` (não `critical`: nada parou).
   - Dedup pelo padrão do repo: `insert ... where not exists (... kind =
     'budget_warning' and status = 'open')` (`run-model-call.ts:130-140`). Isso
     **substitui** o cooldown de 24h por `last_alarm_sent_at`
     (`ai-budget-checker.cron.ts:39`, `:145`) — um item aberto já é o estado
     "esta org já foi avisada", e é o padrão que o engine usa.
   - Corpo carrega os números (gasto, teto, pct, período) para o humano decidir
     sem ir cavar.
   - Contrato do vocabulário (a.7): entra no bloco **único** do CHECK em
     `baseline.sql:9104`, em `InboxKind` (`repository.ts:26`) e em `KIND_LABEL`
     (`agent-inbox-copy.ts:20`) na **mesma** mudança.
   - Rótulo proposto: `budget_warning: "O gasto de IA passou do aviso que você
     definiu"` — diz o que aconteceu, não que algo parou (contraste deliberado
     com `budget_exceeded: "O orçamento de IA foi atingido"`).
2. **E-mail**, best-effort, reaproveitando `lib/email/templates/ai-budget-alarm`
   e o `try/catch` que já existe (`ai-budget-checker.cron.ts:190-195`). Falha de
   e-mail **nunca** derruba a passada. Agendar esta rota é o que retira a entrada
   de dívida em `tests/unit/branding.test.ts:280` — a allowlist só encolhe.
3. **`event_log` `ai.budget_warning`**, mantido para auditoria/realtime.

### c.5 — O laço se fecha: quem FECHA o aviso

Sem isto o item seria uma demanda sem próximo passo (invariante 4). Na mesma
passada, para cada org com item `budget_warning` **aberto** cujo `pct` recomputado
caiu **abaixo** do `alarm_threshold_pct`, o watcher:

- fecha o item (`status` → resolvido, pelo mesmo caminho que a Central usa), e
- emite `ai.budget_recovered`.

Isso acontece naturalmente na virada do mês (o recomputo devolve o gasto do novo
mês) e quando o admin **aumenta o teto** pela tela. O aviso, portanto, se
retrata sozinho e a retratação é visível.

### c.6 — Saneamento único: desarmar a mina

Uma migration versionada + apêndice idempotente no baseline, que roda uma vez em
todo clone:

```sql
-- Nenhum caminho vivo lê estas flags, e o ÚNICO escritor de `false`
-- (workers/ai-budget-reset.cron.ts) nunca foi agendado. Qualquer `true` no banco
-- de um clone é estado preso, sem produtor legítimo e sem saída — e vira negação
-- de serviço no dia em que alguém reanimar um dos leitores.
update public.ai_budgets set is_throttled = false where is_throttled;
```

`is_disabled` **não** é tocado: ele significa "um admin desligou", e é o próprio
`runBudgetReset` que se recusava a limpá-lo (`ai-budget-reset.cron.ts:6-7`).
Limpá-lo religaria IA que alguém desligou de propósito.

A mesma migration adiciona `limit_set_at` (c.3) e o kind `budget_warning` (c.4),
com backfill deliberado: `limit_set_at` nasce `null` para todos — inclusive para
quem tem `monthly_limit_cents` diferente de 5000. **Escolha consciente:** inferir
"deliberado" de "≠ default" reintroduz o palpite que este desenho existe para
eliminar, e o custo do erro é assimétrico (um alarme a menos é silêncio; um
alarme a mais numa primeira impressão é abandono). Quem quiser o aviso salva o
teto uma vez na tela — e a tela pode dizer isso.

### c.7 — Kill switch, e o que aparece quando falta

- `AI_BUDGET_ALARM_ENABLED`, default **`"true"`**. Em `lib/env.ts`,
  `.env.example` e `.env.hostgator.example` (DoD 9). Default que não quebra
  `.env` antigo (doutrina de packaging).
- Quando `false`: a rota **ainda responde 200**, com
  `ok({ skipped: true, reason: "disabled" })` — precedente literal em
  `app/api/v1/cron/agent-dispatcher/route.ts:43`. Um cron que passa a dar 4xx
  parece quebrado no log do operador.
- **O que aparece quando falta:** o `ok()` de toda passada devolve `enabled`,
  `scanned`, `recomputed`, `avisados`, `fechados` e `sem_teto_deliberado`. O
  operador vê o estado da chave na resposta do próprio cron, sem precisar
  adivinhar.
- Deliberadamente **não** existe um modo `bloqueia`. Oferecer a opção enquanto
  nenhum consumidor vivo lê a flag seria um controle decorativo — o defeito que
  este desenho inteiro existe para não repetir.

**O que promoveria para bloqueio, escrito para não virar promessa vaga:** (i) um
consumidor vivo e nomeado que leia a decisão no caminho quente; (ii) o teto da
tela e o teto que vincula reconciliados num só campo, com opt-in explícito;
(iii) o caminho de volta (desbloqueio na virada do mês) provado em `pnpm test:db`
**antes** do caminho de ida. Enquanto (i) não existir, promover é construir a
mina de novo.

### c.8 — Itens declarados, fora desta onda

Não são dívida oculta; são defeitos medidos que esta onda não conserta:

1. **Dois tetos divergentes** (a.5): a tela edita `ai_budgets.monthly_limit_cents`
   (sem efeito); o enforcement lê `organizations.settings.llm.monthly_budget_cents`
   (sem UI). Reconciliar exige decidir qual sobrevive e migrar dados — e a direção
   ingênua liga negação de serviço para todo mundo.
2. **Badge "Pausado"/"Desabilitado" sem produtor vivo**
   (`BudgetCard.tsx:74-80`). Depois de c.6 o badge fica corretamente apagado,
   mas continua ligado a uma flag que nada escreve. O certo é apontá-lo para o
   que o caminho vivo produz: um `budget_exceeded` aberto.
3. **`fn_admin_ai_budget_warning_count` não existe** (a.8).

---

## (d) Living System Checklist — `ai-budget-watcher`

```
Living System Checklist — cron ai-budget-watcher (alarme de orçamento de IA)
```

**1. Quem me alimenta?**
Três fontes reais, nomeadas:
(i) `public.llm_calls` — linhas gravadas pelo agent-engine em
`lib/agent-engine/edge/llm/run-model-call.ts` após cada chamada ao provider; é a
**mesma** tabela e o **mesmo** recorte que `assertBudget` já agrega
(`run-model-call.ts:120-125`).
(ii) `ai_budgets.monthly_limit_cents` / `alarm_threshold_pct` / `limit_set_at` —
escritos por `PATCH /api/v1/ai/budget` (`app/api/v1/ai/budget/route.ts:69-74`),
acionado por `EditBudgetDialog` em `components/ai/BudgetCard.tsx:155`.
(iii) O disparo: a linha `23 * * * *|60|api/v1/cron/ai-budget-watcher` no
`CRONS` de `docker/scheduler/entrypoint.sh:43-60`, executada pelo busybox crond
do serviço `scheduler`.

**2. Quem eu alimento?**
(i) `agent_inbox_items` (kind `budget_warning`) → consumido pela Central de
avisos em `app/app/ai/inbox/page.tsx`, rotulado por `KIND_LABEL` em
`lib/ai/agent-inbox-copy.ts:20`.
(ii) `ai_budgets.current_month_consumed_cents` + `current_period_start` → lidos
por `getBudgetStatus` (`lib/ai/budget/check.ts:64`) → renderizados por
`components/ai/BudgetCard.tsx:57-58` e `:68-70`; e por
`app/api/v1/admin/dashboard/kpis/route.ts:210` e
`app/api/v1/admin/tenants/[id]/health/route.ts:185`.
(iii) `sendEmail` (`lib/email/resend.ts`) com `lib/email/templates/ai-budget-alarm`.
(iv) `event_log`, via a RPC `emit_event` (`ai-budget-checker.cron.ts:98-104`).

**3. Que registro eu emito?**
`event_log`: `ai.budget_warning` e `ai.budget_recovered` (fatos — isentos do gate
de `tests/unit/evento-comando-tem-consumidor.test.ts:20-30`, que só cobra
consumidor de `*_requested`). `logger.warn`/`logger.error` com `requestId`, no
padrão de `risk-watcher/route.ts:102-106`. E os contadores no corpo do `ok()`
(c.7), que é o que o operador lê no log do scheduler.

**4. Onde eu apareço na tela?**
Duas telas reais, hoje existentes: `/app/ai/inbox` (a Central), onde o item
aparece com o rótulo de `KIND_LABEL`; e `/app/ai/usage`, onde a barra e o texto
"Período iniciado em" de `components/ai/BudgetCard.tsx:68-70` passam a ser
verdadeiros **pela primeira vez** — hoje o período está congelado no mês da
instalação (a.2).

**5. Por qual porta se chega?**
Portas já declaradas, nenhuma nova: `lib/navigation/registry.ts:305` →
`/app/ai/inbox`; `lib/navigation/registry.ts:338` → `/app/ai/usage`. Nada a
acrescentar em `tests/unit/navegacao-completude.test.ts`.

**6. Qual meu anti-morte?**
O próprio cron é o anti-morte do orçamento: antes dele, "ninguém avisou" era
indistinguível de "ninguém passou do teto" — o modo de falha silencioso descrito
em `risk-watcher/route.ts:26-32`. A garantia de que ele roda é mecânica, não
documental: `tests/unit/cron-routes-scheduled.test.ts:58-66` reprova o CI se a
rota existir sem linha no crontab, sem allowlist (a.6).
Para o **item** de aviso, o anti-morte é c.5: o watcher fecha o item quando o pct
cai, então ele não fica aberto para sempre nem exige gesto humano para sumir.

**7. Onde se configura?**
Teto e limiar: `/app/ai/usage` → `EditBudgetDialog` → `PATCH /api/v1/ai/budget`
(admin, `route.ts:46`). Ver e mudar, na mesma tela.
Chave geral: `AI_BUDGET_ALARM_ENABLED` em `lib/env.ts`, `.env.example` e
`.env.hostgator.example`.
Falha visível: o `ok()` de cada passada devolve `enabled` e
`sem_teto_deliberado`, então "não recebo aviso" tem resposta observável em vez
de virar mistério. É a correção direta do controle decorativo descrito em
`docker/scheduler/entrypoint.sh:29-33`.

**8. Qual a continuidade?**
IA→humano: o item da Central entrega **contexto pronto** — gasto, teto, pct e
período no corpo —, não um ping que obriga o humano a ir procurar. É a diferença
que o invariante 2 nomeia (transferir contexto, não custo).
Humano→IA: o admin responde pela tela, e a resposta é estruturada, não texto —
aumentar o teto em `PATCH /api/v1/ai/budget` faz a passada seguinte fechar o item
sozinha (c.5). Resolver o item na Central é o "eu já sei", e como o dedup é por
item **aberto**, resolver reabilita um aviso futuro.

**9. Qual meu laço de retorno? (o que muda quando eu erro)**
Dois modos de erro, com retorno concreto em cada:

- **Aviso errado (avisei e o gasto estava bom).** A causa possível é um número
  ruim no banco. O retorno é estrutural, não humano: a passada seguinte
  **sobrescreve** `current_month_consumed_cents` com o recomputo da fonte
  (c.2) — o número que produziu o alarme falso não sobrevive ao próprio erro —
  e, com o pct abaixo do limiar, o item é fechado e sai `ai.budget_recovered`
  (c.5). Um alarme errado se retrata sozinho, e a retratação aparece na mesma
  tela em que o alarme apareceu. É a diferença entre este desenho e o worker
  original, cujo `is_throttled = true` (`ai-budget-checker.cron.ts:204`) **não
  tinha escritor de volta** e portanto não tinha como se retratar.
- **Aviso que faltou (passou do teto e nada disparou).** A assinatura observável
  é o contador `sem_teto_deliberado` no `ok()` da rota: uma org acima do limiar
  com `limit_set_at is null`. Se esse número for alto de forma persistente, o
  que está errado não é a org — é o opt-in de c.3 ou o default de R$ 50
  (`baseline.sql:1053`), e o próprio contador é a evidência que reabre essa
  decisão. Ou seja: a regra que eu uso para decidir é medida pela minha própria
  saída.

Declaro o que **não** é laço: este cron não aprende sozinho e não ajusta teto
nem limiar. Ajustar é decisão do dono do negócio, e é por isso que a saída dele é
um número que sustenta a decisão, não uma mudança automática.

**10. Atualizei o mapa?**
`docs/architecture/` (11 mapas hoje, `README.md` como índice). A peça entra com
**≥2 arestas** em cada ponta, todas nomeadas em (1) e (2): entrada
`llm_calls` + `PATCH /api/v1/ai/budget` + crontab; saída `agent_inbox_items` +
`ai_budgets` + `event_log` + e-mail. Como o alarme cruza IA, Central e cobrança,
o lugar natural é um bloco no mapa de IA existente
(`docs/architecture/ia-360-retencao.architecture.json`) ou um
`orcamento-de-ia.architecture.json` próprio — decisão de quem implementar, mas
**não opcional**: DoD 13.

---

## (e) O que só se prova com banco — e o que não precisa

**Régua:** nada abaixo foi executado. Docker fora do ar.

### Prova SEM banco (dá para fazer já, e o CI cobra)

| O quê | Como | Gate |
|---|---|---|
| A rota está agendada | comparação diretório × crontab | `tests/unit/cron-routes-scheduled.test.ts:58-66` (`pnpm test:unit`) |
| O crontab **gerado** tem a linha | paridade de contagem no arquivo escrito | `tests/shell/scheduler-entrypoint.test.sh:59-62` (`pnpm test:shell`) |
| Guard fail-closed (401/403 sem segredo) | teste de rota com `Request` sintético, no padrão de `app/api/v1/cron/agent-dispatcher/route.test.ts` | `pnpm test:unit` |
| Kill switch desligado devolve 200 + `skipped` | idem | `pnpm test:unit` |
| `KIND_LABEL` cobre o kind novo | `satisfies Record<InboxKind, string>` (`agent-inbox-copy.ts:20`) | `pnpm typecheck` |
| A dívida de marca some | a entrada de `tests/unit/branding.test.ts:280` deixa de valer | `pnpm test:unit` |
| Aritmética de pct/limiar/dedup | função pura extraída, testada com tabela de casos | `pnpm test:unit` |

### Só se prova COM banco (`pnpm test:db`, Postgres real)

1. **O CHECK novo de `agent_inbox_items.kind` aceita `budget_warning`** e o
   apêndice do baseline continua reconstruindo a constraint **num bloco só** —
   a armadilha do issue #159 documentada em `baseline.sql:9124-9130`.
2. **`tests/invariants/vocabulario-banco-x-typescript.test.ts`**: o CHECK e o
   tipo `InboxKind` (`repository.ts:26`) dizem o mesmo conjunto. Este invariante
   compara contra Postgres real por design — não há atalho.
3. **Baseline em modo `install` (fresh, `ON_ERROR_STOP=1`) e `update`
   (re-aplicação, sem a flag)**, ambos verdes, com o apêndice novo. É o que o
   `install.sh`/`update.sh` do self-hoster realmente aplica.
4. **Idempotência do saneamento** (c.6): re-aplicar não pode reverter um
   `is_disabled` legítimo nem re-zerar nada duas vezes.
5. **A equivalência que sustenta o desenho inteiro:** o recomputo do watcher
   (c.2) devolve **o mesmo número** que `assertBudget`
   (`run-model-call.ts:121-124`) para a mesma org e o mesmo mês. Se divergirem,
   a tela e o bloqueio voltam a contar histórias diferentes — que é o defeito
   original.
6. **A deriva de virada de mês desaparece:** fixture com gasto em dois meses,
   provar que depois de uma passada o contador reflete **só** o mês corrente.
   Esta é a prova que a 0140 já ensaia em
   `tests/invariants/orcamento-apos-backfill.test.ts` — o caso novo é o irmão
   dela.
7. **RLS/isolamento:** o watcher usa admin client (service role bypassa RLS), e o
   `organization_id` vem do scan, nunca de body. Provar não-vazamento com 2
   tenants, como manda o CLAUDE.md.
8. **O laço fecha (c.5):** org acima do limiar → item aberto; teto aumentado →
   passada seguinte fecha o item e emite `ai.budget_recovered`. Sem esta prova,
   o invariante 7 está afirmado e não medido.

### Só se prova PELA TELA (DoD 12, ambiente fresco estilo VPS)

Playwright em banco `baseline.sql` + `bootstrap-owner.ts`, **sem
`RESEND_API_KEY`** (é o estado real de um primeiro deploy):

9. `/app/ai/usage` mostra "Período iniciado em" com o **mês corrente**, e o
   badge "Pausado" **não** aparece.
10. Salvar um teto pela `EditBudgetDialog`, forçar gasto acima dele, rodar o cron
    pelo endpoint, e ver o aviso **na Central** com o rótulo leigo — e sumir
    quando o teto sobe.

### Afirmação que NÃO faço

Não afirmo que o desenho funciona. Nada foi executado. O que está medido é o
**estado atual do código** (seção a), com caminho e linha; o resto desta página é
desenho, e o que o promove a "pronto" é a lista (e).
