-- 0241 — fila recuperável para arquivamento de documentos no Advomax.
alter table public.crm_document_intake
  drop constraint if exists crm_document_intake_status_check;
alter table public.crm_document_intake
  add constraint crm_document_intake_status_check
  check (status in ('pending','processing','uploaded','failed','ignored'));
alter table public.crm_document_intake
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by text;
create index if not exists idx_crm_document_intake_retry
  on public.crm_document_intake (status, next_attempt_at)
  where status in ('pending','processing');
