-- manifest: **O dono do card entrega o próprio negócio na transferência, mesmo em `own_and_unassigned` (#4371, relato de @aerosuiteapp).** Desde o #4019 (migration 9208), o negócio aberto do contato acompanha a troca de dono da conversa dentro de `fn_conversation_assign`, mas a conta de permissão (`fn_can_view_lead` sobre o responsável ATUAL e sobre o NOVO) barrava o role `agent` que transfere para uma colega na visibilidade padrão: `fn_can_view_lead(A → B)` é falso, a escrita é pulada e o card fica com quem saiu do atendimento (a colega não acha o negócio no filtro Responsável, a meta conta para quem saiu, tarefas e avisos vão para a pessoa errada). Conserto pelo SERVIDOR, na porta única: a exceção é UMA condição acrescentada ao portão existente — `p_reason = 'transfer' and v_negocio.owner_user_id = auth.uid()` —, ou seja, só quando quem transfere é o DONO ATUAL do card. A policy `crm_leads_update` NÃO é tocada (e não adiantaria: a função é SECURITY DEFINER e `crm_leads` não tem FORCE RLS, então o portão que recusava era este). O agente que não é dono continua sem tomar nem entregar card de colega; `claim`/`routing`/demais motivos seguem só preenchendo card SEM responsável; contato com mais de um negócio aberto continua intocado. Assinatura idêntica (8 argumentos): `create or replace`, sem `drop`, sem sobrecarga. Idempotente; espelho no `baseline.sql` antes da VARREDURA anon. Gate: `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.
--
-- 9322 — O DONO DO CARD ENTREGA O PRÓPRIO NEGÓCIO NA TRANSFERÊNCIA (#4371).
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- A 9208 (#4019) levou o negócio aberto do contato para dentro da porta única
-- da atribuição. A conta de permissão dela é a mesma da policy de escrita:
-- `fn_can_view_lead` sobre o responsável ATUAL e sobre o NOVO.
--
-- Na visibilidade padrão (`own_and_unassigned`), o role `agent` que é dono do
-- card e transfere a conversa para uma colega vê `fn_can_view_lead(A → B)`
-- responder FALSO (o outro atendente não é "meu" nem "sem dono"). A escrita do
-- negócio era então pulada em silêncio: a conversa trocava de dono e o card
-- ficava com quem saiu. Consequências relatadas na issue: a colega não acha o
-- negócio no filtro "Responsável", a meta por vendedor conta para quem saiu e
-- tarefas/avisos vão para a pessoa errada.
--
-- ─── Por que a policy NÃO foi a via escolhida ──────────────────────────────
--
-- `crm_leads_update` (baseline, perto de :5629) já aceita a escrita de um
-- `agent` quando ele enxerga o responsável ATUAL (`fn_can_view_lead` no USING)
-- — o que o dono do card sempre enxerga. O WITH CHECK é que recusa o NOVO dono.
-- Mas afrouxar a policy abriria, para TODO `agent`, a troca de dono de qualquer
-- card que ele já enxerga — inclusive o card SEM responsável que ele viu na
-- fila — e não é isso que a issue pede nem o que a trava de escopo permite.
-- Pior: `crm_leads` não tem `FORCE ROW LEVEL SECURITY` e a função é SECURITY
-- DEFINER (roda como o dono da tabela), então o UPDATE de dentro da função nem
-- passa pela policy. Medido pelo `caminho 1` do invariante antes deste conserto:
-- a conversa trocava de dono e o card ficava — não havia erro de RLS, havia o
-- portão em PL/pgSQL pulando a escrita. Mudar a policy sozinha deixaria o
-- comportamento do Inbox exatamente como está.
--
-- ─── O conserto: uma condição, na porta única ──────────────────────────────
--
-- A permissão continua sendo calculada no servidor, no mesmo lugar, com uma
-- exceção EXPLÍCITA e estreita: quando `p_reason = 'transfer'` E o responsável
-- atual do card é o próprio `auth.uid()`, o destino não precisa ser visível a
-- quem transfere — o dono está entregando o atendimento dele de propósito.
--
-- O que a exceção NÃO alcança (e o invariante cobra, como controle):
--   · agente que NÃO é dono do card: o `fn_can_view_lead` do responsável atual
--     segue exigido, e o card do colega continua sem se mover;
--   · `claim` (Assumir, Iniciar conversa), `routing`, `handoff` e os demais
--     motivos: entram com `v_so_sem_dono = true` e a exceção exige 'transfer';
--   · contato com mais de um negócio aberto: o portão `v_negocios = 1` acima
--     não muda;
--   · conversa de colega: a visibilidade da CONVERSA barra antes, na leitura
--     da própria `fn_conversation_assign` — ser dono do card não é chave para
--     a conversa de outra pessoa.
--
-- Assinatura IDÊNTICA à da 9208 (8 argumentos, o último com default), então
-- `create or replace` basta: sem `drop`, sem sobrecarga, sem quebra para os
-- chamadores de 6/7 argumentos. Idempotente.
-- Espelho no `supabase/baseline.sql`, ANTES da VARREDURA anon.
-- Gate: `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false,
  p_source_job_id uuid default null,
  -- #4019: com `true`, o negócio aberto só ganha dono se estiver SEM dono,
  -- qualquer que seja o motivo. Fora de `'transfer'` essa já é a régua.
  p_negocio_so_sem_dono boolean default false
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
  -- #4019 — o negócio ABERTO do contato que acompanha o dono novo.
  v_negocios integer;
  v_negocio public.crm_leads%rowtype;
  -- Doc 178 (B) / doc 267 (A): só a transferência tira o negócio de alguém.
  v_so_sem_dono boolean := p_negocio_so_sem_dono or p_reason is distinct from 'transfer';
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
      p_organization_id, v_continua, p_to_user_id, 'transfer', null, false, p_source_job_id,
      v_so_sem_dono);
  end if;

  -- ─── #4019: o NEGÓCIO ABERTO do contato acompanha o dono novo ──────────────
  --
  -- Porta única: Transferir (um e em lote), Assumir, MCP, automação, fila e
  -- carteira entram todos por aqui. A régua:
  --   · só status = 'open'; zero aberto = nada criado; mais de um = nada tocado
  --     (caminho 4 da issue, decisão de produto);
  --   · já é o dono novo: não escreve (o gatilho de crm_leads emite
  --     `lead.assigned` a cada UPDATE);
  --   · v_so_sem_dono (todo motivo que não é 'transfer'): só card SEM
  --     responsável — nunca tira o card de um colega;
  --   · com sessão, a escrita é a que a RLS de crm_leads_update já daria a quem
  --     clicou: enxergar o responsável atual E o novo (fn_can_view_lead).
  if p_to_user_id is not null then
    select count(*) into v_negocios
      from public.crm_leads l
     where l.organization_id = p_organization_id
       and l.contact_id = v_conv.contact_id
       and l.status = 'open';

    if v_negocios = 1 then
      -- Sem `for update`: o UPDATE abaixo repete `status = 'open'`, então uma
      -- corrida que feche o card entre a leitura e a escrita não é vencida por
      -- engano. Travar a linha aqui só acrescentaria, no caminho mais quente da
      -- atribuição, um lock de crm_leads DEPOIS do lock de conversations — a
      -- ordem inversa da automação que cria card e mexe na conversa.
      select * into v_negocio
        from public.crm_leads l
       where l.organization_id = p_organization_id
         and l.contact_id = v_conv.contact_id
         and l.status = 'open';

      if found
         and v_negocio.owner_user_id is distinct from p_to_user_id
         and (not v_so_sem_dono
              or (v_negocio.owner_user_id is null and v_negocio.owner_agent_id is null))
         -- A permissão é a de quem clicou: a mesma conta de crm_leads_update
         -- (USING sobre o responsável atual, WITH CHECK sobre o novo) — com UMA
         -- exceção (#4371): quando quem transfere é o DONO ATUAL do card.
         --
         -- Por que a exceção mora aqui e não na policy: a função é SECURITY
         -- DEFINER e o dono da tabela não sofre RLS (não há FORCE ROW LEVEL
         -- SECURITY em crm_leads), então quem barrava a escrita era ESTA conta,
         -- não o WITH CHECK de crm_leads_update — mudar a policy não mudaria o
         -- comportamento do Inbox. E a checagem é explícita: `owner_user_id`
         -- igual a `auth.uid()`, só em 'transfer'. Quem entrega o atendimento do
         -- próprio card de propósito não precisa enxergar o destino — na
         -- visibilidade padrão (own_and_unassigned) `fn_can_view_lead` responde
         -- "não vejo" para a colega, e o card ficava com quem saiu (a colega não
         -- achava o negócio no filtro Responsável, a meta contava para quem
         -- saiu, tarefas e avisos iam para a pessoa errada).
         --
         -- O que NÃO abre: o agente que não é dono continua sem tomar nem
         -- entregar o card de um colega (o `fn_can_view_lead` do responsável
         -- atual segue exigido); 'claim', 'routing' e os demais motivos nunca
         -- chegam nesta exceção (o `p_reason = 'transfer'` é condição dela, e
         -- eles já entram com v_so_sem_dono = true); mais de um negócio aberto
         -- continua intocado (o portão é v_negocios = 1, acima).
         and (auth.uid() is null
              or (public.fn_can_view_lead(p_organization_id, v_negocio.owner_user_id)
                  and (public.fn_can_view_lead(p_organization_id, p_to_user_id)
                       -- #4371: o dono ATUAL do card o entrega mesmo para um
                       -- destino que ele não enxerga. `auth.uid()` é a sessão de
                       -- quem clicou; o servidor (auth.uid() nulo) já passava.
                       or (p_reason = 'transfer'
                           and v_negocio.owner_user_id = auth.uid()))))
      then
        -- O trio dono/kind é o da migration 0070: owner_user_id sozinho produz
        -- card com dono e sem kind, que some do filtro e das métricas sem erro.
        update public.crm_leads
           set owner_user_id = p_to_user_id,
               owner_agent_id = null,
               owner_kind = 'user',
               assigned_at = now()
         where id = v_negocio.id
           and organization_id = p_organization_id
           and status = 'open'
           -- Sem lock na leitura: o responsável lido é a condição da escrita.
           -- Se alguém trocou o card no meio, a escrita não acontece.
           and owner_user_id is not distinct from v_negocio.owner_user_id
           and owner_agent_id is not distinct from v_negocio.owner_agent_id;
      end if;
    end if;
  end if;

  return next v_conv;
end;
$function$;
revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid, boolean)
  to authenticated, service_role;

