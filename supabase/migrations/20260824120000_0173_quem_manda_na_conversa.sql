-- 0173 — quem manda na conversa: "Assumir" cala o automático, e o histórico de
-- atribuição deixa de ser legível por quem não vê a conversa.
--
-- ## Parte 1 — o comando muda o silêncio (fn_conversation_assign)
--
-- Medido no HEAD 927dfa51: `lib/agent-engine/` NUNCA lê `assignee_kind` nem
-- `assigned_to_user_id` (`grep -rn` → rc=1), e esta função nunca tocou
-- `bot_silenced_until`. Consequência: um atendente clicava "Assumir" e o
-- automático continuava respondendo o mesmo cliente. Ele só calava por 5 minutos
-- deslizantes quando a pessoa ENVIAVA uma mensagem (`extendBotSilence`,
-- app/api/v1/messages/_handler.ts). Dois atores atendendo o mesmo cliente é o
-- defeito; qualquer selo de "você está no comando" em cima disso seria mentira.
--
-- O conserto entra AQUI e não no motor porque `bot_silenced_until` é o gate que o
-- motor JÁ lê (`isLeadInHandoff`) — nenhuma linha do motor muda. A alternativa
-- (ensinar o motor a ler `assignee_kind`) foi medida e REPROVADA: `Fechar` não
-- solta o dono, de propósito ("quem atendeu é histórico"), então o fim normal de
-- um atendimento deixaria `assignee_kind='user'` pendurado e o automático mudo
-- para sempre naquele contato — inclusive em conversa NOVA de outro número, porque
-- aquele gate é por CONTATO.
--
-- Três braços, e o do rodízio é o que impede a regressão silenciosa:
--
--   * `p_reason = 'routing'` → NÃO MEXE. O rodízio DISTRIBUI, não toma o comando.
--     `trg_conversation_routing_requested` dispara em TODA conversa nova e o worker
--     roda de 1 em 1 minuto: sem esta ressalva, uma org em `round_robin` teria o
--     automático calado na primeira mensagem da vida de cada cliente — e a tela que
--     liga o rodízio não diz uma palavra sobre isso.
--   * destino humano (`claim`/`transfer`) → `'infinity'`. Eu mando agora.
--   * destino nulo (`release`)           → `null`. Devolvi.
--
-- `create or replace` com a assinatura IDÊNTICA de 6 args, de propósito: acrescentar
-- parâmetro criaria OVERLOAD (o replace não substitui assinatura diferente) e as
-- cinco chamadas por nome passariam a falhar com `is not unique`.
--
-- A limpeza do silêncio ao FECHAR mora na rota (`close/route.ts`), não aqui: fechar
-- não passa por esta função. Sem ela o silêncio vazaria para o próximo episódio,
-- porque a ingestão reusa a MESMA linha de conversa (`on conflict do update`).
--
-- ## Parte 2 — `cae_select` deixa de ser mais frouxa que a da conversa
--
-- Medido: org em `visibility_mode='own'`, agent que NÃO é dono → `select` em
-- `conversations` devolve 0 linhas e `select` em `conversation_assignment_events`
-- da MESMA conversa devolve 1. A policy era membership de org pura enquanto
-- `conversations_select` passa por `fn_can_view_conversation`. A tabela está no
-- schema `public`, logo é alcançável pelo PostgREST com a anon key + o JWT do
-- usuário — não depende de existir rota nossa.
--
-- O molde é o do `messages_select`: o `exists` sobre `conversations` já aplica a
-- RLS de `conversations`, então o escopo passa a ser herdado em vez de reescrito
-- (reescrever faria duas cópias da mesma regra divergirem na primeira mudança).
--
-- Idempotente: `create or replace` + `drop policy if exists`. Sem dados a corrigir.

create or replace function public.fn_conversation_assign(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_to_user_id uuid,
  p_reason text,
  p_expected_assignee uuid default null,
  p_enforce_expected boolean default false
) returns setof public.conversations
language plpgsql security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_conv public.conversations%rowtype;
begin
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

  select assigned_to_user_id into v_from
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
   for update;

  if not found then
    return;
  end if;

  if p_enforce_expected and v_from is distinct from p_expected_assignee then
    return;
  end if;

  update public.conversations
     set assigned_to_user_id = p_to_user_id,
         assigned_at = case when p_to_user_id is null then null else now() end,
         assignee_kind = case when p_to_user_id is null then null else 'user' end,
         status = case when p_to_user_id is null then 'open' else 'claimed' end,
         status_changed_at = now(),
         unread_count_for_assignee = 0,
         -- O comando muda o silêncio. `routing` é a exceção: distribuir não é
         -- assumir, e calar o automático em toda conversa nova de uma org em
         -- rodízio seria desligar o produto sem avisar ninguém.
         -- A trava só é solta por quem a pôs. `last_handoff_at` é o discriminador
         -- que já existe: uma ESCALAÇÃO o carimba (`performHumanHandoff` e
         -- `triggerHandoff`), um humano ASSUMINDO não. Sem esta condição, o
         -- release apagaria o silêncio de uma conversa que a IA escalou — e o
         -- caminho legado (`triggerHandoff`, usado pelo MCP, pelo handler de
         -- sentimento, pelo worker e pelo teto de gasto) NÃO grava
         -- `contacts.force_human`, então ali o silêncio é a ÚNICA trava. Medido:
         -- `grep -n force_human lib/ai/handoff/orchestrator.ts` → rc=1.
         -- Soltar de propósito é o botão "Devolver ao automático"
         -- (`devolverAtendimentoAoAgente`), que limpa as três travas de uma vez.
         bot_silenced_until = case
           when p_reason = 'routing'  then bot_silenced_until
           when p_to_user_id is null  then (case when last_handoff_at is null
                                                 then null
                                                 else bot_silenced_until end)
           else 'infinity'::timestamptz
         end,
         updated_at = now()
   where id = p_conversation_id
   returning * into v_conv;

  insert into public.conversation_assignment_events
    (organization_id, conversation_id, from_user_id, to_user_id, changed_by, reason)
  values
    (p_organization_id, p_conversation_id, v_from, p_to_user_id, auth.uid(), p_reason);

  return next v_conv;
end;
$$;

-- As DUAS origens de EXECUTE (doutrina de migrations, item 9): o `revoke from
-- public` não remove o grant DIRETO que `anon` carrega via ALTER DEFAULT
-- PRIVILEGES, e o `revoke from anon` não remove o grant a PUBLIC que o Postgres
-- dá na criação. Re-asseridas aqui porque esta é uma SECURITY DEFINER que
-- reatribui conversa.
revoke all     on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from public;
revoke execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean) from anon;
grant  execute on function public.fn_conversation_assign(uuid, uuid, uuid, text, uuid, boolean)
  to authenticated, service_role;

drop policy if exists cae_select on public.conversation_assignment_events;
create policy cae_select on public.conversation_assignment_events
  for select using (
    public.fn_is_platform_admin()
    or (
      -- O filtro de org fica, mesmo com o `exists` ao lado. Os dois predicados
      -- respondem perguntas DIFERENTES: o `exists` diz "você enxerga esta
      -- conversa?", e este diz "esta LINHA é da sua organização?". A policy de
      -- INSERT (intocada) permite gravar uma linha com o `organization_id` de um
      -- tenant e o `conversation_id` de outro; sem esta metade, quem enxerga a
      -- conversa apontada leria a linha do tenant vizinho.
      organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1
          from public.conversations c
         where c.id = conversation_assignment_events.conversation_id
      )
    )
  );

notify pgrst, 'reload schema';
