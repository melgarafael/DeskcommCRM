-- manifest: **O negócio aberto do contato acompanha o dono da conversa na porta única da atribuição (#4019, PR #4046 de @webtecnica; decisão do mantenedor: B do doc 178, reafirmada no doc 267).** A régua que vivia nas telas (`sincronizarNegocioAbertoDoContato`, removido) desce para `fn_conversation_assign`, na MESMA transação da troca de dono, e passa a valer também para MCP e chamada direta (na automação, só preenche negócio sem dono). Só `p_reason = 'transfer'` leva um negócio que já tem responsável; `claim` (Assumir, Iniciar conversa, quem responde assume), `routing`, `handoff` e os demais só dão dono a negócio SEM responsável — nunca tiram de um colega. Com sessão, a escrita fica dentro do que a RLS de `crm_leads` já permite a quem clicou (`fn_can_view_lead` sobre o responsável atual E sobre o novo): na visibilidade padrão, o Atendente que transfere para uma colega continua sem levar o negócio. A troca de carteira e a passagem de conversas do contato (`fn_definir_carteira_do_cliente`, `fn_passar_conversas_do_contato`) entram com `'transfer'` e sem sessão: são recriadas passando `p_negocio_so_sem_dono => true`, e não levam negócio que já tem responsável (#2591). Só um negócio aberto é tocado; zero não cria card; mais de um não é tocado. 8º argumento `p_negocio_so_sem_dono` (default `false`) exige o `drop` da assinatura de 7. Idempotente; espelho no `baseline.sql` antes da VARREDURA anon. Gate: `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.
--
-- 9208 — O NEGÓCIO ABERTO DO CONTATO ACOMPANHA O DONO DA CONVERSA (#4019).
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- O #3177 (PR #3216) levou o negócio aberto ao transferir/assumir PELA TELA:
-- `sincronizarNegocioAbertoDoContato` rodava na rota de transferência e no
-- helper do Assumir, com o cliente da SESSÃO. Levantamento do relator da #4019
-- em 46 conversas com dono: 14 negócios abertos com responsável DIFERENTE do
-- dono da conversa (ou sem responsável). A transferência FORA da tela —
-- `crm_assign_conversation` (MCP) e chamada direta da função — não passava por
-- régua nenhuma, porque a régua morava na tela.
--
-- ─── O conserto: a régua desce para a porta única ──────────────────────────
--
-- `fn_conversation_assign` é a ÚNICA porta de escrita da atribuição. A sincronia
-- acontece DENTRO dela, na mesma transação: o card e a conversa nunca divergem
-- por uma falha no meio, e todo caminho que atribui herda a regra.
--
-- A regra é a do mantenedor (doc 178, letra B; reafirmada no doc 267, letra A):
--
--   · TRANSFERIR (`p_reason = 'transfer'`) leva o negócio aberto do contato,
--     inclusive de outro responsável;
--   · todo o resto — Assumir, Iniciar conversa, "quem responde assume", a fila
--     automática, a passagem para humano — só dá dono a negócio SEM
--     responsável. Nunca tira o negócio de um colega sem que alguém tenha
--     pedido a transferência;
--   · `p_negocio_so_sem_dono = true` força a segunda régua em qualquer motivo.
--     É o que a conversa que CONTINUA no número do dono novo (#3732) recebe da
--     chamada de fora, para a chamada interna (sempre `'transfer'`) não levar
--     um negócio que a de fora não levaria.
--
-- E a régua do #3177, que não muda: só `status = 'open'` do contato da
-- conversa; zero aberto = nada criado; mais de um = nada tocado (caminho 4 da
-- issue, decisão de produto em aberto); já é o dono novo = nenhuma escrita (o
-- gatilho de crm_leads emite `lead.assigned` a cada UPDATE).
--
-- ─── Com sessão, a permissão é a de quem clicou ────────────────────────────
--
-- A função é `security definer` (já era). Com sessão (`auth.uid()` presente), a
-- escrita no negócio só acontece quando a própria RLS de `crm_leads_update`
-- deixaria quem clicou fazê-la: `fn_can_view_lead` sobre o responsável ATUAL
-- (o USING) e sobre o NOVO (o WITH CHECK). Gestor e admin enxergam tudo; o
-- Atendente, na visibilidade padrão, não entrega o negócio a uma colega (#2556)
-- — ampliar isso é decisão separada, que o mantenedor não tomou. Sem sessão
-- (service role: MCP, automação, fila) esse filtro não existe: decidem o motivo
-- e `p_negocio_so_sem_dono`.
--
-- ─── O que muda para os chamadores ────────────────────────────────────────
--
-- Assinatura nova (8º argumento com default) = função NOVA: sem o `drop` da de
-- 7 argumentos, ela sobreviveria como SOBRECARGA e toda chamada de 6/7
-- argumentos receberia "function ... is not unique". A lista congelada de
-- `tests/invariants/hardening-definer-varredura.test.ts` acompanha.
--
-- O resto do corpo é o da 9103: guarda de suporte, papel, elegibilidade do
-- destino, visibilidade da conversa (0685/9017), o número que segue o vendedor
-- (9039), a conversa que continua (9054) e a origem do turno (9103).
--
-- Idempotente. Espelho no `supabase/baseline.sql`, ANTES da varredura de anon.
-- Gate: `tests/invariants/negocio-aberto-acompanha-o-dono.test.ts`.

drop function if exists public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean, uuid);

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
         -- (USING sobre o responsável atual, WITH CHECK sobre o novo).
         and (auth.uid() is null
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

-- ─── #4019: a carteira e a passagem de conversas não levam negócio com dono ──
--
-- As duas funções abaixo passam conversas pela porta única com `'transfer'`
-- e SEM sessão. Sem o 8º argumento, a régua da transferência moveria o
-- negócio aberto de um colega junto com a conversa — contra a regra da
-- carteira (#2591: "os que já têm dono não mudam"). Com isto, a carteira segue
-- como antes da 9208; a passagem de conversas passa a preencher o negócio
-- aberto sem responsável, quando há um só, e nunca tira negócio de um colega.
-- Corpo idêntico à última definição de cada uma (9077 e 9057); a única
-- mudança é `p_negocio_so_sem_dono => true` na chamada interna.

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
  v_dono_atual uuid;
begin
  if v_origem not in ('manual', 'importacao', 'atribuicao_automatica', 'automacao') then
    raise exception 'carteira_origem_invalida' using errcode = '22023';
  end if;
  if v_ator is null then
    -- #3514: sem ator humano, quem grava é o SISTEMA — e só ele. A automação
    -- não tem sessão; o que a identifica é a origem `automacao`, que a função
    -- recusa a quem chega com ator (senão a origem do sistema virava um rótulo
    -- que qualquer manager escolhia para esconder o próprio ato).
    if v_origem <> 'automacao' then
      raise exception 'carteira_sem_ator' using errcode = '42501';
    end if;
  end if;
  if p_org is null or p_contact is null then
    raise exception 'carteira_parametro_invalido' using errcode = '22023';
  end if;

  if v_ator is not null then
    -- Quem muda: `agent`+ da MESMA organização (e membro aceito, não revogado).
    -- #3746: o Atendente entrou nesta porta, mas com ESCOPO DE POSSE — o papel
    -- sozinho não distingue "meu cliente" de "cliente do colega", e liberar o
    -- papel seco deixaria qualquer Atendente se pôr como dono do cliente de
    -- outro e levar o negócio seguinte no nome errado (o defeito do #2591).
    select uo.role into v_papel
      from public.user_organizations uo
     where uo.user_id = v_ator
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_papel is null or v_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_permissao_negada'
        using errcode = '42501',
              detail = 'Só atendente, manager e admin definem a carteira do cliente.';
    end if;
    if v_papel = 'agent' then
      -- A POSSE, conferida AQUI e não só na rota: esta é a porta ÚNICA de
      -- gravação (`trg_contacts_carteira_so_pelo_servidor` recusa a sessão), e
      -- um chamador novo não pode nascer sem a régua. Doc 250, escolha 1-B:
      --   • o contato já está na carteira dele → passa (pode passar adiante);
      --   • conversa do contato atribuída a ele + contato SEM dono → passa;
      --   • conversa com ele + contato na carteira de OUTRO →
      --     `carteira_permissao_negada`: tirar o cliente de um colega segue
      --     sendo do gerente (a regra do #2591 — o rodízio não leva a venda
      --     de quem atende o cliente);
      --   • nenhuma das duas → `carteira_fora_da_posse`.
      -- A rota traduz as duas recusas em 403.
      select c.carteira_user_id into v_dono_atual
        from public.contacts c
       where c.id = p_contact
         and c.organization_id = p_org;
      if v_dono_atual is distinct from v_ator then
        if not exists (
             select 1
               from public.conversations cv
              where cv.organization_id = p_org
                and cv.contact_id = p_contact
                and cv.assigned_to_user_id = v_ator
           ) then
          raise exception 'carteira_fora_da_posse'
            using errcode = '42501',
                  detail = 'O atendente só muda a carteira do cliente que já está com ele: contato na carteira dele, ou conversa atribuída a ele com o contato sem dono.';
        end if;
        if v_dono_atual is not null then
          raise exception 'carteira_permissao_negada'
            using errcode = '42501',
                  detail = 'O cliente está na carteira de outro vendedor: só manager e admin tiram o cliente da carteira de um colega.';
        end if;
      end if;
    end if;
    if v_origem = 'automacao' then
      raise exception 'carteira_origem_invalida'
        using errcode = '22023',
              detail = 'A origem automacao é do servidor, sem ator: quem chama com ator grava manual ou atribuicao_automatica.';
    end if;
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
        perform public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer',
          p_negocio_so_sem_dono => true);
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

create or replace function public.fn_passar_conversas_do_contato(
  p_org uuid,
  p_contact uuid,
  p_dono uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversa uuid;
  v_passou uuid;
  v_movidas integer := 0;
begin
  if p_org is null or p_contact is null or p_dono is null then
    raise exception 'passagem_parametro_invalido' using errcode = '22023';
  end if;

  for v_conversa in
    select c.id
      from public.conversations c
     where c.organization_id = p_org
       and c.contact_id = p_contact
       and c.status in ('open', 'pending', 'claimed', 'ai_handling')
       and c.assigned_to_user_id is not null
       and c.assigned_to_user_id <> p_dono
     order by c.id
       for no key update
  loop
    -- Zero linhas devolvidas = nada gravado: `v_passou` fica nulo e não conta.
    select a.id into v_passou
      from public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer',
                                          p_negocio_so_sem_dono => true) a;
    if v_passou is not null then
      v_movidas := v_movidas + 1;
    end if;
  end loop;

  return v_movidas;
end;
$$;

revoke execute on function public.fn_passar_conversas_do_contato(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_passar_conversas_do_contato(uuid, uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
