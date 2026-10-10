-- ============================================================================
-- 0139 — DEVOLVE OS TRÊS `kind` QUE A 0129 APAGOU.
--
-- A 0129 reconstruiu `agent_inbox_items_kind_check` com a lista de 15 valores
-- que ela conhecia, enquanto o vocabulário vigente já tinha 18. Sumiram:
--
--   * `contact_proposal_expired` — criado pela 0124, a migration IMEDIATAMENTE
--     anterior. Emitido por `lib/contacts/proposta-de-dado.ts` quando um dado
--     que o cliente disse vence sem ninguém conferir.
--   * `promise_unfulfilled`      — emitido por
--     `lib/agent-engine/agent/operator-turn.ts` quando o agente promete e não
--     cumpre.
--   * `other`                    — o escape do vocabulário.
--
-- O efeito não é cosmético: num banco onde a 0129 foi aplicada por cima (quem
-- usa `supabase db push`, isto é, a cadeia de migrations), os dois INSERTs
-- acima passam a violar a constraint e o operador NUNCA VÊ o aviso. É o mesmo
-- desfecho que a 0129 existe para evitar — o problema acontece e ninguém fica
-- sabendo —, só que numa outra porta.
--
-- Quem instala/atualiza pelo kit (`install.sh` / `update.sh`) NÃO foi afetado:
-- o kit aplica só o `baseline.sql`, cujo bloco único sempre teve os 18. Por
-- isso esta migration não tem apêndice novo no baseline — o baseline já está
-- correto, e acrescentar um segundo bloco reconstruindo a mesma constraint
-- seria justamente o defeito da issue #159 que o gate
-- `tests/unit/baseline-constraint-reconstruida.test.ts` proíbe.
--
-- A lista abaixo é a do baseline, verbatim. Quem acrescentar um `kind` novo
-- daqui em diante mexe nos DOIS lugares: o bloco único do baseline e a última
-- migration que reconstrói a constraint — e é o gate
-- `tests/unit/kind-check-migration-x-baseline.test.ts` que reprova quando as
-- duas listas divergem.
-- ============================================================================

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired',
    'capabilities_missing', 'message_send_stuck', 'midia_nao_lida',
    'promise_unfulfilled', 'contact_proposal_expired', 'other'
  ));
