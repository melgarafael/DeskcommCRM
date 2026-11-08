-- manifest: O comando da conversa só diz "automatico" com agente publicado na organização, e a troca de carteira passa a levar a conversa (#4012).
-- ============================================================================
-- 9252 — O COMANDO DA CONVERSA SABE SE HÁ AGENTE NO AR
--
-- `fn_comando_da_conversa` respondia `automatico` para TODA conversa sem dono e
-- sem trava, sem perguntar se a organização tem agente publicado. Quem decide
-- pelo banco não compensava: `fn_definir_carteira_do_cliente` (#3642) e
-- `fn_conversation_assign` (#3732, e a adoção de `fn_conversa_que_continua`)
-- filtram `public.comando_da_conversa(c) <> 'automatico'`. Numa instalação sem
-- IA no ar — a primeira impressão de quem instala —, passar o cliente para um
-- vendedor não levava NENHUMA conversa: a regra do Doc 237 ("a conversa que a
-- IA atende fica com a IA") era aplicada onde não há IA.
--
-- O TypeScript já sabia. `comandoDaConversa()` devolve `ninguem` quando
-- `automaticoDaOrg === false` (lib/inbox/comando-da-conversa.ts:249), e a Fila
-- compensava pedindo `aguardando` E `automatico` (`comandosDaFila`, :360). O
-- banco não tinha como responder porque a função era `immutable` e não tocava
-- tabela nenhuma: o fato da organização nunca chegava até ela.
--
-- A régua desta migration é a MESMA pergunta do TS, com o mesmo escopo
-- ORG-WIDE:
--
--   há agente no ar = existe `ai_agents` da organização com
--   `published_version_id` preenchido, `paused_at` nulo e `archived_at` nulo.
--
-- É exatamente `agenteAtende()` (lib/ai/agents/no-ar.ts:30, via
-- `estadoDoAgente`), a função que `orgTemAutomatico()`
-- (lib/ai/agents/org-tem-automatico.ts:23) usa para responder o fato à tela. A
-- régua NÃO olha canal nem número, porque o TS também não olha: a pergunta por
-- número ("há agente publicado NESTE canal?") é outra, mora no dreno
-- (`haQuemAtendaASessao`) e fica para a parte 2 do #4012.
--
-- Por que o parâmetro, e não uma subconsulta no wrapper: a regra é uma só para a
-- tela e para o banco, e a tela pergunta por ORGANIZAÇÃO. `p_organization_id`
-- entra como OITAVO parâmetro, com default — a assinatura de sete continua
-- chamável (o corpus de `tests/invariants/comando-da-conversa-espelha-o-ts.ts`
-- chama assim), e o default `null` quer dizer "não sei a organização" e preserva
-- a resposta antiga (`automatico`), a mesma convenção do TS, que só troca a
-- resposta quando SABE que não há automático (`automaticoDaOrg === false`,
-- nunca `undefined`). A sobrecarga de sete é removida antes, como fez a 0482:
-- duas sobrecargas com default tornariam a chamada de sete ambígua.
--
-- `immutable` vira `stable`: a função passa a ler `ai_agents`. Medido: ela não
-- aparece em índice, coluna gerada ou qualquer contexto que exija imutabilidade;
-- o wrapper `comando_da_conversa(conversations)` já era `stable`.
--
-- O wrapper passa `$1.organization_id`, então TODO consumidor do banco
-- (`fn_definir_carteira_do_cliente`, `fn_conversation_assign`,
-- `fn_conversa_que_continua`) herda a régua sem mudar uma linha — era o defeito:
-- cada um perguntava "isto é da IA?" e a resposta era sempre "sim".
-- ============================================================================

-- Duas sobrecargas com default são ambíguas: a de sete sai antes. Funções
-- `language sql` não registram dependência, então o DROP não arrasta o wrapper
-- `comando_da_conversa(c)` — que é recriado logo abaixo, passando a organização.
drop function if exists public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz, boolean);

create or replace function public.fn_comando_da_conversa(
  p_status                text,
  p_assigned_to_user_id   uuid,
  p_bot_silenced_until    timestamptz,
  p_force_human           boolean,
  p_is_blocked            boolean,
  p_agora                 timestamptz,
  p_is_group              boolean default false,
  p_organization_id       uuid    default null
) returns text
language sql
stable
set search_path = public
as $fn_comando$
  select case
    -- A ordem é a mesma de `comandoDaConversa`, e ela é o contrato: dono
    -- primeiro (a aba "Fechadas" precisa continuar dizendo QUEM atendeu),
    -- encerrada depois, e só então as travas — grupo entre elas.
    when p_assigned_to_user_id is not null then 'humano'
    when p_status in ('closed', 'archived', 'resolved') then 'encerrada'
    when p_is_group is true
      or p_force_human is true
      or p_is_blocked is true
      or (p_bot_silenced_until is not null and p_bot_silenced_until > p_agora) then 'aguardando'
    -- #4012: `automatico` é uma afirmação sobre quem RESPONDE, e quem responde é
    -- um agente publicado. Sem nenhum no ar, a conversa sem dono e sem trava
    -- espera gente — é `ninguem`, a resposta que `comandoDaConversa` já dava com
    -- `automaticoDaOrg === false` (lib/inbox/comando-da-conversa.ts:249).
    when p_organization_id is not null
      and not exists (
        select 1
          from public.ai_agents a
         where a.organization_id = p_organization_id
           and a.archived_at is null
           and a.paused_at is null
           and a.published_version_id is not null
      ) then 'ninguem'
    else 'automatico'
  end;
$fn_comando$;

comment on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz, boolean, uuid)
  is 'Quem manda na conversa. Espelho SQL de comandoDaConversa() (lib/inbox/comando-da-conversa.ts); as duas são casadas por tests/invariants/comando-da-conversa-espelha-o-ts.test.ts. Grupo sem dono é aguardando (migration 0482). Sem agente publicado na organização — published_version_id preenchido, paused_at e archived_at nulos, a régua de agenteAtende() (lib/ai/agents/no-ar.ts) — a conversa sem dono e sem trava é ninguem, não automatico (migration 9252, issue #4012); p_organization_id nulo preserva a resposta antiga.';

-- A regra é interna: quem a expõe é o wrapper, SECURITY DEFINER. Sem EXECUTE
-- para anon (nunca) nem para authenticated (não é API), como as vizinhas que
-- decidem em nome do tenant.
revoke execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.fn_comando_da_conversa(text, uuid, timestamptz, boolean, boolean, timestamptz, boolean, uuid) to service_role;

-- O campo calculado: mesma forma da 0404/0645 (SECURITY DEFINER, parâmetro sem
-- nome, trava lida da coluna `contato_trava_humano`), com o oitavo argumento.
drop function if exists public.comando_da_conversa(public.conversations);

create function public.comando_da_conversa(public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    $1.status,
    $1.assigned_to_user_id,
    $1.bot_silenced_until,
    -- O bit consolida `force_human OR is_blocked` (migration 0645); entra no
    -- primeiro parâmetro de trava e o segundo vai `false` — o OR da regra é
    -- comutativo, e o resultado é o mesmo do wrapper antigo, sem a subconsulta
    -- por linha.
    $1.contato_trava_humano,
    false,
    now(),
    coalesce($1.is_group, false),
    -- #4012: o fato org-wide que o servidor busca em `orgTemAutomatico()` entra
    -- AQUI. Era o único pedaço da regra que o banco não respondia sozinho.
    $1.organization_id
  );
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). A trava do contato vem da COLUNA contato_trava_humano (issue #2739), não de subconsulta por linha; o prazo do silêncio é avaliado NA CONSULTA com now() de verdade. SECURITY DEFINER e parâmetro SEM NOME desde a 0404 (issue #1571). Passa organization_id desde a 9252 (#4012): sem agente publicado na organização, conversa sem dono e sem trava é ninguem. A regra em si é fn_comando_da_conversa.';

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
