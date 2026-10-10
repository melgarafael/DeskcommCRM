-- 0080 — o acervo de negócios já frios ganha UM item de caixa, com ação nomeada
--
-- POR QUE ISTO EXISTE: quando o estado de risco (0078) começa a ser gravado, os
-- negócios que JÁ estavam frios entram todos de uma vez. Medido no banco de
-- desenvolvimento: 48 críticos e 2 em risco, de 66 abertos.
--
-- Eles NÃO podem emitir atividade de timeline ("esfriou agora" seria falso: eles
-- esfriaram há dias) e não podem entrar em silêncio, porque aí ficariam
-- absolvidos por decreto de migração — cinquenta demandas abertas que ninguém
-- decidiu abandonar e ninguém vai revisar. O `event_log` sozinho não resolve:
-- é rastro de máquina, e não coloca ninguém para agir.
--
-- Daí UM item agregado (não cinquenta) com dono e AÇÃO NOMEADA. Item de caixa
-- sem ação nomeada é o ruído que a própria doutrina proíbe: "revise os 48 e
-- decida quais encerrar" é trabalho; "48 negócios em risco" é um número.
--
-- ⚠️ O `InboxKind` em `lib/agent-engine/db/repository.ts` é a outra ponta deste
-- CHECK e JÁ FICOU TRÊS VALORES ATRÁS DO BANCO sem nada falhar. Kind novo aqui
-- = kind novo lá, na mesma mudança. Está sendo feito neste commit.

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
      'other'
    ]::text[])
  );
