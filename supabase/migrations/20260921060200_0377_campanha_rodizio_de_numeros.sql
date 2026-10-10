-- 0377 — RODÍZIO DE NÚMEROS NA CAMPANHA
--
-- A campanha falava por UM número (`campaigns.channel_session_id`, not null).
-- Passa a poder falar por VÁRIOS, escolhidos explicitamente.
--
-- ═══ Por que uma tabela de vínculo, e não um array de uuid ═══
--
-- O vínculo é tenant-aware e aponta para `channel_sessions`: com array, nenhuma
-- FK protege contra o número de OUTRA organização entrar na lista, e a checagem
-- viraria código que alguém esquece. Com linha, a FK composta
-- `(organization_id, channel_session_id)` recusa no banco — o mesmo padrão da
-- 0260, 0262 e 0375.
--
-- ═══ O que NÃO muda ═══
--
-- `campaigns.channel_session_id` CONTINUA obrigatório e é o número principal:
-- toda campanha que já existe segue funcionando sem uma linha sequer nesta
-- tabela, e quem não quiser rodízio nunca abre essa parte da tela. O pool
-- efetivo é "o principal mais os vinculados".
--
-- ═══ Por que o destinatário guarda o número ═══
--
-- A escolha é feita no ENVIO (quem tem mais folga naquele instante), então só
-- depois de enviar se sabe por onde foi. Sem gravar, a tela precisaria buscar a
-- mensagem para responder "quem falou com esta pessoa?", e o relatório por
-- número viraria um join a mais em cada linha.
--
-- ⚠️ A coluna é NULLABLE e assim fica: destinatário excluído na preparação
-- nunca recebe número, e um default aqui inventaria um envio que não houve.

create table if not exists public.campaign_channel_sessions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  channel_session_id uuid not null,
  created_at timestamptz not null default now(),
  -- O mesmo número duas vezes na mesma campanha dobraria o peso dele no
  -- rodízio sem ninguém pedir.
  constraint campaign_channel_sessions_unico unique (campaign_id, channel_session_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaign_channel_sessions_org_fk'
  ) then
    alter table public.campaign_channel_sessions
      add constraint campaign_channel_sessions_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete cascade;
  end if;
end $$;

comment on table public.campaign_channel_sessions is
  'Os números que UMA campanha pode usar, além do principal em campaigns.channel_session_id. Rodízio: a cada envio o worker escolhe entre eles o que tem mais folga, preferindo aquele em que o contato já conversa.';

create index if not exists idx_campaign_channel_sessions_campanha
  on public.campaign_channel_sessions (campaign_id);

alter table public.campaign_recipients
  add column if not exists channel_session_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaign_recipients_channel_org_fk'
  ) then
    alter table public.campaign_recipients
      add constraint campaign_recipients_channel_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete set null;
  end if;
end $$;

comment on column public.campaign_recipients.channel_session_id is
  'Por qual número esta pessoa foi falada. Preenchido no ENVIO, porque é lá que o rodízio decide. NULL = ainda não saiu, ou foi excluída na preparação.';

-- A pergunta do relatório por número: quantas saíram por cada um, nesta campanha.
create index if not exists idx_campaign_recipients_por_numero
  on public.campaign_recipients (campaign_id, channel_session_id)
  where channel_session_id is not null;

-- ═══ RLS — o padrão da 0375/0376 ═══
alter table public.campaign_channel_sessions enable row level security;

drop policy if exists campaign_channel_sessions_select on public.campaign_channel_sessions;
create policy campaign_channel_sessions_select on public.campaign_channel_sessions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_channel_sessions_write on public.campaign_channel_sessions;
create policy campaign_channel_sessions_write on public.campaign_channel_sessions
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_channel_sessions from anon, authenticated;
grant select on public.campaign_channel_sessions to authenticated;
grant all on public.campaign_channel_sessions to service_role;
