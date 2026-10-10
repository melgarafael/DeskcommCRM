-- 0015_conversations_rag_optin
-- EPIC-06 wave 7 (S-06.07): conversations opt-in flag for RAG ingestion + manual-review tri-state
-- LGPD-critical (L-08): only flagged + reviewed conversations participate in RAG.

alter table public.conversations
  add column if not exists usable_for_rag boolean not null default false,
  add column if not exists usable_for_rag_marked_at timestamptz,
  add column if not exists usable_for_rag_marked_by uuid references auth.users(id),
  add column if not exists rag_review_status text;

alter table public.conversations
  drop constraint if exists conversations_rag_review_status_check;
alter table public.conversations
  add constraint conversations_rag_review_status_check
  check (rag_review_status is null or rag_review_status in ('pending_review','ingested','skipped'));

create index if not exists conversations_usable_rag_idx
  on public.conversations(organization_id, usable_for_rag, usable_for_rag_marked_at)
  where usable_for_rag = true;
