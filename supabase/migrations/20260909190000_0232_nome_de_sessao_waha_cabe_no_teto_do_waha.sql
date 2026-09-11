-- ============================================================================
-- 0232 — O NOME DA SESSÃO WAHA ESTOURA O TETO QUE O WAHA IMPÕE
--
-- `fn_reserve_channel_connection` (nasceu na 0228, forward-fix na 0230) gera o
-- `waha_session_name` de canal novo como:
--
--   'org_' || replace(p_org::text,'-','') || '_' || replace(gen_random_uuid()::text,'-','')
--   = 'org_' (4) + uuid da org sem hífen (32) + '_' (1) + uuid aleatório sem hífen (32)
--   = 69 caracteres
--
-- O `devlikeapro/waha:latest-2026.7.2` (o pino do `docker-compose.prod.yml` e o
-- que a doutrina fixa) valida `POST /api/sessions` com `@MaxLength(54)` no campo
-- `name`. A resposta é literal:
--
--   400 {"message":["name must be shorter than or equal to 54 characters"],
--        "error":"Bad Request","statusCode":400}
--
-- Ou seja: NENHUM canal WAHA novo consegue ser criado numa instalação que roda
-- um WAHA de verdade. O sintoma na tela é `waha_create_400` ("Falha na
-- comunicação com o WhatsApp") ao Conectar um número ou ao Reconectar — e o
-- canal fica preso em FAILED/STOPPED com `connection_repair_required`. O
-- `stop`/`get`/`restart` que o fluxo de Reconectar tenta antes nem chega a
-- importar: não há sessão do lado do WAHA para reiniciar, porque o `create`
-- morre na validação de tamanho.
--
-- Não foi pego porque o `connect-waha.test.ts` e os e2e de pré-go-live usam um
-- `Transport` falso — a validação de tamanho só existe contra um WAHA real.
--
-- ─── O conserto: encurtar o prefixo da org para 8, como o resto do código já
--     esperava ────────────────────────────────────────────────────────────────
--
-- A MESMA função, duas linhas acima do INSERT, procura o canal de onboarding
-- por `waha_session_name = 'org_' || left(p_org::text,8)` — o formato curto
-- `org_<8>` que já produzia `org_11db0f22` e que o WAHA aceita (12 caracteres).
-- O INSERT é que divergiu. Alinhando os dois:
--
--   'org_' || left(replace(p_org::text,'-',''),8) || '_' || replace(gen_random_uuid()::text,'-','')
--   = 'org_' (4) + 8 + '_' (1) + 32 = 45 caracteres  ≤ 54 ✓
--
-- Mantém os 128 bits de aleatoriedade do sufixo (a UNIQUE de `waha_session_name`
-- continua garantida com folga) e não toca em `metadataInicialDoCanal` nem no
-- resto do corpo — só a expressão do nome muda.
--
-- ─── Reparo dos canais já quebrados (auto-curativo, genérico, conservador) ──
--
-- Toda linha `provider='waha'` cujo nome passou de 54 e que NUNCA pareou
-- (`phone_number is null`) e não está WORKING recebe um nome novo no formato
-- curto. São canais que o WAHA nunca aceitou — renomear não pode quebrar uma
-- sessão que não existe lá fora. Canal WORKING ou já pareado NÃO é tocado (não
-- há nenhum com nome > 54 nesse estado, por construção — o create falhava
-- antes de qualquer pareamento — mas a guarda fica explícita).
-- ============================================================================

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
 -- Não ressuscita antes da pós-condição remota. Arquivado permanece invisível
 -- até finish; falha conserva identidade e estado FAILED para reparo.
 update public.channel_sessions set status='STARTING',status_reason='connection_pending',last_status_change_at=now()
  where organization_id=p_org and id=channel.id returning * into channel;
 return jsonb_build_object('replay',false,'channel',to_jsonb(channel),'receipt_id',receipt.id,'lease_token',token);
end;
$$;
revoke all on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) from public,anon;
grant execute on function public.fn_reserve_channel_connection(uuid,uuid,text,text,boolean) to authenticated;

-- Reparo dos nomes já gravados fora do teto — só canais WAHA que nunca pararam de pé.
update public.channel_sessions
   set waha_session_name = 'org_'||left(replace(organization_id::text,'-',''),8)||'_'||replace(gen_random_uuid()::text,'-',''),
       updated_at = now()
 where provider = 'waha'
   and waha_session_name is not null
   and length(waha_session_name) > 54
   and phone_number is null
   and status <> 'WORKING';

notify pgrst,'reload schema';
