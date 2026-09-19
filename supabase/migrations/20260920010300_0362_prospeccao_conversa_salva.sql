-- The administrator's unfinished setup belongs to the campaign, not to Inbox.
-- Existing rows keep the empty default. Server-only RLS/grants remain unchanged.
alter table public.prospecting_campaigns
  add column if not exists agent_setup jsonb not null default '{}'::jsonb,
  add column if not exists agent_setup_revision bigint not null default 0;
notify pgrst, 'reload schema';
