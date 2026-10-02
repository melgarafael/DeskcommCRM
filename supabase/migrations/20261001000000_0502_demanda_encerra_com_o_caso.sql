-- ============================================================================
-- 2026-10-01 — 0502: A DEMANDA ABERTA PELO CASO ENCERRA COM O CASO (issue #2035)
--
-- ## O buraco, no estado em que a main o tem
--
-- A IA abre um caso de escalação por handoff (§15). Esse caso abre uma demanda
-- com `origem='handoff'` e `agent_case_id` preenchido, `estado='em_atendimento'`.
-- Quando o caso chega a um status terminal (`resolved` ou `cancelled`), a
-- demanda ligada FICA ABERTA: `estado='em_atendimento'`, `fechada_em` nulo, sem
-- próximo passo — e não há nada que a feche.
--
--   * O fecho por conversa (`fn_demanda_fecha_com_conversa`, 0138) só dispara
--     quando a conversa vai a `resolved`/`closed` — o handoff de caso, cuja
--     conversa é arquivada, não a alcança.
--   * `fn_demanda_encerrar` exige um ator humano e uma revisão; num caso
--     cancelado pelo próprio agente, a demanda ficaria eternamente "aberta sem
--     próximo passo" no Radar (issue #2035), sem nunca aparecer como encerrada.
--
-- ## Por que TRIGGER, e não um emissor em código
--
-- O caso pode terminar por CINCO escritores (`provideCaseUpdate`,
-- `resolveCaseFromHuman`, `markAwaitingLead`, `escalateCase`,
-- `encerrarChamadoPeloAgente`), todos em `lib/agent-engine/agent/human-cases.ts`.
-- Caçar emissor deixa a garantia dependendo de alguém lembrar — a mesma razão
-- pela qual a 0148 resolveu o anúncio de abertura/fechamento com um trigger na
-- TABELA. Aqui a garantia é da Tabela: qualquer UPDATE que leve `agent_cases` a
-- um desfecho fecha a demanda que ele abriu, sem coerção sobre quem escreve.
--
-- Isto NÃO viola o anti-pattern nº 9 do CLAUDE.md: o trigger é SQL puro, sem
-- I/O externo, dentro da transação (mesmo mecanismo da 0138/0148/0500).
--
-- ## O que fecha, e o que deliberadamente NÃO fecha
--
--   * `resolved`  → demanda `estado='resolvida'` / `desfecho='resolvida'`.
--   * `cancelled` → demanda `estado='encerrada'` / `desfecho='nao_procede'`.
--   * `escalated` NÃO fecha a demanda: o caso subiu de nível, mas o problema do
--     contato segue em trabalho (é a mesma semântica que 0136 deu a derivar).
--
-- A guarda `fechada_em is null` torna o fecho idempotente: re-aplicar a
-- transição ou um segundo fecho concorrente não reescreve demanda já encerrada.
-- `organization_id` vem SEMPRE de `new` — não há superfície para alcançar
-- demanda de outra organização (tenant-aware por construção).
--
-- Idempotente (`create or replace` + `drop trigger if exists`), sem coluna e
-- sem backfill. Mesmo texto no apêndice do `supabase/baseline.sql`, ANTES da
-- VARREDURA anon (0116). Mantida sob gate por
-- `tests/unit/demanda-encerra-com-o-caso.test.ts` (leitura do fonte).
-- ============================================================================

create or replace function public.fn_demanda_fecha_com_caso()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_estado  text;
  v_desfecho text;
begin
  if new.status = 'resolved' then
    v_estado   := 'resolvida';
    v_desfecho := 'resolvida';
  elsif new.status = 'cancelled' then
    v_estado   := 'encerrada';
    v_desfecho := 'nao_procede';
  else
    -- 'awaiting_human','awaiting_lead' e 'escalated' não encerram a demanda.
    return new;
  end if;

  -- Fecha a demanda que ESTE caso abriu (origem='handoff', agent_case_id
  -- preenchido). `fechada_em is null` = idempotente sob reaplicação/corrida.
  update public.demandas
     set estado          = v_estado,
         desfecho        = v_desfecho,
         proximo_passo   = null,
         proximo_passo_em = null,
         fechada_em      = clock_timestamp(),
         updated_at      = clock_timestamp()
   where organization_id = new.organization_id
     and agent_case_id   = new.id
     and fechada_em is null;

  return new;
end;
$fn$;

-- ⚠️ AS DUAS ORIGENS DE EXECUTE (doutrina, item 9): público dá a qualquer
-- função nova ao criá-la (revoke from anon não remove) e o default ACL do
-- baseline dá a anon (revoke from public não remove). O PostgREST não pode
-- alcançar esta função como RPC.
revoke execute on function public.fn_demanda_fecha_com_caso() from public, anon;
revoke execute on function public.fn_demanda_fecha_com_caso() from authenticated;

drop trigger if exists trg_demanda_fecha_com_caso on public.agent_cases;
create trigger trg_demanda_fecha_com_caso
  after update of status on public.agent_cases
  for each row
  when (old.status is distinct from new.status
        and new.status in ('resolved','cancelled'))
  execute function public.fn_demanda_fecha_com_caso();

notify pgrst, 'reload schema';