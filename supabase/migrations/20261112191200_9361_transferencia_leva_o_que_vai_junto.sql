-- manifest: **A transferência de conversa leva o que anda junto (#4312).** Três defeitos na MESMA operação, todos com o mesmo cheiro. (1) O negócio aberto do contato não acompanhava quando quem transfere é `agent` dono do card: em `own`/`own_and_unassigned` o `fn_can_view_lead` do destino é falso, a escrita era pulada em silêncio e o card ficava com quem saiu — agora o DONO ATUAL do card entrega o que é dele (`p_reason = 'transfer' and owner_user_id = auth.uid()`), e quem NÃO é dono continua sem tomar nem entregar card de colega, com o diálogo de Transferir avisando que o negócio continua com a outra pessoa (`fn_previa_do_negocio_na_transferencia`, consultada pela mesma rota que aplica). (2) A conversa devolvida não voltava ao número de origem: `fn_numero_da_transferencia` devolvia nulo quando o destino já responde pelo número atual, então a devolução ficava no número do colega; agora o número da ÚLTIMA mensagem inbound da conversa (o número em que o cliente falou por último) tem prioridade sobre o primeiro número do destino, com as mesmas cercas (conectado, mesmo provedor, contato sem outra conversa 1:1 ali). (3) O diálogo de Transferir passa a listar as outras conversas do mesmo contato, com o número de cada uma, para a equipe não perder o fio. Idempotente (`create or replace`, assinaturas idênticas); espelho no `baseline.sql` antes da VARREDURA anon e antes da cascata da 9243. Gates: `tests/invariants/transferencia-leva-o-negocio-e-volta-ao-numero.test.ts` e `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.
--
-- 9361 — A TRANSFERÊNCIA LEVA O QUE ANDA JUNTO (#4312).
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- Uma operação só — transferir a conversa — deixava três coisas para trás.
--
-- 1. O NEGÓCIO ABERTO. A 9208 (#4019) levou a sincronia do negócio para dentro
--    desta função, com a conta de permissão de `crm_leads_update`:
--    `fn_can_view_lead` sobre o responsável ATUAL e sobre o NOVO. Em `own` e
--    `own_and_unassigned` o atendente que é DONO do card não enxerga o card do
--    destino: `fn_can_view_lead(A → B)` é falso, a escrita é pulada em
--    silêncio e o negócio fica com quem saiu — a colega não acha o negócio no
--    filtro "Responsável", a meta por vendedor conta para quem saiu e
--    tarefas/avisos vão para a pessoa errada. (O mesmo item foi relatado em
--    #4371 e consertado pela migration 9322 com esta exceção; ela é reafirmada
--    aqui porque esta migration redefine o corpo inteiro da função.)
--
-- 2. O NÚMERO DE ORIGEM. Na política de responsáveis por número (#3642), a
--    conversa passa para o número do dono novo. Ao DEVOLVER a conversa a quem
--    a tinha antes, `fn_numero_da_transferencia` devolvia nulo — o destino já
--    responde pelo número ATUAL, e a guarda `not exists (responsável atual =
--    destino)` pulava a escolha. O resultado medido na issue: a conversa fica
--    no número do colega, o cliente continua escrevendo no número de origem
--    (e lá nasce OUTRA conversa), e a resposta pela conversa antiga sai por um
--    número em que o cliente nunca falou.
--
-- 3. AS CONVERSAS DO MESMO CONTATO. O diálogo de Transferir não mostrava que o
--    contato já tem outra conversa em outro número, então a equipe transferia
--    sem saber que o fio estava partido em dois.
--
-- ─── Os consertos ──────────────────────────────────────────────────────────
--
-- (1) UMA condição a mais no portão do negócio, estreita e explícita: quando
--     `p_reason = 'transfer'` E o responsável atual do card é o próprio
--     `auth.uid()`, o destino não precisa ser visível a quem transfere — o
--     dono está entregando o atendimento dele de propósito. O que a exceção
--     NÃO alcança: agente que não é dono (o `fn_can_view_lead` do responsável
--     atual segue exigido); `claim`/`routing`/`handoff` e os demais motivos
--     (entram com `v_so_sem_dono = true` e a exceção exige `'transfer'`);
--     contato com mais de um negócio aberto (`v_negocios = 1` acima); e
--     conversa de colega (barrada antes, na leitura da conversa).
--
--     O caminho de quem NÃO é dono deixa de ser silencioso pela TELA:
--     `fn_previa_do_negocio_na_transferencia` responde, para o destino
--     escolhido, se o negócio aberto vai junto e com quem ele fica. É a mesma
--     regra da escrita, no mesmo lugar — como `fn_numero_da_transferencia` já
--     é para o número —, e a rota `GET /api/v1/conversations/[id]/transfer` a
--     entrega ao diálogo, que avisa "o negócio aberto continua com X".
--
-- (2) PRIORIDADE para o número da última mensagem INBOUND da conversa, entre
--     os números do destino. As cercas continuam as da 9039: só número
--     CONECTADO (`WORKING`, não arquivado, não desativado), do MESMO provedor,
--     e o contato não pode ter outra conversa 1:1 naquele número (o índice
--     `uniq_conversations_1to1_per_contact_session`). Fora da devolução, nada
--     muda: se a última entrada do cliente foi no número atual — ou se o
--     destino não responde por ele —, a regra antiga decide (primeiro número
--     conectado do destino, e nulo quando ele já responde pelo número atual).
--
-- (3) A lista vive no DIÁLOGO (`ReassignDialog`), com o número de cada
--     conversa; não nasce um segundo seletor na conversa. Quem lista é a rota
--     que já existe (`GET /api/v1/conversations?contact_id=…`), pela RLS de
--     quem está transferindo.
--
-- Assinaturas idênticas às vigentes: `create or replace`, sem `drop`, sem
-- sobrecarga. Idempotente.
-- Espelho no `supabase/baseline.sql`, antes da VARREDURA anon e antes da
-- cascata da 9243.
-- Gates: `tests/invariants/transferencia-leva-o-negocio-e-volta-ao-numero.test.ts`
-- e `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.

-- ─── (2) o número da devolução: a última entrada do cliente tem prioridade ───
-- Mesma assinatura e mesmas cercas da 9039. A única diferença é a ORDEM entre
-- os números do destino: o da última mensagem inbound da conversa (prioridade
-- 0) vem antes do primeiro número conectado do destino (prioridade 1), e o
-- ramo 1 continua exigindo que o destino NÃO responda pelo número atual.
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
  -- #4312: o número em que o CLIENTE falou por último nesta conversa. É para
  -- lá que a conversa devolvida volta — o número de origem, e o único em que
  -- uma resposta não sai de um número que o cliente nunca viu.
  ultima_entrada as (
    select m.channel_session_id
      from conversa
      join public.messages m
        on m.organization_id = conversa.organization_id
       and m.conversation_id = conversa.id
       and m.direction = 'inbound'
     order by m.created_at desc, m.id desc
     limit 1
  ),
  candidato as (
    select cs.id,
           case when cs.id = (select channel_session_id from ultima_entrada) then 0 else 1 end as prioridade
      from conversa
      join public.channel_routing_responsibles r
        on r.organization_id = conversa.organization_id and r.user_id = p_to_user_id
      join public.channel_routing_policies p
        on p.organization_id = r.organization_id and p.id = r.policy_id
      join public.channel_sessions cs
        on cs.organization_id = p.organization_id and cs.id = p.channel_session_id
     where cs.id <> conversa.channel_session_id
       and cs.provider = conversa.provider
       and cs.archived_at is null
       and cs.status = 'WORKING'
       and coalesce(cs.metadata ->> 'disabled', 'false') <> 'true'
       -- #4312: o número da última entrada do cliente, quando ele é do destino;
       -- OU a regra da 9039 (o destino ainda não responde pelo número atual).
       and (cs.id = (select channel_session_id from ultima_entrada)
            or (exists (select 1 from responsaveis_do_atual)
                and not exists (select 1 from responsaveis_do_atual a where a.user_id = p_to_user_id)))
     order by prioridade, cs.created_at, cs.id
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

-- ─── (1) o negócio aberto: o dono entrega o que é dele ──────────────────────
-- Corpo da 9208 inteiro, com UMA condição a mais no portão do negócio (e o
-- comentário dela). Nada mais muda: guardas de suporte, papel, elegibilidade do
-- destino, visibilidade da conversa, o número que segue o vendedor, a conversa
-- que continua e a origem do turno seguem como estavam.

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
  --     clicou: enxergar o responsável atual E o novo (fn_can_view_lead) — mais
  --     a exceção do #4312, o dono do card entregando o próprio negócio.
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
         -- (USING sobre o responsável atual, WITH CHECK sobre o novo) — com a
         -- exceção do DONO do card, que entrega o que é dele (#4312).
         and (auth.uid() is null
              -- #4312: quando quem transfere é o DONO ATUAL do card, o destino
              -- não precisa ser visível a ele. Sem este termo, em `own`/
              -- `own_and_unassigned` o `fn_can_view_lead(A → B)` é falso, a
              -- escrita é pulada em SILÊNCIO e o negócio fica com quem saiu (o
              -- defeito da issue). Estreito de propósito: exige `'transfer'` —
              -- claim/routing/handoff entram com `v_so_sem_dono = true` e não
              -- passam por aqui — e exige que o card seja DELE.
              or (p_reason = 'transfer' and v_negocio.owner_user_id = auth.uid())
              or (public.fn_can_view_lead(p_organization_id, v_negocio.owner_user_id)
                  and public.fn_can_view_lead(p_organization_id, p_to_user_id)))
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
-- ─── (1b) a prévia do negócio para o diálogo de Transferir ─────────────────
-- A MESMA regra da escrita, numa função só, porque DUAS peças precisam da
-- mesma resposta: `fn_conversation_assign` (que aplica) e o diálogo de
-- Transferir (que avisa ANTES). Duas cópias da conta divergiriam, e o diálogo
-- diria que o negócio vai junto enquanto a troca o deixa para trás — ou o
-- contrário, que é o silêncio que esta issue fechou.
--
-- Devolve UMA linha sempre que a conversa é da organização e quem pergunta a
-- enxerga (as mesmas guardas da atribuição):
--   · `tem_negocio` — há exatamente UM negócio aberto do contato (zero ou mais
--     de um: nada é tocado na transferência, e não há o que avisar);
--   · `leva` — o negócio vai junto nesta transferência;
--   · `dono_user_id` — com quem o negócio fica (o atual), para o diálogo dizer
--     o nome de quem continua com ele.
-- Zero linhas = não há o que dizer (conversa fora da visibilidade de quem
-- pergunta, ou destino nulo). Só leitura: nada muda aqui.
create or replace function public.fn_previa_do_negocio_na_transferencia(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid
)
returns table (tem_negocio boolean, leva boolean, dono_user_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dono_da_conversa uuid;
  v_negocios integer;
  v_negocio public.crm_leads%rowtype;
begin
  if p_to_user_id is null then
    return;
  end if;

  -- A conversa tem de existir e estar na visibilidade de quem pergunta: a
  -- mesma conta da leitura da `fn_conversation_assign`. Sem isto, a prévia
  -- responderia sobre conversa de colega a quem não a enxerga.
  select c.assigned_to_user_id into v_dono_da_conversa
    from public.conversations c
   where c.id = p_conversation_id
     and c.organization_id = p_organization_id;
  if not found then
    return;
  end if;
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;
  if auth.uid() is not null
     and not public.fn_can_view_conversation(p_organization_id, v_dono_da_conversa) then
    return;
  end if;

  select count(*) into v_negocios
    from public.crm_leads l
    join public.conversations c
      on c.organization_id = l.organization_id and c.contact_id = l.contact_id
   where c.id = p_conversation_id
     and c.organization_id = p_organization_id
     and l.status = 'open';

  tem_negocio := v_negocios = 1;
  if not tem_negocio then
    leva := false;
    dono_user_id := null;
    return next;
    return;
  end if;

  select l.* into v_negocio
    from public.crm_leads l
    join public.conversations c
      on c.organization_id = l.organization_id and c.contact_id = l.contact_id
   where c.id = p_conversation_id
     and c.organization_id = p_organization_id
     and l.status = 'open';

  dono_user_id := v_negocio.owner_user_id;
  -- A conta do portão da escrita, termo por termo: já é o dono novo (nada a
  -- escrever); card sem responsável (a transferência preenche); servidor (sem
  -- sessão, decide o motivo); ou a permissão de quem clicou — com a exceção do
  -- dono do card (#4312).
  leva := v_negocio.owner_user_id is distinct from p_to_user_id
          and (
            (v_negocio.owner_user_id is null and v_negocio.owner_agent_id is null)
            or auth.uid() is null
            or (public.fn_can_view_lead(p_organization_id, v_negocio.owner_user_id)
                and (public.fn_can_view_lead(p_organization_id, p_to_user_id)
                     or v_negocio.owner_user_id = auth.uid()))
          );
  return next;
end;
$$;

revoke all     on function public.fn_previa_do_negocio_na_transferencia(uuid, uuid, uuid) from public;
revoke execute on function public.fn_previa_do_negocio_na_transferencia(uuid, uuid, uuid) from anon;
grant  execute on function public.fn_previa_do_negocio_na_transferencia(uuid, uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
