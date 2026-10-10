-- 0027_whatsapp_conversation_unification
--
-- PROBLEMA (bug de governança de conversas): a ingestão WAHA criava um contato
-- (e portanto uma conversa 1:1) NOVO a cada mensagem. Duas causas provadas nos
-- dados de produção:
--   1. Contatos @lid (número protegido do WhatsApp) NÃO tinham unique key, e a
--      resolução era check-then-act (SELECT depois INSERT). O WAHA NOWEB emite
--      DOIS eventos (`message` + `message.any`) por mensagem → as duas execuções
--      correm e ambas inserem. Resultado real: 1 lid = até 12 contatos.
--   2. A unique de conversa incluía group_chat_id (NULL no 1:1) e no Postgres
--      NULL != NULL em UNIQUE → a constraint não protegia conversas 1:1.
--
-- SOLUÇÃO:
--   A. Identidade canônica determinística por org: coluna gerada `wa_identity`
--      = 'phone:+E164' | 'lid:<digits>'.
--   B. Merge idempotente do histórico duplicado (contatos e conversas),
--      repontando todas as FKs — genérico, roda em qualquer clone. Usa o próprio
--      contacts.is_merged_into como mapa (sem temp tables → portátil em psql puro).
--   C. Unique index em (org, wa_identity) e unique parcial de conversa 1:1.
--   D. Funções de upsert atômico (ON CONFLICT DO UPDATE) que a aplicação passa a
--      usar no lugar do check-then-act — a corrida deixa de existir na raiz.
--
-- Idempotente: pode ser re-aplicada sem efeito colateral. Sem BEGIN/COMMIT
-- explícito (o runner de migration já envolve em transação, como as demais).

-- ---------------------------------------------------------------------------
-- A. Coluna de identidade canônica (generated) — mesma doutrina de email_normalized
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists wa_identity text
  generated always as (
    case
      when phone_number is not null then 'phone:' || phone_number
      when source_metadata->>'waha_lid' is not null
        then 'lid:' || regexp_replace(source_metadata->>'waha_lid', '@.*$', '')
      else null
    end
  ) stored;

comment on column public.contacts.wa_identity is
  'Identidade WhatsApp canônica por org (phone:+E164 | lid:<digits>). Chave de dedup/upsert da ingestão WAHA.';

-- ---------------------------------------------------------------------------
-- B1. Merge de contatos duplicados (mesma wa_identity dentro da org).
--     Canônico = mais antigo (created_at, id). is_merged_into vira o mapa.
-- ---------------------------------------------------------------------------
with ranked as (
  select
    id,
    first_value(id) over (
      partition by organization_id, wa_identity
      order by created_at asc, id asc
    ) as canonical_id
  from public.contacts
  where wa_identity is not null and is_merged_into is null
)
update public.contacts c
set is_merged_into = r.canonical_id, merged_at = now()
from ranked r
where c.id = r.id and r.id <> r.canonical_id;

-- Repointa cada tabela que referencia contacts(id) para o canônico (FK map
-- verificado no catálogo). is_merged_into aponta dup -> canônico (nível único:
-- canônico nunca é dup, pois foi escolhido entre os não-merged).
update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

-- Preserva o melhor display_name no canônico: prefere nome real sobre "Contato NNN"/null.
update public.contacts can set display_name = better.name
from (
  select
    coalesce(c.is_merged_into, c.id) as canonical_id,
    (array_agg(c.display_name order by (c.display_name ~ '^Contato ') asc, c.created_at asc)
       filter (where c.display_name is not null and c.display_name <> ''))[1] as name
  from public.contacts c
  where coalesce(c.is_merged_into, c.id) in (
    select is_merged_into from public.contacts where is_merged_into is not null
  )
  group by 1
) better
where can.id = better.canonical_id
  and better.name is not null
  and (can.display_name is null or can.display_name = '' or can.display_name ~ '^Contato ');

-- ---------------------------------------------------------------------------
-- B2. Merge de conversas duplicadas que emergem sob o contato canônico
--     (mesma org, contact_id, channel_session_id, is_group=false).
--     Canônico via subquery de janela (avaliada por statement).
-- ---------------------------------------------------------------------------
update public.messages t set conversation_id = canon.canonical_id
from (
  select id, organization_id, contact_id, channel_session_id,
    first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id
  from public.conversations where is_group = false
) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;

update public.ai_agent_runs t set conversation_id = canon.canonical_id
from (
  select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id
  from public.conversations where is_group = false
) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;

update public.ai_invocations t set conversation_id = canon.canonical_id
from (
  select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id
  from public.conversations where is_group = false
) canon
where t.conversation_id = canon.id and canon.id <> canon.canonical_id;

delete from public.conversations d
using (
  select id, first_value(id) over (partition by organization_id, contact_id, channel_session_id order by created_at asc, id asc) as canonical_id
  from public.conversations where is_group = false
) canon
where d.id = canon.id and canon.id <> canon.canonical_id;

-- Recalcula agregados de timeline de todas as conversas 1:1 a partir das
-- mensagens (idempotente — recomputa a verdade; barato numa migration única).
update public.conversations c set
  last_message_at      = agg.max_at,
  last_inbound_at      = agg.max_in,
  last_outbound_at     = agg.max_out,
  last_message_preview = agg.preview
from (
  select
    conversation_id,
    max(coalesce(sent_at, created_at)) as max_at,
    max(coalesce(sent_at, created_at)) filter (where direction = 'inbound')  as max_in,
    max(coalesce(sent_at, created_at)) filter (where direction = 'outbound') as max_out,
    (array_agg(coalesce(nullif(body, ''), '[' || type || ']') order by coalesce(sent_at, created_at) desc))[1] as preview
  from public.messages
  group by conversation_id
) agg
where c.id = agg.conversation_id and c.is_group = false;

-- ---------------------------------------------------------------------------
-- C. Constraints que impedem a re-duplicação a nível de banco
-- ---------------------------------------------------------------------------
create unique index if not exists uniq_contacts_org_wa_identity
  on public.contacts (organization_id, wa_identity)
  where wa_identity is not null and is_merged_into is null;

-- Conversa 1:1 (a antiga conversations_unique_per_contact_session continua válida
-- para grupos, onde group_chat_id é NOT NULL).
create unique index if not exists uniq_conversations_1to1_per_contact_session
  on public.conversations (organization_id, contact_id, channel_session_id)
  where is_group = false;

-- ---------------------------------------------------------------------------
-- D. Upsert atômico — a aplicação chama estas funções no lugar do check-then-act.
--    SECURITY DEFINER + filtro de org por parâmetro (nunca do body).
-- ---------------------------------------------------------------------------
create or replace function public.fn_upsert_wa_contact(
  p_org uuid,
  p_kind text,      -- 'phone' | 'lid'
  p_phone text,     -- +E164 (kind=phone) senão null
  p_lid text,       -- somente dígitos (kind=lid) senão null
  p_chat_id text,   -- chatId cru p/ source_metadata (auditoria)
  p_notify text     -- notifyName/pushName, se houver
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.contacts (
    organization_id, phone_number, source, consent, tags, source_metadata, display_name
  )
  values (
    p_org,
    case when p_kind = 'phone' then p_phone end,
    'whatsapp',
    '{}'::jsonb,
    '{}'::text[],
    case when p_kind = 'lid'
      then jsonb_build_object('waha_lid', p_lid, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, '')
  )
  on conflict (organization_id, wa_identity) where wa_identity is not null and is_merged_into is null
  do update set
    display_name = coalesce(contacts.display_name, excluded.display_name),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.fn_upsert_wa_contact is
  'Resolve/cria contato WhatsApp de forma atômica pela identidade canônica (org, wa_identity). Elimina a corrida message/message.any.';

create or replace function public.fn_upsert_wa_conversation(
  p_org uuid,
  p_contact uuid,
  p_session uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.conversations (
    organization_id, contact_id, channel_session_id, channel, status,
    is_group, unread_count_for_assignee, metadata
  )
  values (
    p_org, p_contact, p_session, 'whatsapp', 'open', false, 0, '{}'::jsonb
  )
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.fn_upsert_wa_conversation is
  'Resolve/cria conversa 1:1 WhatsApp de forma atômica por (org, contact, session).';

-- Bump de agregados da conversa após persistir a mensagem (increment atômico do unread).
create or replace function public.fn_mark_conversation_message(
  p_conv uuid,
  p_direction text,   -- 'inbound' | 'outbound'
  p_preview text,
  p_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversations
  set
    last_message_at = p_at,
    last_message_preview = p_preview,
    last_inbound_at  = case when p_direction = 'inbound'  then p_at else last_inbound_at  end,
    last_outbound_at = case when p_direction = 'outbound' then p_at else last_outbound_at end,
    unread_count_for_assignee = unread_count_for_assignee + case when p_direction = 'inbound' then 1 else 0 end,
    updated_at = now()
  where id = p_conv;
end;
$$;

comment on function public.fn_mark_conversation_message is
  'Atualiza agregados de timeline da conversa e incrementa unread atômico. Chamado após INSERT da mensagem (pós-checagem de idempotência 23505).';

revoke all on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from public;
revoke all on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from public;
revoke all on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from public;
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) to service_role;
