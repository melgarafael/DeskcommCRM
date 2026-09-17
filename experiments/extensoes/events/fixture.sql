-- SOMENTE BANCADA. Aplicada num schema exclusivo; não é migration do produto.
-- event_log e a semântica de registro são extraídos das fontes pelo probe.
create table subscriptions (
  id text not null, revision integer not null, organization_id uuid not null,
  event_type text not null, destination text not null, version text not null,
  primary key (id, revision)
);
create table outbox (
  event_id uuid primary key references event_log(id),
  organization_id uuid not null,
  subscriptions_revision integer not null,
  expanded boolean not null default false
);
create function capture_event() returns trigger language plpgsql as $$
begin
  if exists (select 1 from subscriptions where organization_id=new.organization_id
             and event_type=new.event_type and revision=1) then
    insert into outbox(event_id,organization_id,subscriptions_revision)
    values(new.id,new.organization_id,1);
  end if;
  return new;
end;
$$;
create trigger capture_extension_event after insert on event_log
for each row execute function capture_event();
create table receipts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references event_log(id), organization_id uuid not null,
  subscription_id text not null, subscription_revision integer not null,
  destination text not null, version text not null,
  state text not null default 'pending'
    check(state in ('pending','processing','sending','done','uncertain')),
  attempts integer not null default 0,
  lease_token uuid, lease_until timestamptz,
  unique(event_id,subscription_id,subscription_revision),
  foreign key(subscription_id,subscription_revision) references subscriptions(id,revision)
);
create table local_effects (
  receipt_id uuid primary key references receipts(id), marker text not null
);
-- O receiver escreve esta tabela por outra conexão antes de perder a resposta.
create table external_effects (
  receipt_id uuid primary key references receipts(id), requests integer not null default 1
);
