-- Durable, explicitly requested calls. Browser clients cannot enqueue directly.
create table if not exists public.voice_missions (
 id uuid primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 created_by uuid not null references auth.users(id),
 objective text not null default '' check (length(objective)<=3000),
 agent_id uuid references public.ai_agents(id) on delete set null,
 channel_id uuid references public.channel_sessions(id) on delete set null,
 test_contact_id uuid references public.contacts(id) on delete set null,
 test boolean not null default true,
 status text not null default 'draft' check(status in ('draft','queued','preparing','dialing','ringing','connected','finishing','completed','unanswered','cancelled','failed','uncertain')),
 cancel_requested boolean not null default false,
 call_id text,
 provider_conversation_id text,
 redacted boolean not null default false,
 context_snapshot text,
 usage_evidence jsonb,
 result jsonb,
 error text,
 heartbeat_at timestamptz,
 started_at timestamptz,
 ended_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists voice_missions_conversation on public.voice_missions(organization_id,conversation_id,created_at desc);
create unique index if not exists voice_missions_one_active on public.voice_missions(organization_id) where status in ('queued','preparing','dialing','ringing','connected','finishing');
alter table public.voice_missions enable row level security;
revoke all on public.voice_missions from public,anon,authenticated;
grant select on public.voice_missions to authenticated;
drop policy if exists voice_missions_read on public.voice_missions;
create policy voice_missions_read on public.voice_missions for select to authenticated using(organization_id in(select public.fn_user_org_ids()) and public.fn_user_role_in_org(organization_id) in ('agent','manager','admin'));
-- Voice context is personal data and follows contact anonymization.
create or replace function public.fn_redact_voice_missions() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.is_anonymized and not coalesce(old.is_anonymized,false) then
  update public.voice_missions m set objective='',context_snapshot=null,result=null,usage_evidence=null,redacted=true,cancel_requested=true,error='Contato anonimizado.'
  where m.organization_id=new.organization_id and (m.test_contact_id=new.id or m.conversation_id in(select id from public.conversations where organization_id=new.organization_id and contact_id=new.id));
 end if;
 return new;
end $$;
revoke execute on function public.fn_redact_voice_missions() from public,anon,authenticated;
drop trigger if exists redact_voice_missions on public.contacts;
create trigger redact_voice_missions after update of is_anonymized on public.contacts for each row execute function public.fn_redact_voice_missions();
alter table public.voice_missions add column if not exists transport_status text;
alter table public.voice_missions add column if not exists transport_ended boolean not null default false;
alter table public.voice_missions add column if not exists session_id text;
alter table public.voice_missions add column if not exists reservation_id uuid;
alter table public.voice_missions add column if not exists usage_evidence jsonb;
alter table public.voice_missions add column if not exists redacted boolean not null default false;
-- Internal liveness gate; no tenant data or browser access.
create table if not exists public.voice_mission_runtime(id integer primary key check(id=1),heartbeat_at timestamptz not null);
alter table public.voice_mission_runtime enable row level security;
revoke all on public.voice_mission_runtime from public,anon,authenticated;

grant all on public.voice_missions,public.voice_mission_runtime to service_role;
