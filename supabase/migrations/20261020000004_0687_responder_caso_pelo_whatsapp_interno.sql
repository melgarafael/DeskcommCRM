-- manifest: Permite opt-in por organização para responder casos pelo WhatsApp interno e retomar a IA.

alter table public.config_aviso_de_caso
  add column if not exists resposta_whatsapp_habilitada boolean not null default false;

-- A mensagem recebida é idempotente por organização e id de mensagem do canal.
-- O valor fica em metadata, junto do evento que já registra a resposta humana;
-- a cascata LGPD já limpa metadata de agent_case_events.
create unique index if not exists agent_case_events_whatsapp_message_unica
  on public.agent_case_events (organization_id, (metadata->>'whatsapp_message_key'))
  where kind = 'human_replied' and metadata ? 'whatsapp_message_key';

create or replace function public.fn_responder_caso_por_whatsapp(
  p_org uuid,
  p_case uuid,
  p_session uuid,
  p_phone_variants text[],
  p_action text,
  p_body text,
  p_message_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_delivery_id uuid;
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'
  );
begin
  if coalesce(v_role, '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('resolved', 'need_lead_info') then
    raise exception 'invalid_case_reply_action' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'invalid_case_reply_body' using errcode = '22023';
  end if;
  if p_message_key is null or char_length(p_message_key) not between 1 and 300 then
    raise exception 'invalid_case_reply_message_key' using errcode = '22023';
  end if;

  -- Serializa a reentrega do mesmo webhook. Se o mesmo id chegar depois que o
  -- caso for reaberto para uma pergunta nova, continua sendo a mesma resposta.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_message_key, 0));
  if exists (
    select 1 from public.agent_case_events e
     where e.organization_id = p_org
       and e.kind = 'human_replied'
       and e.metadata->>'whatsapp_message_key' = p_message_key
  ) then
    return 'duplicate';
  end if;

  -- O telefone e o canal precisam continuar sendo os configurados agora, e o
  -- caso precisa ter sido efetivamente avisado por essa mesma conexão e destino.
  -- A entrega enviada é a prova que a pessoa recebeu autorização para responder.
  if not exists (
    select 1
      from public.config_aviso_de_caso cfg
     where cfg.organization_id = p_org
       and cfg.ligado = true
       and cfg.resposta_whatsapp_habilitada = true
       and cfg.channel_session_id = p_session
       and cfg.telefone_destino = any(p_phone_variants)
     for update
  ) then
    return 'unauthorized';
  end if;

  select conv.contact_id, entrega.id
    into v_contact_id, v_delivery_id
    from public.agent_cases caso
    join public.conversations conv
      on conv.organization_id = caso.organization_id
     and conv.id = caso.conversation_id
    join public.entregas_de_aviso_de_caso entrega
      on entrega.organization_id = caso.organization_id
     and entrega.case_id = caso.id
   where caso.organization_id = p_org
     and caso.id = p_case
     and caso.status = 'awaiting_human'
     and entrega.status = 'enviado'
     and entrega.channel_session_id = p_session
     and entrega.destino = any(p_phone_variants)
   for update of caso;

  if v_delivery_id is null or v_contact_id is null then
    return 'case_unavailable';
  end if;

  if p_action = 'resolved' then
    update public.agent_cases
       set status = 'resolved', closed_at = now(), updated_at = now()
     where organization_id = p_org and id = p_case and status = 'awaiting_human';
    if not found then return 'case_unavailable'; end if;

    insert into public.agent_case_events
      (organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (p_org, p_case, 'human_replied', 'human', 'resolved', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session)),
      (p_org, p_case, 'resolved', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  else
    update public.agent_cases
       set status = 'awaiting_lead', updated_at = now()
     where organization_id = p_org and id = p_case and status = 'awaiting_human';
    if not found then return 'case_unavailable'; end if;

    insert into public.agent_case_events
      (organization_id, case_id, kind, actor_kind, human_action, body, metadata)
    values
      (p_org, p_case, 'human_replied', 'human', 'need_lead_info', p_body,
       jsonb_build_object('source', 'whatsapp', 'whatsapp_message_key', p_message_key,
                          'channel_session_id', p_session)),
      (p_org, p_case, 'lead_asked', 'human', null, null,
       jsonb_build_object('source', 'whatsapp', 'channel_session_id', p_session));
  end if;

  -- A transição, os eventos e a retomada entram no mesmo commit. Se a fila não
  -- aceitar o job, o webhook pode ser reentregue e nenhum caso fica sem retomada.
  insert into public.job_queue (organization_id, contact_id, kind, payload)
  values (
    p_org,
    v_contact_id,
    'case_reply_turn',
    jsonb_build_object('case_id', p_case, 'action', p_action, 'body', p_body)
  );

  return 'accepted';
end;
$$;

revoke all on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text)
  from public, anon, authenticated;
grant execute on function public.fn_responder_caso_por_whatsapp(uuid, uuid, uuid, text[], text, text, text)
  to service_role;

-- A opção é gravada pela mesma RPC administrativa que protege o restante da
-- configuração de avisos. A coluna e a guarda acima mantêm o opt-in no banco.
create or replace function public.fn_definir_aviso_de_caso(
  p_org uuid,
  p_channel uuid,
  p_telefone text,
  p_rotulo text,
  p_ligado boolean,
  p_confirma_contato boolean default false,
  p_resposta_whatsapp_habilitada boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes public.config_aviso_de_caso;
  v_arch timestamptz;
  v_digitos text;
  v_variantes text[];
begin
  -- Papel + suporte, nesta ordem e na MESMA transação da escrita. `auth.uid()`
  -- nulo é o caminho do service role: quem escreve configuração é gente.
  if auth.uid() is null or p_org is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'aviso_de_caso_forbidden' using errcode = '42501';
  end if;
  -- Quem NÃO tem fator cadastrado passa: a função já trata isso, e é coerente
  -- com a política de MFA opcional deste produto.
  if not public.fn_session_mfa_proven() then
    raise exception 'aviso_de_caso_mfa_required' using errcode = '42501';
  end if;
  if p_telefone is null or p_telefone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'aviso_de_caso_telefone_invalido' using errcode = '22023';
  end if;

  -- O canal é DA organização e não está arquivado. Sem isto a FK simples
  -- deixaria apontar para o canal de outro tenant — a FK composta do padrão
  -- 0228 não serve aqui porque o `on delete set null` anularia também
  -- `organization_id`, que é a chave primária desta tabela.
  if p_channel is not null then
    select archived_at into v_arch
      from public.channel_sessions
     where id = p_channel and organization_id = p_org;
    if not found or v_arch is not null then
      raise exception 'aviso_de_caso_canal_invalido' using errcode = '22023';
    end if;
  end if;

  -- As duas grafias do nono dígito — a MESMA regra de
  -- `lib/channels/phone-variants.ts`. Comparar a string crua deixaria passar o
  -- número do suporte cadastrado com 9 e registrado sem.
  v_digitos := regexp_replace(p_telefone, '\D', '', 'g');
  v_variantes := array[v_digitos];
  if v_digitos like '55%' then
    if length(v_digitos) = 13
       and substring(v_digitos from 5 for 1) = '9'
       and substring(v_digitos from 6 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || substring(v_digitos from 6));
    elsif length(v_digitos) = 12
       and substring(v_digitos from 5 for 1) between '6' and '9' then
      v_variantes := v_variantes || (substring(v_digitos from 1 for 4) || '9' || substring(v_digitos from 5));
    end if;
  end if;

  -- O NÚMERO DE AVISO NÃO PODE SER UM NÚMERO DA PRÓPRIA ORGANIZAÇÃO. É o laço
  -- robô-com-robô: a conexão de avisos manda para o número oficial, o agente
  -- dele responde, e as duas pontas se alimentam sem fim.
  -- A conexão ARQUIVADA fica FORA da conta. Ela não envia nem recebe, então o
  -- laço não acontece por ela — e contá-la bloqueia o número PARA SEMPRE, porque
  -- a conexão que já teve agente publicado não pode ser apagada (as versões a
  -- seguram) e o número nunca mais poderia receber aviso.
  if exists (
       select 1 from public.channel_sessions s
        where s.organization_id = p_org
          and s.archived_at is null
          and s.phone_number is not null
          and regexp_replace(s.phone_number, '\D', '', 'g') = any (v_variantes)) then
    raise exception 'aviso_de_caso_numero_da_propria_org' using errcode = '22023';
  end if;

  -- O número de aviso vira INTERNO: tudo o que chegar dele deixa de virar
  -- contato, conversa, lead e despacho do agente. Se ele já é um CLIENTE desta
  -- organização, as mensagens dessa pessoa param de chegar ao CRM — e isso não
  -- pode acontecer por engano. A tela pergunta e reenvia com `p_confirma_contato`.
  if not coalesce(p_confirma_contato, false) and exists (
       select 1 from public.contacts c
        where c.organization_id = p_org
          and c.phone_number is not null
          and regexp_replace(c.phone_number, '\D', '', 'g') = any (v_variantes)) then
    raise exception 'aviso_de_caso_numero_de_cliente' using errcode = '22023';
  end if;

  select * into v_antes from public.config_aviso_de_caso where organization_id = p_org;

  insert into public.config_aviso_de_caso
    (organization_id, channel_session_id, telefone_destino, rotulo, ligado, resposta_whatsapp_habilitada, criado_por, atualizado_por)
  values
    (p_org, p_channel, p_telefone, nullif(btrim(p_rotulo), ''), coalesce(p_ligado, false), coalesce(p_resposta_whatsapp_habilitada, false), auth.uid(), auth.uid())
  on conflict (organization_id) do update
    set channel_session_id = excluded.channel_session_id,
        telefone_destino   = excluded.telefone_destino,
        rotulo             = excluded.rotulo,
        ligado             = excluded.ligado,
        resposta_whatsapp_habilitada = excluded.resposta_whatsapp_habilitada,
        atualizado_por     = auth.uid(),
        -- Trocou o número, o JID resolvido do anterior não vale mais — e é o
        -- JID que o corte da ingestão usa para reconhecer quem está em modo
        -- privacidade. Mantê-lo faria o corte continuar valendo para o número
        -- ANTIGO, que pode voltar a ser um cliente.
        destino_jid        = case
                               when excluded.telefone_destino is distinct from config_aviso_de_caso.telefone_destino
                               then null
                               else config_aviso_de_caso.destino_jid
                             end,
        updated_at         = now();

  return jsonb_build_object(
    'trocou_numero', (v_antes.telefone_destino is distinct from p_telefone),
    'antes_ligado',  coalesce(v_antes.ligado, false)
  );
end;
$$;
revoke all on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean) from public, anon;
grant execute on function public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean,boolean) to authenticated;
drop function if exists public.fn_definir_aviso_de_caso(uuid,uuid,text,text,boolean,boolean);
