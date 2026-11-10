-- manifest: Reconectar uma conexão que morreu sem número volta a conferir a vaga de números do plano, como conectar um número novo já conferia (complemento da 0809, #3416).
-- 9036 — REVIVER UMA CONEXÃO SEM NÚMERO RESPEITA A VAGA DO PLANO.
--
-- A 0809 tirou da contagem a linha MORTA e SEM NÚMERO (`FAILED`/`STOPPED`,
-- `phone_number` nulo): ela não ocupa vaga. Só que a vaga é conferida na
-- CRIAÇÃO da linha (`fn_trava_canais_do_plano`), e há dois caminhos que trazem
-- uma linha morta de volta sem criar nada — só trocam o `status`:
--
--   · o "Reconectar" (`app/api/v1/channel-sessions/[id]/reconnect/route.ts`);
--   · os ramos de REUSO de `fn_reserve_channel_connection` (a linha de
--     onboarding que já existe e o recibo que é retomado).
--
-- A regra fica inteira quando a conferência acompanha também esses dois
-- caminhos: a linha que deixou de ocupar só volta a ocupar se houver vaga.
--
-- `fn_vaga_ao_reviver_canal(org, canal)` é o único lugar dessa conferência. Ela
-- segura a MESMA trava consultiva da reserva e do gatilho (chave 2281), conta
-- com a régua da 0809 e, havendo vaga, já TOMA a vaga (status `STARTING`) sob a
-- mesma trava: conferir e tomar são um passo só.
-- Sem vaga: PT402 `limite_do_plano:canais:<teto>`, o contrato que
-- `lib/cobranca/limites.ts` traduz para 409 `plan_limit_reached`.
--
-- O que NÃO muda: número pareado (`FAILED` inclusive) e conexão em curso não
-- passam pela conferência — reconectar um número que já é da empresa nunca é
-- recusado, mesmo acima do teto. O gatilho NÃO passa a observar `status`: o
-- espelho do webhook não pode virar PT402 no meio de uma reconexão já pareada
-- (é o motivo escrito na 0809). A conferência mora em quem DECIDE reviver.
--
-- `fn_reserve_channel_connection` é o corpo da 0233 com UMA linha a mais, antes
-- do `update ... set status='STARTING'`. Grants iguais aos dela.
-- Gate: `tests/invariants/cobranca-canais-reviver-respeita-vaga.test.ts`.
-- Idempotente: `create or replace`. Sem BEGIN/COMMIT.

create or replace function public.fn_vaga_ao_reviver_canal(p_org uuid, p_canal uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canal public.channel_sessions;
  v_limite integer;
  v_em_uso integer;
begin
  -- A MESMA trava de `fn_trava_canais_do_plano` e da reserva: contagem e
  -- tomada da vaga nunca correm em paralelo com outra conexão da empresa.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 2281));

  select * into v_canal
    from public.channel_sessions
   where organization_id = p_org and id = p_canal
   for update;

  -- Só interessa a linha que hoje NÃO ocupa vaga (WAHA morta e sem número, 0809) e
  -- vai voltar a ocupar. Número pareado, conexão em curso, arquivada e voz
  -- seguem como antes: reconectar um número que já é da empresa nunca é recusado.
  if not found
     or v_canal.archived_at is not null
     or v_canal.provider <> 'waha'
     or v_canal.phone_number is not null
     or v_canal.status not in ('FAILED', 'STOPPED') then
    return;
  end if;

  v_limite := public.fn_limite_do_plano(p_org, 'canais');
  if v_limite is not null then
    select count(*) into v_em_uso
      from public.channel_sessions cs
     where cs.organization_id = p_org
       and cs.archived_at is null
       and cs.provider <> 'wacalls'
       and (cs.provider <> 'waha' or cs.phone_number is not null or cs.status not in ('FAILED', 'STOPPED'))
       and cs.id <> p_canal;

    if v_em_uso >= v_limite then
      raise exception 'limite_do_plano:canais:%', v_limite
        using errcode = 'PT402',
              detail = jsonb_build_object('recurso', 'canais', 'limite', v_limite, 'em_uso', v_em_uso)::text;
    end if;
  end if;

  -- A vaga é TOMADA aqui, ainda dentro da trava: a linha passa a ser conexão
  -- em curso, que ocupa. Conferir e tomar são um passo só.
  update public.channel_sessions
     set status = 'STARTING',
         status_reason = 'connection_pending',
         last_status_change_at = now()
   where organization_id = p_org and id = p_canal;
end;
$$;

revoke execute on function public.fn_vaga_ao_reviver_canal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_vaga_ao_reviver_canal(uuid, uuid) to service_role;

create or replace function public.fn_reserve_channel_connection(p_org uuid,p_key uuid,p_hash text,p_display_name text default null,p_onboarding boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receipt public.channel_connection_requests; channel public.channel_sessions; token uuid:=gen_random_uuid();
begin
 if auth.uid() is null or not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)
 then raise exception 'connection_forbidden' using errcode='42501';end if;
 if not public.fn_session_mfa_proven() then raise exception 'connection_mfa_required' using errcode='42501';end if;
 if p_key is null or p_hash is null or length(p_hash)<>64 or length(coalesce(p_display_name,''))>100 then
  raise exception 'connection_invalid_request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,2281));
 delete from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key
  and state='succeeded' and updated_at<now()-interval '24 hours';
 select * into receipt from public.channel_connection_requests where organization_id=p_org and idempotency_key=p_key for update;
 if found then
  if receipt.request_hash<>p_hash then raise exception 'idempotency_conflict' using errcode='22023';end if;
  if receipt.state='succeeded' then
   select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id;
   return jsonb_build_object('replay',true,'channel',to_jsonb(channel),'receipt_id',receipt.id);
  end if;
  if receipt.state='processing' and receipt.lease_until>now() then
   raise exception 'connection_in_progress' using errcode='55P03';end if;
  select * into channel from public.channel_sessions where organization_id=p_org and id=receipt.channel_session_id for update;
  if not found then raise exception 'connection_reservation_missing' using errcode='P0002';end if;
 else
  if p_onboarding then
   select * into channel from public.channel_sessions where organization_id=p_org and provider='waha'
    and (metadata->>'onboarding'='true' or waha_session_name='org_'||left(p_org::text,8))
    order by created_at limit 1 for update;
  end if;
  if channel.id is null then
   insert into public.channel_sessions(organization_id,waha_session_name,display_name,engine,webhook_path_token,
     webhook_secret_encrypted,status,last_status_change_at,consecutive_health_fails,daily_message_limit,metadata)
   values(p_org,'org_'||left(replace(p_org::text,'-',''),8)||'_'||replace(gen_random_uuid()::text,'-',''),p_display_name,'NOWEB',
     replace(gen_random_uuid()::text,'-',''),'\x00'::bytea,'STARTING',now(),0,250,
     '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
     || case when p_onboarding then '{"onboarding":true}'::jsonb else '{}'::jsonb end) returning * into channel;
  end if;
  if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
    and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
  insert into public.channel_connection_requests(organization_id,idempotency_key,request_hash,channel_session_id)
   values(p_org,p_key,p_hash,channel.id) returning * into receipt;
 end if;
 if exists(select 1 from public.channel_connection_requests where organization_id=p_org and channel_session_id=channel.id
   and id<>receipt.id and (state='processing' and lease_until>now())) then raise exception 'connection_in_progress' using errcode='55P03';end if;
 update public.channel_connection_requests set state='processing',lease_token=token,lease_until=now()+interval '5 minutes',
  remote_created=false,updated_at=now() where organization_id=p_org and id=receipt.id;
 -- 9036: reviver a linha morta e sem número volta a ocupar a vaga do plano.
 perform public.fn_vaga_ao_reviver_canal(p_org,channel.id);
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;
revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;

notify pgrst, 'reload schema';
