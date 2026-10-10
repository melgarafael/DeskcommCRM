-- 0169 — celular BR canônico COM o nono dígito
--
-- +553284793302 e +5532984793302 são a MESMA pessoa. O CRM passa a GRAVAR e
-- MOSTRAR a forma com o 9; o WhatsApp/WAHA continuam podendo endereçar sem ele
-- (check-exists tenta as duas grafias).
--
-- A busca por variantes já existia em TypeScript. Sem a RPC e sem o backfill,
-- o webhook que chega sem o 9 ainda nascia um segundo contato.
--
-- Idempotente: create or replace + updates que na segunda passada casam zero
-- linhas. Sem constraint nova.

-- 1 · a RPC reencontra pelas duas grafias e GRAVA a canônica.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
  v_digits text;
  v_alt text;
begin
  -- Celular BR de 12 dígitos (local 6–9) ganha o nono. A grafia sem o 9 fica
  -- em v_alt só para a BUSCA — não se escreve mais.
  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
      v_alt := '+' || v_digits;
      v_phone := '+55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
    elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
      v_phone := '+' || v_digits;
      v_alt := '+55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
    end if;
  end if;

  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid and is_merged_into is null
     limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and phone_number in (v_phone, v_alt)
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
  end if;

  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    update public.contacts set
      -- Promove 12→13 quando é a MESMA pessoa e o canônico está livre.
      -- Outro número (pessoa diferente) continua intocável.
      phone_number = case
        when v_phone is not null and (phone_number is null or phone_number = v_alt) then v_phone
        else phone_number
      end,
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  begin
    insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
    values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
      case when v_lid is not null
        then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
        else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
      nullif(p_notify, ''))
    returning id into v_id;
    return v_id;
  exception when unique_violation then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and (
         (v_phone is not null and phone_number = v_phone)
         or (v_alt is not null and phone_number = v_alt)
         or (v_lid is not null and wa_lid = v_lid)
       )
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
    return v_id;
  end;
end; $$;

-- 2 · pares 12+13: funde o de 12 no de 13 (canônico). Conversas 1:1 no mesmo
-- canal são fundidas ANTES de remarcarmos o contact_id, senão
-- uniq_conversations_1to1_per_contact_session estoura.

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv, p.winner_id
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.messages m
   set conversation_id = cp.winner_conv, contact_id = cp.winner_id
  from conv_pares cp
 where m.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.ai_agent_runs t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.ai_invocations t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.conversation_notes t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.conversation_assignment_events t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.agent_cases t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.followup_enrollments t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.contact_field_proposals t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
delete from public.demanda_conversas d
 using conv_pares cp
 where d.conversation_id = cp.loser_conv
   and exists (
     select 1 from public.demanda_conversas w
      where w.demanda_id = d.demanda_id and w.conversation_id = cp.winner_conv
   );

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
update public.demanda_conversas t set conversation_id = cp.winner_conv
  from conv_pares cp where t.conversation_id = cp.loser_conv;

with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
, conv_pares as (
  select loser.id as loser_conv, winner.id as winner_conv
    from pares p
    join public.conversations loser
      on loser.contact_id = p.loser_id and loser.is_group = false
    join public.conversations winner
      on winner.contact_id = p.winner_id
     and winner.channel_session_id = loser.channel_session_id
     and winner.organization_id = loser.organization_id
     and winner.is_group = false
     and winner.id <> loser.id
)
delete from public.conversations d
 using conv_pares cp
 where d.id = cp.loser_conv;

-- Marca os de 12 dígitos como fundidos no irmão de 13.
with pares as (
  select sem.id as loser_id, com.id as winner_id
    from public.contacts sem
    join public.contacts com
      on com.organization_id = sem.organization_id
     and com.is_merged_into is null
     and sem.is_merged_into is null
     and sem.id <> com.id
     and sem.is_anonymized = false
     and com.is_anonymized = false
     and regexp_replace(coalesce(sem.phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
     and com.phone_number = '+55'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 3 for 2)
       || '9'
       || substring(regexp_replace(sem.phone_number, '\D', '', 'g') from 5)
)
update public.contacts c
   set is_merged_into = p.winner_id, merged_at = now()
  from pares p
 where c.id = p.loser_id;

-- lead_state é unique (org, contact): apaga o perdedor se o vencedor já tem linha.
delete from public.lead_state l
 using public.contacts c
 where l.contact_id = c.id and c.is_merged_into is not null
   and exists (
     select 1 from public.lead_state w
      where w.contact_id = c.is_merged_into and w.organization_id = l.organization_id
   );

update public.followup_enrollments e
   set status = 'cancelled', cancel_reason = 'nono_digito_merge', next_eval_at = null, updated_at = now()
  from public.contacts c
 where e.contact_id = c.id and c.is_merged_into is not null
   and e.status in ('active', 'waiting_reply', 'paused_handoff')
   and exists (
     select 1 from public.followup_enrollments w
      where w.organization_id = e.organization_id
        and w.contact_id = c.is_merged_into
        and w.status in ('active', 'waiting_reply', 'paused_handoff')
   );

update public.conversations       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.messages            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.ai_agent_runs       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_lead_activities t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.crm_leads           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lgpd_requests       t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.orders              t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.job_queue           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null
  and not (t.status = 'running' and exists (
    select 1 from public.job_queue w where w.contact_id = c.is_merged_into and w.status = 'running'
  ));
update public.send_ledger         t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.llm_calls           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_checkpoints    t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_state          t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_state_transitions t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.cron_jobs           t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.lead_notes          t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.before_send_traces  t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.followup_enrollments t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.demandas            t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;
update public.contact_field_proposals t set contact_id = c.is_merged_into from public.contacts c where t.contact_id = c.id and c.is_merged_into is not null;

-- 3 · quem só tinha a grafia de 12 dígitos ganha o nono. Pula se o canônico
-- já pertence a outro contato vivo (o passo 2 deveria ter fundido; isto é o
-- piso de segurança para o unique).
update public.contacts
   set phone_number = '+55'
     || substring(regexp_replace(phone_number, '\D', '', 'g') from 3 for 2)
     || '9'
     || substring(regexp_replace(phone_number, '\D', '', 'g') from 5),
       updated_at = now()
 where is_merged_into is null
   and is_anonymized = false
   and regexp_replace(coalesce(phone_number, ''), '\D', '', 'g') ~ '^55[1-9][0-9][6-9][0-9]{7}$'
   and not exists (
     select 1 from public.contacts o
      where o.organization_id = contacts.organization_id
        and o.is_merged_into is null
        and o.id <> contacts.id
        and o.phone_number = '+55'
          || substring(regexp_replace(contacts.phone_number, '\D', '', 'g') from 3 for 2)
          || '9'
          || substring(regexp_replace(contacts.phone_number, '\D', '', 'g') from 5)
   );
