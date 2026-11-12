-- manifest: devolve a LEITURA de `llm_calls`, `before_send_traces` e `flywheel_judge_verdicts` à organização dona — a instalação que ficou com RLS ligada e sem policy permissiva volta a mostrar IA › Execuções e o Custo da IA no primeiro `update.sh`; idempotente, por organização, sem tocar em linha.
--
-- 9362 — a policy de leitura que a atualização nunca recriava (#4527).
--
-- O DEFEITO, medido na instalação do membro: `llm_calls` com as 73 chamadas no
-- banco, `relrowsecurity = true` e só as restritivas `support_write_*`. Sem
-- policy PERMISSIVA, a sessão do usuário lê 0 linha — a tela `/app/ai/runs`
-- (app/api/v1/ai/runs/route.ts, `createClient()` + `.eq("organization_id", …)`)
-- mostra "nenhuma execução", e `fn_uso_de_ia` (security invoker, a rota do
-- custo) soma 0 e devolve "Custo da IA no período US$ 0,00". Não é tela: é
-- permissão.
--
-- POR QUE O `update.sh` NÃO CONSERTAVA: a única rotina do baseline que dá a
-- policy de leitura a tabela de organização é
-- `fn_proteger_tabelas_de_organizacao()` (migration 0325), e a régua dela é
-- `and not c.relrowsecurity` — ela SÓ age em tabela com RLS DESLIGADA. Tabela
-- que perdeu a policy com a RLS ligada fica fora da varredura para sempre, e
-- `fn_aplicar_travas_de_suporte()` (0274) só acrescenta as três restritivas de
-- escrita. O estado fica preso: reaplicar o baseline não o cura.
--
-- O CONSERTO é cirúrgico e ADITIVO: `drop policy if exists` + `create policy`
-- de SELECT por `fn_user_org_ids()` — o MESMO filtro da `tenant_isolation_*_all`
-- que a 0050 cria e que o baseline entrega na instalação nova. Não se recria a
-- `_all`: leitura é o que falta, e devolver `for all` a quem só precisa ler abre
-- mais do que o defeito pedia. Quem já tem a `_all` ganha uma policy redundante
-- (permissivas somam em OR) — inofensiva, e é o que mantém esta migração
-- idempotente em banco que já está no ar.
--
-- As duas vizinhas entram junto porque são a MESMA família da 0050 e aparecem
-- do mesmo jeito na instalação do membro: `before_send_traces` é lido com a
-- sessão do usuário em app/api/v1/conversations/[id]/retention/route.ts, e
-- `flywheel_judge_verdicts` alimenta o flywheel. Consertar só `llm_calls`
-- deixaria a mesma armadilha armada para as duas.
--
-- Idempotente: rodar duas vezes converge. Sem `security definer`, sem view, sem
-- backfill, sem dado tocado.

drop policy if exists tenant_isolation_llm_calls_select on public.llm_calls;
create policy tenant_isolation_llm_calls_select on public.llm_calls
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_before_send_traces_select on public.before_send_traces;
create policy tenant_isolation_before_send_traces_select on public.before_send_traces
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts;
create policy tenant_isolation_flywheel_judge_verdicts_select on public.flywheel_judge_verdicts
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
