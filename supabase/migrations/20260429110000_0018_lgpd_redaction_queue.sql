-- 0018_lgpd_redaction_queue
-- EPIC-08 wave 5 (S-08.05): async storage media deletion queue for LGPD redact cascade.
-- Producer: fn_lgpd_cascade_redact_contact (migration 0019).
-- Consumer: storage-cleanup-worker (drained via cron route).

create table if not exists public.storage_redaction_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  request_id uuid references public.lgpd_requests(id) on delete set null,
  bucket text not null,
  object_path text not null,
  status text not null default 'pending' check (status in ('pending','deleted','failed','skipped')),
  attempts int not null default 0,
  error_message text,
  enqueued_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (bucket, object_path)
);

create index if not exists storage_redaction_queue_status_idx
  on public.storage_redaction_queue(status, enqueued_at)
  where status = 'pending';

create index if not exists storage_redaction_queue_org_idx
  on public.storage_redaction_queue(organization_id);

alter table public.storage_redaction_queue enable row level security;

drop policy if exists tenant_isolation_storage_redaction_queue_all on public.storage_redaction_queue;
create policy tenant_isolation_storage_redaction_queue_all on public.storage_redaction_queue
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

revoke all on public.storage_redaction_queue from anon;
