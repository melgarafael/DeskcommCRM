-- manifest: Entrega humana opcional por organização, episódio e recibos duráveis para atribuição consistente e avisos sem replay cego
alter table public.contacts add column if not exists handoff_delivery_revision bigint not null default 0;
create table if not exists public.handoff_delivery_episodes (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 passage_id uuid not null references public.passagens_de_atendimento(id) on delete cascade,
 service_revision bigint not null, handoff_revision bigint not null, config_hash text not null, attempts integer not null default 0,
 lead_id uuid references public.crm_leads(id) on delete set null, owner_user_id uuid references auth.users(id) on delete set null,
 status text not null default 'pending' check(status in ('pending','delivered','blocked','ambiguous','cancelled')),
 reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(organization_id,id), unique(organization_id,conversation_id,service_revision,handoff_revision)
);
create table if not exists public.handoff_delivery_receipts (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null,
 episode_id uuid not null, destination_hash text not null check(destination_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'planned' check(status in ('planned','requested','delivered','ambiguous','cancelled')),
 claim_token uuid, claimed_at timestamptz, external_id text, updated_at timestamptz not null default now(),
 foreign key(organization_id,episode_id) references public.handoff_delivery_episodes(organization_id,id) on delete cascade,
 unique(organization_id,episode_id,destination_hash)
);
create index if not exists idx_handoff_delivery_contact on public.handoff_delivery_episodes(organization_id,contact_id);
create index if not exists idx_handoff_delivery_pending on public.handoff_delivery_episodes(organization_id,status) where status in('pending','blocked','ambiguous');
alter table public.handoff_delivery_episodes enable row level security;
alter table public.handoff_delivery_receipts enable row level security;
revoke all on public.handoff_delivery_episodes,public.handoff_delivery_receipts from public,anon,authenticated;
grant all on public.handoff_delivery_episodes,public.handoff_delivery_receipts to service_role;
grant select on public.handoff_delivery_episodes to authenticated;
drop policy if exists handoff_episode_visibility on public.handoff_delivery_episodes;
create policy handoff_episode_visibility on public.handoff_delivery_episodes for select to authenticated using(exists(select 1 from public.conversations c where c.organization_id=handoff_delivery_episodes.organization_id and c.id=conversation_id and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)));
create or replace function public.fn_handoff_delivery_generation() returns trigger language plpgsql set search_path=public as $$
begin
 if new.force_human and not coalesce(old.force_human,false) and exists(select 1 from public.organizations where id=new.organization_id and settings->'handoff_delivery'->>'enabled'='true') then new.handoff_delivery_revision:=old.handoff_delivery_revision+1;end if;
 return new;
end;$$;
revoke execute on function public.fn_handoff_delivery_generation() from public,anon,authenticated;
drop trigger if exists trg_handoff_delivery_generation on public.contacts;
create trigger trg_handoff_delivery_generation before update of force_human on public.contacts for each row execute function public.fn_handoff_delivery_generation();
create or replace function public.fn_handoff_delivery_enqueue() returns trigger language plpgsql security definer set search_path=public as $$
declare c public.conversations; v_generation bigint; v_id uuid;
begin
 if not exists(select 1 from public.organizations where id=new.organization_id and settings->'handoff_delivery'->>'enabled'='true') then return new;end if;
 -- Não qualificar opt-out, jurídico ou teto como oportunidade comercial.
 if new.motivo_codigo not in('requested_human','critical_stage') then return new;end if;
 select * into c from public.conversations where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
 if not found or c.status not in('open','pending','claimed','ai_handling') or c.bot_silenced_until is distinct from 'infinity'::timestamptz then return new;end if;
 select handoff_delivery_revision into v_generation from public.contacts where organization_id=new.organization_id and id=new.contact_id and force_human and anonymized_at is null;
 if not found then return new;end if;
 insert into public.handoff_delivery_episodes(organization_id,contact_id,conversation_id,passage_id,service_revision,handoff_revision,config_hash)
 values(new.organization_id,new.contact_id,new.conversation_id,new.id,c.service_revision,v_generation,(select md5((settings->'handoff_delivery')::text) from public.organizations where id=new.organization_id))
 on conflict(organization_id,conversation_id,service_revision,handoff_revision) do nothing returning id into v_id;
 if v_id is not null then
 insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
 values(new.organization_id,'ai.handoff_delivery','handoff_delivery',v_id,jsonb_build_object('episode_id',v_id));
 end if;
 return new;
end;$$;
revoke execute on function public.fn_handoff_delivery_enqueue() from public,anon,authenticated;
drop trigger if exists trg_handoff_delivery_enqueue on public.passagens_de_atendimento;
create trigger trg_handoff_delivery_enqueue after insert on public.passagens_de_atendimento for each row execute function public.fn_handoff_delivery_enqueue();
-- manifest: Permite atribuição pós-IA sem aviso externo, opt-in e sem mudar configurações existentes.
-- fn_set_handoff_delivery mantém RBAC, MFA, organização e validação dos vendedores.
create or replace function public.fn_set_handoff_delivery(p_org uuid,p_config jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare seller uuid; item text;
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'manager') or not public.fn_support_write_allowed(p_org) then raise exception 'handoff_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'handoff_mfa_required' using errcode='42501';end if;
 if jsonb_typeof(p_config) is distinct from 'object' or jsonb_typeof(p_config->'enabled') is distinct from 'boolean' or jsonb_typeof(p_config->'seller_user_ids') is distinct from 'array' or jsonb_typeof(p_config->'seller_destinations') is distinct from 'object' or jsonb_typeof(p_config->'supervisor_destinations') is distinct from 'array' then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if p_config ? 'notifications_enabled' and jsonb_typeof(p_config->'notifications_enabled') is distinct from 'boolean' then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if jsonb_array_length(p_config->'seller_user_ids')>50 or jsonb_array_length(p_config->'supervisor_destinations')>10 then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if p_config ? 'retry_seconds' and ((p_config->>'retry_seconds')::integer not between 10 and 3600) then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if p_config ? 'max_attempts' and ((p_config->>'max_attempts')::integer not between 1 and 100) then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if (select count(*)<>count(distinct value) from jsonb_array_elements_text(p_config->'seller_user_ids')) then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if exists(select 1 from jsonb_object_keys(p_config->'seller_destinations') k where not (p_config->'seller_user_ids' ? k)) then raise exception 'handoff_config_invalid' using errcode='22023';end if;
 if (p_config->>'enabled')::boolean then
 if jsonb_array_length(p_config->'seller_user_ids')=0 then raise exception 'handoff_sellers_missing' using errcode='22023';end if;
 for item in select jsonb_array_elements_text(p_config->'seller_user_ids') loop
 seller:=item::uuid;
 if not exists(select 1 from user_organizations where organization_id=p_org and user_id=seller and revoked_at is null and role in('agent','manager','admin')) then raise exception 'handoff_invalid_member' using errcode='22023';end if;
 if coalesce((p_config->>'notifications_enabled')::boolean,true) and coalesce(p_config->'seller_destinations'->>item,'') !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'handoff_destination_missing' using errcode='22023';end if;
 end loop;
 end if;
 for item in select value from jsonb_each_text(p_config->'seller_destinations') union all select jsonb_array_elements_text(p_config->'supervisor_destinations') loop
 if item !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'handoff_destination_invalid' using errcode='22023';end if;
 end loop;
 update organizations set settings=jsonb_set(coalesce(settings,'{}'),'{handoff_delivery}',p_config),updated_at=now() where id=p_org;
 if not found then raise exception 'handoff_org_missing' using errcode='22023';end if;
 return p_config;
end;$$;
revoke execute on function public.fn_set_handoff_delivery(uuid,jsonb) from public,anon;
grant execute on function public.fn_set_handoff_delivery(uuid,jsonb) to authenticated;

create or replace function public.fn_handoff_delivery_anonymize() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.is_anonymized and not old.is_anonymized then delete from handoff_delivery_episodes where organization_id=new.organization_id and contact_id=new.id;end if;
 return new;
end;$$;
revoke execute on function public.fn_handoff_delivery_anonymize() from public,anon,authenticated;
drop trigger if exists trg_handoff_delivery_anonymize on public.contacts;
create trigger trg_handoff_delivery_anonymize after update of is_anonymized on public.contacts for each row execute function public.fn_handoff_delivery_anonymize();

drop policy if exists tenant_isolation_handoff_delivery_episodes_all on public.handoff_delivery_episodes;
create policy tenant_isolation_handoff_delivery_episodes_all on public.handoff_delivery_episodes as restrictive for all to authenticated
using (organization_id in (select public.fn_user_org_ids()))
with check (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_handoff_delivery_receipts_all on public.handoff_delivery_receipts;
create policy tenant_isolation_handoff_delivery_receipts_all on public.handoff_delivery_receipts as restrictive for all to authenticated
using (organization_id in (select public.fn_user_org_ids()))
with check (organization_id in (select public.fn_user_org_ids()));
