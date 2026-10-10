-- 0062: snooze por conversa (Onda 5.3). Vendedor pede "me avise se o lead não
-- responder em X h"; cron reabre a conversa + cria aviso interno. Nada ao cliente.
alter table conversations
  add column if not exists snooze_until timestamptz,
  add column if not exists snoozed_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists snoozed_at timestamptz;

-- índice parcial p/ o cron varrer só o que tem snooze ativo
create index if not exists idx_conversations_snooze_until
  on conversations (snooze_until) where snooze_until is not null;

-- agent_inbox_items.kind += 'snooze_expired' (recria o CHECK de forma auto-curativa)
alter table agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
alter table agent_inbox_items add constraint agent_inbox_items_kind_check
  check (kind in ('qr_rescan','job_dead','event_dead','budget_exceeded','handoff',
                  'promotion_review','judge_unaligned','snooze_expired','other'));
