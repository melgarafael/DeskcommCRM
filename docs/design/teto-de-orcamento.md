# O teto de orçamento que vincula

> Plano de implementação. **Nada aqui foi implementado nem commitado.**

## RÉGUA DA MEDIÇÃO (leia antes de qualquer número)

Worktree `/Users/rafaelmelgaco/SonghaiCRM-marca`, branch `fix/auth-getuser-erro-mudo`
(**não `main`**), working tree limpo, **HEAD `760b3d17`** — não `fe323354` como diz o
briefing, nem `bcf5875c` como diziam os desenhos. A árvore avançou 2 commits durante a
fase de desenho. Medi o delta:

```console
$ git diff --name-only fe323354..HEAD
lib/auth/server.ts
tests/unit/auth-getuser-erro-mudo.test.ts

$ git diff --name-only fe323354..HEAD -- app/api/v1/ai/budget lib/ai/budget \
    components/ai/BudgetCard.tsx lib/agent-engine/edge/llm supabase/baseline.sql \
    supabase/migrations hooks/ai/useAiBudget.ts lib/audit workers/ai-budget-*.cron.ts
(vazio)
```

**Nenhum arquivo de orçamento mudou.** Todo `arquivo:linha` deste plano foi lido em
`760b3d17` e vale igualmente nos SHAs citados pelos mapeamentos.

**NADA foi executado**: zero query, zero teste, zero typecheck. Docker não sobe nesta
máquina (disco da VM corrompido — instrução do briefing é não consertar). Toda afirmação
sobre runtime é inferência a partir do código lido, e está marcada como tal. O que só se
prova com banco/CI está isolado na seção 7.

---

## 1. A DECISÃO CENTRAL, EM UMA FRASE

**O teto passa a morar só em `ai_budgets` e o `assertBudget` passa a lê-lo — mas atrás de
uma coluna nova `enforcement_mode` cujo default é `'off'`, e a migration não reescreve
uma única linha de `monthly_limit_cents`.**

### Por que isso não estrangula ninguém — e por que a pergunta difícil do briefing dissolve

O briefing pergunta: *"e quem já preencheu um teto na tela deliberadamente?"* — porque o
`DEFAULT 5000` (`supabase/baseline.sql:1053`) torna "escolhi R$ 50" indistinguível de
"nunca abri a tela", e os dois backfills do apêndice (`:8653-8662` e `:10304-10318`)
criam linha para **toda** organização em todo `install.sh` e todo `update.sh`.

Os três desenhos tentaram *adivinhar* a intenção a partir do dado que existe — coluna
`limit_set_at`, coluna nullable, mapear `5000 → NULL`. Todos gastam uma reescrita de dados
para inferir um fato que ninguém gravou. **A pergunta não precisa ser respondida.**

O valor herdado continua exatamente onde está, intocado, e simplesmente **não vale nada
até alguém mudar o modo**. `enforcement_mode` não é um proxy de intenção: é a intenção,
declarada por um admin, num controle que só existe para isso, com auditoria e carência.
Não há dado antigo que possa satisfazer a condição, porque a coluna nasce `'off'` por
`ALTER` — sem `UPDATE`, sem heurística, sem backfill.

**Consequência que eu quero explícita, porque é a manchete que os desenhos anteriores
erraram:** não é verdade que "zero organizações passam a poder bloquear". Um bloco nomeado
da migration arma `'bloquear'` para as orgs que **já são bloqueadas hoje** por
`organizations.settings.llm.monthly_budget_cents` — direção B→A, preservação de
comportamento, nunca criação. A afirmação exata e conferível é: **nenhuma organização ganha
uma capacidade de bloqueio que ela já não tivesse**, e o único bloco que escreve
`'bloquear'` é rotulado, escopado e vigiado por um teste de artefato com controle negativo
(`tests/unit/migracao-nao-arma-ninguem.test.ts`).

### As seis condições conjuntivas do bloqueio

| # | Condição | Como nasce | Algum dado de hoje satisfaz? |
|---|---|---|---|
| 1 | `enforcement_mode = 'bloquear'` | só `PATCH /api/v1/ai/budget`, admin, auditado, escada obrigatória | **Não** — a coluna não existe; nasce `'off'` por `ALTER ... DEFAULT` |
| 2 | `enforcement_effective_at <= now()` | gravado `now()+72h` ao armar | **Não** — nasce `null`, e `null <= now()` é `null`, nunca verdadeiro |
| 3 | `monthly_limit_cents >= 100` (US$ 1,00) | valor da tela | Sim (o `DEFAULT 5000` satisfaz) — irrelevante sozinho |
| 4 | chave `AI_BUDGET_ENFORCEMENT` não afrouxa | default `on` | Sim — e a chave **só sabe afrouxar** |
| 5 | `purpose` fora da lista de isentos | depende da chamada | Sim, para turnos normais |
| 6 | já houve `budget_warning` **neste mês** | só o próprio gate, na passada anterior | **Não** no primeiro cruzamento |

As condições **1 e 2 são inalcançáveis por qualquer caminho de dados existente**, e a 6
torna impossível o cenário "calou sem nunca ter avisado" mesmo no salto 79% → 101% entre
duas chamadas.

### Direção: por que B→A e não A→B

`organizations.settings.llm.monthly_budget_cents` é um escalar num jsonb livre, lido por um
Zod com `.catch()` em **dois** níveis (`lib/agent-engine/edge/llm/credentials.ts:102` e
`:105-111`): valor com forma errada vira `null`, e `null` é ilimitado
(`run-model-call.ts:117-119`). O campo que hoje protege **falha aberto por construção**, é
jsonb lock-in (anti-pattern 6), e mora num objeto que já tem **cinco** donos fazendo
read-modify-write (`app/actions/settings/updateTenant.ts`, `app/api/v1/settings/routing/route.ts`,
`app/api/v1/metrics/atrito/route.ts`, `app/actions/auth/politicaDeMfa.ts`,
`scripts/bootstrap-owner.ts`) — o padrão cuja perda a migration 0157 mediu e curou com
`fn_definir_marca_da_organizacao`. Escrever o teto lá seria criar o sexto, ou pagar por
mais uma `security definer` de escrita cross-tenant.

`ai_budgets` não tem nenhum desses defeitos: tem tela, tem par RLS SELECT/WRITE com
`fn_role_at_least(organization_id,'admin')` desde a 0150 (`baseline.sql:11408-11424`), e
tem os campos-irmãos que um `number|null` não teria onde guardar.

**Custo em caminho quente: negativo.** `resolveOrgLlmConfig` já faz
`select settings->'llm' from organizations where id = $1` (`credentials.ts:135-138`); vira
um `left join` na PK de uma tabela de uma linha por org — mesmo round-trip. E como o modo é
`'off'` para 100% das orgs no dia 1, o gate retorna **antes** da query de gasto: menos
trabalho que hoje.

---

## 2. ARQUIVO POR ARQUIVO

### 2.1 `lib/agent-engine/edge/llm/orcamento.ts` — **NOVO**, o coração

Duas exportações, ambas **testáveis sem banco**:

**(a) `decidirOrcamento(entrada): Veredito` — função PURA, zero I/O.**

```ts
export const PISO_DE_TETO_CENTS = 100;               // US$ 1,00/mês
export const PURPOSES_ISENTOS = [
  'connection_test',    // lib/agent-engine/edge/llm/test-model.ts:31
  'jailbreak_detect',   // lib/agent-engine/guardrails/jailbreak/classifier.ts:114
  'promise_semantic',   // lib/agent-engine/guardrails/promise/semantic.ts:113
] as const;

export interface EntradaDeOrcamento {
  modo: 'off' | 'avisar' | 'bloquear';
  tetoCents: number;
  gastoCents: number;
  efetivoEm: Date | null;
  agora: Date;
  purpose: string;
  chave: 'on' | 'avisar' | 'off';
  avisadoNesteMes: boolean;
}
export type Veredito =
  | { acao: 'seguir'; porque: RazaoDeSeguir }
  | { acao: 'avisar_e_seguir'; porque: 'primeiro_cruzamento' | 'limiar' }
  | { acao: 'bloquear'; porque: 'teto_atingido' };
```

`porque` é **enum, não string livre** — é o que o log e o teste comparam.

Sete recusas embutidas, cada uma matando um caminho de estrangulamento medido:

1. `modo === 'off'` → `seguir`. É o retorno mais cedo, **antes de qualquer query**.
2. `chave === 'off'` → `seguir`; `chave === 'avisar'` rebaixa `bloquear` para `avisar`.
3. `PURPOSES_ISENTOS.includes(purpose)` → `seguir`. Bloquear `connection_test` tira o único
   diagnóstico de quem está no escuro; bloquear guardrail transformaria estouro de orçamento
   em possível **desligamento de proteção** (**NÃO MEDIDO** se algum chamador trata a
   exceção do guardrail como "sem veto" — a isenção mata a pergunta em vez de deixá-la
   aberta). O custo deles **continua somando** no teto: excluí-los da soma faria o número
   mentir.
4. `tetoCents <= 0` → `seguir`, **sempre**. Hoje `0` significa "sem limite" na tela
   (`components/ai/BudgetCard.tsx:192`) e "bloqueia tudo" no enforcement (o teste é
   `spent < 0`, sempre falso — `run-model-call.ts:127`; é exatamente assim que
   `scripts/smoke-llm.ts:168-182` prova o bloqueio). A inversão perfeita — quem recusou o
   orçamento de propósito levando o corte mais duro — morre por construção, com caso de
   teste nomeado.
5. `tetoCents < PISO_DE_TETO_CENTS` → `seguir`, e o chamador abre aviso dizendo que o teto é
   baixo demais para ser honrado. Um teto sub-dólar/mês não é orçamento de um agente de
   WhatsApp; é erro de unidade.
6. `efetivoEm === null || agora < efetivoEm` → no máximo `avisar_e_seguir`. É a carência.
7. `!avisadoNesteMes` → `avisar_e_seguir`, mesmo com gasto acima do teto. **Ninguém é
   bloqueado sem ter sido avisado.** Custo: no máximo uma chamada além do teto.

Só depois: `gastoCents >= tetoCents` → `bloquear`. Entre `teto*limiar/100` e `teto` →
`avisar_e_seguir` com `porque: 'limiar'`.

**(b) `normalizarChaveDeOrcamento(v: string | undefined): 'on' | 'avisar' | 'off'` — pura.**

`off|false|0|no|nao|não|disabled` (case-insensitive, trim) → `'off'`; `avisar|warn` →
`'avisar'`; **qualquer outra coisa, inclusive vazio e lixo → `'on'`**.

Isto existe porque `lib/env.ts:204-224` faz `safeParse` e **lança** quando o schema recusa
(`:222`). Um `z.enum` para o kill switch transformaria a alavanca de emergência em um
derrubador do app inteiro no dia em que o operador escrevesse `false` — o idioma dos
vizinhos `AGENT_DISPATCH_CONSUMER` (`:104`) e `EVENT_LOG_WORKER_ENABLED` (`:107`). O
precedente correto no mesmo arquivo é `APP_ACCENT_HEX: z.string().optional().default("")`
(`:201`): string crua no env, normalização no código. E aceitar as grafias falsas comuns
como `off` é dar ao operador de VPS às 2h da manhã o que ele quis dizer.

**(c) `SQL_ORCAMENTO: string` — o statement único, exportado como constante.**

Ser constante exportada é o que permite ao invariante executar **o SQL de verdade** contra
um Postgres real, em vez de reimplementá-lo — reimplementar mediria a minha cópia, e a
cópia continuaria certa com o original sabotado (mesma técnica de
`tests/invariants/orcamento-apos-backfill.test.ts`, que extrai o bloco do baseline por
rótulo).

O statement, em uma ida ao banco:

```sql
with orc as (
  select b.monthly_limit_cents            as teto,
         b.enforcement_mode               as modo,
         b.enforcement_effective_at       as efetivo_em,
         b.alarm_threshold_pct            as limiar_pct
    from ai_budgets b
   where b.organization_id = $1
),
gasto as (
  select public.fn_gasto_de_ia_do_mes($1) as spent
),
-- Lido ANTES dos inserts: todas as CTEs enxergam o MESMO snapshot, então
-- `avisado_antes` reflete o estado anterior a qualquer insert deste statement.
-- É `created_at >= date_trunc('month', now())` e NÃO `status = 'open'`: fechar o
-- aviso à mão não pode virar um bypass permanente do bloqueio.
avisado_antes as (
  select exists (
    select 1 from agent_inbox_items
     where organization_id = $1 and kind = 'budget_warning'
       and created_at >= date_trunc('month', now())
  ) as ja
),
-- LAÇO DE RETORNO (invariante 7): o gasto caiu abaixo do limiar — virou o mês, ou
-- o admin subiu o teto. Retrata os dois avisos. Sem isto o alerta CRÍTICO fica
-- aceso para sempre: o único auto-resolvedor do produto é
-- lib/agent-engine/health/circuit.ts:331-335, escopado por
-- ref_kind = HEALTH_HOLD_REF_KIND, e o item de orçamento nunca teve ref_kind.
retrata as (
  update agent_inbox_items set status = 'resolved'
   where organization_id = $1
     and kind in ('budget_exceeded','budget_warning')
     and status = 'open'
     and (select spent from gasto)
         < (select teto * limiar_pct / 100.0 from orc)
  returning 1
),
avisa as (
  insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
  select $1, 'budget_warning', 'warn', $2, $3, 'ai_budget', $1
   where (select modo from orc) in ('avisar','bloquear')
     and (select spent from gasto) >= (select teto * limiar_pct / 100.0 from orc)
     and not exists (
       select 1 from agent_inbox_items
        where organization_id = $1 and kind = 'budget_warning' and status = 'open'
     )
  returning 1
)
select (select teto from orc)        as teto,
       (select modo from orc)        as modo,
       (select efetivo_em from orc)  as efetivo_em,
       (select limiar_pct from orc)  as limiar_pct,
       (select spent from gasto)     as gasto,
       (select ja from avisado_antes) as avisado_antes;
```

Sem linha em `ai_budgets` (acontece: **nenhum trigger de `organizations` semeia a tabela** —
os produtores são o gatilho de `llm_calls`, os dois backfills e o PATCH), `orc` é vazia,
`modo` volta `null`, e o normalizador do TypeScript resolve para `'off'`. **Nulo é sempre a
resposta mais frouxa.**

### 2.2 `lib/agent-engine/edge/llm/credentials.ts`

A query de `:135-138` vira:

```sql
select o.settings->'llm'            as llm,
       b.monthly_limit_cents        as teto,
       b.enforcement_mode           as modo,
       b.enforcement_effective_at   as efetivo_em,
       b.alarm_threshold_pct        as limiar_pct
  from organizations o
  left join ai_budgets b on b.organization_id = o.id
 where o.id = $1
```

`left join`, não `join`. `OrgLlmConfig.monthlyBudgetCents` (`:91`, `:199`) **sai**; entra
`orcamento: { modo, tetoCents, efetivoEm, limiarPct }` e `orcamentoIndisponivel: boolean`.
O campo `monthly_budget_cents` sai do `llmSettingsSchema` (`:102`) e do `.catch()` de objeto
(`:110`); os demais `.catch()` **ficam** (são a defesa certa para jsonb livre).

**O RESOLVEDOR NUNCA LANÇA POR SCHEMA DESATUALIZADO.** A query joinada roda dentro de
`try/catch`; em **qualquer** erro (o caso concreto é `42703` — coluna inexistente), ele cai
para a query legada (`select settings->'llm' ...`), devolve `modo: 'off'` e
`orcamentoIndisponivel: true`. Uma query no caminho feliz; duas só no caminho quebrado.

Isto não é paranoia: `hostgator-setup-kit/update.sh:137-138` aplica o baseline com
`|| true` (**sem `ON_ERROR_STOP`**) e o `dc up -d` acontece depois, em `:225`. Um apêndice
parcialmente aplicado deixa a imagem nova consultando uma coluna que não existe, e um throw
ali derruba **toda** chamada de LLM de **toda** org — pior que o estrangulamento que este
trabalho existe para evitar. É a mesma lei que o CLAUDE.md já escreve para a marca
("Resolvedor NUNCA lança"), aplicada onde ela também vale. E falha **aberto na ação, aberto
na informação**: `run-model-call` loga um `warn` nomeando a causa, nunca a frase
tranquilizadora.

### 2.3 `lib/agent-engine/edge/llm/run-model-call.ts`

`assertBudget` (`:116-142`) vira `aplicarOrcamento(db, orgId, config.orcamento, purpose, chave)`:

- `modo === 'off'` ou `chave === 'off'` → **retorna antes de qualquer query**. Para 100% das
  orgs no dia 1, o caminho de orçamento faz estritamente menos trabalho que hoje.
- Senão, executa `SQL_ORCAMENTO` **uma vez**, monta `EntradaDeOrcamento`, chama
  `decidirOrcamento`, executa o veredito.
- `'avisar_e_seguir'` → o próprio statement já inseriu o `budget_warning`; loga
  `deps.log?.warn` e segue.
- `'bloquear'` → insere `budget_exceeded` **com `ref_kind = 'ai_budget'` e `ref_id = orgId`**
  (hoje o insert de `:130-140` não grava ref nenhum, e é por isso que nenhum auto-resolvedor
  o alcança), registra a recusa em `llm_calls` via `registrarFalha`, loga, e lança.

Três consertos que vêm junto porque são o mesmo defeito:

**(a) A recusa passa a virar linha em `llm_calls`.** Hoje o `throw` de `:141` cai **fora**
do `try` que chama `registrarFalha` (`:216-268`). A tela `/app/ai/runs` — criada exatamente
porque *"llm_calls só registrava sucesso — a tabela ficava vazia exatamente no caso que
precisava de explicação"* (`app/app/ai/runs/page.tsx:14-17`, e o comentário verbatim em
`run-model-call.ts:237-244`) — nunca mostra o único caso em que o agente para de propósito.
É o irmão que não foi replantado quando a 0128 consertou a classe.

**(b) O corpo do aviso para de mandar o usuário a lugar nenhum.** Hoje ele diz, literalmente,
*"o teto configurado em organizations.settings.llm.monthly_budget_cents; aumente o teto ou
aguarde a virada do mês"* (`:134`), renderizado **cru** para um leigo na Central
(`app/app/ai/inbox/_components/AgentInboxList.tsx:96`) — um caminho de coluna jsonb como
instrução, mandando aumentar um teto na única tela que edita **outro** campo. Novo corpo:
os números (gasto, teto, %), o que parou, o que **não** parou (a conversa foi para a fila
humana — ver 2.9), e o nome da tela.

**(c) O título também.** O juiz mediu que `AgentInboxList.tsx:91` renderiza `item.title` em
negrito — é onde o olho cai. O título atual é *"Orçamento mensal de LLM esgotado — agente
pausado para esta org"* (`:133`): "LLM" e "org" são jargão. Vira *"O limite de gasto com IA
foi atingido"*.

`LlmBudgetExceededError` (`:40-45`) ganha `readonly terminal = true`.

### 2.4 `lib/env.ts`, `.env.example`, `.env.hostgator.example`

```ts
AI_BUDGET_ENFORCEMENT: z.string().optional().default("on"),
```

**String crua, jamais `z.enum`** — ver 2.1(b). A normalização é
`normalizarChaveDeOrcamento`. `on` **não liga nada**: com `enforcement_mode = 'off'` em toda
org, `on` significa apenas *"respeite o que cada organização escolheu"*. A chave só sabe
afrouxar (`avisar` rebaixa qualquer `bloquear`; `off` cala tudo), e é essa monotonicidade
que a torna um kill switch de verdade — o operador põe `off`, reinicia, e a IA volta, sem
`psql`, sem saber SQL. `.env` antigo sem a variável cai no default (doutrina de packaging:
variável nova tem default que não quebra `.env` antigo). DoD 9.

### 2.5 `app/api/v1/ai/budget/route.ts`

Seis mudanças. Todas neste arquivo, que a mudança já obriga a tocar.

1. **`enforcement_mode` no Zod**, com a escada validada **no servidor**:
   `off→avisar` livre; `avisar→bloquear` grava `enforcement_effective_at = now()+72h`, ou
   `now()` se vier `confirmar_imediato: true`; **`off→bloquear` é 422** — a fase de aviso não
   é pulável por chamada direta de API. Afrouxar (`→off`, `bloquear→avisar`) é sempre livre.
2. **Armar `bloquear` exige `monthly_limit_cents >= 100`** — resolvido sobre o estado
   PÓS-escrita (`tetoDepois = patch ?? atual`), 422 nomeando o piso. É o "armado sem valor
   útil" tentando renascer pela porta da frente; o CHECK do banco é o backstop, não a régua.
3. **`alarm_threshold_pct` aperta de `min(1).max(100)` (`:23`) para `min(50).max(99)`**,
   casando o CHECK `ai_budgets_alarm_threshold_pct_check` (`baseline.sql:1063`, medido:
   `>= 50 AND <= 99`). Hoje 30 ou 100 passam no Zod, batem no 23514, caem no `updErr`
   genérico e o usuário recebe `"Erro ao atualizar orçamento."` 500 (`:95-97`) sem saber qual
   campo ofendeu — e o rollback otimista de `hooks/ai/useAiBudget.ts:65-70` desfaz a mudança
   na tela, então parece que o app engoliu o clique. **Não relaxo o CHECK**: a régua mais
   estrita é a certa; a errada é a visível.
4. **AUDITORIA.** Hoje `grep -c "lib/audit" app/api/v1/ai/budget/route.ts` = **0**, e os 217
   códigos de `lib/audit/actions.ts` não têm nenhum de orçamento. É violação direta da
   doutrina (*"toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log`"*)
   e do DoD 5, num endpoint que mexe em dinheiro, que o PRD já lista como auditado
   (`docs/prd/05-prd-ai-rag-handoff.md:176`). Três ações, fire-and-forget, com before/after.
   **Efeito colateral que fecha a porta para sempre:** a partir daqui *"este teto foi
   escolhido por um humano?"* é uma query em `api_audit_log`, e nenhuma sessão futura precisa
   inventar um `limit_set_at`.
5. **LAÇO DE RETORNO no afrouxamento.** Quando o PATCH afrouxa (desarma, ou sobe o teto acima
   do gasto), fecha os itens abertos:
   `update agent_inbox_items set status='resolved' where organization_id=$1 and kind in ('budget_exceeded','budget_warning') and status='open'`.
   Medido que a transição de fechamento é só `status:'resolved'` — é o que
   `app/api/v1/ai/inbox/[id]/route.ts:48-50` e `lib/agent-engine/health/circuit.ts:331-335`
   fazem. Assim a retratação tem **dois** produtores: o gate (na chamada seguinte) e o PATCH
   (imediato). Sem cron.
6. Os dois `console.warn` (`:91`, `:103`) viram logger estruturado — anti-pattern nº 14.

### 2.6 `lib/audit/actions.ts`

Três códigos no bloco `ai.*`: `ai.budget_limit_changed`,
`ai.budget_enforcement_armed`, `ai.budget_enforcement_disarmed`. Separados de propósito —
"quem armou a proteção" vira um filtro único e permanente.

### 2.7 `lib/ai/budget/check.ts`

- `getBudgetStatus` para de ler `current_month_consumed_cents` e passa a chamar
  `fn_gasto_de_ia_do_mes` por RPC. **O número exibido passa a ser o número que decide.** Sem
  isso a pessoa arma a proteção contra uma mentira: o contador materializado deriva — o
  gatilho `fn_update_budget_consumption` (`baseline.sql:747-761`) soma `NEW.cost_cents`
  **sem olhar a data** e nunca zera, porque `runBudgetReset` nunca foi agendado; o único
  recomputo em produção é o apêndice da 0140 (`:10304-10318`), que só roda no
  `install.sh`/`update.sh`. Numa instalação que não atualiza há três meses, o card compara
  três meses de gasto contra um teto **mensal**.
- Degradação declarada: se a RPC falhar (schema antigo), cai para a coluna materializada e
  loga. É pior número, mas é o de hoje — nunca um erro na tela.
- `BudgetStatus` ganha `enforcement_mode`, `enforcement_effective_at` e `enforcement_env`
  (o valor efetivo da chave, para a tela poder dizer que o teto não vale nesta instalação).
  `is_throttled` e `is_disabled` **saem do tipo**.
- `isBudgetExhausted` (`:52`) é **APAGADA** — zero chamadores (o único outro hit do grep é
  uma string dentro de regex em `scripts/qa-wave-11.ts:524`).
- `DEFAULTS.monthly_limit_cents: 0` **fica**: org sem linha continua caindo em "sem teto".

### 2.8 `components/ai/BudgetCard.tsx` e `hooks/ai/useAiBudget.ts`

A peça que hoje mente **por default**, para 100% das instalações.

**(a) O diálogo ganha a intenção como ENTRADA de primeira classe** — não inferida do formato
do payload. Três opções em radio, na ordem da escada:

> ( ) **Só acompanhar** — a IA nunca para por gasto.
> ( ) **Me avisar** ao passar de `[80]`% de `[US$ 50,00]` — a IA **continua** respondendo.
> ( ) **Parar a IA** ao chegar em `[US$ 50,00]` — só disponível depois de "Me avisar".

Isto conserta, de graça, o defeito que medi na especificação da onda 7: a regra "escrever
`limit_set_at` quando `monthly_limit_cents` vem no payload" é acionada por um `onSubmit` que
manda os **três** campos incondicionalmente (`:153-158`) — quem abrisse o diálogo só para
mudar o alerta de 80% para 90% carimbaria "teto deliberado" e receberia o estrangulamento
por um clique que não fala de teto nenhum. E conserta o defeito que o juiz apontou no
desenho vencedor: não existe botão "Ligar a proteção" que leve a um modo que não protege —
cada opção diz o que faz.

**(b) O sentinela `0` SAI.** A instrução *"0 desativa o orçamento (sem limite, sem alertas)"*
(`:192`) some; "não quero limite" agora é a primeira opção do radio. Uma representação, um
significado.

**(c) A frase de `:113-119` vira uma por estado, e todas verdadeiras:**
`off` → "Isto é só acompanhamento. A IA não vai parar sozinha por gasto.";
`avisar` → "Avisamos ao passar de {N}%. A IA **não** para.";
`bloquear` pendente → "A proteção começa a valer em {data}. Até lá, só avisamos.";
`bloquear` ativo → "A IA para de responder ao chegar em {teto}. **Quando isso acontecer, as
conversas em andamento vão para a fila de atendimento humano.**" — a segunda frase é o custo
real, dito no momento da decisão, e é o que o desenho vencedor não dizia.

**(d) Kill switch != `on`** → faixa dizendo que a proteção está desligada **nesta instalação**
e que o valor abaixo não vale. Senão é controle decorativo com outro nome.

**(e) Os badges `Pausado`/`Desabilitado` (`:74-77`) SAEM.** Leem `is_throttled`/`is_disabled`,
que têm leitor vivo e **nenhum escritor vivo** — hoje mentem numa direção só, e é a pior: o
card fica em **silêncio** enquanto o gate recusa. O estado passa a vir de um
`budget_exceeded` aberto, que é o único produtor real.

**(f) `action_at_100pct` sai do diálogo (`:209-220`) e a frase que ramifica nele (`:117`)
morre junto.** Sob um gate que recomputa por mês, "Pausar (reversível mensalmente)" e
"Desabilitar (requer reativar manualmente)" não têm significado observável distinto — o
bloqueio já se desfaz sozinho na virada. Dar-lhe efeito exigiria persistir estado em
`is_disabled`, que é justamente a mina que 2.10 desarma. **A coluna fica** (dois leitores de
admin); o controle sai; e a remoção vai na nota de release, declarada — não some calada.

**(g) `alarm_threshold_pct` FICA, e pela primeira vez tem consumidor vivo**: a CTE `avisa` de
`SQL_ORCAMENTO`. Input vai a `min=50 max=99`.

**(h) Unidade.** `lib/agent-engine/edge/llm/pricing.ts:43-49` calcula em dólares e devolve
`usd * 100` — `llm_calls.cost_cents` é **centavo de dólar**; a tela formata o mesmo número
com `Intl.NumberFormat('pt-BR', {currency:'BRL'})` (`:32-39`). O "R$ 50,00" que o dono lê é
US$ 50,00. **Não converto** (exigiria fonte de câmbio: dependência externa nova, novo modo de
falha, número que deriva sozinho). O rótulo e o formatador passam a dizer **US$**, com uma
linha no diálogo explicando que o provedor cobra em dólar. Isto tem que estar no **mesmo**
release em que o teto ganha dentes: armar bloqueio contra um número lido ~5x errado é
estrangulamento por outra porta. É mudança de rótulo visível → **grep em `tests/` antes**; eu
já rodei e está livre:

```console
$ grep -rn "Limite mensal\|Orçamento mensal de IA\|monthly_limit_cents\|Editar limite\|desativa o orçamento" tests/
(vazio)
```

**(i)** `hooks/ai/useAiBudget.ts`: `BudgetPatch` ganha `enforcement_mode` e
`confirmar_imediato`; o optimistic update de `:47-66` cobre os campos novos.

### 2.9 `lib/agent-engine/agent/inbound-turn.ts` — **o lead não fica no vácuo**

Este é o enxerto que nenhum dos três desenhos tinha inteiro, e é o defeito mais grave que a
lente do cliente apontou: quando o bloqueio dispara, a mensagem do lead no WhatsApp morre —
o desenho vencedor tornava o job terminal e suprimia o alerta, sem nada que re-enfileirasse;
o segundo o adiava para o mês seguinte (até 30 dias de silêncio) usando um `deferJob` que
**não existe** (o primitivo é `rescheduleJob`, `lib/agent-engine/queue/queue.ts:284-301`).

A resposta certa já existe no repositório e é feita exatamente para isto:
`performHumanHandoff` (`lib/agent-engine/agent/human-handoff.ts:153-157`), cujo cabeçalho diz
que escalação humana é *"EXIGÊNCIA fiscalizada da Meta, não fallback"* (`:2-4`). Ela força
`contacts.force_human`, transiciona a conversa `ai_handling → pending` (fila humana), cancela
os follow-ups pendentes do lead e abre um `agent_inbox_items` kind `handoff` por contato —
tudo em banco, **sem gastar um único token**.

`inbound-turn.ts` **já importa `performHumanHandoff`** (`:64`) e já tem exatamente a tríade
que ela pede — `{ tenantId, leadId, conversationId: input.conversationId }` (`:996-998`).
Então: envolver as duas chamadas de `runModelCall` (`:2127`, `:2183`) num `catch` de
`LlmBudgetExceededError` que chama `performHumanHandoff` com `reason: 'orcamento_de_ia'` e um
`conversationSummary` **estático** (nunca gerado por LLM — o orçamento acabou), e **relança**.

O lead recebe um humano, não silêncio. `operator-turn.ts` **não** ganha handoff: ali o
"lead" é o próprio operador, e a mensagem de erro na tela dele é a resposta certa.

### 2.10 `workers/agent-worker/main.ts`

No `catch` de `:278-283`, `LlmBudgetExceededError` deixa de ir para `failJob` e passa a
`cancelJob` (`queue.ts:262-276`).

Medido por que isso importa: o erro **não é capturado em lugar nenhum do produto** (grep em
`lib workers app` casa só a definição, o throw e `scripts/smoke-llm.ts`), então hoje ele
subiria até `failJob` (`:220-253`), que reagenda até `max_attempts` (**5**,
`baseline.sql:5558`) e então insere um `job_dead` **crítico por job, sem dedup** — o
comentário de `lib/agent-engine/db/repository.ts:101` diz que `job_dead` QUER uma linha por
evento. Um bloqueio produziria N conversas × 5 tentativas e N alertas críticos rotulados
*"Uma tarefa do assistente falhou"* (`lib/ai/agent-inbox-copy.ts:22`), afogando o único
`budget_exceeded` — esse sim deduplicado. O precedente de que isso dói está escrito no
próprio `queue.ts:238-242` (*"Caso real desta VPS: 16 alertas críticos idênticos"*).

`cancelJob` é a peça exata: seu docstring diz que existe para **veto PERMANENTE de negócio**,
*"não é incidente de sistema, então nem retry nem 'dead' + alerta crítico (seria ruído de
inbox para um opt-out)"* (`:256-259`). O trabalho não fica órfão porque a conversa já foi
para a fila humana em 2.9 — o job termina porque **outra pessoa assumiu**, não porque foi
descartado.

### 2.11 `workers/ai-response-worker.ts` — o guard legado é repontado

O guard de `:408-413` (`skip("budget_throttled")`) lê `is_throttled`/`is_disabled` e passa a
aplicar a regra canônica (`enforcement_mode='bloquear'` + carência vencida + gasto ≥ teto).

**CORREÇÃO MEDIDA AO DESENHO DA ONDA 7:** `docs/design/onda-7-alarme-de-orcamento.md:100`
afirma que `processMessageReceived` é importado *"apenas por testes"* e conclui *"nenhum
chamador de produção"*. A cadeia é contínua e viva:
`docker/scheduler/entrypoint.sh:46` → `app/api/v1/cron/event-log-drain/route.ts:44`
(`ensureHandlersRegistered()`) → `lib/event-log/register-handlers.ts:8,26` →
`workers/ai-response-worker.handler.ts:11,19` → `workers/ai-response-worker.ts:59,289,408`.
Isso **não** derruba a conclusão dele (não dar escritor às flags) — derruba a **razão**, e
desfecho conservador com razão falsa é o que blinda a decisão de ser revista quando alguém a
reusar noutro contexto.

O recorte alcançável é estreito (org com agente ativo, **sem** `published_version_id`, **com**
`active_kb_version_id` — o caminho legado de RAG-bot, isto é, a org mais nova, a de primeira
impressão), e **NÃO MEDIDO** quantas orgs estão nele. Repontar fecha o buraco onde esse
caminho gasta sem teto nenhum e desarma a mina de vez, porque a flag deixa de ter leitor.

**Consequência declarada:** uma org com `is_disabled = true` posto à mão (nenhum escritor vivo
jamais rodou; **hipótese**: conjunto vazio) deixa de ser barrada. A migration abre um item
`info` para essas orgs dizendo que a flag parou de agir e como obter o mesmo efeito
(`enforcement_mode='bloquear'`). Mudança real, declarada, não escondida.

### 2.12 Código morto: **APAGADOS**

`workers/ai-budget-checker.cron.ts` (único escritor de `is_throttled/is_disabled = true`),
`workers/ai-budget-reset.cron.ts` (único escritor de `false`), `lib/ai/dispatcher/budget.ts`
(`@deprecated`).

Reconferido em `760b3d17`: `grep -n budget docker/scheduler/entrypoint.sh` sai **vazio**, e
não há diretório de budget entre os 16 crons de `app/api/v1/cron/`. Nenhum tem chamador.

Deixá-los vivos mantém armada a mina que este desenho desarma: um PR futuro que só
acrescentasse o agendamento pareceria inofensivo e ligaria negação de serviço à distância.
E `runBudgetReset` zera o contador **incondicionalmente** (`:70`): rodando pela primeira vez
no meio de um mês — o caso de **toda** instalação, já que `current_period_start` está
congelado no mês em que a linha nasceu — descartaria o gasto corrente. Trocar erro-para-mais
por erro-para-menos não é conserto.

⚠️ **`lib/ai/dispatcher/index.ts` importa `checkTenantBudget` em `:31` e o chama em `:280`.**
Remover a referência **no mesmo commit**, senão `verify` fica vermelho. (Foi o defeito
apontado no segundo desenho; está resolvido aqui por nomeação explícita.) A rota
`app/api/v1/cron/agent-dispatcher/route.ts:43` já é no-op permanente.

### 2.13 `lib/agent-engine/db/repository.ts` e `lib/ai/agent-inbox-copy.ts`

`budget_warning` no union `InboxKind` (`repository.ts:25-56`) e em `KIND_LABEL`, **na mesma
mudança** que o CHECK do banco. `KIND_LABEL` é `satisfies Record<InboxKind, string>`, então
kind sem rótulo é erro de build; e `tests/invariants/vocabulario-banco-x-typescript.test.ts`
cobra a igualdade contra Postgres real. O comentário do próprio `repository.ts:44-47` avisa
que a lista já ficou três valores atrás do banco sem nada falhar.

Rótulo: `budget_warning: 'O gasto de IA passou do aviso que você definiu'` — diz o que
**aconteceu**, não que algo parou (contraste deliberado com
`budget_exceeded: 'O orçamento de IA foi atingido'`). Severity `warn`, não `critical`.

### 2.14 Painéis de plataforma

`app/api/v1/admin/tenants/[id]/health/route.ts`: **apagar o comentário de `:184`** —
``// `monthly_budget_cents` → `monthly_limit_cents`: mesmo dado, nome real.`` É falso desde
que `assertBudget` existe (fontes, defaults e efeitos opostos) e é o **único texto do
repositório que afirma que este problema não existe**. O gate não lê comentário; nada o
reprovaria. Depois desta mudança `monthly_budget_cents` deixa de ser um conceito: o
comentário sai, não é corrigido. `:185`/`:236` passam a considerar `enforcement_mode`.

`app/api/v1/admin/dashboard/kpis/route.ts`: o alerta de `:207-225` pula `modo === 'off'`
(alertar o operador sobre um teto que não é aplicado é ruído), e a ordenação por `updated_at`
(`:154-157`) deixa de ser usada como sinal de atividade de orçamento — `updated_at` é
reescrito pelo gatilho de consumo a cada `llm_calls` e por todo backfill, então é o carimbo
da última chamada de IA. **E o KPI mentiroso é consertado**: `admin.rpc("fn_admin_ai_budget_warning_count")`
(`:93-96`) chama uma função que **não existe** (grep global: 1 hit, a própria chamada); o
`error` é descartado, `data` vem `null`, `typeof null === "object"` cai no fallback
(`:98-102`) que conta `ai_budgets` com `.gte("current_month_consumed_cents", 0)` — filtro
sempre verdadeiro, porque a coluna é `numeric NOT NULL DEFAULT 0` (`baseline.sql:1056`). O
cartão renderiza **o total de organizações** sob o subtítulo "tenants com uso ≥80%"
(`components/admin/dashboard/KPICards.tsx:81-87`). Vira uma contagem real, in-line, sem RPC.

### 2.15 `scripts/smoke-llm.ts`

Para de gravar `'0'` em `settings.llm.monthly_budget_cents` (`:166-169` — campo que deixa de
existir no resolvedor) e passa a armar `ai_budgets` (`enforcement_mode='bloquear'`,
`enforcement_effective_at=now()`, `monthly_limit_cents=100`) para provar o bloqueio. **E
restaura o estado no fim** — hoje o script não reverte, então um smoke rodado por engano
deixa a org permanentemente bloqueada. É a mesma família de defeito que esta feature conserta.

### 2.16 `lib/database.types.ts`

Regenerar (duas colunas novas em `ai_budgets`). Sem isso o `typecheck` do check obrigatório
`verify` reprova.

---

## 3. MIGRATION

### 3.1 Número: **0159**

Medido neste HEAD: `ls supabase/migrations/` tem `20260814140000_0158_logo_no_storage.sql`
como máximo.

⚠️ **Reconferir na abertura do PR.** Já existe colisão em voo: o número `0155` está usado
duas vezes entre as pontas (o nosso `0155_marca_da_instalacao_no_banco` e um
`20260814010000_0155_a_mensagem_que_responde_outra.sql` em `refs/remotes/jmpo/main`). Há
contribuição externa numerando em paralelo. E **não meça por `git log --all --name-only`** —
merge commit não lista arquivos sem `--diff-merges`, e essa forma erra por 3; a medição
válida é `git ls-tree` nas pontas.

Arquivo: `supabase/migrations/20260814210000_0159_o_teto_que_vincula.sql`.

### 3.2 O SQL, na ordem obrigatória

A ordem é o desenho. **Dados antes de constraint** (doutrina item 8), e — a lição do defeito
fatal do terceiro desenho — **DDL que habilita um dado antes do dado**.

**Este plano não reescreve `monthly_limit_cents` para nenhuma org.** Não há `drop not null`,
não há `set ... = null`, não há mapeamento de `5000`/`0`. Isso elimina, por construção,
toda a família de falha que matou aquele desenho (o `UPDATE ... = null` rodando enquanto a
coluna ainda era `NOT NULL`, abortando o `do $$` inteiro, engolido pelo `update.sh` sem
`ON_ERROR_STOP`, deixando a coluna `enforcement_mode` inexistente e o app novo em `42703`).
A única escrita em `monthly_limit_cents` é o resgate B→A, e ela grava um valor **não-nulo**
numa coluna `NOT NULL`.

```sql
-- ---- o teto de IA que vincula (migration 0159) ----
--
-- A tela editava `ai_budgets.monthly_limit_cents` e o enforcement lia
-- `organizations.settings.llm.monthly_budget_cents`. Quem preenchia a tela
-- acreditava estar protegido e não estava.
--
-- O teto passa a morar SÓ aqui. Ligá-lo no campo da tela, sozinho, estrangularia
-- todo mundo: o DEFAULT 5000 desta coluna torna "escolhi R$ 50" indistinguível de
-- "nunca abri a tela". A saída NÃO é adivinhar a intenção a partir do valor — é
-- tornar o valor INERTE até um admin declarar a intenção. Por isso:
--
--   * `enforcement_mode` nasce 'off' por DEFAULT do ALTER — sem UPDATE nenhum;
--   * `enforcement_effective_at` nasce null, e `null <= now()` nunca é verdadeiro;
--   * NENHUMA linha desta migration escreve `monthly_limit_cents`, EXCETO o bloco
--     RESGATE abaixo — e ele é direção B->A, preservação, nunca criação.
--
-- Vigiado por tests/unit/migracao-nao-arma-ninguem.test.ts (com controle negativo).

-- (1) DDL. Idempotente; re-aplicar é no-op. Linha existente recebe 'off' pelo
--     próprio ALTER, sem UPDATE.
alter table public.ai_budgets
  add column if not exists enforcement_mode text not null default 'off';
alter table public.ai_budgets
  add column if not exists enforcement_effective_at timestamptz;

-- (2) DADOS — RESGATE B->A. O ÚNICO bloco desta migration que escreve
--     'bloquear', e ele preserva o comportamento de HOJE para a única população
--     que hoje pode ser bloqueada. Sem carência: essa org JÁ está capada nesse
--     número, e dar 72h de folga AFROUXARIA o que ela apertou de propósito.
--
--     Garante a linha antes, porque nenhum trigger de `organizations` semeia
--     `ai_budgets` — sem isto, uma org com teto vigente e sem linha perderia o
--     bloqueio quando a chave jsonb saísse em (3).
insert into public.ai_budgets (organization_id)
select o.id from public.organizations o
 where jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
on conflict (organization_id) do nothing;

update public.ai_budgets b
   set monthly_limit_cents      = (o.settings->'llm'->>'monthly_budget_cents')::numeric::integer,
       enforcement_mode         = 'bloquear',
       enforcement_effective_at = now(),
       updated_at               = now()
  from public.organizations o
 where o.id = b.organization_id
   and jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100;
-- `jsonb_typeof = 'number'` e não `is not null`: o jsonb `'null'` e um valor com
-- forma errada (string) precisam cair fora — o `::numeric` de uma string levantaria
-- 22P02 dentro do `update.sh` de um clone, e a doutrina proíbe migration que quebra.
-- Espelha exatamente o `.catch(null)` do Zod em credentials.ts:102: string ali JÁ é
-- `null` (ilimitado) hoje, então não resgatar é preservar.
-- `>= 100` deixa fora o `0` (artefato de scripts/smoke-llm.ts:168, que grava '0' e
-- NÃO restaura) e o implausível. Um `0` ali bloqueia 100% das chamadas com gasto
-- zero; trazê-lo DESARMADO conserta, e é a única vez que esta migration muda
-- comportamento — na direção que AFROUXA.

-- (3) A duplicata some, para não haver duas verdades. Uma instrução, sem
--     read-modify-write de aplicação (o padrão que a 0157 curou depois de medir
--     perda real de chave irmã em organizations.settings).
update public.organizations
   set settings = jsonb_set(settings, '{llm}', (settings->'llm') - 'monthly_budget_cents')
 where jsonb_typeof(settings->'llm') = 'object'
   and settings->'llm' ? 'monthly_budget_cents';
-- Idempotência: a segunda passada casa 0 linhas (a chave já saiu), o que também
-- torna (2) idempotente sem precisar de guarda de catálogo.

-- (4) SANEAMENTO. `is_throttled` só teve escritor no cron morto; qualquer `true`
--     é estado preso. `is_disabled` NÃO é tocado: significaria "um admin
--     desligou", e limpá-lo religaria IA que alguém desligou de propósito.
update public.ai_budgets set is_throttled = false where is_throttled;

-- (5) CONSTRAINT — depois dos dados, sempre (doutrina item 8). O `update.sh` roda
--     SEM ON_ERROR_STOP e engoliria um 23514, deixando a coluna sem validação em
--     silêncio.
alter table public.ai_budgets
  drop constraint if exists ai_budgets_enforcement_mode_check;
alter table public.ai_budgets
  add constraint ai_budgets_enforcement_mode_check
  check (enforcement_mode in ('off','avisar','bloquear'));

alter table public.ai_budgets
  drop constraint if exists ai_budgets_bloquear_precisa_de_teto;
alter table public.ai_budgets
  add constraint ai_budgets_bloquear_precisa_de_teto
  check (enforcement_mode <> 'bloquear' or monthly_limit_cents >= 100);
-- Os dados já satisfazem: 'bloquear' só foi escrito onde o jsonb era >= 100.

-- (6) INFORMAÇÃO, nunca alarme. Item `info` para as orgs cujo `is_disabled` foi
--     posto à mão (hipótese: conjunto vazio) — a flag para de agir quando o guard
--     de workers/ai-response-worker.ts:408-413 é repontado.
insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
select b.organization_id, 'budget_warning', 'info',
       'A pausa antiga de IA por gasto foi desligada',
       'Esta organização estava marcada como desabilitada por gasto num mecanismo '
       'que nunca teve como ser reativado. Para voltar a parar a IA no limite, use '
       'Uso de IA › Orçamento e escolha "Parar a IA ao chegar no limite".',
       'ai_budget', b.organization_id
  from public.ai_budgets b
 where b.is_disabled
   and not exists (
     select 1 from public.agent_inbox_items i
      where i.organization_id = b.organization_id
        and i.kind = 'budget_warning' and i.status = 'open'
   );
```

### 3.3 A função de gasto — **uma régua só**

```sql
create or replace function public.fn_gasto_de_ia_do_mes(p_org uuid)
returns numeric
  language sql stable security invoker
  set search_path to 'public','pg_temp'
as $$
  select coalesce(sum(cost_cents), 0)::numeric
    from public.llm_calls
   where organization_id = p_org
     and created_at >= date_trunc('month', now());
$$;

revoke execute on function public.fn_gasto_de_ia_do_mes(uuid) from public, anon;
revoke execute on function public.fn_gasto_de_ia_do_mes(uuid) from authenticated;
grant  execute on function public.fn_gasto_de_ia_do_mes(uuid) to service_role;
```

**`security invoker`, não `definer`**: ela recebe a org por argumento e não filtra por
membro — uma definer alcançável por `authenticated` seria leitura cross-tenant. Quem a chama
já tem o `orgId` de fonte confiável (o `pg.Pool` do engine, dono; e o admin client via
PostgREST como `service_role`).

**Consequência não-óbvia, e é por isso que os três revokes são obrigatórios:** o bloco
`VARREDURA anon` do baseline (linha `11986`) percorre **só `p.prosecdef`** — ele **não cura
função invoker**. Ela depende inteiramente dos revokes próprios. São duas origens distintas
de `EXECUTE` (item 9 do CLAUDE.md): o grant do Postgres a `PUBLIC` na criação, e o grant
direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do corpo do
dump. `revoke from public` não remove o segundo; `revoke from anon` não remove o primeiro.

**Ela é a ÚNICA definição de gasto do produto.** O gate a chama dentro de `SQL_ORCAMENTO`;
`getBudgetStatus` a chama por RPC; os painéis de admin a chamam. Não há query inline de
`sum(cost_cents)` em lugar nenhum — vigiado por
`tests/unit/orcamento-uma-regua-de-gasto.test.ts`. (Isto corrige uma contradição do desenho
vencedor, que prometia "a MESMA query" e então propunha um invariante calibrando **duas**
queries uma contra a outra: anti-pattern 2 com teste em cima, justo no número em que a
proteção se apoia.)

### 3.4 Apêndice do `supabase/baseline.sql` — **três pontos, e a ordem é load-bearing**

O arquivo tem **12.281 linhas** (medido) e o último rótulo é
`-- ---- logo da marca: BUCKET e COLUNA (migration 0158) ----` na linha **12205**.

1. **`fn_gasto_de_ia_do_mes` entra ANTES da linha 11986**
   (`-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`),
   no molde do bloco da 0157 (`:11639-11766`), terminando com `notify pgrst, 'reload schema';`.
   `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` proíbe **qualquer** `create function`
   ancorado em início de linha depois daquele bloco, e o regex **não distingue** definer de
   invoker. Foi essa dança em dois blocos que a 0158 já teve de fazer.
2. **O kind `budget_warning` entra DENTRO da lista existente**, na reconstrução única de
   `agent_inbox_items_kind_check` (`baseline.sql:9104-9108`) — a constraint é definida uma vez
   só, e `tests/unit/kind-check-migration-x-baseline.test.ts` exige igualdade valor-a-valor
   com a última migration que a reconstrói.
3. **Todo o resto (3.2, itens 1–6) vai no FIM do arquivo**, depois da linha 12205, sob o
   rótulo `-- ---- o teto de IA que vincula (migration 0159) ----`, idempotente e
   auto-curativo — o `update.sh` re-aplica **sem** `ON_ERROR_STOP`.

**Por que a idempotência é natural aqui (e por que isso é uma vantagem, não sorte):** o
resgate (2) é guardado pela remoção da chave em (3) — na segunda passada não há chave, então
casa 0 linhas. O DDL usa `if not exists`. As constraints usam `drop if exists` + `add`. O
saneamento (4) é `where is_throttled`. O item `info` (6) tem `not exists`. **Nenhum bloco
precisa de guarda de catálogo**, porque nenhum bloco reescreve um valor que o usuário possa
ter escolhido depois. É o benefício direto de não tocar `monthly_limit_cents` fora do
resgate — os outros desenhos precisaram inventar guardas (`pg_attribute.attnotnull`,
`information_schema.columns`) justamente porque reescreviam o teto.

Conferido que a ordem coopera: os dois backfills que criam linha para toda org
(`:8653-8662` da 0095 e `:10304-10318` da 0140) rodam **antes** do nosso bloco e não tocam
`enforcement_mode` — a linha que eles criam ganha `'off'` pelo DEFAULT.

### 3.5 Linha do `MANIFEST.md`

Na tabela **Applied**, no padrão denso das 0157/0158, carregando:

- **O quê:** duas colunas em `ai_budgets`, o resgate B→A, o saneamento de `is_throttled`, e
  `fn_gasto_de_ia_do_mes` como definição única de gasto.
- **O porquê:** a tela prometia "a IA pausa ao chegar no limite" para 100% das organizações
  (`DEFAULT 5000 > 0`) e nenhuma estava protegida; o campo que protegia não tinha escritor
  de produto.
- **O não-óbvio, três itens que a próxima triagem vai querer sem reler o SQL:**
  (a) a migration **não arma ninguém** — `enforcement_mode` nasce `'off'` por `ALTER` e o único
  bloco que escreve `'bloquear'` é o resgate rotulado, direção B→A;
  (b) **nenhuma linha reescreve `monthly_limit_cents`** fora do resgate — é o que torna o
  apêndice idempotente sem guarda de catálogo, e quem "simplificar" isso reintroduz a perda
  de configuração a cada `update.sh`;
  (c) `0` significava "sem limite" na tela e "bloqueia tudo" no enforcement; o `>= 100` do
  resgate existe por isso.
- Que os dois CHECKs novos são **cross-coluna / de domínio, não de vocabulário** ⇒ ficam
  **fora** de `PARES` em `tests/invariants/vocabulario-banco-x-typescript.test.ts` (mesma
  classificação que os MANIFESTs da 0157 e 0158 registram para os CHECKs de regex deles).

---

## 4. OS TESTES QUE PROVAM

Regra desta seção: **teste que não reprova sob sabotagem não entra.** Para cada um, a
sabotagem e a contagem de reprovações **prevista antes** de sabotar (previsão errada é sinal
de que o teste mede outra coisa).

### 4.1 `tests/unit/orcamento-decisao.test.ts` — o primeiro artefato do PR

**Guarda:** as sete recusas de `decidirOrcamento`, uma variável por caso.

| Caso | Espera |
|---|---|
| `modo:'off'`, gasto 10× o teto | `seguir` |
| `modo:'avisar'`, gasto 10× o teto | `avisar_e_seguir`, nunca `bloquear` |
| `teto: 0` | `seguir` — a inversão que hoje bloquearia TUDO com gasto zero |
| `teto: 99` (abaixo do piso) | `seguir` |
| `efetivoEm` no futuro | no máximo `avisar_e_seguir` |
| `purpose` em `PURPOSES_ISENTOS` (3 casos) | `seguir` |
| `chave:'off'` / `chave:'avisar'` | `seguir` / rebaixa |
| `avisadoNesteMes:false`, gasto > teto | `avisar_e_seguir` |
| **controle negativo:** as sete satisfeitas | `bloquear` |

**Sabotagem:** remover o early-return de `modo === 'off'`. **Previsão: 1 reprovação** (o
primeiro caso) — as demais têm outra condição ainda barrando. Se reprovar 0, o teste não
guarda o que digo; se reprovar mais de 1, meu modelo das condições está errado e é isso que
precisa ser entendido antes de seguir.

**Sabotagem 2 (a que importa):** trocar `teto <= 0 → seguir` por `teto < 0 → seguir`.
**Previsão: 1 reprovação** (`teto: 0`). É o caso que reproduz o defeito real do produto.

Hoje `grep -rn assertBudget tests/` devolve **zero**: o enforcement vivo nunca teve um teste,
e os dois arquivos que citam `monthly_budget_cents`
(`tests/unit/llm-calls-registra-falha.test.ts:37`,
`tests/unit/seam-respeita-o-binding.test.ts:51`) só o fixam em `null` para ele **não**
atrapalhar. Uma mudança de semântica hoje atravessa `verify`, `invariants`,
`build-and-size` e `e2e` verdes.

### 4.2 `tests/unit/orcamento-chave-de-emergencia.test.ts`

**Guarda:** `normalizarChaveDeOrcamento`. `off|false|0|no|nao|não|OFF|" off "` → `'off'`;
`avisar|warn` → `'avisar'`; `on|""|undefined|"xpto"` → `'on'`. E — o caso que existe por
causa de `lib/env.ts:222` — **um teste do próprio schema**: `AI_BUDGET_ENFORCEMENT="lixo"`
não faz `lib/env.ts` lançar.

**Sabotagem:** trocar o campo por `z.enum(['on','avisar','off'])`. **Previsão: 1 reprovação**
(o caso do schema). É exatamente o furo que o juiz achou no desenho vencedor: a alavanca de
emergência derrubando o app inteiro.

### 4.3 `tests/unit/migracao-nao-arma-ninguem.test.ts` — teste de ARTEFATO

Molde de `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`: mede a propriedade **onde ela
mora, no texto**.

**Guarda:** varre a 0159 e o bloco rotulado do baseline e reprova
(a) qualquer `enforcement_mode` recebendo valor ≠ `'off'` **fora** do bloco `-- (2) ... RESGATE`,
(b) qualquer `update ... ai_budgets ... set ... monthly_limit_cents` fora daquele mesmo bloco,
(c) qualquer `alter column monthly_limit_cents` (o plano não faz nenhum, e um futuro
`drop not null` reintroduz a família de falha do terceiro desenho).

**Guardas de vacuidade** (senão o teste passa por não medir nada): os dois arquivos existem,
não estão vazios, o marcador do resgate foi encontrado exatamente uma vez em cada, e os
textos da migration e do apêndice são equivalentes.

**Controle negativo obrigatório:** injetar
`update public.ai_budgets set enforcement_mode = 'bloquear';` numa **cópia em memória** do
texto e afirmar que o detector a sinaliza. Sem isso, o teste ficaria verde com um detector
quebrado.

**Sabotagem:** remover o escopo por marcador (excluir o resgate globalmente em vez de por
bloco). **Previsão: 1 reprovação** — o controle negativo. O caso "arquivo real está limpo"
continuaria verde, que é precisamente por que o controle negativo existe.

**É este teste que transforma "ninguém é estrangulado" de promessa em propriedade conferível
por quem nunca leu o SQL.**

### 4.4 `tests/unit/orcamento-uma-regua-de-gasto.test.ts` — teste de ARTEFATO

**Guarda:** `lib/agent-engine/edge/llm/orcamento.ts` e `lib/ai/budget/check.ts` **não contêm**
`sum(cost_cents)`, e ambos referenciam `fn_gasto_de_ia_do_mes`. Vacuidade: os arquivos foram
lidos e são não-vazios.

**Sabotagem:** reintroduzir a query inline de `run-model-call.ts:120-125` dentro de
`SQL_ORCAMENTO`. **Previsão: 1 reprovação.** É a catraca contra o anti-pattern 2 voltar por
"otimização".

### 4.5 `tests/unit/api-orcamento-de-ia.test.ts`

A rota que escreve o teto **não tem nenhum teste hoje**: `ls app/api/v1/ai/budget/` devolve
só `route.ts`, e `grep -rln "api/v1/ai/budget" tests/ scripts/` casa apenas
`scripts/qa-wave-11.ts`, que nenhum job de CI invoca.

**Guarda:** `viewer`/`agent`/`manager` → 403 no PATCH; `off→bloquear` → **422** (não 500, não
sucesso); `avisar→bloquear` grava `effective_at ≈ now()+72h`; com `confirmar_imediato` grava
`≈ now()`; armar com teto 50 → 422 nomeando o piso; `alarm_threshold_pct: 30` → 422 do Zod
(**não** 500 do CHECK); afrouxar fecha os `budget_exceeded`/`budget_warning` abertos; cada
mutação emite a linha de auditoria.

**Sabotagem:** remover a checagem da escada (`off→bloquear`). **Previsão: 1 reprovação.**
**Sabotagem 2:** devolver o Zod para `min(1).max(100)`. **Previsão: 1 reprovação** (o caso
30 passaria a 500).

### 4.6 `tests/unit/handoff-por-orcamento.test.ts`

**Guarda:** `inbound-turn` chama `performHumanHandoff` com a tríade correta ao capturar
`LlmBudgetExceededError` e **relança**; `workers/agent-worker/main.ts` roteia essa classe para
`cancelJob`, **não** para `failJob`; e o `conversationSummary` do handoff é uma constante
(nenhuma chamada de LLM no caminho de erro de orçamento).

**Sabotagem:** trocar `cancelJob` de volta por `failJob`. **Previsão: 1 reprovação.**
**Sabotagem 2:** engolir o erro em vez de relançar. **Previsão: 1 reprovação** (o caso do
relançamento) — e é a que importa, porque engolir trocaria uma falha visível por uma
silenciosa.

### 4.7 `tests/invariants/orcamento-nasce-desarmado.test.ts` — **`pnpm test:db`, Postgres real**

Técnica obrigatória: **extrair os blocos DO `baseline.sql` por rótulo e executá-los como
texto** (molde de `tests/invariants/orcamento-apos-backfill.test.ts`). Reimplementar mediria
a minha cópia, e a cópia continuaria certa com o baseline sabotado.

| # | Propriedade | Sabotagem que a deixa vermelha |
|---|---|---|
| a | Depois de `install`, toda org tem `enforcement_mode='off'` | `default 'bloquear'` |
| b | **O dia do `update.sh`:** semeia org + linha em `ai_budgets` com 5000 **ANTES** de executar o bloco; depois do bloco, `count(*) where enforcement_mode <> 'off'` = 0 | `default 'bloquear'`, ou um `update ... set enforcement_mode='avisar'` solto |
| c | Executar o bloco **duas vezes** não muda nenhuma linha (idempotência) | remover a remoção da chave jsonb em (3) — o resgate voltaria a casar |
| d | Org com `settings.llm.monthly_budget_cents = 700` → `monthly_limit_cents=700`, `modo='bloquear'`, `effective_at` não-nulo, chave removida | remover o bloco de resgate |
| e | Org com jsonb `0` → **não** resgatada, `modo='off'`, chave removida | trocar `>= 100` por `>= 0` |
| f | Org com jsonb `"700"` (string) → não resgatada, e o bloco **não levanta 22P02** | trocar `jsonb_typeof = 'number'` por `is not null` |
| g | Org com jsonb válido e **sem** linha em `ai_budgets` → ganha linha e é resgatada | remover o `insert ... on conflict do nothing` |
| h | `fn_gasto_de_ia_do_mes` não é executável por `anon` nem `authenticated`; é por `service_role` | remover qualquer um dos revokes |
| i | Executar `SQL_ORCAMENTO` com item aberto e gasto abaixo do limiar **fecha** o item | remover a CTE `retrata` |
| j | Executar `SQL_ORCAMENTO` com gasto entre limiar e teto abre **um** `budget_warning`; segunda execução não duplica | remover o `not exists` da CTE `avisa` |
| k | Com gasto acima do teto e **nenhum** `budget_warning` no mês, o retorno traz `avisado_antes = false` | trocar `created_at >= date_trunc('month', now())` por `status = 'open'` — e aí fechar o aviso à mão viraria bypass permanente |
| l | O CHECK rejeita `enforcement_mode='xpto'` e rejeita `'bloquear'` com teto 50 | remover qualquer um dos dois CHECKs |

**O caso (b) é a correção direta do defeito fatal do terceiro desenho.** O invariante dele
não semeava linha antes de rodar o bloco, então o caminho `install` (tabela vazia) ficava
verde enquanto o caminho do cliente instalado quebrava. Aqui a semeadura é a **primeira**
instrução do caso.

**Previsão global:** cada sabotagem da tabela reprova **exatamente 1** caso, exceto
`default 'bloquear'`, que reprova **2** (a e b). Se reprovar menos, os casos não são
independentes; se reprovar mais, há acoplamento que precisa ser entendido antes do merge.

### 4.8 Testes existentes que mudam de estado (saber antes, não descobrir pelo CI)

- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — passa a cobrar `budget_warning`
  nos dois lados. É por isso que `repository.ts` e `agent-inbox-copy.ts` mudam **no mesmo
  commit** que o CHECK.
- `tests/unit/kind-check-migration-x-baseline.test.ts` — exige que a lista de kinds da
  migration e a do baseline sejam iguais valor a valor.
- `tests/unit/branding.test.ts:296` — a dívida D1 (template `ai-budget-alarm` na allowlist de
  marca) **NÃO muda**: este plano não constrói e-mail nem cron de alarme, então a condição de
  saída escrita em `docs/architecture/marca-propria.architecture.json:205` ("sai quando o
  alarme ganhar cron de verdade") continua não cumprida. Declaro para que ninguém a "encolha"
  por engano — allowlist só encolhe quando a condição se cumpre.
- `tests/unit/cron-routes-scheduled.test.ts` e `tests/shell/scheduler-entrypoint.test.sh` —
  **intocados**: este plano não cria rota de cron nenhuma.

---

## 5. LIVING SYSTEM CHECKLIST

Regra: resposta que não **nomeia o artefato concreto** não conta.

> **AS-BUILT (2026-08-15, fechamento da entrega).** As respostas abaixo eram do DESENHO. Cinco
> delas mudaram na construção, e a lista das mudanças vem primeiro para que ninguém leia o
> texto antigo achando que é o disco:
>
> 1. **(2) Saída — a escolta subiu.** O desenho a punha em volta das duas chamadas diretas de
>    `runModelCall`. Errado: o turno faz outras chamadas de modelo ANTES delas, por auxiliares
>    (`classifyStage` — que roda em TODO turno — e `maybeCompact`/flush), nenhuma com try/catch.
>    Com o teto estourado, o erro subia do classificador, `performHumanHandoff` NUNCA rodava, e
>    o worker cancelava o job com o lead no vácuo. A escolta agora envolve o TURNO INTEIRO, em
>    `runAgentTurn` (`lib/agent-engine/agent/inbound-turn.ts`), que é o único ponto por onde os
>    três kinds de turno passam. Guarda: `tests/unit/handoff-por-orcamento.test.ts` conta os
>    call sites de `executarTurnoDoAgente` (não exportada) e verifica que os auxiliares vivem
>    DENTRO dela — a versão anterior contava `runModelCall(` no texto e tinha ponto cego
>    exatamente no defeito.
> 2. **(2) Saída — o caminho legado ganhou a mesma resposta.**
>    `workers/ai-response-worker.ts` chama `triggerHandoff` com a MESMA razão
>    (`HANDOFF_REASON_ORCAMENTO`, agora em `orcamento.ts` para os dois emissores a lerem). E o
>    veto SAIU de `buildContext`: ele barrava G1 ("quero falar com um atendente"), G4 legal e
>    G4 stage, porque `processMessageReceived` retorna no primeiro skip. Um lead que PEDIA um
>    humano recebia silêncio.
> 3. **(7) Configuração — o piso guarda `avisar` também.** `avisar` com teto 0 era salvável e
>    produzia um `budget_warning` PERMANENTE e falso (a CTE `avisa` virava `gasto >= 0`, e a
>    `retrata` exigia `gasto < 0`). Recusado no servidor (`route.ts`), espelhado na tela e
>    guardado no próprio `SQL_ORCAMENTO` (`and teto >= PISO`).
> 4. **(9) Laço — a coluna da carência é zerada ao desarmar.** Sem isso a carência ficava
>    pré-gasta e a próxima armada valeria no ato.
> 5. **(4/5) Tela — três textos eram falsos e viraram guarda.** O rótulo do período
>    contradizia o número ao lado dele; a razão do degrau bloqueado prometia uma janela de
>    tempo que o servidor não exige; e o corpo do `budget_exceeded` mandava usar um botão
>    chamado "Retomar atendimento automático" — que **não existe**: o rótulo real, medido em
>    `components/inbox/ConversationHeader.tsx`, é **"Devolver ao automático"**. Guardas:
>    `tests/unit/budget-card-promessas.test.tsx` e o bloco de contrato de rótulo em
>    `tests/unit/handoff-por-orcamento.test.ts` (que LÊ o rótulo do componente, nunca uma
>    cópia).
>
> **O mapa vivo (invariante 10) é `docs/architecture/teto-de-orcamento.architecture.json`:** 26
> nós, 43 arestas, e o card "O laço de retorno" responde o invariante 7 nos quatro modos de
> erro (bloquear quem não devia · não bloquear quem devia · não saber medir · instalação com o
> kill switch afrouxado).

1. **Entrada.** O radio de três estados em `components/ai/BudgetCard.tsx` (`EditBudgetDialog`)
   → `PATCH /api/v1/ai/budget` → `ai_budgets.enforcement_mode`. Consumidor real:
   `lib/agent-engine/edge/llm/credentials.ts` (`left join`), lido por `aplicarOrcamento` em
   `run-model-call.ts` a cada chamada de LLM.

2. **Saída.** Três artefatos: `agent_inbox_items` kind `budget_warning` (novo) e
   `budget_exceeded` (com `ref_kind='ai_budget'`, novo), renderizados em
   `app/app/ai/inbox/_components/AgentInboxList.tsx`; uma linha de falha em `llm_calls`,
   renderizada em `/app/ai/runs` (`app/app/ai/runs/page.tsx`); e a conversa em
   `status='pending'` na fila humana, via `performHumanHandoff`.

3. **Registro visível.** `api_audit_log` com `ai.budget_limit_changed`,
   `ai.budget_enforcement_armed`, `ai.budget_enforcement_disarmed` (hoje: **zero** códigos de
   orçamento em 217). Mais `deps.log?.warn` em `run-model-call.ts` no veredito
   `avisar_e_seguir` e `bloquear` — hoje `assertBudget` **nem recebe** `deps.log`, ao contrário
   do caminho irmão de `:249-266`, 120 linhas abaixo no mesmo arquivo.

4. **Porta na navegação.** Nenhuma tela nova. O card vive em `/app/ai/usage`
   (`app/app/ai/usage/page.tsx`), já registrada em `lib/navigation/registry.ts`; os avisos
   caem em `/app/ai/inbox`, registrada em `registry.ts:304-311`. DoD 14 satisfeito sem
   allowlist.

5. **Anti-morte.** A verificação roda **no caminho que gasta**: se a org gastou, o código
   rodou. Não há cron para apodrecer — e é exatamente por não ter essa propriedade que
   `workers/ai-budget-checker.cron.ts` morreu sem ninguém notar (sem rota, sem linha no
   `docker/scheduler/entrypoint.sh`, medido vazio). Segunda camada:
   `tests/unit/orcamento-uma-regua-de-gasto.test.ts` reprova se alguém recriar uma segunda
   definição de gasto.

6. **Configuração com superfície.** `enforcement_mode`, `monthly_limit_cents` e
   `alarm_threshold_pct` são editáveis na tela e **os três têm consumidor vivo** depois desta
   mudança (o limiar ganha a CTE `avisa` — hoje não tem nenhum). `action_at_100pct` **sai da
   tela** porque não tem: controle sem efeito é o defeito que este plano existe para não
   repetir. A chave `AI_BUDGET_ENFORCEMENT` aparece na faixa do card quando afrouxa.

7. **Laço de retorno — o que muda no sistema quando ela erra.**
   - Errou para o lado **duro** (bloqueou quem não devia): o gate se retrata sozinho na
     chamada seguinte (CTE `retrata`), o PATCH fecha os itens ao afrouxar, e
     `AI_BUDGET_ENFORCEMENT=off` + restart devolve a IA sem tocar em banco.
   - Errou para o lado **frouxo** (não bloqueou): aparece como gasto na tela de Uso, com o
     mesmo número que decide, e é recuperável.
   - **A ponta que hoje está quebrada e este plano solda:** nada fecha o `budget_exceeded`. O
     único auto-resolvedor do produto é `lib/agent-engine/health/circuit.ts:331-335`, escopado
     por `ref_kind = HEALTH_HOLD_REF_KIND` + `ref_id`, e o insert atual
     (`run-model-call.ts:130-140`) **não grava `ref_kind` nenhum**. Virou o mês, a IA voltou, e
     o alerta crítico continuava aceso — estado falso, que é pior que ausente, porque quem lê
     age sobre ele.

---

## 6. O QUE FICA DE FORA, DECLARADO

1. **A moeda não é convertida.** `cost_cents` é centavo de **dólar** (`pricing.ts:43-49`); a
   tela passa a dizer **US$**. Converter exigiria fonte de câmbio — dependência externa nova
   num produto self-host, e um número que deriva sozinho. É decisão do dono do produto; o
   mínimo honesto (o rótulo dizer a unidade real) entra neste commit porque armar um teto
   contra um número lido 5x errado é estrangulamento por outra porta.
2. **Gasto multimodal continua fora de qualquer teto.**
   `workers/media-derive-worker.ts:238` chama `generateText` direto, sem `runModelCall`, e não
   grava `llm_calls`. Transcrição de áudio e leitura de imagem/PDF — o normal de quem usa
   WhatsApp, que é o canal primário — gastam dinheiro que nenhum teto vê e que não aparece na
   tela. Se um dia entrar, entra como **degrau de aviso**, nunca bloqueio surpresa, porque a
   condição 6 protege.
3. **Modelo sem preço não consome teto.** `pricing.ts:14-19,34-37` casa por prefixo contra
   três chaves Claude e devolve `null` fora delas (o docstring diz isso com todas as letras).
   Id de OpenRouter vem prefixado por vendor (`anthropic/claude-…`, formato documentado em
   `lib/ai/cost.ts:68-73`) e **não** casa `startsWith('claude-')`. **HIPÓTESE**, não medida em
   banco: numa instalação OpenRouter — que o instalador oferece como primeira opção — o
   contador fica em zero e um teto armado nunca dispara. Falha **aberta**, direção certa, mas
   é a diferença entre "o teto vale" e "o teto vale para quem usa Claude com id nu". O conserto
   tem caminho pronto: `ai_models` já precifica os 8 modelos dos 4 provedores e o motor não o
   consulta. **É pré-requisito honesto do valor da feature, não detalhe** — item próprio, e o
   card deve dizê-lo quando o provedor não for Anthropic nativo.
4. **`action_at_100pct` sai da tela e a coluna fica.** Remoção visível de um controle que
   nunca fez nada, declarada na nota de release.
5. **Não há teto de plataforma.** Nenhuma superfície de admin escreve nenhum dos campos, e o
   `platform_max_per_tenant` do PRD (`docs/prd/05-prd-ai-rag-handoff.md:156`) nunca foi ao
   schema. Num self-host com revendedor, quem paga a conta do provedor não tem freio sobre o
   tenant. Item próprio — e mais barato agora, porque existe um `enforcement_mode` onde
   pendurar.
6. **Sem e-mail e sem cron de alarme.** O aviso vive na Central. A dívida D1 de marca
   permanece com a condição de saída intacta.
7. **`is_disabled` posto à mão deixa de agir** (2.11), com item `info` avisando. Hipótese:
   conjunto vazio; nenhum escritor vivo jamais rodou.

### O que este plano SACRIFICA, e por quê aceito

**Ninguém sai protegido no dia do upgrade — inclusive quem digitou um teto de propósito.**
É o maior sacrifício e é deliberado. A pessoa que digitou US$ 200 acreditando na frase *"a
IA pausa ao chegar no limite"* continua sem proteção até abrir a tela e escolher. **Recuso
armá-la automaticamente** porque não consigo distingui-la de quem herdou o `DEFAULT 5000`, e
o custo do erro é assimétrico em ordens de grandeza: errar frouxo custa dinheiro de provedor,
é visível na tela de Uso e é recuperável; errar duro mata o WhatsApp de um negócio numa VPS
onde não há para quem ligar, e a descoberta vem pelo cliente dele. Mitigações reais: o card,
no estado `off`, diz em letras grandes que a proteção nunca foi ligada, com o controle a um
clique; o valor que ela digitou é **preservado**, então a frase "você definiu US$ 200" é
honesta; e a auditoria passa a existir, de modo que a pergunta nunca mais precise ser
adivinhada.

**Toda condição ambígua deste plano resolve para "não bloqueia"** — e cada uma tem um caso de
teste com esse nome, para que a próxima pessoa que "simplificar" o gate veja vermelho.

---

## 7. O QUE SE PROVA LOCALMENTE × O QUE SÓ SE PROVA COM BANCO/CI

**Localmente, sem Docker** (`pnpm typecheck`, `pnpm lint`, `pnpm test:unit`):

- 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 — as seis suítes unitárias, incluindo os dois testes de
  artefato que medem o SQL **como texto**. É deliberado que a propriedade central ("a
  migration não arma ninguém") seja verificável sem banco: ela é uma propriedade do arquivo.
- `pnpm lint:channels` e `pnpm test:shell` — lembrete de que **`verify` tem cinco passos** e
  `pnpm lint` sozinho não os inclui. `test:shell` é o único gate que exercita o kit; este
  plano não muda `Dockerfile`, compose nem `install.sh`, mas a variável nova em
  `.env.example`/`.env.hostgator.example` passa por ali.

**Só com Postgres real** (`pnpm test:db`, job `invariants` do CI):

- 4.7 inteiro — as 12 propriedades, inclusive **(b), o dia do `update.sh`**, e **(h)**, os
  privilégios da função.
- A aplicação do `baseline.sql` num `pgvector/pgvector:pg17` em modo **install**
  (`ON_ERROR_STOP=1`) e **update** (re-aplicar, sem a flag) — os dois têm de passar.

**Só com o CI completo:**

- `build-and-size` (`pnpm build`), `e2e` (45 das 46 specs), `imagens-ok`.
- ⚠️ Reconferir a lista de checks obrigatórios na fonte antes de citar qualquer número —
  `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'`.
  Essa lista já apodreceu três vezes no `CLAUDE.md`.

**LACUNA DE VERIFICAÇÃO DECLARADA, não resolvida:** o Docker desta máquina não sobe, então
**nenhum SQL deste plano foi executado** e nenhum invariante foi rodado. `pnpm gov:verify`
**não** cobre `test:db` nem `test:e2e` (`docs/harness-audit.md`) — verde ali não é prova para
uma mudança de schema. Quem implementar **precisa** rodar `pnpm test:db` localmente antes de
abrir o PR; é o único caminho que exercita o `baseline.sql` que o self-hoster realmente
aplica.

**O que continua NÃO MEDIDO, e o que cada número decidiria:**

1. Quantas organizações têm `organizations.settings.llm.monthly_budget_cents` não-nulo — é o
   tamanho exato da população do resgate B→A. O único escritor no repositório é
   `scripts/smoke-llm.ts:168`, um smoke de dev, o que **sugere** zero; sugerir não é medir, e
   o campo é jsonb livre, editável por qualquer acesso privilegiado ao banco.
   `select count(*) from organizations where jsonb_typeof(settings->'llm'->'monthly_budget_cents') = 'number'`
   responde em um segundo. Há **dois** ambientes de produção com bancos diferentes (Vercel e
   VPS) e a resposta pode divergir entre eles.
2. Quantas têm `monthly_limit_cents <> 5000` — dimensiona quantas pessoas vão ler "você
   definiu X, mas nunca foi aplicado".
3. Quantas orgs estão no recorte que alcança o guard de `ai-response-worker.ts:408-413`
   (agente ativo, **sem** `published_version_id`, **com** `active_kb_version_id`) — dimensiona
   o efeito de repontá-lo.
4. Se algum chamador dos guardrails (`guardrails/jailbreak/classifier.ts:107`,
   `guardrails/promise/semantic.ts:106`) trata a exceção como "sem veto". A isenção de
   `purpose` mata a pergunta antes que ela importe, mas ela continua sem resposta.

Nenhum desses números muda a **direção** do plano — a barreira do `default 'off'` vale seja
qual for a distribuição. Eles mudam a **expectativa do dia do deploy**, e o (1) em particular
deve ser medido antes do merge: se a população do resgate for não-vazia, aquele bloco deixa de
ser precaução teórica e vira o pedaço mais delicado do commit.

---

## Apêndice: correções medidas aos desenhos anteriores

- **`docs/design/onda-7-alarme-de-orcamento.md:100`** afirma que `processMessageReceived` só é
  importado por testes e conclui "nenhum chamador de produção". **Falso** — a cadeia via
  `event-log-drain` é contínua (2.11). O desfecho de c.1 sobrevive; a razão não.
- **c.3 (`limit_set_at`)** é substituída. Além de ser um proxy inferido da forma do payload, a
  regra proposta não funciona como escrita: `EditBudgetDialog.onSubmit` manda os **três**
  campos incondicionalmente (`BudgetCard.tsx:153-158`), então mudar só o percentual de alerta
  carimbaria "teto deliberado". `enforcement_mode` é a intenção **declarada**, não inferida.
- **c.8.2** ("badge sem produtor vivo", declarado fora do escopo) é **central**, não periférico:
  é o estado que o dono consulta exatamente quando o agente parou, e hoje ele fica em silêncio
  enquanto o gate recusa.
