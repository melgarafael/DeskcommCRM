-- Links nomeados compartilham os refs existentes; o clique continua sendo consumido uma vez.
create table if not exists public.ad_tracking_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  whatsapp_e164 text not null check (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  message_template text not null check (char_length(message_template) between 1 and 1000),
  use_case text not null check (use_case in ('site','anuncio','organico')),
  utm jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
alter table public.ad_tracking_links enable row level security;
revoke all on public.ad_tracking_links from public, anon, authenticated;
grant select, insert, update, delete on public.ad_tracking_links to service_role;
drop trigger if exists trg_ad_tracking_links_updated_at on public.ad_tracking_links;
create trigger trg_ad_tracking_links_updated_at before update on public.ad_tracking_links
  for each row execute function public.fn_set_updated_at();
alter table public.google_ads_click_refs add column if not exists tracking_link_id uuid;
alter table public.meta_ads_click_refs add column if not exists tracking_link_id uuid;
alter table public.google_ads_click_refs drop constraint if exists google_click_tracking_link_org_fk;
alter table public.google_ads_click_refs add constraint google_click_tracking_link_org_fk
  foreign key (organization_id, tracking_link_id) references public.ad_tracking_links(organization_id, id);
alter table public.meta_ads_click_refs drop constraint if exists meta_click_tracking_link_org_fk;
alter table public.meta_ads_click_refs add constraint meta_click_tracking_link_org_fk
  foreign key (organization_id, tracking_link_id) references public.ad_tracking_links(organization_id, id);
create index if not exists google_click_tracking_link_idx on public.google_ads_click_refs(organization_id, tracking_link_id, created_at);
create index if not exists meta_click_tracking_link_idx on public.meta_ads_click_refs(organization_id, tracking_link_id, created_at);

-- Apenas service_role. O p_org é resolvido da sessão no servidor, nunca do browser.
create or replace function public.fn_metricas_links_rastreaveis(p_org uuid)
returns table(link_id uuid, clicks bigint, contacts bigint, leads bigint)
language sql stable security definer set search_path = public as $$
  with clicks as (
    select tracking_link_id, contact_id from public.google_ads_click_refs
      where organization_id = p_org and tracking_link_id is not null
    union all
    select tracking_link_id, contact_id from public.meta_ads_click_refs
      where organization_id = p_org and tracking_link_id is not null
  ), counts as (
    select tracking_link_id, count(*) as n, count(distinct contact_id) as c
      from clicks group by tracking_link_id
  ), lead_counts as (
    select c.tracking_link_id, count(distinct l.id) as n from clicks c
      join public.crm_leads l on l.contact_id = c.contact_id and l.organization_id = p_org
      group by c.tracking_link_id
  )
  select c.tracking_link_id, c.n, c.c, coalesce(l.n,0)
    from counts c left join lead_counts l using(tracking_link_id);
$$;
revoke all on function public.fn_metricas_links_rastreaveis(uuid) from public, anon, authenticated;
grant execute on function public.fn_metricas_links_rastreaveis(uuid) to service_role;
