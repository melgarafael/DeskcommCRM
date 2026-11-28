-- manifest: Permite destinos Google distintos na mesma etapa e preserva o destino original de cada envio, sem trocar a autorização global nem reenviar protocolos legados.
-- 9509 — destino explícito por regra, sem credencial de leitura no envio.

-- IDs externos do Google, como em ad_platform_connections. Não apontam para
-- google_ads_reporting_accounts: autorizar leitura não autoriza conversões.
alter table public.google_ads_conversion_rules
  add column if not exists google_customer_id text,
  add column if not exists google_login_customer_id text;

do $rule_destination$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.google_ads_conversion_rules'::regclass
    and conname = 'google_ads_conversion_rules_destination_check') then
    alter table public.google_ads_conversion_rules
      add constraint google_ads_conversion_rules_destination_check check (
        (google_customer_id is null or google_customer_id ~ '^[0-9]{10}$')
        and (google_login_customer_id is null or google_login_customer_id ~ '^[0-9]{10}$')
        and (google_customer_id is not null or google_login_customer_id is null)
      );
  end if;
end $rule_destination$;

-- NULL é a regra global legada; também só pode existir uma por etapa.
-- Um bloco só: o update.sh reaplica sem ON_ERROR_STOP e em autocommit, e uma
-- falha no create depois dos drops deixaria a tabela sem índice único.
do $rule_destination_uk$ begin
  drop index if exists public.google_ads_conversion_rules_org_stage_uk;
  drop index if exists public.google_ads_conversion_rules_org_event_uk;
  create unique index if not exists google_ads_conversion_rules_org_stage_customer_uk
    on public.google_ads_conversion_rules (organization_id, stage_id, google_customer_id) nulls not distinct;
end $rule_destination_uk$;

comment on column public.google_ads_conversion_rules.google_customer_id is
  'Conta Google de destino desta regra; NULL conserva a conta global de conversões. Identidade externa, sem vínculo com a autorização de leitura.';
comment on column public.google_ads_conversion_rules.google_login_customer_id is
  'Gerente MCC para o destino explícito; NULL significa acesso direto. Na regra global, ambos os IDs vêm da conexão de conversões.';
comment on column public.google_ads_conversion_rules.event_name is
  'Identidade estável por etapa, compartilhada por suas contas de destino. QualifiedLead legado e Etapa:<uuid> já existentes não são renomeados.';

create or replace function public.fn_marcar_configuracao_regra_google()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.configured_at := coalesce(new.configured_at, now());
  elsif new.stage_id is distinct from old.stage_id
     or new.google_action_id is distinct from old.google_action_id
     or new.google_customer_id is distinct from old.google_customer_id
     or new.google_login_customer_id is distinct from old.google_login_customer_id
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

-- Retrato histórico, sem FK: remover/alterar configuração não muda um envio.
-- Não preencher retroativamente: o destino de protocolos antigos é desconhecido.
alter table public.ad_conversion_dispatches
  add column if not exists google_customer_id text,
  add column if not exists google_login_customer_id text,
  add column if not exists google_api text,
  add column if not exists google_destination_explicit boolean;

do $dispatch_destination$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.ad_conversion_dispatches'::regclass
    and conname = 'ad_conversion_dispatches_google_destination_check') then
    alter table public.ad_conversion_dispatches
      add constraint ad_conversion_dispatches_google_destination_check check (
        (google_customer_id is null and google_login_customer_id is null
          and google_api is null and google_destination_explicit is null)
        or (google_customer_id is not null and google_customer_id ~ '^[0-9]{10}$'
          and (google_login_customer_id is null or google_login_customer_id ~ '^[0-9]{10}$')
          and google_destination_explicit is not null)
      );
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.ad_conversion_dispatches'::regclass
    and conname = 'ad_conversion_dispatches_google_api_check') then
    alter table public.ad_conversion_dispatches
      add constraint ad_conversion_dispatches_google_api_check
      check (google_api is null or google_api in ('google_ads', 'data_manager'));
  end if;
end $dispatch_destination$;

comment on column public.ad_conversion_dispatches.google_customer_id is
  'Conta de destino do primeiro envio. NULL em registros legados; um protocolo sem retrato continua sendo consultado pela conexão global, nunca reenviado.';
comment on column public.ad_conversion_dispatches.google_login_customer_id is
  'MCC do primeiro envio; NULL com conta registrada preserva o acesso direto original.';
comment on column public.ad_conversion_dispatches.google_api is
  'Primeira API disponível, registrada antes do envio. Pode ser NULL enquanto só o destino explícito é conhecido; depois de preenchida não muda.';
comment on column public.ad_conversion_dispatches.google_destination_explicit is
  'Se o primeiro envio escolheu destino por regra (true) ou herdou a conta global (false); NULL é registro legado sem retrato.';

create or replace function public.fn_preservar_conversao_enviada()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then return old; end if;
  new.event_occurred_at := coalesce(old.event_occurred_at, new.event_occurred_at);
  new.google_action_id := coalesce(old.google_action_id, new.google_action_id);
  -- A identidade vence primeiro, inclusive MCC NULL; a API pode ser preenchida
  -- uma vez quando a autorização existir. Protocolo legado não ganha retrato.
  if old.google_customer_id is not null then
    new.google_customer_id := old.google_customer_id;
    new.google_login_customer_id := old.google_login_customer_id;
    new.google_api := coalesce(old.google_api, new.google_api);
    new.google_destination_explicit := old.google_destination_explicit;
  elsif old.remote_request_id is not null then
    new.google_customer_id := old.google_customer_id;
    new.google_login_customer_id := old.google_login_customer_id;
    new.google_api := old.google_api;
    new.google_destination_explicit := old.google_destination_explicit;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_preservar_conversao_enviada() from public, anon, authenticated;
grant execute on function public.fn_preservar_conversao_enviada() to service_role;

notify pgrst, 'reload schema';
