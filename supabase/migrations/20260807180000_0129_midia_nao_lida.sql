-- ============================================================================
-- 0129 — A MÍDIA QUE O AGENTE NÃO CONSEGUE LER PASSA A APARECER.
--
-- O cliente manda uma foto do produto ou um comprovante, e o agente responde
-- como se nada tivesse chegado. Acontece em dois casos reais:
--
--   1. o modelo configurado para a organização não enxerga imagem
--      (`workers/media-derive-worker.ts` checava `modelCapabilities().image` e,
--      quando falso, devolvia string vazia);
--   2. falta a chave da OpenAI para transcrever áudio (o Whisper é da OpenAI
--      mesmo quando o resto da organização está em outro provedor).
--
-- Nos dois, a derivação devolvia `""` EM SILÊNCIO. Sem erro, sem log, sem aviso.
-- Para quem instalou, o produto parecia estar ignorando o cliente de propósito
-- — e o caminho de diagnóstico não existia, porque nada tinha acontecido do
-- ponto de vista do sistema.
--
-- Esta migration só acrescenta o `kind` do aviso; o comportamento novo (marcador
-- no texto derivado + item na Central) é código. O par existe porque um sem o
-- outro não resolve: o marcador sozinho conta ao AGENTE, o aviso sozinho conta
-- ao OPERADOR, e o problema precisa dos dois.
--
-- O kind entra na MESMA constraint, não num bloco novo: reconstruir a mesma
-- constraint em N blocos foi o defeito da issue #159 — o último bloco vence e os
-- valores dos anteriores somem sem ninguém perceber.
-- ============================================================================

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired',
    'capabilities_missing', 'message_send_stuck',
    'midia_nao_lida'
  ));
