-- ============================================================================
-- 0140 — O `update.sh` PARAVA DE COBRAR CERTO O ORÇAMENTO DO MÊS.
--
-- Três peças que existiam separadas e, juntas, passaram a mentir:
--
--   1. `fn_update_budget_consumption` é um trigger AFTER INSERT que soma
--      `NEW.cost_cents` a `ai_budgets.current_month_consumed_cents` — **sem
--      olhar a data da linha**. Ele existe para contar gasto NOVO, e para isso
--      a data é sempre "agora".
--   2. A 0095 pendurou esse mesmo trigger em `llm_calls`.
--   3. A 0130 fez o backfill de `ai_invocations` para dentro de `llm_calls`.
--
-- O backfill é um INSERT, então o trigger disparou uma vez por linha migrada —
-- inclusive pelas de meses passados. Migrar histórico virou "gastar dinheiro
-- novo". E o recomputo da 0095, que roda ANTES no arquivo, somava
-- `llm_calls + ai_invocations` do mês, de modo que as linhas migradas passaram
-- a ser contadas nas duas pontas.
--
-- Medido em pg17 com fixture (org com 1000 centavos de ai_invocations do mês,
-- 400 de três meses atrás e 600 de llm_calls do mês — gasto real do mês 1600):
--
--     antes do update.sh ....... 0
--     depois de UM update.sh ... 3000   (+87,5%, inclusive os 400 de 3 meses atrás)
--     re-aplicando ............. 2600   (estabiliza ERRADO, nunca em 1600)
--
-- Numa organização com histórico e gasto ZERO no mês, o contador saltava de 0
-- para o total histórico — 200% do `monthly_limit_cents` padrão de 5000 no caso
-- medido. É o número que a tela mostra e que `lib/ai/dispatcher/budget.ts` lê
-- para decidir throttle: a IA do clone podia parar sem nenhuma chamada nova.
--
-- ## O conserto, e por que não é `disable trigger`
--
-- Desligar o trigger em volta do backfill resolveria a peça 3 e deixaria a
-- peça 2 de pé — e, pior, um `update.sh` que morresse entre o disable e o
-- enable deixaria a instalação sem contador nenhum, em silêncio.
--
-- O que este bloco faz é dar a ÚLTIMA PALAVRA a um recomputo correto, que roda
-- DEPOIS do backfill: atribui (não incrementa) o gasto real do mês corrente,
-- contando cada linha uma vez só. Seja qual for o estado que o trigger deixou,
-- o valor final é o certo — e a re-aplicação chega no mesmo número, que é o
-- que "idempotente" tem de significar aqui.
--
-- ## O que MUDA de comportamento, declarado
--
-- O total do mês passa a incluir o que os workers legados gastaram. Esse
-- dinheiro sempre saiu; ele é que não era contado, porque vivia em
-- `ai_invocations` e o enforcement lia só `llm_calls`. Uma organização cujo
-- teto esteja entre o valor subcontado e o real vai ver o agente pausar — pela
-- primeira vez com razão. Isto está aqui por escrito para que a pergunta "por
-- que o agente parou no dia da atualização?" tenha resposta.
-- ============================================================================

insert into public.ai_budgets (organization_id, current_month_consumed_cents)
select o.id,
       -- `llm_calls` é a tabela única desde a 0130, e já contém as linhas
       -- migradas com o `created_at` ORIGINAL — o recorte por mês continua
       -- valendo.
       coalesce((select sum(c.cost_cents) from public.llm_calls c
                 where c.organization_id = o.id
                   and c.created_at >= date_trunc('month', now())), 0)
       -- A parcela legada conta APENAS o que o backfill ainda não trouxe. Sem
       -- o `not exists`, a mesma linha entra duas vezes — que é exatamente
       -- como o número estabilizava errado.
     + coalesce((select sum(i.cost_cents) from public.ai_invocations i
                 where i.organization_id = o.id
                   and i.created_at >= date_trunc('month', now())
                   and not exists (
                     select 1 from public.llm_calls c2 where c2.legacy_invocation_id = i.id
                   )), 0)
from public.organizations o
on conflict (organization_id) do update
set current_month_consumed_cents = excluded.current_month_consumed_cents,
    updated_at = now();
