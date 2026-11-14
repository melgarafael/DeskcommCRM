-- manifest: **A conexão nova herda a configuração da conversa mais recente do mesmo contato (#4013).** `conversations` é única por `(organization_id, contact_id, channel_session_id)`: quando o mesmo telefone volta por OUTRA conexão (a empresa trocou a API oficial pelo QR, ou abriu uma conexão nova para o mesmo aparelho), cada cliente ganha uma conversa nova — e ela nascia sem agente (`conversations.active_ai_agent_id` nulo), sem regra de distribuição (`channel_routing_policies` só na conexão antiga) e em pré-go-live (`channel_sessions.metadata.ai_gate_mode`, o estado de fábrica). A troca de VENDEDOR já tinha tratamento (`fn_conversa_que_continua`, 9054); a troca de CONEXÃO não tinha. Aqui a conversa que NASCE herda as três peças da conversa mais recente do mesmo contato na MESMA organização, e só o que falta: agente já configurado, conexão com política própria e conexão que saiu do pré-go-live não são tocados. Não funde conversas, não migra histórico, não apaga a antiga, não atribui a ninguém e não mexe na régua de distribuição — herda a configuração dela. A herança do agente também grava o vínculo versão↔número (`ai_agent_version_channels`, 0665), que é o que faz o seletor e o portão do dreno enxergarem a versão publicada na conexão nova. `create or replace` em `fn_upsert_wa_conversation` (mesma aridade) + função nova; sem tabela, coluna, policy ou dado novo; apêndice idempotente no `baseline.sql` ANTES da VARREDURA anon.
-- 9215 — a conexão nova herda agente, regra de distribuição e pré-go-live (#4013)
--
-- Nada aqui cria dono: a conversa nasce sem `assigned_to_user_id`, como hoje. O
-- que se copia é CONFIGURAÇÃO (quem atende pelo número, para quem ele distribui,
-- a IA está liberada?) — não atribuição, não fila, não histórico.
--
-- Idempotente por construção: cada peça só é gravada quando falta na conexão
-- nova (`active_ai_agent_id is null`, sessão sem policy, sessão no estado de
-- fábrica do pré-go-live) e o vínculo versão↔número entra com `on conflict do
-- nothing`. Rodar duas vezes não muda o resultado.

-- ─── a herança, numa função só ────────────────────────────────────────────────
create or replace function public.fn_conexao_nova_herda_configuracao(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_conversa        public.conversations;
  v_origem          public.conversations;
  v_agente          uuid;
  v_versao          uuid;
  v_politica        uuid;
  v_nova_politica   uuid;
  v_meta_nova       jsonb;
  v_meta_origem     jsonb;
  v_heranca         jsonb;
  v_atual           jsonb;
  v_herdou_agente   boolean := false;
  v_herdou_politica boolean := false;
  v_herdou_pre      boolean := false;
begin
  select c.* into v_conversa
    from public.conversations c
   where c.id = p_conversation_id
     and c.organization_id = p_organization_id;

  if not found or v_conversa.is_group then
    return jsonb_build_object('aplicado', false, 'motivo', 'conversa_inexistente_ou_grupo');
  end if;

  -- "A conversa mais recente do mesmo contato": a MESMA busca de
  -- `fn_conversa_que_continua` (mesma organização, mesmo contato, 1:1, ordem por
  -- updated_at desc, id) — trocando "o número do destino" por "qualquer outra
  -- conexão". A organização entra no WHERE, nunca no JOIN: conversa de outra
  -- empresa não é fonte.
  select s.* into v_origem
    from public.conversations s
   where s.organization_id = v_conversa.organization_id
     and s.contact_id = v_conversa.contact_id
     and s.is_group = false
     and s.id <> v_conversa.id
     and s.channel_session_id <> v_conversa.channel_session_id
   order by s.updated_at desc, s.id
   limit 1;

  if not found then
    return jsonb_build_object('aplicado', false, 'motivo', 'sem_conversa_anterior_em_outra_conexao');
  end if;

  -- ─── 1. o agente de IA publicado ───────────────────────────────────────────
  -- Só quando a conexão nova NÃO tem agente próprio: versão publicada apontando
  -- para ela, ou vínculo versão↔número. Conexão já configurada não é sobrescrita.
  if v_conversa.active_ai_agent_id is null
     and not exists (
       select 1
         from public.ai_agents a0
         join public.ai_agent_versions v0
           on v0.organization_id = a0.organization_id and v0.id = a0.published_version_id
        where a0.organization_id = v_conversa.organization_id
          and a0.archived_at is null
          and v0.status = 'published'
          and v0.channel_session_id = v_conversa.channel_session_id
     )
     and not exists (
       select 1
         from public.ai_agent_version_channels ch
        where ch.organization_id = v_conversa.organization_id
          and ch.channel_session_id = v_conversa.channel_session_id
     )
  then
    -- (a) o agente que a conversa de origem estava usando (a stickiness do
    -- roteador), se ainda estiver publicado e não arquivado;
    v_agente := v_origem.active_ai_agent_id;
    if v_agente is not null then
      select a.id, a.published_version_id into v_agente, v_versao
        from public.ai_agents a
        join public.ai_agent_versions v
          on v.organization_id = a.organization_id and v.id = a.published_version_id
       where a.organization_id = v_conversa.organization_id
         and a.id = v_agente
         and a.archived_at is null
         and v.status = 'published'
       limit 1;
      if not found then
        v_agente := null;
        v_versao := null;
      end if;
    end if;

    -- (b) o caso comum: a origem não tem agente grudado, e quem atende o número
    -- dela é a versão PUBLICADA — mesma ordem de desempate do seletor do motor
    -- (`escolherAgenteDoNumero`: no ar antes de pausado, prioridade desc, mais
    -- antigo primeiro).
    if v_agente is null then
      select a.id, v.id into v_agente, v_versao
        from public.ai_agents a
        join public.ai_agent_versions v
          on v.organization_id = a.organization_id and v.id = a.published_version_id
       where a.organization_id = v_conversa.organization_id
         and a.archived_at is null
         and v.status = 'published'
         and v.channel_session_id = v_origem.channel_session_id
       order by (a.paused_at is not null) asc, a.priority desc, a.created_at asc, a.id
       limit 1;
    end if;

    -- Agente arquivado ou sem versão publicada não é herdado: a conversa fica
    -- como hoje (sem agente) em vez de apontar para um agente que não executa.
    if v_agente is not null and v_versao is not null then
      update public.conversations c
         set active_ai_agent_id = v_agente
       where c.id = v_conversa.id
         and c.organization_id = v_conversa.organization_id
         and c.active_ai_agent_id is null;
      -- O vínculo é ADITIVO: a versão passa a atender também a conexão nova e a
      -- antiga segue com o que tinha. É o que faz o seletor do turno e o portão
      -- do dreno enxergarem a versão publicada nesta conexão.
      insert into public.ai_agent_version_channels
        (organization_id, agent_version_id, channel_session_id)
      values
        (v_conversa.organization_id, v_versao, v_conversa.channel_session_id)
      on conflict (agent_version_id, channel_session_id) do nothing;
      v_herdou_agente := true;
    end if;
  end if;

  -- ─── 2. a regra de distribuição ────────────────────────────────────────────
  -- Copia a POLICY (modo de distribuição e destino padrão) e os responsáveis da
  -- conexão de origem. Só a policy: nenhuma conversa é atribuída aqui.
  select p.id into v_politica
    from public.channel_routing_policies p
   where p.organization_id = v_origem.organization_id
     and p.channel_session_id = v_origem.channel_session_id;

  if v_politica is not null
     and not exists (
       select 1
         from public.channel_routing_policies p2
        where p2.organization_id = v_conversa.organization_id
          and p2.channel_session_id = v_conversa.channel_session_id
     )
  then
    insert into public.channel_routing_policies
      (organization_id, channel_session_id, distribution_mode, default_assignee_user_id)
    select p.organization_id,
           v_conversa.channel_session_id,
           p.distribution_mode,
           -- o destino padrão só viaja se ainda for membro ativo (FK da tabela)
           case when exists (
             select 1 from public.user_organizations u
              where u.organization_id = p.organization_id
                and u.user_id = p.default_assignee_user_id
                and u.revoked_at is null
           ) then p.default_assignee_user_id end
      from public.channel_routing_policies p
     where p.organization_id = v_origem.organization_id
       and p.id = v_politica
    on conflict (organization_id, channel_session_id) do nothing
    returning id into v_nova_politica;

    if v_nova_politica is not null then
      insert into public.channel_routing_responsibles (organization_id, policy_id, user_id)
      select r.organization_id, v_nova_politica, r.user_id
        from public.channel_routing_responsibles r
        join public.user_organizations u
          on u.organization_id = r.organization_id
         and u.user_id = r.user_id
         and u.revoked_at is null
       where r.organization_id = v_origem.organization_id
         and r.policy_id = v_politica
      on conflict (policy_id, user_id) do nothing;
      v_herdou_politica := true;
    end if;
  end if;

  -- ─── 3. o estado de pré-go-live ────────────────────────────────────────────
  -- Mora em `channel_sessions.metadata` (`ai_gate` + `ai_gate_mode` +
  -- `ai_test_phone_numbers`), que é o que `decidirElegibilidadeDaConversa` lê.
  -- A conexão nova nasce no estado de fábrica; é só nesse estado que ela herda.
  select coalesce(cs.metadata, '{}'::jsonb) into v_meta_nova
    from public.channel_sessions cs
   where cs.organization_id = v_conversa.organization_id
     and cs.id = v_conversa.channel_session_id;

  select coalesce(cs.metadata, '{}'::jsonb) into v_meta_origem
    from public.channel_sessions cs
   where cs.organization_id = v_origem.organization_id
     and cs.id = v_origem.channel_session_id;

  if v_meta_nova is not null and v_meta_origem is not null then
    v_heranca := jsonb_strip_nulls(jsonb_build_object(
      'ai_gate', v_meta_origem -> 'ai_gate',
      'ai_gate_mode', v_meta_origem -> 'ai_gate_mode',
      'ai_test_phone_numbers',
        case when jsonb_typeof(v_meta_origem -> 'ai_test_phone_numbers') = 'array'
             then v_meta_origem -> 'ai_test_phone_numbers' end
    ));
    v_atual := jsonb_strip_nulls(jsonb_build_object(
      'ai_gate', v_meta_nova -> 'ai_gate',
      'ai_gate_mode', v_meta_nova -> 'ai_gate_mode',
      'ai_test_phone_numbers',
        case when jsonb_typeof(v_meta_nova -> 'ai_test_phone_numbers') = 'array'
             then v_meta_nova -> 'ai_test_phone_numbers' end
    ));

    if v_heranca <> '{}'::jsonb
       and v_heranca is distinct from v_atual
       -- estado de fábrica da conexão nova: pré-go-live, allowlist, lista vazia
       and coalesce(v_meta_nova ->> 'ai_gate', 'allowlist') = 'allowlist'
       and coalesce(v_meta_nova ->> 'ai_gate_mode', 'pre_go_live') = 'pre_go_live'
       and coalesce(
             jsonb_array_length(
               case when jsonb_typeof(v_meta_nova -> 'ai_test_phone_numbers') = 'array'
                    then v_meta_nova -> 'ai_test_phone_numbers' end),
             0) = 0
    then
      update public.channel_sessions cs
         set metadata = coalesce(cs.metadata, '{}'::jsonb) || v_heranca
       where cs.organization_id = v_conversa.organization_id
         and cs.id = v_conversa.channel_session_id;
      v_herdou_pre := true;
    end if;
  end if;

  return jsonb_build_object(
    'aplicado', true,
    'origem_conversation_id', v_origem.id,
    'origem_channel_session_id', v_origem.channel_session_id,
    'agente', v_agente,
    'versao', v_versao,
    'politica', v_nova_politica,
    'herdou_agente', v_herdou_agente,
    'herdou_politica', v_herdou_politica,
    'herdou_pre_go_live', v_herdou_pre
  );
end;
$fn$;

revoke all on function public.fn_conexao_nova_herda_configuracao(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_conexao_nova_herda_configuracao(uuid, uuid)
  to service_role;

comment on function public.fn_conexao_nova_herda_configuracao(uuid, uuid) is
  'A conversa que NASCE numa conexão em que o mesmo contato já tem conversa mais antiga herda dela o agente de IA publicado (conversations.active_ai_agent_id + vínculo versão↔número), a regra de distribuição (channel_routing_policies + responsibles) e o estado de pré-go-live (channel_sessions.metadata.ai_gate/ai_gate_mode/ai_test_phone_numbers) — só o que falta na conexão nova. Não funde conversas, não migra histórico, não atribui a ninguém (#4013).';

-- ─── a entrada chama a herança só quando a conversa NASCE ────────────────────
-- `create or replace` na MESMA aridade: nenhuma chamada muda.
create or replace function public.fn_upsert_wa_conversation(
  p_org uuid, p_contact uuid, p_session uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_criada boolean;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, 'whatsapp', 'open', false, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id, (xmax = 0) into v_id, v_criada;
  -- #4013: só a conversa que NASCE herda. A que já existe foi configurada (ou
  -- não) pelo dono, e mensagem nova não é evento de configuração.
  if coalesce(v_criada, false) then
    perform public.fn_conexao_nova_herda_configuracao(p_org, v_id);
  end if;
  return v_id;
end; $$;

revoke all on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from public;
revoke execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from anon, authenticated;
grant execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) to service_role;
