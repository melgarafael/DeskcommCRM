-- 0083 — a proposta de reativação vencida tem PARA ONDE IR
--
-- Sem este kind, o vencimento seria uma linha de banco e nada mais: a proposta
-- sai do card e desaparece. "Some do card" resolve a simulação de atenção e
-- cria o problema anterior de volta — o negócio parado sem ninguém sabendo.
--
-- A demanda que a wave criou não pode morrer por silêncio, e é EXATAMENTE a
-- mesma forma da promessa cujo prazo depende de terceiro: sem fallback
-- declarado, ela não é quebrada por decisão — ELA EXPIRA SOZINHA E NINGUÉM
-- PERCEBE QUE DECIDIU. O item de caixa é o fallback, e ele tem dono e ação
-- nomeada porque item sem ação é o ruído que a doutrina proíbe.
--
-- ⚠️ O `InboxKind` em `lib/agent-engine/db/repository.ts` e o
-- `Record<InboxKind, string>` em `lib/ai/agent-inbox-copy.ts` são as outras
-- pontas deste CHECK. Kind novo aqui = kind novo nos dois, no mesmo commit —
-- e agora o invariante `vocabulario-banco-x-typescript` LÊ o arquivo de
-- verdade, então esquecer não passa mais em silêncio.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (
    kind = any (array[
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
      'other'
    ]::text[])
  );
