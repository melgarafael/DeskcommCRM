-- 0095 — o orçamento de IA passa a contar o runtime que realmente gasta
--
-- `ai_budgets.current_month_consumed_cents` era alimentado por um gatilho
-- existente APENAS em `ai_invocations`, a telemetria dos workers legados. O
-- agent-engine — que é o consumidor padrão (AGENT_DISPATCH_CONSUMER=engine) —
-- grava em `llm_calls`, então o contador ficava em zero para sempre.
--
-- Efeito: a tela mostrava "R$ 0,00 consumidos" com dinheiro saindo, e o alarme
-- em 80% e a pausa em 100% — a proteção que existe justamente para o dono não
-- ser surpreendido pela fatura — nunca disparavam.
--
-- O mesmo gatilho passa a valer nas duas tabelas. Não há risco de contagem
-- dobrada: cada runtime escreve na sua, nunca nas duas.

drop trigger if exists trg_llm_calls_budget on public.llm_calls;
create trigger trg_llm_calls_budget
  after insert on public.llm_calls
  for each row execute function public.fn_update_budget_consumption();

-- Reconcilia o mês corrente a partir da fonte (idempotente: recalcula, não
-- soma), para quem já gastou antes deste gatilho existir.
insert into public.ai_budgets (organization_id, current_month_consumed_cents)
select o.id,
       coalesce((select sum(cost_cents) from public.llm_calls c
                 where c.organization_id = o.id and c.created_at >= date_trunc('month', now())), 0)
     + coalesce((select sum(cost_cents) from public.ai_invocations i
                 where i.organization_id = o.id and i.created_at >= date_trunc('month', now())), 0)
from public.organizations o
on conflict (organization_id) do update
set current_month_consumed_cents = excluded.current_month_consumed_cents,
    updated_at = now();
