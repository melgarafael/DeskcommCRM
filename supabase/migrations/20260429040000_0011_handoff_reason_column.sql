-- EPIC-06 wave 3: handoff orchestrator support columns.
-- Adds:
--   * conversations.last_handoff_reason text — diagnostics for why a conversation
--     handed off to a human (G1 requested_human, G2 low_sentiment, G3 low_confidence,
--     G4 critical_stage / legal_mention).
--   * crm_stages.requires_human boolean — gate G4: when a lead enters a stage
--     flagged requires_human, any inbound message bypasses the bot.

alter table public.conversations
  add column if not exists last_handoff_reason text;

alter table public.crm_stages
  add column if not exists requires_human boolean not null default false;
