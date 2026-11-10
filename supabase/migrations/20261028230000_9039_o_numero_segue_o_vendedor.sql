-- manifest: o número de WhatsApp acompanha o dono da conversa — transferir (ou passar a carteira) leva a conversa para a sessão do novo vendedor; a carteira não tira da IA a conversa que ela atende; a decisão do número mora em fn_numero_da_transferencia, consultada também pelo aviso do diálogo de Transferir (#3642, doc 237).
--
-- 9039 — o número de WhatsApp segue o vendedor (#3642).
--
-- ─── O defeito (medido) ─────────────────────────────────────────────────────
--
-- Numa empresa com um número por vendedor (`channel_sessions` + uma policy em
-- `channel_routing_policies` por número + os donos em
-- `channel_routing_responsibles`), trocar o dono da conversa
-- (`fn_conversation_assign`, chamada por Transferir, Assumir, lote, MCP e pela
-- automação) mudava só `assigned_to_user_id`. A conversa continuava com o
-- `channel_session_id` do vendedor ANTERIOR, e o envio humano sai pela sessão da
-- CONVERSA (`app/api/v1/messages/_handler.ts`, `channel_session_id` do select +
-- `resolveSessionRef(c.channel_sessions)`): o vendedor novo respondia pelo
-- WhatsApp do colega, o cliente recebia a resposta no número do antigo, e o
-- antigo continuava recebendo as respostas no celular dele.
--
-- ─── A regra ────────────────────────────────────────────────────────────────
--
-- O número acompanha o dono da conversa. Quando o novo dono é responsável por um
-- número CONECTADO (`status = 'WORKING'`, não arquivado, não desativado), a
-- conversa passa para esse número na MESMA transação da troca de dono — é a
-- porta única de escrita da atribuição, então a regra vale para todos os
-- caminhos de troca de uma vez (Transferir um e em lote, Assumir, MCP,
-- automação, passagem de carteira) sem nenhum deles precisar sabê-la.
--
-- Os controles, em que nada muda (regra inteira em `fn_numero_da_transferencia`,
-- a mesma que o diálogo de Transferir consulta para avisar antes):
--   * o novo dono JÁ responde pelo número da conversa (número compartilhado por
--     vários responsáveis);
--   * o número atual não é de ninguém (sem policy, ou policy sem responsáveis):
--     o número geral da empresa não vira o número de um vendedor;
--   * o novo dono não tem número conectado do MESMO canal (a transferência não
--     falha; o envio humano segue como hoje — doc 237, escolha 1-B);
--   * conversa de grupo;
--   * o contato já tem conversa no número novo.
--
-- `provider_conversation_id` é zerado junto, quando o número troca: é o id da
-- thread no provider ANTERIOR, e mandá-lo para a sessão nova seria endereçar uma
-- thread que ela nunca viu.
--
-- ─── A carteira ─────────────────────────────────────────────────────────────
--
-- Trocar a carteira do cliente (`fn_definir_carteira_do_cliente`) trocava o dono
-- do contato e dos negócios e deixava as conversas abertas com o vendedor
-- anterior — o mesmo defeito, pela outra porta. Agora a carteira passa as
-- conversas abertas do contato que estavam com o dono anterior (ou sem dono) ao
-- novo dono PELA MESMA função de atribuição, com `reason = 'transfer'`: a
-- conversa, o evento na linha do tempo e o número andam juntos. As que a IA
-- está atendendo (`comando_da_conversa = 'automatico'`, inclusive a `open` sem
-- dono, que é o caso comum) ficam com a IA (doc 237, escolha 3-B).
--
-- ─── Baseline ───────────────────────────────────────────────────────────────
--
-- Os dois corpos entram por EDIÇÃO NO LUGAR nas últimas definições do
-- `supabase/baseline.sql` (o mesmo desenho das 0426/0513): são `create or
-- replace` de funções que já existem. A função nova
-- (`fn_numero_da_transferencia`) entra no apêndice logo antes da última
-- `fn_conversation_assign`, que a chama — e antes da VARREDURA anon.

-- ---- o número da transferência (migration 9039, #3642) ----
-- Para qual número a conversa vai quando muda de dono. Nulo = o número fica.
-- Uma função só para a decisão, porque DUAS peças precisam da mesma resposta:
-- `fn_conversation_assign` (que aplica) e o diálogo de Transferir (que avisa
-- antes — `GET /api/v1/conversations/[id]/transfer`). Duas cópias da regra
-- divergiriam, e o aviso diria um número enquanto a troca grava outro.
--
-- A regra, em ordem:
--   * o número ATUAL é de pessoas (policy com ao menos um responsável) e o dono
--     novo não é um deles — número sem dono (o número geral da empresa) e número
--     compartilhado em que o dono novo já está não mudam;
--   * o dono novo responde por um número CONECTADO (`WORKING`, não arquivado,
--     não desativado) do MESMO canal (`provider`) — uma conversa de rede social
--     não vira WhatsApp, nem o contrário;
--   * conversa de grupo não muda: o grupo existe no telefone de quem está nele;
--   * o primeiro desses números, em ordem estável;
--   * e o contato ainda não tem conversa nesse número
--     (`uniq_conversations_1to1_per_contact_session`, 0027): re-apontar estouraria
--     a transação e a transferência falharia — o dono muda e o número não.
--
-- Sem `security definer`: quem chama é a `fn_conversation_assign` (definer, roda
-- como dona) e a rota pelo cliente admin. Ninguém mais precisa dela.
create or replace function public.fn_numero_da_transferencia(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  with conversa as (
    select c.id, c.organization_id, c.contact_id, c.channel_session_id, atual.provider
      from public.conversations c
      join public.channel_sessions atual
        on atual.organization_id = c.organization_id and atual.id = c.channel_session_id
     where c.id = p_conversation_id
       and c.organization_id = p_organization_id
       and c.is_group = false
       and p_to_user_id is not null
  ),
  responsaveis_do_atual as (
    select r.user_id
      from conversa
      join public.channel_routing_policies p
        on p.organization_id = conversa.organization_id
       and p.channel_session_id = conversa.channel_session_id
      join public.channel_routing_responsibles r
        on r.organization_id = p.organization_id and r.policy_id = p.id
  ),
  candidato as (
    select cs.id
      from conversa
      join public.channel_routing_responsibles r
        on r.organization_id = conversa.organization_id and r.user_id = p_to_user_id
      join public.channel_routing_policies p
        on p.organization_id = r.organization_id and p.id = r.policy_id
      join public.channel_sessions cs
        on cs.organization_id = p.organization_id and cs.id = p.channel_session_id
     where exists (select 1 from responsaveis_do_atual)
       and not exists (select 1 from responsaveis_do_atual a where a.user_id = p_to_user_id)
       and cs.provider = conversa.provider
       and cs.archived_at is null
       and cs.status = 'WORKING'
       and coalesce(cs.metadata ->> 'disabled', 'false') <> 'true'
     order by cs.created_at, cs.id
     limit 1
  )
  select candidato.id
    from candidato, conversa
   where not exists (
     select 1
       from public.conversations o
      where o.organization_id = conversa.organization_id
        and o.contact_id = conversa.contact_id
        and o.channel_session_id = candidato.id
        and o.is_group = false
        and o.id <> conversa.id
   );
$$;

revoke execute on function public.fn_numero_da_transferencia(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_numero_da_transferencia(uuid, uuid, uuid)
  to service_role;

CREATE OR REPLACE FUNCTION public.fn_conversation_assign(p_organization_id uuid, p_conversation_id uuid, p_to_user_id uuid, p_reason text, p_expected_assignee uuid DEFAULT NULL::uuid, p_enforce_expected boolean DEFAULT false)
 RETURNS SETOF conversations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
  v_numero uuid;
  v_trocou_de_numero boolean := false;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  if p_to_user_id is not null then
    if coalesce(public.fn_member_role_in_org(p_to_user_id, p_organization_id), 'none')
         not in ('agent','manager','admin') then
      raise exception 'assignee_not_eligible_member'
        using hint = 'target must be an active agent+ member of the organization';
    end if;
  end if;

  -- Conversa fora da visibilidade de quem chama responde como conversa
  -- inexistente (zero linhas). A regra fica no WHERE, com o dono da própria
  -- linha (reavaliado na versão nova se houver espera), nunca um valor do
  -- corpo. Service role (sem auth.uid) segue.
  --
  -- A EXCEÇÃO DA #3479: conversa SEM dono pode ser assumida por quem assume
  -- para si. Sem ela o modo "Só os seus" se morde: a conversa que nasceu do
  -- cadastro do contato tem dono nulo, o predicado do modo responde "não vejo"
  -- para dono nulo, e o claim — a operação que daria dono a ela — era recusado,
  -- com a tela dizendo "está com outro atendente" sobre uma conversa de
  -- ninguém. O termo se limita sozinho: exige dono nulo E dono novo =
  -- chamador, então conversa de colega (o caso que a 0685 protege), a
  -- transferência para terceiro e o release continuam respondendo zero linhas
  -- exatamente como antes.
  select * into v_conv
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and (
       auth.uid() is null
       or public.fn_can_view_conversation(organization_id, assigned_to_user_id)
       or (assigned_to_user_id is null and p_to_user_id = auth.uid()
           and p_reason = 'claim' and p_enforce_expected)
     )
   for no key update;

  if not found then
    return;
  end if;

  v_from := v_conv.assigned_to_user_id;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  -- ─── #3642: o número segue o vendedor ──────────────────────────────────────
  -- Numa empresa com um número por vendedor (`channel_routing_policies` +
  -- `channel_routing_responsibles`), a troca de dono mudava só o dono: a
  -- conversa continuava no `channel_session_id` do vendedor ANTERIOR e o envio
  -- (que sai pela sessão da conversa) fazia o vendedor novo responder pelo
  -- WhatsApp do colega. Aqui a conversa passa para o número conectado do dono
  -- novo, na MESMA transação — e como esta é a porta única da atribuição, a
  -- regra vale para Transferir (um e em lote), Assumir, MCP, automação e a
  -- passagem de carteira sem nenhum deles precisar conhecê-la.
  --
  -- QUAL número é a `fn_numero_da_transferencia` — a mesma que o diálogo de
  -- Transferir consulta para avisar antes de confirmar, então o aviso e o efeito
  -- não divergem. Nulo = o número fica (número compartilhado, número sem dono,
  -- dono novo sem número conectado do mesmo canal, grupo, ou o contato já tem
  -- conversa no número novo). A transferência nunca falha por causa do número.
  v_numero := public.fn_numero_da_transferencia(p_organization_id, p_conversation_id, p_to_user_id);
  v_trocou_de_numero := v_numero is not null;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         -- Desnormalizado JUNTO com o dono, na mesma transação: nunca existe
         -- uma janela em que id e nome discordam. NULL junto com o id quando
         -- a atribuição é removida (release) — nunca sobra um nome órfão de
         -- dono nenhum. Lido de auth.users porque quem chama esta função
         -- (RPC) não necessariamente tem acesso ao Admin API — a definer
         -- resolve por dentro.
         assigned_to_user_name = case
           when p_to_user_id is null then null
           else (select raw_user_meta_data ->> 'full_name' from auth.users where id = p_to_user_id)
         end,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         -- #3642: o número acompanha o dono, e a thread do provider ANTERIOR não
         -- viaja — ela pertence ao número antigo.
         channel_session_id = case when v_trocou_de_numero then v_numero
                                   else channel_session_id end,
         provider_conversation_id = case when v_trocou_de_numero then null
                                         else provider_conversation_id end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$function$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

drop function if exists public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, text);

create or replace function public.fn_definir_carteira_do_cliente(
  p_org uuid,
  p_actor uuid,
  p_contact uuid,
  p_dono uuid,
  p_origem text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := p_actor;
  v_papel text;
  v_dono_papel text;
  v_contato_org uuid;
  v_origem text := coalesce(p_origem, 'manual');
  v_anterior uuid;
  v_conversa uuid;
begin
  if v_ator is null then
    raise exception 'carteira_sem_ator' using errcode = '42501';
  end if;
  if p_org is null or p_contact is null then
    raise exception 'carteira_parametro_invalido' using errcode = '22023';
  end if;
  if v_origem not in ('manual', 'importacao', 'atribuicao_automatica') then
    raise exception 'carteira_origem_invalida' using errcode = '22023';
  end if;

  -- Quem muda: manager+ da MESMA organização (e membro aceito, não revogado).
  select uo.role into v_papel
    from public.user_organizations uo
   where uo.user_id = v_ator
     and uo.organization_id = p_org
     and uo.accepted_at is not null
     and uo.revoked_at is null;
  if v_papel is null or v_papel not in ('manager', 'admin') then
    raise exception 'carteira_permissao_negada'
      using errcode = '42501',
            detail = 'Só manager e admin definem a carteira do cliente.';
  end if;

  select c.organization_id, c.carteira_user_id into v_contato_org, v_anterior
    from public.contacts c
   where c.id = p_contact;
  if v_contato_org is null then
    raise exception 'carteira_contato_nao_encontrado' using errcode = '22023';
  end if;
  if v_contato_org <> p_org then
    raise exception 'carteira_contato_de_outra_organizacao' using errcode = '42501';
  end if;

  if p_dono is not null then
    -- Quem CONTA: membro ativo da mesma org com papel de trabalho. `viewer` e
    -- membro revogado não contam — o cliente volta ao fluxo normal.
    select uo.role into v_dono_papel
      from public.user_organizations uo
     where uo.user_id = p_dono
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_dono_papel is null or v_dono_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_dono_invalido'
        using errcode = '22023',
              detail = 'O dono precisa ser membro ativo da mesma organização com papel agent, manager ou admin.';
    end if;
  end if;

  update public.contacts
     set carteira_user_id = p_dono,
         carteira_origem = case when p_dono is null then null else v_origem end,
         carteira_definida_em = case when p_dono is null then null else now() end,
         updated_at = now()
   where id = p_contact
     and organization_id = p_org;

  -- Os negócios ABERTOS sem dono do contato vão para o dono da carteira; os que
  -- já têm dono não mudam (ninguém perde carteira por causa de uma carteira).
  if p_dono is not null then
    update public.crm_leads
       set owner_user_id = p_dono,
           owner_kind = 'user',
           assigned_at = coalesce(assigned_at, now())
     where organization_id = p_org
       and contact_id = p_contact
       and status = 'open'
       and owner_user_id is null
       and owner_agent_id is null;

    -- ─── #3642: a carteira leva as conversas abertas ─────────────────────────
    -- Só as que estavam com o dono ANTERIOR da carteira (ou sem dono): conversa
    -- que já é de outra pessoa não é roubada por uma troca de carteira. Passa
    -- pela MESMA porta da transferência, então a conversa, o evento na linha do
    -- tempo e o número do vendedor andam juntos — e `reason` fica no vocabulário
    -- fechado da tabela de eventos ('transfer').
    if p_dono is distinct from v_anterior then
      for v_conversa in
        select c.id
          from public.conversations c
         where c.organization_id = p_org
           and c.contact_id = p_contact
           and c.status in ('open', 'pending', 'claimed', 'ai_handling')
           and (c.assigned_to_user_id is null or c.assigned_to_user_id = v_anterior)
           -- Doc 237, escolha 3-B: a conversa que a IA está atendendo fica com a
           -- IA. Quem diz isso é `comando_da_conversa` (a mesma regra da tela e
           -- do motor), não o status: a IA atende conversa `open` sem dono, e
           -- `ai_handling` quase não é escrito. Passá-la aqui a deixaria
           -- "assumida" e a IA calada sem prazo. Quando a IA passar a conversa
           -- para humano, o dono da carteira já é o vendedor novo.
           and public.comando_da_conversa(c) <> 'automatico'
         order by c.id
      loop
        perform public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer');
      end loop;
    end if;
  end if;

  return p_dono;
end;
$$;

revoke execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  to service_role;
