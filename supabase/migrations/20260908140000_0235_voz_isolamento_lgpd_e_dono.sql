-- 0235_voz_isolamento_lgpd_e_dono
--
-- Forward-fix da 0232 (chamada de voz WaCalls). A 0232 não é editada: doutrina
-- de migrations — o que se corrige, corrige-se para a frente, e tudo aqui é
-- idempotente e auto-curativo para o `update.sh` de um clone que já a aplicou.
--
-- Cinco consertos, todos medidos:
--
--  1. A policy de `voice_calls` nasceu sem o `for all` explícito e sem revogar
--     `anon`. O Postgres assume ALL quando o `for` falta, então o comportamento
--     casava com o nome `_all` por sorte, não por declaração — e a convenção
--     deste repo (0067, 0050, 0068, 0085) escreve as duas coisas.
--  2. `voice_calls` guardava `peer_phone` — telefone de gente — e ficava FORA
--     de `fn_lgpd_cascade_redact_contact`. Depois de anonimizar um contato, o
--     número real sobrevivia ligado ao `contact_id`: caminho de reidentificação.
--  3. Não havia coluna para QUEM esteve na linha. Sem dono, qualquer colega da
--     organização desligava a ligação de qualquer outro, a linha do tempo dizia
--     "Sistema" e a Central não sabia a quem o painel pertencia.
--  4. Ligação atendida não quebrava o silêncio do negócio: o Radar de Risco
--     seguia marcando como frio quem tinha acabado de falar vinte minutos ao
--     telefone.
--  5. Trabalho ao telefone não aparecia em `fn_attendant_metrics`.
--
-- E uma decisão de produto que virou schema: apagar o canal NÃO apaga o
-- histórico de ligações. A FK era `on delete cascade`, e o cálculo de impacto
-- do DELETE (`app/api/v1/channel-sessions/[id]/route.ts`) nem enumerava
-- `voice_calls` — o diálogo mostrava zeros e o histórico sumia. Vira
-- `on delete restrict`, entrando na mesma família de `conversations`/`messages`:
-- é o Postgres, e não a boa vontade da rota, que transforma a exclusão em
-- arquivamento.

-- ─── 1. dono da ligação ─────────────────────────────────────────────────────
alter table public.voice_calls
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

comment on column public.voice_calls.owner_user_id is
  'Quem esteve NA LINHA. Gravado pela rota de atender/iniciar e confirmado pelo campo `owner` do upstream (que é o X-Client-Id que nós mandamos, ou seja, o auth.users.id). Distinto de created_by, que só existe na chamada iniciada pelo CRM e é nulo em toda ligação recebida.';

-- Índice do recorte que `fn_attendant_metrics` faz: dono + janela de atendimento.
create index if not exists idx_voice_calls_owner_answered
  on public.voice_calls(organization_id, owner_user_id, answered_at)
  where answered_at is not null;

-- ─── 2. isolamento declarado, não presumido ─────────────────────────────────
alter table public.voice_calls enable row level security;

-- Policy ALL que confere só a organização deixa QUALQUER membro escrever —
-- inclusive `viewer`, o papel mais restrito, que não pode nem responder uma
-- mensagem. Registro de ligação é histórico com o cliente: todo mundo da
-- organização LÊ; quem ESCREVE é quem pode atender (`agent` para cima), que é
-- o mesmo papel que as rotas de voz exigem. Vigiado por
-- `tests/invariants/rbac-config-ia-canais.test.ts` — "nenhuma tabela NOVA entra
-- com policy ALL só-tenancy".
drop policy if exists tenant_isolation_voice_calls_all on public.voice_calls;
drop policy if exists voice_calls_select on public.voice_calls;
drop policy if exists voice_calls_write on public.voice_calls;

create policy voice_calls_select on public.voice_calls for select
  using (organization_id in (select public.fn_user_org_ids()));

create policy voice_calls_write on public.voice_calls for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
  );

revoke all on public.voice_calls from anon;

-- ─── 3. apagar o canal não apaga o histórico ────────────────────────────────
do $$
declare v_nome text;
begin
  select conname into v_nome
    from pg_constraint
   where conrelid = 'public.voice_calls'::regclass
     and contype = 'f'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.voice_calls'::regclass
                            and attname = 'channel_session_id')];
  if v_nome is not null and (
       select confdeltype from pg_constraint where conname = v_nome
         and conrelid = 'public.voice_calls'::regclass) <> 'r' then
    execute format('alter table public.voice_calls drop constraint %I', v_nome);
  end if;
end $$;

alter table public.voice_calls
  drop constraint if exists voice_calls_channel_session_id_fkey;
alter table public.voice_calls
  add constraint voice_calls_channel_session_id_fkey
  foreign key (channel_session_id) references public.channel_sessions(id) on delete restrict;

-- ─── 4. LGPD: o telefone da pessoa entra na cascata ─────────────────────────
CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"("p_organization_id" "uuid", "p_contact_id" "uuid", "p_request_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_already bool;
  v_counts jsonb := '{}'::jsonb;
  v_media_paths text[] := '{}';
  v_anon_label text;
  v_count int;
begin
  perform public.fn_service_lock(p_organization_id,p_contact_id);
  select is_anonymized into v_already
    from contacts
    where id = p_contact_id and organization_id = p_organization_id;

  if not found then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;

  if v_already then
    return jsonb_build_object('already_anonymized', true, 'counts', v_counts, 'media_paths', v_media_paths);
  end if;

  v_anon_label := 'Cliente Anonimizado #' || substring(p_contact_id::text from 1 for 8);

  -- Collect media storage paths (we only delete what we own — media_storage_path)
  select coalesce(array_agg(distinct media_storage_path) filter (where media_storage_path is not null), '{}')
    into v_media_paths
    from messages
    where organization_id = p_organization_id
      and conversation_id in (
        select id from conversations
          where contact_id = p_contact_id and organization_id = p_organization_id
      );

  -- 1. contacts (irreversible)
  update contacts set
    name = v_anon_label,
    display_name = v_anon_label,
    email = null,
    -- email_normalized NÃO entra: é GENERATED ALWAYS AS (lower(trim(email)))
    -- e o Postgres recusa escrita nela — a linha acima já a zera por derivação.
    -- Com a atribuição, o cascade INTEIRO abortava e nada era anonimizado.
    phone_number = null,
    cpf_encrypted = null,
    cpf_hash = null,
    birthdate = null,
    is_anonymized = true,
    anonymized_at = now(),
    consent = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contacts', v_count);

  -- 2. conversations metadata + preview strip
  update conversations set
    metadata = '{}'::jsonb,
    last_message_preview = null,
    updated_at = now()
  where contact_id = p_contact_id and organization_id = p_organization_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('conversations', v_count);

  -- 3. messages: redact body + null media + strip metadata (preserve status/timestamps/conversation_id)
  update messages set
    body = '[mensagem anonimizada]',
    media_url = null,
    media_mime = null,
    media_size_bytes = null,
    media_storage_path = null,
    metadata = '{}'::jsonb,
    updated_at = now()
  where organization_id = p_organization_id
    and conversation_id in (
      select id from conversations
        where contact_id = p_contact_id and organization_id = p_organization_id
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messages', v_count);

  -- 4. crm_lead_activities — strip payload, metadata E reason (migration 0071).
  --    `reason` é texto livre escrito por LLM sobre a conversa do lead: supor que
  --    nunca conterá um nome é a suposição que falha. `evidence` NÃO é limpa —
  --    guarda só ids, e as linhas apontadas são redigidas por conta própria.
  update crm_lead_activities set
    payload = '{}'::jsonb,
    metadata = '{}'::jsonb,
    reason = null
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or lead_id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
      or lead_id in (
        select id from crm_leads
          where contact_id = p_contact_id and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('activities', v_count);

  -- 5. crm_leads — strip title/description/custom_fields/source_metadata/tags but PRESERVE pipeline/stage/value
  update crm_leads set
    title = v_anon_label,
    description = null,
    custom_fields = '{}'::jsonb,
    source_metadata = '{}'::jsonb,
    tags = '{}'::text[],
    updated_at = now()
  where organization_id = p_organization_id
    and (
      contact_id = p_contact_id
      or id in (
        select lead_id from crm_lead_links
          where target_kind = 'contact'
            and target_id = p_contact_id
            and organization_id = p_organization_id
      )
    );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('leads', v_count);

  -- 6. orders — PRESERVE values + status + timestamps. Strip personal fields from payload jsonb
  --    and replace customer_external_id with null (FK-safe; soft de-link). Keep contact_id null.
  update orders set
    payload = (coalesce(payload, '{}'::jsonb))
      - 'customer'
      - 'customer_name'
      - 'customer_email'
      - 'customer_phone'
      - 'shipping_address'
      - 'billing_address'
      - 'contact_identification',
    customer_external_id = null,
    contact_id = null,
    is_anonymized = true,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_count);

  -- 7. enqueue media for async deletion (idempotent via unique (bucket, object_path))
  if array_length(v_media_paths, 1) > 0 then
    insert into storage_redaction_queue (organization_id, request_id, bucket, object_path)
    select p_organization_id, p_request_id, 'whatsapp-media', path
      from unnest(v_media_paths) as path
      where path is not null and length(path) > 0
    on conflict (bucket, object_path) do nothing;
  end if;

  -- 7b. voice_calls — o TELEFONE de quem falou ao telefone (migration 0235).
  --
  -- `peer_phone` é `not null` e guarda o número da outra ponta: depois de
  -- anonimizar o contato, ele sobrevivia ligado ao `contact_id` e reidentificava
  -- a pessoa que pediu para ser esquecida. É o mesmo argumento que a foto de
  -- perfil já tinha (ver o bloco do avatar em `lib/lgpd/redact-cascade.ts`):
  -- anonimizar em toda parte menos numa é não ter anonimizado.
  --
  -- O que fica: direção, status, motivo do fim, marcas de tempo e duração. Um
  -- registro de "houve uma chamada de 12 minutos" sem número e sem dono não
  -- identifica ninguém e é o que sustenta a métrica do atendente e a fatura.
  -- `peer_phone` é NOT NULL, então recebe o rótulo, não `null`.
  update voice_calls set
    peer_phone = v_anon_label,
    owner_user_id = null,
    created_by = null,
    updated_at = now()
  where organization_id = p_organization_id
    and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('voice_calls', v_count);

  -- 8. dense audit row
  insert into api_audit_log (organization_id, action, actor_user_id, resource_type, resource_id, metadata, bypassed_rls)
  values (
    p_organization_id,
    'lgpd.redact_executed',
    null,
    'contact',
    p_contact_id,
    jsonb_build_object(
      'cascaded_to', v_counts,
      'media_queued', coalesce(array_length(v_media_paths, 1), 0),
      'request_id', p_request_id
    ),
    true
  );

  return jsonb_build_object(
    'already_anonymized', false,
    'counts', v_counts,
    'media_paths', v_media_paths
  );
end;
$$;
revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;

-- ─── 5. ligação atendida quebra o silêncio do negócio ───────────────────────
create or replace function public.fn_update_last_activity_at()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
begin
  -- LISTA POSITIVA: só isto conta como "alguém tocou este negócio". Tipo que
  -- não está aqui NÃO quebra o silêncio — inclusive tipo que ainda não existe.
  -- Ver o cabeçalho da 0079 antes de acrescentar linha nesta lista.
  if new.type not in (
    'ai_turn',              -- a IA falou com o cliente
    'note',                 -- alguém registrou trabalho no negócio
    'lead_edited',          -- humano mexeu nos dados
    'stage_changed',        -- humano moveu o negócio
    'next_action_approved', -- humano decidiu agir
    -- (0235) Uma ligação ATENDIDA é interação, e das mais fortes: alguém falou
    -- com o cliente. Sem esta linha o Radar de Risco seguia marcando como frio
    -- quem tinha acabado de passar vinte minutos ao telefone, e a IA propunha
    -- "retomar contato" com quem nunca ficou sem contato.
    --
    -- `voice_call_missed` NÃO entra, e a ausência é a regra e não esquecimento:
    -- telefone que tocou sem resposta é constatação de silêncio, não quebra
    -- dele. É exatamente a assimetria que a 0079 existe para preservar.
    'voice_call'
  ) then
    return new;
  end if;

  update public.crm_leads
     set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
   where id = new.lead_id;

  if new.contact_id is not null then
    update public.contacts
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.performed_at)
     where id = new.contact_id;
  end if;
  return new;
end$function$;
-- ─── 6. trabalho ao telefone conta como trabalho ────────────────────────────
create or replace function public.fn_attendant_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_owner uuid default null
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  lead_agg as (
    select
      owner_user_id as user_id,
      count(*) filter (where status = 'won')  as won,
      count(*) filter (where status = 'lost') as lost
    from public.crm_leads
    where organization_id = p_org
      and status in ('won', 'lost')
      and closed_at >= p_from and closed_at < p_to
      and owner_user_id is not null
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  conv_agg as (
    select
      assigned_to_user_id as user_id,
      count(*) as conversations_handled
    from public.conversations
    where organization_id = p_org
      and assigned_to_user_id is not null
      and assigned_at >= p_from and assigned_at < p_to
      and (p_owner is null or assigned_to_user_id = p_owner)
    group by assigned_to_user_id
  ),
  -- (0235) Chamada de voz ATENDIDA conta como trabalho.
  --
  -- Quem passa o dia ao telefone tinha produtividade zero nesta função: ela
  -- lia negócios fechados, conversas atribuídas e primeira resposta por
  -- MENSAGEM, e nenhuma das três enxerga uma ligação.
  --
  -- `owner_user_id` é quem esteve NA LINHA (a rota de atender grava; a ponte de
  -- eventos confirma pelo `owner` do upstream) — e não `created_by`, que só
  -- existe na chamada iniciada pelo CRM e diria zero para toda ligação
  -- recebida. `answered_at is not null` é o que separa trabalho de telefone
  -- tocando.
  voice_agg as (
    select
      owner_user_id as user_id,
      count(*) as calls_answered,
      coalesce(sum(duration_ms), 0)::bigint as call_ms
    from public.voice_calls
    where organization_id = p_org
      and owner_user_id is not null
      and answered_at is not null
      and answered_at >= p_from and answered_at < p_to
      and (p_owner is null or owner_user_id = p_owner)
    group by owner_user_id
  ),
  ttfr as (
    select
      c.assigned_to_user_id as user_id,
      avg(extract(epoch from (fr.first_human_out - fr.first_in))) as avg_first_response_seconds
    from public.conversations c
    cross join lateral (
      select
        min(m.sent_at) filter (where m.direction = 'inbound') as first_in,
        min(m.sent_at) filter (
          where m.direction = 'outbound' and m.sent_by_user_id is not null
        ) as first_human_out
      from public.messages m
      where m.conversation_id = c.id
    ) fr
    where c.organization_id = p_org
      and c.assigned_to_user_id is not null
      and (p_owner is null or c.assigned_to_user_id = p_owner)
      and fr.first_in is not null
      and fr.first_human_out is not null
      and fr.first_human_out > fr.first_in
      and fr.first_human_out >= p_from and fr.first_human_out < p_to
    group by c.assigned_to_user_id
  ),
  attendant_ids as (
    select user_id from lead_agg
    union select user_id from conv_agg
    union select user_id from ttfr
    union select user_id from voice_agg
  )
  select jsonb_build_object(
    'funnel', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage_id', s.id,
          'stage_name', s.name,
          'position', s.position,
          'count', coalesce(l.cnt, 0)
        ) order by s.position, s.name
      )
      from public.crm_stages s
      left join (
        select stage_id, count(*) as cnt
        from public.crm_leads
        where organization_id = p_org
          and status = 'open'
          and (p_owner is null or owner_user_id = p_owner)
        group by stage_id
      ) l on l.stage_id = s.id
      where s.organization_id = p_org
        and s.is_archived = false
    ), '[]'::jsonb),
    'attendants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'user_id', a.user_id,
          'won', coalesce(la.won, 0),
          'lost', coalesce(la.lost, 0),
          'conversations_handled', coalesce(ca.conversations_handled, 0),
          'avg_first_response_seconds', tf.avg_first_response_seconds,
          'calls_answered', coalesce(va.calls_answered, 0),
          'call_seconds', (coalesce(va.call_ms, 0) / 1000)::bigint
        ) order by coalesce(la.won, 0) desc, a.user_id
      )
      from attendant_ids a
      left join lead_agg la on la.user_id = a.user_id
      left join conv_agg ca on ca.user_id = a.user_id
      left join ttfr tf on tf.user_id = a.user_id
      left join voice_agg va on va.user_id = a.user_id
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) from public, anon;
grant execute on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) to authenticated, service_role;
