-- 0436 — Conversão do Google Ads por ETAPA do funil, e a venda que não tem valor.
--
-- Até aqui a organização reportava ao Google dois eventos fixos: a compra (ao
-- ganhar o negócio, e só com valor) e UMA etapa de qualificação. Quem opera
-- tráfego quer avisar o Google em mais de um momento do funil — o lead que
-- chegou, o que qualificou, o que recebeu orçamento — cada um numa ação de
-- conversão própria, porque é com eles que a campanha aprende antes da venda.
--
-- ── Uma linha por etapa ─────────────────────────────────────────────────────
--
-- `google_ads_conversion_rules` diz: "quando um negócio ENTRAR nesta etapa,
-- mande esta ação de conversão". O `event_name` é a chave do livro-razão
-- (`ad_conversion_dispatches`, único por lead + evento): `Etapa:<uuid da etapa>`
-- para as regras novas, e `QualifiedLead` para a qualificação que já existia —
-- migrada abaixo com o MESMO nome, para que um negócio já qualificado e enviado
-- não seja mandado de novo com outro nome.
--
-- `configured_at` é a trava de retroatividade, a mesma da 0402: só movimentos
-- DEPOIS de a regra existir (ou de mudar de etapa/ação) enviam. Configurar uma
-- regra não despeja o histórico do funil no Google.
--
-- ── A venda sem valor ───────────────────────────────────────────────────────
--
-- `google_purchase_value_mode` decide o que acontece com o negócio ganho sem
-- valor preenchido: `obrigatorio` (o comportamento de sempre, e o padrão — nada
-- muda para quem não mexer), `quando_houver` (envia a compra; o valor vai só se
-- existir) e `nunca` (envia sem valor mesmo que exista).
--
-- ── Telefone criptografado ──────────────────────────────────────────────────
--
-- `google_send_hashed_phone` liga o envio do telefone do contato em SHA-256
-- (E.164) junto da conversão, o que o Google usa para casar a conversão com a
-- conta de quem clicou. Desligado por padrão: é dado pessoal, e quem liga
-- declara que tem base legal para isso.
--
-- Server-side only, como as demais tabelas de conversão (0213): RLS ligada sem
-- policy e grants revogados de anon/authenticated.

create table if not exists public.google_ads_conversion_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stage_id uuid not null,
  event_name text not null,
  label text not null,
  google_action_id text not null,
  category text not null default 'DEFAULT',
  included_in_conversions boolean not null default true,
  channel text not null default 'todos',
  enabled boolean not null default true,
  configured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint google_ads_conversion_rules_action_numerica
    check (google_action_id ~ '^[0-9]{1,32}$'),
  constraint google_ads_conversion_rules_evento_conhecido
    check (event_name = 'QualifiedLead' or event_name ~ '^Etapa:[0-9a-f-]{36}$'),
  constraint google_ads_conversion_rules_canal_conhecido
    check (channel in ('todos', 'whatsapp', 'outros')),
  constraint google_ads_conversion_rules_categoria_conhecida
    check (category in (
      'DEFAULT', 'PAGE_VIEW', 'PURCHASE', 'SIGNUP', 'DOWNLOAD', 'ADD_TO_CART',
      'BEGIN_CHECKOUT', 'SUBSCRIBE_PAID', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD',
      'SUBMIT_LEAD_FORM', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE', 'GET_DIRECTIONS',
      'OUTBOUND_CLICK', 'CONTACT', 'ENGAGEMENT', 'STORE_VISIT', 'STORE_SALE',
      'QUALIFIED_LEAD', 'CONVERTED_LEAD'
    )),
  constraint google_ads_conversion_rules_label_curto
    check (char_length(btrim(label)) between 1 and 100)
);

alter table public.google_ads_conversion_rules
  drop constraint if exists google_ads_conversion_rules_stage_org_fk;
alter table public.google_ads_conversion_rules
  add constraint google_ads_conversion_rules_stage_org_fk
  foreign key (organization_id, stage_id)
  references public.crm_stages (organization_id, id)
  on delete cascade;

create unique index if not exists google_ads_conversion_rules_org_stage_uk
  on public.google_ads_conversion_rules (organization_id, stage_id);
create unique index if not exists google_ads_conversion_rules_org_event_uk
  on public.google_ads_conversion_rules (organization_id, event_name);

comment on table public.google_ads_conversion_rules is
  'Qual ação de conversão do Google Ads cada etapa do funil envia quando um negócio entra nela. event_name é a chave do livro-razão ad_conversion_dispatches. Server-side only: RLS sem policy e grants revogados de anon/authenticated.';
comment on column public.google_ads_conversion_rules.configured_at is
  'Trava de retroatividade: só movimentos de etapa posteriores enviam. Regravada pelo gatilho quando a etapa ou a ação mudam.';
comment on column public.google_ads_conversion_rules.channel is
  'Por onde o negócio precisa ter entrado para enviar: todos, whatsapp (tem conversa vinculada) ou outros (sem conversa).';

alter table public.google_ads_conversion_rules enable row level security;
revoke all on public.google_ads_conversion_rules from anon, authenticated;
grant select, insert, update, delete on public.google_ads_conversion_rules to service_role;

drop trigger if exists trg_google_ads_conversion_rules_updated_at on public.google_ads_conversion_rules;
create trigger trg_google_ads_conversion_rules_updated_at
  before update on public.google_ads_conversion_rules
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_marcar_configuracao_regra_google()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- A migração importa o carimbo legado; inserções normais usam DEFAULT now().
    new.configured_at := coalesce(new.configured_at, now());
  elsif new.stage_id is distinct from old.stage_id
     or new.google_action_id is distinct from old.google_action_id
     or (new.enabled and not old.enabled) then
    new.configured_at := now();
  else
    new.configured_at := old.configured_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_marcar_configuracao_regra_google() from public, anon, authenticated;
grant execute on function public.fn_marcar_configuracao_regra_google() to service_role;

drop trigger if exists trg_marcar_configuracao_regra_google on public.google_ads_conversion_rules;
create trigger trg_marcar_configuracao_regra_google
  before insert or update on public.google_ads_conversion_rules
  for each row execute function public.fn_marcar_configuracao_regra_google();

-- A qualificação que já existia vira a primeira regra, com o nome de evento de
-- sempre. `on conflict do nothing`: reaplicar não duplica nem sobrescreve a
-- regra que o admin já editou. O `configured_at` herdado preserva a trava.
insert into public.google_ads_conversion_rules
  (organization_id, stage_id, event_name, label, google_action_id, category, configured_at)
select c.organization_id, c.google_qualification_stage_id, 'QualifiedLead',
       'Lead qualificado', c.google_qualification_action_id, 'QUALIFIED_LEAD',
       coalesce(c.google_qualification_configured_at, now())
  from public.ad_platform_connections c
  join public.crm_stages s
    on s.organization_id = c.organization_id and s.id = c.google_qualification_stage_id
 where c.platform = 'google_ads'
   and c.google_qualification_stage_id is not null
   and c.google_qualification_action_id ~ '^[0-9]{1,32}$'
on conflict do nothing;

alter table public.ad_platform_connections
  add column if not exists google_purchase_value_mode text not null default 'obrigatorio',
  add column if not exists google_purchase_category text not null default 'PURCHASE',
  add column if not exists google_send_hashed_phone boolean not null default false;

alter table public.ad_platform_connections
  drop constraint if exists ad_platform_connections_google_purchase_value_mode_check;
alter table public.ad_platform_connections
  add constraint ad_platform_connections_google_purchase_value_mode_check
  check (google_purchase_value_mode in ('obrigatorio', 'quando_houver', 'nunca'));

comment on column public.ad_platform_connections.google_purchase_value_mode is
  'Negócio ganho sem valor: obrigatorio (não envia, padrão histórico), quando_houver (envia; valor só se existir), nunca (envia sempre sem valor).';
comment on column public.ad_platform_connections.google_send_hashed_phone is
  'Envia o telefone do contato em SHA-256 (E.164) com a conversão. Desligado por padrão: dado pessoal.';

-- O reenvio passa a aceitar os eventos de etapa, com a mesma exigência da
-- qualificação: só reenvia o que tem o retrato (quando + qual ação) gravado.
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid, p_event text)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  if p_event is null or not (p_event in ('Purchase', 'QualifiedLead') or p_event ~ '^Etapa:[0-9a-f-]{36}$') then
    return false;
  end if;
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = p_event for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if p_event <> 'Purchase' and (v_linha.event_occurred_at is null or v_linha.google_action_id is null) then return false; end if;
  if p_event = 'Purchase' and v_linha.remote_request_id is null and not exists (
    select 1 from public.crm_leads where id = p_lead and organization_id = p_org and status = 'won'
  ) then return false; end if;
  if exists (select 1 from public.event_log where organization_id = p_org and entity_id = p_lead
    and event_type = 'ad_conversion.retry_requested' and status in ('pending', 'processing')
    and coalesce(payload->>'event_name', 'Purchase') = p_event) then return false; end if;
  perform public.emit_event('ad_conversion.retry_requested', 'crm_lead', p_lead,
    jsonb_build_object('event_name', p_event), '{}'::jsonb, p_org);
  update public.ad_conversion_dispatches set reason = 'reprocessamento_solicitado', attempted_at = now()
    where id = v_linha.id and organization_id = p_org;
  return true;
end;
$$;
revoke execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_solicitar_reenvio_conversao(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
