-- manifest: O caso que vai a `resolved`/`cancelled` marca um próximo passo na demanda que ele abriu, sem decidir o desfecho dela (#2035).
-- ============================================================================
-- 2026-10-01 — 0505: A DEMANDA DO CASO ENCERRADO GANHA PRÓXIMO PASSO (issue #2035)
--
-- ## O buraco, no estado em que a main o tem
--
-- A IA abre um caso de escalação por handoff (§15); esse caso abre uma demanda
-- com `origem='handoff'` e `agent_case_id` preenchido, `estado='em_atendimento'`.
-- Quando o caso chega a `resolved` ou `cancelled`, a demanda ligada ficava ABERTA
-- e SEM PRÓXIMO PASSO para sempre — `fechada_em` nulo, `proximo_passo` nulo. Ela
-- aparece no Radar como "demanda aberta sem próximo passo" e não há por onde
-- agir: a issue #2035 mediu isso numa instalação self-host 1.68.0.
--
-- ## Por que NÃO fechar a demanda aqui
--
-- A doutrina é o contrário, e estava num lugar difícil de achar:
-- `docs/doctrine/sistema-vivo/05-unidade-de-demanda.md:77` — "O sistema não pode
-- ser o único a decidir que uma demanda acabou" — e a 0222 REMOVEU o fecho
-- automático por conversa da 0138 (`drop trigger if exists
-- trg_demanda_fecha_com_conversa`, sem nenhum `create` depois). Um gatilho que
-- gravasse `estado`/`desfecho`/`fechada_em` reabriria por outro caminho o que a
-- 0222 fechou, e o caso pode terminar sem pessoa nenhuma no meio (a própria IA
-- fecha como `resolved`/`cancelled`, `lib/agent-engine/agent/human-cases.ts`).
--
-- ## O que este gatilho faz — o espelho do que a conversa já faz
--
-- Quando uma conversa vai a estado terminal, `fn_service_status` (0222) grava
-- `proximo_passo = coalesce(proximo_passo,'Revisar atendimento e registrar o
-- desfecho da demanda')` e deixa a escolha para uma pessoa. Aqui é o mesmo
-- gesto para o CASO: `resolved` ou `cancelled` preenche o próximo passo da
-- demanda ligada com "Revisar o caso encerrado e registrar o desfecho da
-- demanda" — e NÃO mexe em `estado`, `desfecho` nem `fechada_em`.
--
-- Efeito na tela: a demanda sai da seção "demanda aberta sem próximo passo" do
-- Radar e continua VISÍVEL em "Demandas abertas" do painel da conversa, com
-- "Encerrar demanda" e "Marcar próximo passo" ao lado — até alguém registrar o
-- desfecho. `escalated` não dispara: o caso subiu de nível e o problema do
-- contato segue em trabalho (semântica da 0136).
--
-- ## Por que TRIGGER, e não um emissor em código
--
-- O caso pode terminar por CINCO escritores (`provideCaseUpdate`,
-- `resolveCaseFromHuman`, `markAwaitingLead`, `escalateCase`,
-- `encerrarChamadoPeloAgente`), todos em `lib/agent-engine/agent/human-cases.ts`.
-- Caçar emissor deixa a garantia dependendo de alguém lembrar — a mesma razão
-- pela qual a 0148 resolveu o anúncio de abertura/fechamento do caso com um
-- trigger na TABELA. Isto NÃO viola o anti-pattern nº 9 do CLAUDE.md: o trigger
-- é SQL puro, sem I/O externo, dentro da transação (mesmo mecanismo da 0138/0148).
--
-- As DUAS guardas juntas são o que torna a escrita inofensiva: `proximo_passo is
-- null` (não reescreve o passo que alguém já marcou — e, sem linha a mudar, o
-- `trg_demanda_revision` nem dispara, a revisão não sobe à toa) e `fechada_em is
-- null` (não reabre passo de demanda que alguém já encerrou). Idempotente por
-- construção; `organization_id` vem SEMPRE de `new` = tenant-safe.
--
-- Idempotente (`create or replace` + `drop trigger if exists`), sem coluna e sem
-- backfill. Mesmo texto no apêndice do `supabase/baseline.sql`, ANTES da VARREDURA
-- anon (0116). Sem linha nova no `MANIFEST.md` (doutrina de 02/10/2026 — a
-- descrição é a linha `-- manifest:` acima). Mantido sob gate por
-- `tests/unit/demanda-marca-proximo-passo-com-o-caso.test.ts`.
-- ============================================================================

create or replace function public.fn_demanda_marca_proximo_passo_com_o_caso()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.status not in ('resolved','cancelled') then
    -- 'awaiting_human', 'awaiting_lead' e 'escalated' não encerram o caso:
    -- o problema do contato segue em trabalho e a demanda continua como está.
    return new;
  end if;

  -- O MESMO gesto de `fn_service_status` quando a conversa vai a estado
  -- terminal: o sistema não decide que a demanda acabou, ele garante que ela
  -- não fique sem próximo passo. As duas guardas tornam a escrita inofensiva —
  -- o `where` casando zero linhas não dispara nem o bump de `revision`.
  update public.demandas
     set proximo_passo = 'Revisar o caso encerrado e registrar o desfecho da demanda'
   where organization_id = new.organization_id
     and agent_case_id   = new.id
     and proximo_passo   is null
     and fechada_em      is null;

  return new;
end;
$fn$;

-- ⚠️ AS DUAS ORIGENS DE EXECUTE (doutrina, item 9): público dá a qualquer
-- função nova ao criá-la (revoke from anon não remove) e o default ACL do
-- baseline dá a anon (revoke from public não remove). O PostgREST não pode
-- alcançar esta função como RPC.
revoke execute on function public.fn_demanda_marca_proximo_passo_com_o_caso() from public, anon;
revoke execute on function public.fn_demanda_marca_proximo_passo_com_o_caso() from authenticated;

drop trigger if exists trg_demanda_marca_proximo_passo_com_o_caso on public.agent_cases;
create trigger trg_demanda_marca_proximo_passo_com_o_caso
  after update of status on public.agent_cases
  for each row
  when (old.status is distinct from new.status
        and new.status in ('resolved','cancelled'))
  execute function public.fn_demanda_marca_proximo_passo_com_o_caso();

notify pgrst, 'reload schema';
