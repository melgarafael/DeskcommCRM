-- manifest: canal de SMS (#4415) — fn_upsert_wa_conversation tira o canal da conexão (sms), colunas do número e da conta do fornecedor de SMS, provider 'twilio' nos CHECKs de channel_sessions e webhook_events_log, canal 'sms' em conversations, e um número de SMS = uma conexão ativa
--
-- 9364 · Canal de SMS (issue #4415).
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo, ao lado de `waha`, `meta_cloud`,
-- `zernio` e `datafy`. O provider é o FORNECEDOR (`twilio`); a conversa que ele
-- abre é `channel = 'sms'`. Separar os dois deixa um segundo fornecedor de SMS
-- entrar depois como outra linha, sem renomear canal nenhum.
--
-- Colunas, nullable e vazias em toda instalação que não conecta SMS:
--   * `twilio_phone_number_sid` — id do NÚMERO no fornecedor (`PN…`). É o
--     sessionRef deste canal (lib/channels/session-ref.ts) e por ele a conexão
--     aponta o webhook de entrada do número.
--   * `twilio_account_sid` — id da CONTA (`AC…`). Não é segredo: vai na URL da
--     API e em todo webhook; serve para conferir que a entrada é desta conta.
-- A CHAVE da conta não ganha coluna própria: no fornecedor de SMS, quem assina
-- cada webhook é a própria chave da conta, então ela É o segredo do webhook da
-- conexão e mora na coluna comum `webhook_secret_encrypted` (cifrada como as
-- demais). Duas colunas com o mesmo segredo seriam duas fontes que podem
-- divergir numa troca de chave. O telefone (E.164) vai na coluna comum
-- `phone_number`, como nos outros canais por telefone.
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- `channel_sessions_provider_check` é o vocabulário fechado; o
-- `channel_sessions_provider_ref_check` exige a coluna do provider da vez NOT
-- NULL. `webhook_events_log_provider_check` entra junto porque a rota genérica
-- de canal arquiva o corpo cru ANTES de conferir a assinatura, com o provider
-- da SESSÃO (`lib/channels/arquivo-de-webhook.ts`): sem `twilio` ali, o arquivo
-- recusaria a linha e a entrada do SMS ficaria sem o único registro do que o
-- fornecedor mandou. `conversations_channel_check` ganha `sms`.
--
-- Alargamento puro nos quatro: um CHECK que aceita mais valores não é violado
-- por linha que já passava pelo antigo, então não há backfill antes.
--
-- ─── Índice único entre ativos ──────────────────────────────────────────────
-- Um número de SMS é UMA conexão ativa: duas conexões com o mesmo número
-- disputariam o webhook do número no fornecedor e misturariam as caixas de
-- entrada. Nenhuma linha tem a coluna preenchida antes desta migration, então
-- não há duplicata a corrigir antes do índice.

alter table public.channel_sessions
  add column if not exists twilio_phone_number_sid text,
  add column if not exists twilio_account_sid text;

comment on column public.channel_sessions.twilio_phone_number_sid is
  'Id do número de SMS no fornecedor (PN…). É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';
comment on column public.channel_sessions.twilio_account_sid is
  'Id da conta de SMS no fornecedor (AC…). Não é segredo; confere que o webhook é desta conta.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'twilio'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'twilio' and twilio_phone_number_sid is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'twilio',
    'stripe', 'asaas'
  ));

alter table public.conversations
  drop constraint if exists conversations_channel_check;

alter table public.conversations
  add constraint conversations_channel_check
    check (channel in ('whatsapp', 'instagram', 'facebook', 'sms'));

create unique index if not exists channel_sessions_twilio_phone_number_sid_ativo_unique
  on public.channel_sessions (twilio_phone_number_sid)
  where archived_at is null and twilio_phone_number_sid is not null;

comment on index public.channel_sessions_twilio_phone_number_sid_ativo_unique is
  'Um número de SMS é UMA conexão ativa (#4415): duas disputariam o webhook do número e misturariam as caixas de entrada.';

-- ─── O canal da conversa vem da conexão ─────────────────────────────────────
-- `fn_upsert_wa_conversation` é o ponto único de abertura de conversa 1:1 por
-- conexão, e gravava `channel = 'whatsapp'` fixo. Conversa de SMS aberta pelo
-- CRM (automação, lembrete, envio por telefone) nascia marcada WhatsApp. A
-- assinatura, o dono e os grants não mudam (`create or replace` os preserva).
create or replace function public.fn_upsert_wa_conversation(
  p_org uuid, p_contact uuid, p_session uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_canal text;
begin
  -- O canal da conversa vem da CONEXÃO (#4415): numa conexão de SMS a conversa
  -- nasce 'sms', em qualquer caminho que a abra (SMS recebido, automação,
  -- lembrete da agenda, envio por telefone, campanha). Antes era 'whatsapp' fixo.
  -- Conexão de outra organização ou inexistente cai no padrão de sempre.
  select case when s.provider = 'twilio' then 'sms' else 'whatsapp' end
    into v_canal
    from public.channel_sessions s
   where s.id = p_session and s.organization_id = p_org;

  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, coalesce(v_canal, 'whatsapp'), 'open', false, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

notify pgrst, 'reload schema';
