-- 0102 — agent_inbox_items.kind ganha 'capabilities_missing'
--
-- Por quê: quando o turno não consegue montar as capacidades configuradas na
-- tela, ele SEGUE sem elas — e isso está certo (a conversa do cliente não pode
-- morrer porque uma tool extra falhou). O errado era o que vinha depois: o
-- código dizia, em comentário, "o humano vê o log". Não vê. O log vai para o
-- stdout do worker, num contêiner de VPS que o dono do negócio nunca abre.
--
-- Resultado medido num turno real: o agente atendeu sem NENHUMA das capacidades
-- que o humano tinha ligado, e a única pista existia num log que ninguém lê.
-- É a falha-em-verde: capacidade anunciada na tela, ausente na execução, e nada
-- em lugar nenhum contando.
--
-- O kind próprio existe para o aviso ser LEGÍVEL na Central de avisos. 'other'
-- caberia no CHECK e mentiria na tela — a Central agrupa e explica por kind.
--
-- Idempotente e auto-curativo: a lista só CRESCE, nenhuma linha existente viola
-- a constraint nova, e não há dado a corrigir antes de criá-la.

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
    'other'
  ));
