-- manifest: **Conversão da Meta por etapa do funil.** Tabela nova `meta_ads_conversion_rules` (uma regra por etapa: evento padrão da Meta em lista fechada — `LeadSubmitted`, `QualifiedLead`, `InitiateCheckout`, `AddToCart`, `ViewContent` —, ligada/desligada), FK composta para `crm_stages (organization_id, id)` com `on delete cascade`, únicos por (org, etapa) e (org, `event_name`). `event_name` é a chave do livro-razão, `MetaEtapa:<uuid>` — prefixo próprio, distinto do `Etapa:` do Google da 0436, para as duas plataformas poderem ter regra na mesma etapa sem uma achar o envio da outra. `fn_marcar_configuracao_regra_meta` (gatilho, só `service_role`) regrava `configured_at` quando etapa/evento mudam ou a regra é religada — trava de retroatividade. `ad_conversion_dispatches.meta_event_name`: o retrato do evento enviado, que o reenvio usa no lugar da regra de agora. `fn_solicitar_reenvio_conversao(uuid, uuid, text)` passa a aceitar `MetaEtapa:<uuid>` exigindo o retrato (`event_occurred_at` + `meta_event_name`). RLS sem policy e grants revogados de anon/authenticated, como a 0213. Aditiva e idempotente. Gate: `tests/invariants/meta-regras-etapa-isoladas.test.ts`.
-- 0524 — Conversão da Meta por ETAPA do funil.
--
-- Até aqui a Meta recebia um evento só: a compra, quando o negócio é ganho. O
-- Google já tinha, desde a 0436, um evento por etapa ("quando o negócio ENTRAR
-- nesta etapa, mande esta conversão"). Quem anuncia na Meta quer o mesmo: o
-- orçamento enviado e a visita agendada também ensinam o pixel antes da venda.
--
-- ── Uma linha por etapa ─────────────────────────────────────────────────────
--
-- `meta_ads_conversion_rules` diz: "quando um negócio ENTRAR nesta etapa, mande
-- este evento padrão da Meta". `meta_event` é o nome que vai no fio (lista
-- fechada, os eventos que a Meta aceita também em conversa de WhatsApp). O
-- `event_name` é a chave do livro-razão (`ad_conversion_dispatches`, único por
-- lead + evento): `MetaEtapa:<uuid da etapa>`. Prefixo PRÓPRIO, e não o
-- `Etapa:` do Google: as duas regras podem existir para a mesma etapa, e com a
-- mesma chave a segunda plataforma acharia o envio da primeira e se calaria.
--
-- `configured_at` é a trava de retroatividade, a mesma da 0402/0436: só
-- movimentos DEPOIS de a regra existir (ou de mudar de etapa/evento, ou de ser
-- religada) enviam. Ligar uma regra não despeja o histórico do funil na Meta.
--
-- ── O retrato do envio ──────────────────────────────────────────────────────
--
-- `ad_conversion_dispatches.meta_event_name` guarda QUAL evento saiu (ou vai
-- sair) para aquele negócio, como o `google_action_id` faz no Google: reenviar
-- usa o retrato, nunca a regra de agora — trocar o evento da etapa depois não
-- pode rebatizar uma conversão antiga.
--
-- Server-side only, como as demais tabelas de conversão (0213): RLS ligada sem
-- policy e grants revogados de anon/authenticated.

create table if not exists public.meta_ads_conversion_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stage_id uuid not null,
  event_name text not null,
  meta_event text not null,
  enabled boolean not null default true,
  configured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint meta_ads_conversion_rules_evento_do_livro
    check (event_name ~ '^MetaEtapa:[0-9a-f-]{36}$'),
  constraint meta_ads_conversion_rules_evento_conhecido
    check (meta_event in (
      'LeadSubmitted', 'QualifiedLead', 'InitiateCheckout', 'AddToCart', 'ViewContent'
    ))
);

alter table public.meta_ads_conversion_rules
  drop constraint if exists meta_ads_conversion_rules_stage_org_fk;
alter table public.meta_ads_conversion_rules
  add constraint meta_ads_conversion_rules_stage_org_fk
  foreign key (organization_id, stage_id)
  references public.crm_stages (organization_id, id)
  on delete cascade;

create unique index if not exists meta_ads_conversion_rules_org_stage_uk
  on public.meta_ads_conversion_rules (organization_id, stage_id);
create unique index if not exists meta_ads_conversion_rules_org_event_uk
  on public.meta_ads_conversion_rules (organization_id, event_name);

comment on table public.meta_ads_conversion_rules is
  'Qual evento padrão da Meta cada etapa do funil envia quando um negócio entra nela. event_name (MetaEtapa:<uuid>) é a chave do livro-razão ad_conversion_dispatches. Server-side only: RLS sem policy e grants revogados de anon/authenticated.';
comment on column public.meta_ads_conversion_rules.configured_at is
  'Trava de retroatividade: só movimentos de etapa posteriores enviam. Regravada pelo gatilho quando a etapa ou o evento mudam, ou quando a regra é religada.';

alter table public.meta_ads_conversion_rules enable row level security;
revoke all on public.meta_ads_conversion_rules from anon, authenticated;
grant select, insert, update, delete on public.meta_ads_conversion_rules to service_role;

drop trigger if exists trg_meta_ads_conversion_rules_updated_at on public.meta_ads_conversion_rules;
create trigger trg_meta_ads_conversion_rules_updated_at
  before update on public.meta_ads_conversion_rules
  for each row execute function public.fn_set_updated_at();

create or replace function public.fn_marcar_configuracao_regra_meta()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.configured_at := coalesce(new.configured_at, now());
  elsif new.stage_id is distinct from old.stage_id
     or new.meta_event is distinct from old.meta_event
     or (new.enabled and not old.enabled) then
    new.configured_at := now();
  else
    new.configured_at := old.configured_at;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_marcar_configuracao_regra_meta() from public, anon, authenticated;
grant execute on function public.fn_marcar_configuracao_regra_meta() to service_role;

drop trigger if exists trg_marcar_configuracao_regra_meta on public.meta_ads_conversion_rules;
create trigger trg_marcar_configuracao_regra_meta
  before insert or update on public.meta_ads_conversion_rules
  for each row execute function public.fn_marcar_configuracao_regra_meta();

alter table public.ad_conversion_dispatches
  add column if not exists meta_event_name text;

comment on column public.ad_conversion_dispatches.meta_event_name is
  'Retrato do evento de etapa da Meta (0524): o nome que saiu no fio. Reenviar usa este, nunca a regra de agora.';

-- O reenvio passa a aceitar os eventos de etapa da Meta, com a mesma exigência
-- dos do Google: só reenvia o que tem o retrato (quando + qual evento) gravado.
create or replace function public.fn_solicitar_reenvio_conversao(p_org uuid, p_lead uuid, p_event text)
returns boolean language plpgsql set search_path = public as $$
declare v_linha public.ad_conversion_dispatches%rowtype;
begin
  if p_event is null or not (
    p_event in ('Purchase', 'QualifiedLead')
    or p_event ~ '^Etapa:[0-9a-f-]{36}$'
    or p_event ~ '^MetaEtapa:[0-9a-f-]{36}$'
  ) then
    return false;
  end if;
  select * into v_linha from public.ad_conversion_dispatches
    where organization_id = p_org and lead_id = p_lead and event_name = p_event for update;
  if not found or v_linha.status = 'sent' then return false; end if;
  if p_event ~ '^MetaEtapa:' then
    if v_linha.event_occurred_at is null or v_linha.meta_event_name is null then return false; end if;
  elsif p_event <> 'Purchase' and (v_linha.event_occurred_at is null or v_linha.google_action_id is null) then
    return false;
  end if;
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
