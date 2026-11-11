-- manifest: A atribuição pedida pelo PRÓPRIO turno autônomo deixa de revogar esse turno; o Assumir de uma pessoa continua revogando (issue #3926).
--
-- 9103 — "eu atribuí" deixou de ser lido como "alguém assumiu".
--
-- ─── O defeito, medido (issue #3926) ────────────────────────────────────────
--
-- Agente nativo publicado com o prompt pedindo, na mesma resposta: mensagem ao
-- cliente, mover o card de etapa, `request_human_handoff` e
-- `crm_assign_conversation`. Em produção a mensagem saía, a conversa aparecia
-- em "Minhas" do atendente — e NÃO nascia o cartão "Por que a IA passou para
-- você" nem a etapa mudava.
--
-- A cadeia: `crm_assign_conversation` chama `fn_conversation_assign` com
-- `reason` default 'transfer'; o INSERT em `conversation_assignment_events`
-- dispara `trg_interromper_turnos_ao_assumir`, que trata `claim` E `transfer`
-- como "uma pessoa assumiu" e marca como `failed`
-- (`conversation_command_taken`) todo `inbound_turn`/`case_reply_turn` vivo
-- daquela conversa — INCLUSIVE o turno que acabou de pedir a atribuição. A
-- partir daí `requireCurrentAutonomousTurn` (`lib/atendimento/fronteira-server.ts`)
-- recusa cada efeito seguinte com `StaleServiceBoundaryError`: a passagem
-- (`performHumanHandoff`) e a mudança de etapa morrem sem rastro visível.
--
-- A ordem no prompt NÃO protege: as chamadas de ferramenta da mesma etapa do
-- modelo rodam em paralelo no AI SDK, então a atribuição pode confirmar antes
-- da passagem — e o efeito é o mesmo.
--
-- ─── A decisão: o fato ganha DE QUEM veio ───────────────────────────────────
--
-- O gatilho não é afrouxado: ele existe para quando uma PESSOA assume e o
-- agente tem de parar. O que faltava era o fato carregar a origem. Agora:
--
-- · `fn_conversation_assign` aceita `p_source_job_id` (7º parâmetro, default
--   nulo) e o grava em `conversation_assignment_events.source_job_id`;
-- · `fn_interromper_turnos_ao_assumir` revoga todos os turnos da conversa
--   EXCETO aquele job (`j.id is distinct from new.source_job_id`), que é o
--   único que pediu a atribuição;
-- · `p_source_job_id` só é aceito de chamador de RUNTIME (`auth.uid()` nulo).
--   Sessão de pessoa que passe o parâmetro recebe
--   `source_job_requires_runtime_caller` — assim ninguém desliga a proteção
--   passando o id do job que está rodando. Na prática o valor vem de
--   `McpContext.sourceJobId`, que o runtime injeta e o modelo NÃO escreve.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- · `claim` e `transfer` de uma pessoa continuam revogando o turno autônomo —
--   é a proteção que o gatilho existe para dar, e o caminho humano não passa
--   `p_source_job_id`;
-- · `reason` 'routing' e 'handoff' continuam não interrompendo nada, como antes;
-- · vocabulário de `reason` intacto (nenhum valor novo);
-- · corpo da função de atribuição intacto FORA do que a issue pede: guarda de
--   suporte, papel, elegibilidade do destino, visibilidade (0685/9017),
--   número que segue o vendedor (9039) e a conversa que continua (9054)
--   seguem byte a byte — a única diferença é o parâmetro novo, a origem
--   gravada no evento e a recusa de sessão de pessoa;
-- · grants: a função de 6 argumentos é derrubada porque assinatura nova com
--   default cria SOBRECARGA (`function ... is not unique` em toda chamada de 6
--   argumentos); a de 7 nasce com os mesmos grants de antes.

alter table public.conversation_assignment_events
  add column if not exists source_job_id uuid;

comment on column public.conversation_assignment_events.source_job_id is
  'Job do turno autônomo que PEDIU a atribuição (issue #3926), gravado por fn_conversation_assign a partir do p_source_job_id do runtime. Nulo em toda atribuição feita por pessoa ou por rota que não é turno (claim do Inbox, roteamento, automação). É o que faz fn_interromper_turnos_ao_assumir poupar o próprio turno que atribuiu, sem poupar mais ninguém: qualquer outro turno da conversa continua sendo revogado.';

-- Assinatura nova = função NOVA: sem o drop, a de 6 argumentos sobrevive como
-- sobrecarga e TODO chamador de 6 argumentos (Inbox, roteamento, automação,
-- testes) passa a receber "function ... is not unique".
drop function if exists public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean);

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false,
  p_source_job_id uuid default null
)
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
  v_continua uuid;
begin
  if not public.fn_support_write_allowed(p_organization_id) then raise exception 'support_readonly' using errcode='42501'; end if;
  -- #3926 — `p_source_job_id` é do RUNTIME (o turno que está executando),
  -- nunca de uma sessão de pessoa: recusar em vez de ignorar, porque ignorar
  -- em silêncio deixaria a atribuição de uma pessoa passando com o turno
  -- revogado sem ninguém saber por quê.
  if p_source_job_id is not null and auth.uid() is not null then
    raise exception 'source_job_requires_runtime_caller'
      using hint = 'p_source_job_id is set by the agent runtime, never by a user session';
  end if;
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

  -- ─── #3732: e quando o número NÃO pode seguir ──────────────────────────────
  -- O caso que a 9039 deixou em pé: o contato já tem conversa no número do dono
  -- novo, então o número fica, e a conversa ficava presa com o dono novo num
  -- número que não é dele (envio em 409, "transfira para você" — já feito).
  --
  -- A conversa que está NESSE número passa para o dono novo quando estava sem
  -- dono ou com o dono ANTERIOR: é a metade que faltava para ele ter onde
  -- responder. Conversa que já é de uma TERCEIRA pessoa não é tomada — quem a
  -- assumiu no meio continua com ela, e o aviso do envio diz o nome dele. A
  -- adoção passa por esta mesma função, então o evento da linha do tempo e o
  -- resto vão junto.
  if not v_trocou_de_numero and p_to_user_id is not null then
    select o.id into v_continua
      from public.conversations o
     where o.id = public.fn_conversa_que_continua(
             p_organization_id, p_conversation_id, p_to_user_id)
       and (o.assigned_to_user_id is null
            or o.assigned_to_user_id is not distinct from v_from)
       and o.assigned_to_user_id is distinct from p_to_user_id
       -- Doc 237, escolha 3-B: a conversa que a IA está atendendo fica com a
       -- IA. Sem esta condição, conversa sem dono e com a IA ativa era adotada
       -- e calada sem prazo (`bot_silenced_until = 'infinity'`), inclusive por
       -- tabela numa troca de carteira, que pula essa conversa de propósito.
       and public.comando_da_conversa(o) <> 'automatico';
  end if;

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
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason, source_job_id)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason, p_source_job_id);

  -- #3732: a conversa que continua no número do dono novo vai junto (depois do
  -- evento da conversa transferida, para a linha do tempo contar na ordem).
  if v_continua is not null then
    perform public.fn_conversation_assign(
      p_organization_id, v_continua, p_to_user_id, 'transfer', null, false, p_source_job_id);
  end if;

  return next v_conv;
end;
$function$;

revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid)
  to authenticated, service_role;

-- O gatilho da 0594 ganha UMA exceção: o job que pediu a atribuição. O resto
-- da regra (quem é assumir, o dono real na mesma organização, o fato terminal
-- em event_log, os tipos que não têm dono autônomo) fica idêntico.
create or replace function public.fn_interromper_turnos_ao_assumir()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Distribuir ao responsável não é assumir; handoff é decisão do próprio turno.
  if new.reason not in ('claim', 'transfer') or new.to_user_id is null then return new; end if;
  -- O fato de atribuição deve corresponder ao dono real, na MESMA organização.
  if not exists (select 1 from public.conversations c
    where c.organization_id = new.organization_id and c.id = new.conversation_id
      and c.assigned_to_user_id = new.to_user_id) then return new; end if;
  -- O turno que PEDIU esta atribuição não perde o próprio comando (#3926): é o
  -- único poupado — os OUTROS turnos da conversa continuam revogados, e uma
  -- atribuição feita por pessoa (source_job_id nulo) revoga todos, como antes.
  insert into public.event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
    select new.organization_id, 'conversation.autonomous_turn_revoked', 'job', j.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'assignment_event_id', new.id), 'done'
    from public.job_queue j
    where j.organization_id = new.organization_id and j.kind = 'followup_turn' and j.status = 'running'
      and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
      and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
      and j.id is distinct from new.source_job_id
      and j.contact_id = (select c.contact_id from public.conversations c
        where c.organization_id = new.organization_id and c.id = new.conversation_id);
  update public.job_queue j
     set status = 'failed', locked_by = null, locked_at = null,
         last_error = 'conversation_command_taken'
   where j.organization_id = new.organization_id
     and j.payload->'service_boundary'->>'conversation_id' = new.conversation_id::text
     and j.payload->'service_boundary'->>'organization_id' = new.organization_id::text
     and j.id is distinct from new.source_job_id
     and j.contact_id = (select c.contact_id from public.conversations c
       where c.organization_id = new.organization_id and c.id = new.conversation_id)
     and j.kind in ('inbound_turn', 'case_reply_turn')
     and j.status in ('pending', 'running');
  return new;
end;
$$;
revoke execute on function public.fn_interromper_turnos_ao_assumir() from public, anon, authenticated, service_role;

drop trigger if exists trg_interromper_turnos_ao_assumir on public.conversation_assignment_events;
create trigger trg_interromper_turnos_ao_assumir
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_interromper_turnos_ao_assumir();

notify pgrst, 'reload schema';
