-- 0124 — a Central avisa quando um dado ouvido venceu sem alguém conferir
--
-- A 0123 criou a fila de confirmação com `expires_at` obrigatório. Prazo que
-- ninguém cobre é pior que nenhum: promete um limite que não existe, e a
-- pendência fica na ficha para sempre — um badge permanente que SIMULA atenção
-- e adia a decisão em vez de cobrá-la.
--
-- Vencer é uma decisão: a do relógio, na ausência da humana. Mas uma decisão que
-- só acontece no banco é invisível — por isso ela precisa aparecer onde o dono
-- do negócio olha (invariante 3 do sistema vivo: log universal E visível).
--
-- ⚠️ ENTRA NA LISTA EXISTENTE, no bloco ÚNICO que reconstrói esta constraint.
-- O #159 do @jmpo mostrou que reconstruir a mesma constraint em N blocos quebra
-- o `update.sh` de todo clone que já tenha uma linha de vocabulário posterior:
-- os blocos antigos rodam antes e falham em cadeia. Um bloco por constraint,
-- vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
--
-- Idempotente: a lista só cresce, nenhuma linha existente viola a constraint
-- nova.

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
    'promise_unfulfilled',
    -- (migration 0124, spec 17 §4b) Dado que o assistente ouviu na conversa e
    -- ninguém confirmou até o prazo. Severidade `info`, não `warn`: nada
    -- quebrou — uma informação simplesmente não foi aproveitada, e tratar isso
    -- como falha ensinaria a ignorar os avisos que são falha de verdade.
    'contact_proposal_expired',
    'other'
  ));

notify pgrst, 'reload schema';
