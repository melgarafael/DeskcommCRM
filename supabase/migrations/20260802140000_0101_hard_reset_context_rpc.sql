-- 0101_hard_reset_context_rpc
-- Spec 16 §6.1 / C2-03: hard reset do contexto do agente em UMA transação.
-- Mesmo padrão de fn_lgpd_cascade_redact_contact (SECURITY DEFINER + service_role).
--
-- Ordem (atômico):
--   1. contato existe?
--   2. caso humano aberto? → ok=false, sem mutação
--   3. job running do contato? → ok=false (não mata lease — o handler em memória
--      continuaria e recriaria estado; esperamos o turno terminar)
--   4. cancela jobs pending → failed
--   5. apaga lead_checkpoints, lead_state, lead_notes
--   6. opcional: purge ai_chunks das conversas do contato
--   7. apaga conversations (cascade messages + conversation_notes)
--   8. zera context_reset_at / context_reset_reason
--
-- ACL: service_role only. Anon/authenticated revoked.

create or replace function public.fn_hard_reset_contact_context(
  p_organization_id uuid,
  p_contact_id uuid,
  p_purge_knowledge_base boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
  v_open_case_id uuid;
  v_running_job_id uuid;
  v_conversation_ids uuid[];
  v_count int;
  v_deleted jsonb := '{}'::jsonb;
begin
  select exists(
    select 1 from contacts
     where id = p_contact_id and organization_id = p_organization_id
  ) into v_exists;

  if not v_exists then
    return jsonb_build_object(
      'ok', false,
      'code', 'not_found',
      'message', 'Contato não encontrado.'
    );
  end if;

  select ac.id into v_open_case_id
    from agent_cases ac
    join conversations conv on conv.id = ac.conversation_id
   where ac.organization_id = p_organization_id
     and conv.organization_id = p_organization_id
     and conv.contact_id = p_contact_id
     and ac.status not in ('resolved', 'cancelled')
   limit 1;

  if v_open_case_id is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'open_case_blocks_reset',
      'message',
        'Existe um caso aberto para este contato. Resolva o caso antes de apagar o contexto — senão quem estiver cuidando dele perde a referência.',
      'details', jsonb_build_object('case_id', v_open_case_id)
    );
  end if;

  -- Job já claimed pelo worker: marcar failed NÃO para o handler em memória.
  -- Bloqueia até o turno terminar (mesmo espírito do caso aberto).
  select id into v_running_job_id
    from job_queue
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and status = 'running'
   limit 1;

  if v_running_job_id is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'job_in_flight_blocks_reset',
      'message',
        'Há um atendimento da IA em andamento para este contato. Espere ele terminar e tente de novo — senão o contexto pode reaparecer no meio do reset.',
      'details', jsonb_build_object('job_id', v_running_job_id)
    );
  end if;

  select coalesce(array_agg(id), '{}') into v_conversation_ids
    from conversations
   where organization_id = p_organization_id
     and contact_id = p_contact_id;

  update job_queue
     set status = 'failed',
         last_error = 'canceled_by_context_hard_reset',
         locked_by = null,
         locked_at = null
   where organization_id = p_organization_id
     and contact_id = p_contact_id
     and status = 'pending';
  get diagnostics v_count = row_count;
  v_deleted := v_deleted || jsonb_build_object('jobs_canceled', v_count);

  delete from lead_checkpoints
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_deleted := v_deleted || jsonb_build_object('lead_checkpoints', v_count);

  delete from lead_state
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_deleted := v_deleted || jsonb_build_object('lead_state', v_count);

  delete from lead_notes
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_deleted := v_deleted || jsonb_build_object('lead_notes', v_count);

  v_count := 0;
  if p_purge_knowledge_base and cardinality(v_conversation_ids) > 0 then
    delete from ai_chunks
     where organization_id = p_organization_id
       and (metadata->>'conversation_id')::uuid = any (v_conversation_ids);
    get diagnostics v_count = row_count;
  end if;
  v_deleted := v_deleted || jsonb_build_object('ai_chunks', v_count);

  delete from conversations
   where organization_id = p_organization_id and contact_id = p_contact_id;
  get diagnostics v_count = row_count;
  v_deleted := v_deleted || jsonb_build_object('conversations', v_count);

  update contacts
     set context_reset_at = null,
         context_reset_reason = null
   where id = p_contact_id and organization_id = p_organization_id;

  return jsonb_build_object(
    'ok', true,
    'contact_id', p_contact_id,
    'deleted', v_deleted
  );
end;
$$;

revoke execute on function public.fn_hard_reset_contact_context(uuid, uuid, boolean) from public;
revoke execute on function public.fn_hard_reset_contact_context(uuid, uuid, boolean) from anon;
revoke execute on function public.fn_hard_reset_contact_context(uuid, uuid, boolean) from authenticated;
grant execute on function public.fn_hard_reset_contact_context(uuid, uuid, boolean) to service_role;
