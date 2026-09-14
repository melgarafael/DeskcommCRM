-- 0239 — atribuição de documento recebido no WhatsApp à Pessoa no Advomax.
create table if not exists public.crm_document_intake (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete restrict,
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  contact_id uuid references public.contacts(id) on delete set null,
  pessoa_codigo bigint,
  filename text not null,
  mime_type text not null default 'application/octet-stream',
  media_storage_path text not null,
  descricao text,
  status text not null default 'pending' check (status in ('pending','uploaded','failed','ignored')),
  advomax_file_id bigint,
  requested_by uuid references auth.users(id) on delete set null,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, message_id)
);
create index if not exists idx_crm_document_intake_org_status
  on public.crm_document_intake (organization_id, status, created_at desc);
alter table public.crm_document_intake enable row level security;
drop policy if exists crm_document_intake_select on public.crm_document_intake;
create policy crm_document_intake_select on public.crm_document_intake
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists crm_document_intake_insert on public.crm_document_intake;
create policy crm_document_intake_insert on public.crm_document_intake
  for insert with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );
drop policy if exists crm_document_intake_update on public.crm_document_intake;
create policy crm_document_intake_update on public.crm_document_intake
  for update using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );
revoke all on public.crm_document_intake from anon;
drop trigger if exists trg_crm_document_intake_updated_at on public.crm_document_intake;
create trigger trg_crm_document_intake_updated_at
  before update on public.crm_document_intake
  for each row execute function public.fn_set_updated_at();
