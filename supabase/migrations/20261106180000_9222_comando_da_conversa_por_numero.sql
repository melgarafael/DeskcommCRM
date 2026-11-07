-- manifest: **O comando da conversa pergunta pelo NÚMERO, não só pela organização (#4012, parte 2):** `comando_da_conversa(c)` deixa de dizer `automatico` para conversa que nenhum agente vai responder — o funil do dreno (`haQuemAtendaASessao`) e o pré-go-live do canal passam a valer também para a tela, para a Fila e para as funções do banco que decidem pelo comando (`fn_definir_carteira_do_cliente`, `fn_conversa_que_continua`, `fn_conversation_assign`). Função nova `fn_automatico_da_conversa(org, sessão, telefone)` (definer, stable) e campo calculado `automatico_da_conversa(conversations)` para o espelho TypeScript. Aditiva: só `create or replace` de função, nenhuma coluna, nenhum dado tocado.
-- ============================================================================
-- 9222 — O COMANDO DA CONVERSA PERGUNTA PELO NÚMERO (issue #4012, parte 2).
--
-- Defeito medido: `fn_comando_da_conversa` responde só pelo estado da CONVERSA
-- (dono, status, silêncio, trava). Toda conversa sem dono e sem trava saía
-- `automatico`, mesmo quando nenhum agente podia respondê-la:
--
--   * organização sem agente publicado — caso 1 da issue, fechado em outra
--     frente; aqui ele cai de graça, porque "sem agente no número" inclui
--     "sem agente nenhum";
--   * agente publicado em OUTRO número — o caso medido em produção (Direct do
--     Instagram de um número sem IA);
--   * canal em pré-go-live com o contato fora da lista de teste — todo canal
--     novo nasce assim (`metadataInicialDoCanal`).
--
-- A consequência não é cosmética: a Fila (que pede `aguardando`) não mostra a
-- conversa, a troca de carteira a pula (`fn_definir_carteira_do_cliente` filtra
-- `comando_da_conversa(c) <> 'automatico'`) e o dreno do agent-engine descarta o
-- turno — ninguém a vê e ninguém responde.
--
-- A régua NÃO é nova: é a MESMA que o dreno já aplica antes de gastar
-- (`lib/ai/agents/quem-atende-a-sessao.ts`, `haQuemAtendaASessao`) mais o
-- portão de pré-go-live (`lib/ai/elegibilidade/pre-go-live.ts`,
-- `numeroPodeTestar`). O que muda é quem pode perguntá-la: até aqui só o
-- TypeScript do worker, porque a resposta exigia ler `ai_agents`,
-- `ai_agent_versions` e `ai_routers` — tabelas fora do alcance de um campo
-- calculado comum. Com uma função `security definer` ela passa a valer também
-- para o PostgREST e para as funções PL/pgSQL, que é onde a mentira doía.
--
-- `pausado` fica FORA de propósito: pausar pela tela grava `paused_at` e a
-- versão segue publicada, mas o turno sai na pausa antes de rodar
-- (`inbound-turn.ts`). Agente pausado não responde, e prometer que responde é a
-- mentira que esta migration fecha. É a mesma régua de `agenteAtende`
-- (`lib/ai/agents/no-ar.ts`), que `orgTemAutomatico` usa.
--
-- Custo: o wrapper passou a rodar 3 EXISTS + 1 leitura de metadata por linha
-- `automatico`. Só as linhas que SERIAM `automatico` pagam (o `case` é o
-- predicado), e são exatamente as que precisam da resposta. ponytail: se a
-- contagem das abas pesar numa organização com muitas conversas, o caminho é
-- materializar o fato por (org, sessão) em cache — não replicar a régua.
-- ============================================================================

-- ─── (1) a régua, numa função só ─────────────────────────────────────────────
create or replace function public.fn_automatico_da_conversa(
  p_organization_id   uuid,
  p_channel_session_id uuid,
  p_telefone          text
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $automatico$
declare
  v_quem        boolean;
  v_metadata    jsonb;
  v_numeros     jsonb;
  v_variantes   text[];
  v_numero      text;
begin
  -- (a) HÁ QUEM ATENDA ESTE NÚMERO? Espelho de `haQuemAtendaASessao`
  -- (lib/ai/agents/quem-atende-a-sessao.ts): agente publicado na sessão, ou
  -- roteador ativo nela cujo fallback/membro pode EXECUTAR (versão publicada,
  -- não arquivado, não pausado). Medir a existência da linha em
  -- `ai_router_members` deixaria o portão aberto para roteador de membros todos
  -- pausados — a mesma correção que o SQL do worker já carrega.
  select
    exists (
      select 1
        from public.ai_agents a
        join public.ai_agent_versions v on v.id = a.published_version_id
       where a.organization_id = p_organization_id
         and a.archived_at is null
         and a.paused_at is null
         and v.status = 'published'
         and v.channel_session_id = p_channel_session_id
    )
    or exists (
      select 1
        from public.ai_routers r
       where r.organization_id = p_organization_id
         and r.is_active
         and r.channel_session_id = p_channel_session_id
         and (
           exists (
             select 1
               from public.ai_agents fa
               join public.ai_agent_versions fv on fv.id = fa.published_version_id
              where fa.id = r.fallback_agent_id
                and fa.organization_id = p_organization_id
                and fa.archived_at is null
                and fa.paused_at is null
                and fv.status = 'published'
           )
           or exists (
             select 1
               from public.ai_router_members m
               join public.ai_agents ma on ma.id = m.agent_id
               join public.ai_agent_versions mv on mv.id = ma.published_version_id
              where m.router_id = r.id
                and ma.organization_id = p_organization_id
                and ma.archived_at is null
                and ma.paused_at is null
                and mv.status = 'published'
           )
         )
    )
  into v_quem;

  if v_quem is not true then
    return false;
  end if;

  -- (b) O CANAL ESTÁ EM PRÉ-GO-LIVE? Espelho de `numeroPodeTestar`
  -- (lib/ai/elegibilidade/pre-go-live.ts): a lista do canal é a ÚNICA
  -- autorização positiva, e o nono dígito é comparado nas duas direções por
  -- `fn_telefone_variantes` — a mesma função que o resto do banco usa.
  select s.metadata
    into v_metadata
    from public.channel_sessions s
   where s.id = p_channel_session_id
     and s.organization_id = p_organization_id;

  -- Canal sem metadata (o legado) não tem gate: nada a perguntar.
  if v_metadata is null then
    return true;
  end if;
  if coalesce(v_metadata ->> 'ai_gate', '') <> 'allowlist' then
    return true;
  end if;
  if coalesce(v_metadata ->> 'ai_gate_mode', '') <> 'pre_go_live' then
    return true;
  end if;

  v_numeros := v_metadata -> 'ai_test_phone_numbers';
  if v_numeros is null or jsonb_typeof(v_numeros) <> 'array' or jsonb_array_length(v_numeros) = 0 then
    return false;
  end if;
  if p_telefone is null or btrim(p_telefone) = '' then
    return false;
  end if;

  v_variantes := public.fn_telefone_variantes(p_telefone);
  if coalesce(array_length(v_variantes, 1), 0) = 0 then
    return false;
  end if;

  for v_numero in select jsonb_array_elements_text(v_numeros) loop
    -- Item inválido é IGNORADO, nunca vira match permissivo — a mesma regra de
    -- `lerNumerosDeTeste` (zod): só telefone com DDI e ao menos 8 dígitos.
    if v_numero ~ '^\+[1-9][0-9 ()-]*$'
       and length(regexp_replace(v_numero, '\D', '', 'g')) >= 8
       and public.fn_telefone_variantes(v_numero) && v_variantes
    then
      return true;
    end if;
  end loop;

  return false;
end;
$automatico$;

comment on function public.fn_automatico_da_conversa(uuid, uuid, text)
  is 'Há agente que vai responder ESTA conversa? Espelho SQL do portão do dreno (haQuemAtendaASessao) + pré-go-live (numeroPodeTestar). false = sem agente publicado no número, ou contato fora da lista de teste do canal. Issue #4012.';

revoke execute on function public.fn_automatico_da_conversa(uuid, uuid, text) from public, anon;
grant  execute on function public.fn_automatico_da_conversa(uuid, uuid, text) to authenticated, service_role;

-- ─── (2) o comando deixa de mentir ──────────────────────────────────────────
-- `create or replace` preserva a ACL e a forma da 0404 (parâmetro SEM NOME: com
-- nome a PostgREST a exporia em /rpc e uma linha fabricada leria force_human de
-- outro tenant). O corpo é o da 0482 com uma pergunta a mais: quando a regra
-- diria `automatico`, o número ainda tem quem atenda? Se não, é `aguardando` —
-- a Fila mostra e a carteira leva.
create or replace function public.comando_da_conversa(public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select case
    when base.comando = 'automatico'
     and not public.fn_automatico_da_conversa(
           $1.organization_id,
           $1.channel_session_id,
           base.telefone
         )
    then 'aguardando'
    else base.comando
  end
  from (
    select
      public.fn_comando_da_conversa(
        $1.status,
        $1.assigned_to_user_id,
        $1.bot_silenced_until,
        coalesce((select ct.force_human from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id), false),
        coalesce((select ct.is_blocked  from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id), false),
        now(),
        coalesce($1.is_group, false)
      ) as comando,
      (select ct.phone_number from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id) as telefone
  ) as base;
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). Resolve o contato e carimba now(); a regra em si é fn_comando_da_conversa, e `automatico` é rebaixado a `aguardando` quando nenhum agente vai responder este número (fn_automatico_da_conversa, issue #4012). SECURITY DEFINER desde a 0404 (issue #1571); parâmetro SEM NOME de propósito. Passa is_group desde a 0482.';

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- ─── (3) o mesmo fato como campo calculado, para o espelho TypeScript ───────
-- A tela não pode recalcular `automatico` por conta própria e continuar
-- dizendo "Automático atendendo" onde o banco já respondeu `aguardando`: é a
-- divergência de duas réguas que este PR fecha. O campo entrega o FATO (há
-- quem atenda?) para `comandoDaConversa()` decidir junto com o resto.
create or replace function public.automatico_da_conversa(public.conversations)
returns boolean
language sql
stable
security definer
set search_path = public
as $campo$
  select public.fn_automatico_da_conversa(
    $1.organization_id,
    $1.channel_session_id,
    (select ct.phone_number from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id)
  );
$campo$;

comment on function public.automatico_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: há agente que vai responder ESTA conversa? Alimenta o espelho TypeScript (comandoDaConversa, lib/inbox/comando-da-conversa.ts) para a tela não recalcular a mesma pergunta com outra régua. Issue #4012.';

revoke execute on function public.automatico_da_conversa(public.conversations) from public, anon;
grant  execute on function public.automatico_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
