-- ═══════════════════════════════════════════════════════════════════════════
-- 0404 — a caixa de abas da Inbox volta a ser barata: `comando_da_conversa`
-- deixa de reavaliar a RLS de `contacts` DUAS vezes por conversa.
--
-- ─── O que dói (issue #1571, medido em v1.46.0, 528 conversas, PostgreSQL 17.6) ──
-- As contagens das abas filtram por `comando_da_conversa(c)` e levam de 1,8 a
-- 2,2 s CADA uma (média do `pg_stat_statements`, 86 chamadas), e a tela dispara
-- várias por vez. A mesma consulta, três medidas:
--
--   papel `authenticated` (dono da org) .... 823–846 ms
--   papel `postgres` (sem RLS) ............. 25 ms
--   `authenticated`, com a função DEFINER .. 75–94 ms
--
-- ─── A causa ────────────────────────────────────────────────────────────────
-- A 0203 criou a função INVOKER de propósito ("respeita RLS de quem pergunta")
-- — decisão certa na origem, e a razão escrita no MANIFEST. O custo dela só
-- ficou visível com a instalação grande: cada uma das duas subconsultas em
-- `contacts` roda COM o papel de quem chama e reavalia
-- `tenant_isolation_contacts_all` — `organization_id IN (SELECT fn_user_org_ids())
-- OR fn_is_platform_admin()` — funções SECURITY DEFINER que o Postgres NÃO
-- inlina, DUAS vezes por conversa, além da policy da própria linha.
--
-- ─── Por que SECURITY DEFINER não enfraquece a RLS aqui ─────────────────────
-- A função recebe a LINHA da conversa: ela só chega ao chamador depois de
-- passar pela RLS de `conversations` (coluna calculada do PostgREST é avaliada
-- sobre as linhas que o filtro devolveu). Daquela linha ela lê apenas
-- `force_human` e `is_blocked` do CONTATO DESSA conversa, e devolve só o texto
-- do comando — nenhum dado do contato vai para a resposta. As abas vistas pelo
-- usuário antes e depois foram conferidas na issue (contagem por comando com o
-- papel `authenticated`): idênticas.
--
-- As duas subconsultas em `contacts` também exigem `ct.organization_id =
-- $1.organization_id`. A policy de UPDATE de `conversations` confere empresa e
-- papel, não o `contact_id`, e a checagem da FK para `contacts` não passa pela
-- RLS: sem o predicado, uma conversa da própria empresa apontada para o contato
-- de OUTRA leria, sob o definer, os dois bits dele. A busca segue pela chave
-- primária, então o predicado não custa nada.
--
-- ─── O parâmetro SEM NOME não é estilo, é a metade da segurança ─────────────
-- A PostgREST expõe coluna calculada com parâmetro NAMEDADO em `/rpc`
-- (documentação v10 e v12: "use an unnamed parameter to prevent it from being
-- exposed as an RPC under /rpc"). Com a função virando DEFINER, `/rpc/
-- comando_da_conversa` passaria a aceitar uma LINHA FABRICADA de `conversations`
-- e devolver o `force_human`/`is_blocked` REAL de qualquer `contact_id` — leitura
-- cross-tenant de dois bits, exatamente o enfraquecimento que este conserto
-- precisa NÃO abrir. Parâmetro sem nome mantém a coluna calculada
-- (`?select=comando_da_conversa` e `?comando_da_conversa=in.(...)`, os
-- caminhos que a Inbox usa) e derruba o `/rpc`.
--
-- DROP + CREATE porque o Postgres recusa `create or replace` trocando o nome do
-- parâmetro ("cannot change name of input parameter") — e SEM `cascade`: medi,
-- que em `supabase/` nenhum view, índice ou função depende desta (as únicas
-- referências são create/comment/revoke/grant dela mesma). A troca de forma do
-- schema pede `notify pgrst, 'reload schema'` — sem ele o PostgREST continua
-- servindo o `/rpc` velho até alguém reiniciar o serviço à mão, o passo manual
-- que a doutrina de packaging proíbe.
--
-- Grants: o DROP leva a ACL junto, então as DUAS origens de EXECUTE da regra 9
-- voltam explícitas (revoke de public e anon; grant a authenticated e
-- service_role) — e a varredura anon do baseline, que percorre
-- `p.prosecdef`, a alcança a partir de agora e preserva os dois grants.
--
-- Reaplicação: `drop if exists` + `create` idempotentes — o `update.sh` de um
-- clone re-executa sem erro. No `baseline.sql` o mesmo bloco está no APÊNDICE,
-- logo ANTES da varredura anon (a definição do meio ainda nasce
-- namedada+invoker, como a 0203 a criou; o apêndice é quem aplica esta decisão
-- depois dela, e a varredura, que vem depois, tira o `anon` dela).
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.comando_da_conversa(public.conversations);

-- Parâmetro SEM NOME, de propósito (leia o bloco acima): é o que a PostgREST
-- lê para NÃO publicar a função em /rpc.
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
    -- `coalesce` porque `contact_id` é anulável no schema: contato ausente não
    -- pode virar `null` e derrubar a linha inteira para fora de todo filtro —
    -- o efeito seria uma conversa invisível em TODAS as abas.
    coalesce((select ct.force_human from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id), false),
    coalesce((select ct.is_blocked  from public.contacts ct where ct.id = $1.contact_id and ct.organization_id = $1.organization_id), false),
    now()
  );
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). Resolve o contato e carimba now(); a regra em si é fn_comando_da_conversa. SECURITY DEFINER desde a 0404 (issue #1571: a contagem das abas reavaliava a RLS de contacts 2x por conversa); parâmetro SEM NOME de propósito — com nome a PostgREST a exporia em /rpc, e ali uma linha fabricada leria force_human/is_blocked de outro tenant.';

-- As DUAS origens de EXECUTE (regra 9): o DROP levou a ACL embora.
revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

-- A forma do schema mudou (o /rpc some): sem isto o PostgREST segue servindo o
-- schema velho até um reinício manual — o passo que a doutrina de packaging
-- proíbe pedir a quem opera a VPS.
notify pgrst, 'reload schema';
