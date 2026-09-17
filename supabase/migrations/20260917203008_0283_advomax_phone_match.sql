-- Estado durável da identificação automática Contato CRM ↔ Pessoa Advomax.
alter table public.contacts
  add column if not exists advomax_match_status text,
  add column if not exists advomax_match_count integer not null default 0,
  add column if not exists advomax_match_checked_at timestamptz;

do $$ begin
  alter table public.contacts add constraint contacts_advomax_match_status_check
    check (advomax_match_status is null or advomax_match_status in ('client','person','ambiguous','not_found'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.contacts add constraint contacts_advomax_match_count_check
    check (advomax_match_count >= 0);
exception when duplicate_object then null; end $$;
