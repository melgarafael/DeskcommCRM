-- manifest: Encerramento condicional atomico de conversas via fn_safe_close_conversation (PR 01). Garante validacao transacional sob fn_service_lock + FOR NO KEY UPDATE de revisao, status, ultima mensagem inbound estavel, responsavel, setor, atendimento humano ativo, pendencias abertas (casos, propostas, tarefas, demanda humana) e idempotencia por chave, delegando a transicao final para fn_service_status.

-- Encerramento seguro e condicional de conversas:
-- 1. Toma fn_service_lock(p_org, contact_id) e FOR NO KEY UPDATE na conversa
--    (mesma ordem global de locks: contato -> conversa, sem AB-BA).
-- 2. Verifica idempotency_key caso a conversa ja esteja fechada pela mesma chave.
-- 3. Valida atomicamente revisao, status, ultima mensagem inbound estavel,
--    responsavel, setor, atendimento humano ativo e pendencias abertas.
-- 4. Delega a transicao para fn_service_status(p_org, p_conversation, 'closed', c.service_revision)
--    para preservar todos os gatilhos, carimbos, demandas e event_log.
create or replace function public.fn_safe_close_conversation(
  p_org uuid,
  p_conversation uuid,
  p_expected_revision bigint default null,
  p_expected_status text default null,
  p_expected_last_inbound_message_id uuid default null,
  p_enforce_last_inbound_message boolean default false,
  p_expected_last_inbound_at timestamptz default null,
  p_expected_assignee uuid default null,
  p_enforce_assignee boolean default false,
  p_expected_sector_id uuid default null,
  p_enforce_sector boolean default false,
  p_reject_human_assigned boolean default true,
  p_reject_open_pendencies boolean default true,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.conversations;
  pre_contact uuid;
  v_last_inbound_id uuid;
  v_key text;
  v_reason text;
  v_fechada public.conversations;
begin
  select * into c
    from public.conversations
   where id = p_conversation
     and organization_id = p_org;
  if not found then
    raise exception 'service_not_found' using errcode = 'P0002';
  end if;

  pre_contact := c.contact_id;
  perform public.fn_service_lock(p_org, c.contact_id);

  select * into c
    from public.conversations
   where id = p_conversation
     and organization_id = p_org
   for no key update;

  if c.contact_id is distinct from pre_contact then
    raise exception 'service_contact_changed' using errcode = '40001';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');

  select m.id into v_last_inbound_id
    from public.messages m
   where m.organization_id = p_org
     and m.conversation_id = p_conversation
     and m.direction = 'inbound'
     and m.type <> 'reaction'
     and coalesce(m.metadata->>'dispatch_mode', '') <> 'institutional'
   order by m.sent_at desc, m.created_at desc, m.id desc
   limit 1;

  -- Replay idempotente: a mesma chave fechou esta conversa e ela permanece fechada.
  if c.status = 'closed' and v_key is not null and coalesce(c.metadata->>'safe_close_idempotency_key', '') = v_key then
    return jsonb_build_object(
      'closed', true,
      'already_closed', true,
      'idempotent_replay', true,
      'last_inbound_message_id', v_last_inbound_id,
      'conversation', row_to_json(c)::jsonb
    );
  end if;

  -- Se o chamador esperava uma revisao especifica e ela mudou (ex.: reaberta e fechada), recusa.
  if p_expected_revision is not null and c.service_revision <> p_expected_revision then
    raise exception 'safe_close_conflict:service_revision_mismatch'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'service_revision_mismatch',
              'expected_revision', p_expected_revision,
              'actual_revision', c.service_revision,
              'status', c.status
            )::text;
  end if;

  -- Se ja esta fechada/arquivada/resolvida e a revisao bate (ou nao foi exigida), valida status esperado.
  if c.status in ('closed', 'resolved', 'archived') then
    if p_expected_status is not null and c.status is distinct from p_expected_status then
      raise exception 'safe_close_conflict:status_changed'
        using errcode = 'PT409',
              detail = jsonb_build_object(
                'reason', 'status_changed',
                'expected_status', p_expected_status,
                'actual_status', c.status
              )::text;
    end if;
    return jsonb_build_object(
      'closed', true,
      'already_closed', true,
      'idempotent_replay', false,
      'last_inbound_message_id', v_last_inbound_id,
      'conversation', row_to_json(c)::jsonb
    );
  end if;

  if p_expected_status is not null and c.status is distinct from p_expected_status then
    raise exception 'safe_close_conflict:status_changed'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'status_changed',
              'expected_status', p_expected_status,
              'actual_status', c.status
            )::text;
  end if;

  if p_enforce_assignee and c.assigned_to_user_id is distinct from p_expected_assignee then
    raise exception 'safe_close_conflict:assignee_changed'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'assignee_changed',
              'expected_assignee', p_expected_assignee,
              'actual_assignee', c.assigned_to_user_id
            )::text;
  end if;

  if p_enforce_sector and c.sector_id is distinct from p_expected_sector_id then
    raise exception 'safe_close_conflict:sector_changed'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'sector_changed',
              'expected_sector_id', p_expected_sector_id,
              'actual_sector_id', c.sector_id
            )::text;
  end if;

  if p_reject_human_assigned and (
    c.assigned_to_user_id is not null
    or c.assignee_kind = 'user'
    or c.status = 'claimed'
    or (c.bot_silenced_until is not null and c.bot_silenced_until > clock_timestamp())
  ) then
    raise exception 'safe_close_conflict:human_attendance_active'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'human_attendance_active',
              'assigned_to_user_id', c.assigned_to_user_id,
              'assignee_kind', c.assignee_kind,
              'status', c.status
            )::text;
  end if;

  if p_enforce_last_inbound_message and v_last_inbound_id is distinct from p_expected_last_inbound_message_id then
    raise exception 'safe_close_conflict:new_inbound_message'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'new_inbound_message',
              'expected_last_inbound_message_id', p_expected_last_inbound_message_id,
              'actual_last_inbound_message_id', v_last_inbound_id
            )::text;
  end if;

  if p_expected_last_inbound_at is not null and c.last_inbound_at is distinct from p_expected_last_inbound_at then
    raise exception 'safe_close_conflict:new_inbound_message'
      using errcode = 'PT409',
            detail = jsonb_build_object(
              'reason', 'new_inbound_message',
              'expected_last_inbound_at', p_expected_last_inbound_at,
              'actual_last_inbound_at', c.last_inbound_at
            )::text;
  end if;

  if p_reject_open_pendencies then
    if exists (
      select 1 from public.agent_cases ac
       where ac.organization_id = p_org
         and ac.conversation_id = p_conversation
         and ac.status in ('awaiting_human', 'awaiting_lead', 'escalated')
    ) then
      v_reason := 'open_agent_case';
    elsif exists (
      select 1 from public.crm_proposals cp
       where cp.organization_id = p_org
         and cp.conversation_id = p_conversation
         and cp.status in ('rascunho', 'enviada')
    ) then
      v_reason := 'open_proposal';
    elsif exists (
      select 1 from public.crm_tasks ct
       where ct.organization_id = p_org
         and ct.contact_id = c.contact_id
         and ct.status in ('pending', 'in_progress')
    ) then
      v_reason := 'open_task';
    elsif c.current_demanda_id is not null and exists (
      select 1 from public.demandas d
       where d.organization_id = p_org
         and d.id = c.current_demanda_id
         and d.fechada_em is null
         and d.dono_kind = 'humano'
         and d.estado not in ('resolvida', 'encerrada')
    ) then
      v_reason := 'open_human_demand';
    end if;

    if v_reason is not null then
      raise exception 'safe_close_conflict:%', v_reason
        using errcode = 'PT409',
              detail = jsonb_build_object(
                'reason', v_reason,
                'conversation_id', c.id
              )::text;
    end if;
  end if;

  v_fechada := public.fn_service_status(p_org, p_conversation, 'closed', c.service_revision);

  if v_key is not null then
    update public.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('safe_close_idempotency_key', v_key)
     where id = v_fechada.id
       and organization_id = p_org
     returning * into v_fechada;
  end if;

  return jsonb_build_object(
    'closed', true,
    'already_closed', false,
    'idempotent_replay', false,
    'last_inbound_message_id', v_last_inbound_id,
    'conversation', row_to_json(v_fechada)::jsonb
  );
end;
$$;

revoke execute on function public.fn_safe_close_conversation(
  uuid, uuid, bigint, text, uuid, boolean, timestamptz, uuid, boolean, uuid, boolean, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.fn_safe_close_conversation(
  uuid, uuid, bigint, text, uuid, boolean, timestamptz, uuid, boolean, uuid, boolean, boolean, boolean, text
) to service_role;

notify pgrst, 'reload schema';
