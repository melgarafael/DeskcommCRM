-- 0159 — O TETO DE IA QUE VINCULA
--
-- A tela editava `ai_budgets.monthly_limit_cents` e o enforcement lia
-- `organizations.settings.llm.monthly_budget_cents`. Dois campos, duas fontes,
-- nenhuma ligação entre eles: quem preenchia a tela acreditava estar protegido e
-- não estava, e a frase da tela ("a IA pausa ao chegar no limite") era falsa para
-- 100% das instalações.
--
-- O teto passa a morar SÓ em `ai_budgets`. Mas ligar a coluna da tela no gate,
-- sozinho, estrangularia todo mundo: aquela coluna tem `DEFAULT 5000`, o que
-- torna "escolhi US$ 50" indistinguível de "nunca abri a tela", e os dois
-- backfills do apêndice criam linha para TODA organização em todo `install.sh` e
-- todo `update.sh`. A saída NÃO é adivinhar a intenção a partir do valor herdado
-- — é tornar o valor INERTE até um admin declarar a intenção, num campo que só
-- existe para isso.
--
-- ⚠️ ESTA MIGRATION NÃO ARMA NINGUÉM.
--
--   * `enforcement_mode` nasce 'off' pelo DEFAULT do próprio ALTER — sem UPDATE,
--     sem heurística, sem backfill. A linha que já existe recebe 'off' porque é
--     assim que `add column ... not null default` preenche o existente;
--   * `enforcement_effective_at` nasce null, e `null <= now()` é null, nunca
--     verdadeiro;
--   * NENHUMA linha reescreve `monthly_limit_cents`, EXCETO o bloco RESGATE
--     abaixo — e ele é direção B->A: preserva o bloqueio de quem HOJE já é
--     bloqueado pelo jsonb. Preservação, nunca criação. A afirmação conferível é
--     "nenhuma organização ganha uma capacidade de bloqueio que já não tivesse".
--
-- Vigiado por `tests/unit/migracao-nao-arma-ninguem.test.ts`, que mede a
-- propriedade onde ela mora (no texto deste arquivo e do apêndice do baseline) e
-- carrega controle negativo — sem ele, um detector quebrado deixaria este arquivo
-- verde por não medir nada.
--
-- ⚠️ E NENHUM BLOCO DEPENDE DE UM `ALTER` QUE SÓ RODA DEPOIS DELE.
--
-- É a lição de um desenho concorrente que morreu na medição, executado num pg17
-- de verdade: ele punha `update ... set monthly_limit_cents = null` DENTRO de um
-- `do $$` e deixava o `alter column ... drop not null` DEPOIS do bloco. Em
-- instalação fresca (`organizations` vazia, `ON_ERROR_STOP=1`) o UPDATE casava 0
-- linhas e o CI ficava verde. Em CLONE INSTALADO — uma linha com 5000, que é toda
-- organização de todo self-host — o UPDATE estourava não-nulo, e como `do $$` é
-- UM statement o rollback levava junto o `add column`. O `update.sh` roda SEM
-- `ON_ERROR_STOP`: o erro era engolido, o script terminava com exit 0, a coluna
-- nova ficava INEXISTENTE, e o release seguinte — que a consulta — derrubaria
-- toda chamada de IA de todo clone atualizado com 42703. O caminho que o CI
-- exercita verde, o caminho do cliente quebrado.
--
-- Aqui a ordem é: DDL primeiro, dados depois, constraint por último (doutrina de
-- migrations, item 8), e o dado que uma DDL habilita nunca vem antes dela.
--
-- Idempotente e portável em `psql` puro: `create or replace function`,
-- `add column if not exists`, `drop constraint if exists` + `add`, e o resgate é
-- guardado pela própria remoção da chave jsonb — na segunda passada não há chave,
-- então ele casa 0 linhas. Sem `BEGIN`/`COMMIT`, sem temp table, sem guarda de
-- catálogo (nenhum bloco reescreve um valor que o usuário possa ter escolhido
-- depois — é o benefício direto de não tocar `monthly_limit_cents` fora do
-- resgate).


-- ---- gasto de IA do mês: uma régua só (migration 0159) ----
--
-- O NÚMERO EXIBIDO PASSA A SER O NÚMERO QUE DECIDE.
--
-- Antes desta função havia duas contagens de gasto no produto e elas divergiam:
--
--   * a query inline de `assertBudget` (`lib/agent-engine/edge/llm/run-model-call.ts`),
--     que soma `llm_calls` do mês corrente — é ela que barrava a chamada;
--   * `ai_budgets.current_month_consumed_cents`, que é o que a TELA mostra — um
--     contador materializado pelo gatilho `fn_update_budget_consumption`, que soma
--     `NEW.cost_cents` SEM olhar a data e nunca zera (o `runBudgetReset` jamais foi
--     agendado). O único recomputo em produção é o apêndice da 0140, que só roda
--     no `install.sh`/`update.sh` — numa instalação que não atualiza há três meses,
--     o card compara três meses de gasto contra um teto MENSAL.
--
-- Armar uma proteção contra um número que não é o número que decide é pedir para
-- a pessoa proteger-se de uma mentira. Uma régua só, e ela é esta.
--
-- `security invoker`, NÃO `definer`: a função recebe a organização por argumento
-- e não valida membership. Uma definer alcançável por `authenticated` seria
-- leitura de gasto cross-tenant. Quem a chama já tem o `organization_id` de fonte
-- confiável — o `pg.Pool` do engine (dono do schema) e o admin client via
-- PostgREST (`service_role`).
--
-- ⚠️ E POR SER INVOKER ELA DEPENDE INTEIRAMENTE DOS PRÓPRIOS REVOKES: o bloco
-- `VARREDURA anon` do baseline percorre só `p.prosecdef`, então ele NÃO cura
-- função invoker. São duas origens distintas de EXECUTE (CLAUDE.md, item 9):
--   (A) o grant que o Postgres dá a PUBLIC ao criar qualquer função — que
--       `revoke ... from anon` não remove;
--   (B) o grant DIRETO a anon do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
--       FUNCTIONS TO anon` do corpo do dump, que vale para toda função criada
--       depois dele (isto é, para todo apêndice) — que `revoke ... from public`
--       não remove.
-- Tratar só uma deixa a função servida como RPC pela anon key, que vai ao browser.
-- `authenticated` sai pelo motivo de (B) e mais um: é ele que carrega o JWT de
-- qualquer pessoa logada, e a organização vem por argumento.
create or replace function public.fn_gasto_de_ia_do_mes(p_org uuid)
returns numeric
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  select coalesce(sum(cost_cents), 0)::numeric
    from public.llm_calls
   where organization_id = p_org
     and created_at >= date_trunc('month', now());
$$;

comment on function public.fn_gasto_de_ia_do_mes(uuid) is
  'Gasto de IA da organização no mês corrente, em centavos de DÓLAR (llm_calls.cost_cents vem de pricing.ts, que calcula em USD). É a ÚNICA definição de gasto do produto: o gate a chama dentro de SQL_ORCAMENTO (lib/agent-engine/edge/llm/orcamento.ts), a tela a chama por RPC e o painel de saúde por tenant a chama. O dashboard de plataforma (app/api/v1/admin/dashboard/kpis) AINDA lê ai_budgets.current_month_consumed_cents, um contador acumulado que nada zera, e por isso pode divergir — a divergência está declarada naquele arquivo e o alerta de lá nunca é critical. Query inline de sum(cost_cents) em outro lugar é uma segunda régua, e a segunda régua sempre diverge — vigiado por tests/unit/orcamento-uma-regua-de-gasto.test.ts. security invoker: recebe a organização por argumento e não valida membership, então definer aqui seria leitura cross-tenant.';

revoke execute on function public.fn_gasto_de_ia_do_mes(uuid)
  from public, anon, authenticated;
grant  execute on function public.fn_gasto_de_ia_do_mes(uuid)
  to service_role;


-- ---- o kind budget_warning na Central (migration 0159) ----
--
-- O aviso de limiar precisa de um kind próprio, e ele é `warn`, não `critical`:
-- `budget_exceeded` diz que algo PAROU, este diz que o gasto passou do aviso que
-- a pessoa definiu e a IA continua respondendo. Colapsar os dois no mesmo kind
-- faria o alerta de "parou" perder o significado.
--
-- Este kind é o que torna a condição 6 do gate possível: NINGUÉM É BLOQUEADO SEM
-- TER SIDO AVISADO NO MÊS. Sem ele, o salto de 79% para 101% entre duas chamadas
-- calaria a IA sem nenhum sinal anterior.
--
-- ⚠️ A LISTA É COPIADA INTEIRA DO BASELINE, e não "só o valor novo". Esta
-- constraint não se altera: ela é DERRUBADA e RECONSTRUÍDA, então a última
-- migration a reconstruí-la é a que vale, e uma lista incompleta não é aditiva —
-- é remoção silenciosa (foi assim que a 0129 apagou três kinds em uso, e o
-- sintoma é o pior: o INSERT bate 23514, o `catch` fire-and-forget engole, e o
-- operador simplesmente nunca vê o aviso). Cobrado por
-- `tests/unit/kind-check-migration-x-baseline.test.ts` (igualdade valor a valor
-- com o baseline) e por `tests/unit/migrations-nao-encolhem-vocabulario.test.ts`.
--
-- No `baseline.sql` o valor novo entra DENTRO do bloco único desta constraint
-- (regra da issue #159), nunca num bloco novo no fim do arquivo.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    -- O valor novo desta migration entra no FIM da lista, e não ao lado de
    -- `budget_exceeded`: `tests/unit/midia-nao-lida.test.ts` procura
    -- `'midia_nao_lida'` nos primeiros 2000 caracteres a partir do
    -- `add constraint` do baseline, e um valor comentado inserido acima dele o
    -- empurra para fora da janela (medido: offset 1532 -> 2275), reprovando um
    -- teste que não tem nada a ver com o kind novo.
    'budget_warning',
    'other'
  ));


-- ---- o teto de IA que vincula (migration 0159) ----
--
-- ⚠️ ESTE BLOCO EXISTE EM DOIS ARQUIVOS, PALAVRA POR PALAVRA:
-- `supabase/migrations/20260814210000_0159_o_teto_que_vincula.sql` (o que o
-- Supabase CLI aplica) e o FIM de `supabase/baseline.sql` (o que o kit self-host
-- aplica, no `install.sh` e no `update.sh`).
-- `tests/unit/migracao-nao-arma-ninguem.test.ts` compara os dois textos: divergir
-- significa que o self-hoster recebe um SQL diferente do que a migration afirma,
-- e é justamente o par que ninguém confere lendo só um dos dois.

-- (1) DDL. Idempotente; re-aplicar é no-op. A linha que já existe recebe 'off'
--     pelo próprio ALTER — não há UPDATE nenhum aqui, e é essa ausência que
--     torna impossível esta migration armar alguém.
alter table public.ai_budgets
  add column if not exists enforcement_mode text not null default 'off';
alter table public.ai_budgets
  add column if not exists enforcement_effective_at timestamptz;

comment on column public.ai_budgets.enforcement_mode is
  'A INTENÇÃO, declarada por um admin — nunca inferida do valor do teto. off = só acompanhar (a IA nunca para por gasto); avisar = abre budget_warning ao passar do limiar e SEGUE; bloquear = recusa a chamada quando o gasto atinge o teto. Nasce off por DEFAULT do ALTER, e é por isso que ligar o teto no gate não estrangula quem herdou o DEFAULT 5000 de monthly_limit_cents. Escrito só por PATCH /api/v1/ai/budget (admin, auditado); lido por lib/agent-engine/edge/llm/credentials.ts.';

comment on column public.ai_budgets.enforcement_effective_at is
  'Carência: a partir de quando bloquear passa a valer de fato (now()+72h ao armar pela tela). Nasce NULL, e null <= now() é null — nunca verdadeiro —, então modo bloquear sem esta data ainda não bloqueia. Existe para que armar a proteção não seja um interruptor que corta o WhatsApp do negócio no mesmo instante, sem ninguém ver o aviso antes.';

-- (2) DADOS — RESGATE B->A.
--
-- >>> RESGATE B->A: INICIO <<<
--
-- O ÚNICO bloco desta migration que escreve 'bloquear', e o único que escreve
-- `monthly_limit_cents`. Ele preserva o comportamento de HOJE para a única
-- população que hoje PODE ser bloqueada: quem tem
-- `organizations.settings.llm.monthly_budget_cents` com um número vigente.
--
-- Sem carência (`now()`, não `now()+72h`): essa organização JÁ está capada nesse
-- número, e dar 72h de folga AFROUXARIA o que ela apertou de propósito.
--
-- Garante a linha ANTES do update, porque nenhum gatilho de `organizations`
-- semeia `ai_budgets` — os produtores são o gatilho de `llm_calls`, os dois
-- backfills do baseline e o PATCH. Sem o insert, uma organização com teto vigente
-- e sem linha perderia o bloqueio no instante em que a chave jsonb saísse em (3).
insert into public.ai_budgets (organization_id)
select o.id from public.organizations o
 where jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric <= 2147483647
on conflict (organization_id) do nothing;

update public.ai_budgets b
   set monthly_limit_cents      = (o.settings->'llm'->>'monthly_budget_cents')::numeric::integer,
       enforcement_mode         = 'bloquear',
       enforcement_effective_at = now(),
       updated_at               = now()
  from public.organizations o
 where o.id = b.organization_id
   and jsonb_typeof(o.settings->'llm'->'monthly_budget_cents') = 'number'
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric >= 100
   and (o.settings->'llm'->>'monthly_budget_cents')::numeric <= 2147483647;
--
-- As três condições, e cada uma existe para não derrubar o `update.sh` de um
-- clone ou para não apertar quem ninguém apertou:
--
--   * `jsonb_typeof = 'number'` e NÃO `is not null`: o jsonb `'null'` e um valor
--     com forma errada (string) caem fora. `('"700"'::jsonb->>...)::numeric`
--     funcionaria, mas `'abc'` levantaria 22P02 dentro do `update.sh` de um clone,
--     e a doutrina proíbe migration que quebra. Espelha exatamente o `.catch(null)`
--     do Zod em `credentials.ts`: valor com forma errada JÁ é `null` (ilimitado)
--     hoje, então não resgatar é PRESERVAR.
--   * `>= 100` deixa fora o `0` (artefato de `scripts/smoke-llm.ts`, que grava '0'
--     e NÃO restaura) e o implausível. Um `0` ali bloqueia 100% das chamadas com
--     gasto zero — a inversão perfeita —, e trazê-lo DESARMADO conserta. É a única
--     vez que esta migration muda comportamento, e é na direção que AFROUXA.
--   * `<= 2147483647` porque `monthly_limit_cents` é `integer`. Medido em pg17:
--     `('{"a":1e20}'::jsonb->>'a')::numeric::integer` levanta `22003 integer out of
--     range`, e `jsonb_typeof` daquilo é 'number'. É jsonb LIVRE, editável por
--     qualquer acesso privilegiado ao banco; sem este corte, uma linha assim
--     abortaria o statement dentro de um `update.sh` sem `ON_ERROR_STOP` — erro
--     engolido, resgate não feito, exit 0. Fora do intervalo não é orçamento, é
--     erro de unidade, e erro de unidade não pode calar a IA nem quebrar o kit.
--
-- >>> RESGATE B->A: FIM <<<

-- (3) A duplicata some, para não haver duas verdades. Uma instrução, sem
--     read-modify-write de aplicação — o padrão que a 0157 curou depois de medir
--     perda real de chave irmã em `organizations.settings` (`visibility_mode`
--     voltando de 'own' para 'all' em silêncio, e ele é lido DIRETO pela RLS).
update public.organizations
   set settings = jsonb_set(settings, '{llm}', (settings->'llm') - 'monthly_budget_cents')
 where jsonb_typeof(settings->'llm') = 'object'
   and settings->'llm' ? 'monthly_budget_cents';
-- Idempotência: a segunda passada casa 0 linhas (a chave já saiu), o que também
-- torna (2) idempotente sem precisar de guarda de catálogo.

-- (4) SANEAMENTO. `is_throttled` só teve escritor no cron morto
--     (`workers/ai-budget-checker.cron.ts`, sem rota e sem linha no
--     `docker/scheduler/entrypoint.sh`), então qualquer `true` é estado preso.
--     `is_disabled` NÃO é tocado: significaria "um admin desligou", e limpá-lo
--     religaria IA que alguém desligou de propósito.
update public.ai_budgets set is_throttled = false where is_throttled;

-- (5) CONSTRAINT — depois dos dados, sempre (doutrina de migrations, item 8). O
--     `update.sh` roda SEM `ON_ERROR_STOP` e engoliria um 23514, deixando a
--     coluna sem validação em silêncio. `drop if exists` + `add`, e não
--     `add ... if not exists` (que o Postgres não tem para constraint): é o que
--     torna a REGRA idempotente, e não só a criação.
alter table public.ai_budgets
  drop constraint if exists ai_budgets_enforcement_mode_check;
alter table public.ai_budgets
  add constraint ai_budgets_enforcement_mode_check
  check (enforcement_mode in ('off', 'avisar', 'bloquear'));

alter table public.ai_budgets
  drop constraint if exists ai_budgets_bloquear_precisa_de_teto;
alter table public.ai_budgets
  add constraint ai_budgets_bloquear_precisa_de_teto
  check (enforcement_mode <> 'bloquear' or monthly_limit_cents >= 100);
-- Os dados já satisfazem: 'bloquear' só foi escrito em (2), onde o jsonb era
-- >= 100. O CHECK é o backstop de "armado sem valor útil" tentando renascer pela
-- porta da frente — a régua da vez é o 422 da rota, não ele.
--
-- ⚠️ SÓ `ai_budgets_bloquear_precisa_de_teto` é CHECK cross-coluna / de domínio,
-- e por isso fica FORA da lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — mesma classificação
-- que os CHECKs de regex da 0155/0157/0158.
--
-- `ai_budgets_enforcement_mode_check` É de vocabulário: um conjunto fechado com
-- par em TypeScript (`ModoDeOrcamento`, em
-- `lib/agent-engine/edge/llm/orcamento.ts`), lido no caminho quente. Ele ESTÁ em
-- `PARES`. Classificá-lo como domínio — o que este comentário e o MANIFEST
-- fizeram — deixava a coluna fora do único gate que pega a classe: um valor novo
-- entra num lado só, passa em typecheck/lint/unit, e aparece como 23514 em
-- produção.

-- (6) INFORMAÇÃO, nunca alarme. Item `info` para as organizações cujo
--     `is_disabled` foi posto à mão (HIPÓTESE: conjunto vazio — nenhum escritor
--     vivo jamais rodou): a flag para de agir quando o guard legado de
--     `workers/ai-response-worker.ts` é repontado para a regra canônica. Mudança
--     real, declarada, não escondida — e `info` porque nada quebrou.
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

notify pgrst, 'reload schema';
