-- manifest: O escopo de leitura da conversa passa a ser avaliado UMA VEZ por consulta (`fn_conversation_scope()`) em vez de uma vez por linha (`fn_can_view_conversation`): a caixa de entrada deixa de custar ~7 ms por linha no RLS (#3090)
--
-- ─── O defeito, medido (issue #3090) ────────────────────────────────────────
--
-- A policy `conversations_select` (migration 0035) chamava
-- `fn_can_view_conversation(organization_id, assigned_to_user_id)` em TODA linha
-- candidata. Aquela função é `stable security definer set search_path = public`;
-- o corpo dela chama `fn_is_platform_admin()` e, até DUAS vezes por linha,
-- `fn_user_role_in_org(p_org)`, que por sua vez chama `fn_support_context()`
-- (join de 4 tabelas + `auth.jwt()` + subconsulta de MFA em `auth.mfa_factors`).
--
-- Medido em Postgres descartável (mesmo baseline, 142 conversas, uma organização,
-- um dono e um atendente; a linha é a média de 3 execuções como `authenticated`):
--
--   `select count(*) from conversations` (RLS) .................. 226 ms (pg15) / 232 ms (pg17)
--   `fn_user_role_in_org(org)` por linha ....................... 84,8 ms para 142 linhas
--   `fn_can_view_conversation(org, responsável)` por linha ..... 214 ms para 142 linhas
--   o MESMO papel lido direto da tabela (index scan) ........... 0,09 ms para 142 linhas
--
-- O custo é o NÚMERO DE CHAMADAS: o trabalho por linha é 2× `fn_user_role_in_org`
-- (cada um refazendo `fn_support_context()`, que não depende da linha nem da
-- organização — depende só da sessão). No `pg_stat_statements` do autor, as
-- consultas do PostgREST sobre `conversations` ficam entre 720 ms e 1430 ms, e
-- numa instalação maior o custo cresce linear com o número de conversas até
-- estourar o statement timeout de 8 s.
--
-- ─── O conserto: o que é da SESSÃO sai do caminho por linha ────────────────
--
-- `fn_conversation_scope()` devolve, por organização a que o usuário tem acesso
-- (`fn_user_org_ids()` — a MESMA fonte que `fn_user_role_in_org` usa para dizer
-- "não é membro"), duas respostas:
--
--   · `org_wide_read` — enxerga a organização inteira (papel viewer/manager/admin
--     ou `visibility_mode = 'all'`);
--   · `sees_unassigned` — enxerga a fila sem responsável (`own_and_unassigned`).
--
-- A policy passa a comparar a LINHA com esse conjunto, e o ramo de plataforma
-- vira um InitPlan sem argumento. O plano medido depois (142 conversas, um
-- atendente) é esta forma, e é ela que o invariante cobra:
--
--   InitPlan 1  -> Result                      -- `(select fn_is_platform_admin())`, 1×
--   Seq Scan on conversations
--     Filter: (InitPlan 1).col1
--          OR ANY (organization_id = (hashed SubPlan 2).col1)
--          OR ((assigned_to_user_id = auth.uid()) AND ANY (organization_id = (hashed SubPlan 3).col1))
--          OR ((assigned_to_user_id IS NULL) AND ANY (organization_id = (hashed SubPlan 4).col1))
--     SubPlan 2 -> Function Scan on fn_conversation_scope s   loops=1  (org_wide_read)
--     SubPlan 3 -> Function Scan on fn_conversation_scope s_1 loops=1  (membro)
--     SubPlan 4 -> Function Scan on fn_conversation_scope s_2 loops=1  (sees_unassigned)
--
-- Nenhuma chamada de função por linha: cada subplano sem correlação é calculado
-- UMA vez no início da consulta (o `loops=1` é o que se mede) e o filtro por
-- linha é teste de pertinência em conjunto — o `hashed SubPlan`. As três
-- disjunções precisam de três conjuntos diferentes (tudo / membro / fila), então
-- são três avaliações por consulta, não uma: o que sai do caminho é a ORDEM de
-- grandeza por LINHA (142 chamadas de `fn_can_view_conversation`, cada uma com
-- 2× `fn_user_role_in_org`, viram 3 leituras do conjunto e nenhuma por linha).
-- A prova de execução única, além do plano, está medida com uma sonda
-- `volatile` que grava uma linha a cada execução: uma execução por subplano
-- (o caso mais difícil — o planejador não pode memoizar nem pular uma volatile).
-- O invariante `tests/invariants/escopo-da-conversa-avaliado-uma-vez.test.ts`
-- cobra as duas pontas: o plano não chama `fn_can_view_conversation` por linha,
-- e a sonda roda uma vez por consulta, não uma vez por conversa.
--
-- Resultado da mesma medição depois: `select count(*)` em 142 conversas .........
-- 4,9 ms (pg17) / 6,9 ms (pg15) — ~40× menos, e o custo deixa de crescer com o
-- número de LINHAS avaliadas (as 142 candidatas passam por teste de pertinência
-- em array; quem cresce é o tamanho do conjunto, uma linha por organização).
--
-- ─── Visibilidade IDÊNTICA (a policy não afrouxa nem aperta) ────────────────
--
-- A escada da 0035 é preservada cláusula por cláusula:
--
--   1. `fn_is_platform_admin()` ⇒ tudo (InitPlan, primeira disjunção);
--   2. não é membro da organização ⇒ nada. `fn_user_org_ids()` devolve
--      exatamente as organizações em que `fn_user_role_in_org(org)` NÃO é nulo
--      (as `user_organizations` não revogadas MAIS a organização da sessão de
--      suporte ativa, quando há uma) — quem não está no conjunto não casa com
--      nenhuma disjunção, nem quando a conversa está atribuída a ele;
--   3. papel viewer/manager/admin ⇒ tudo (dobrado em `org_wide_read`);
--   4. responsável = `auth.uid()` ⇒ vê, em qualquer organização em que seja
--      membro (o `and organization_id in (…)` do 3º ramo é a alínea 2);
--   5. resto ⇒ `visibility_mode`: `'all'` entra em `org_wide_read`;
--      `'own_and_unassigned'` é o único valor que entra em `sees_unassigned`;
--      qualquer outro valor (inclusive `'own'` e um valor inválido no JSON)
--      fica nas duas colunas como falso — só o responsável vê, que é o
--      `else false` da escada. A chave ausente continua caindo no default
--      `own_and_unassigned` (G1-06a), pelo `coalesce` idêntico ao da 0035.
--
-- O caso 5 é onde um atalho erra: `sees_unassigned` NÃO é `mode <> 'own'`
-- (isso daria fila visível a um valor inválido); é `mode = 'own_and_unassigned'`.
--
-- ─── O que NÃO mudou (e por quê) ────────────────────────────────────────────
--
-- · `fn_can_view_conversation` segue intacta e continua sendo a fonte da verdade
--   da escada: ela é chamada por `conversation_notes`, `ai_reply_drafts`,
--   `conversation_assignment_events`, `crm_cases` e pelos comandos de atribuição
--   (`messages` não a chama: a policy dela consulta `conversations` e por isso
--   herda a regra nova) — trocar o corpo dela mudaria o
--   custo de todas elas e ampliaria o raio desta fatia sem necessidade. O novo
--   invariante compara, pessoa por pessoa, o que a policy devolve com o que ela
--   devolve: se as duas escadas divergirem no futuro, o teste fica vermelho.
-- · O `SET search_path = public` das funções chamadas por linha FICA. Medido nas
--   duas majors: o `SET` custa ~2 ms POR CONSULTA, não por linha (com `SET`,
--   `fn_user_org_ids()` interna deixa de ser embutida: 2,606 ms contra 0,491 ms
--   do scan embutido, para 142 linhas), e removê-lo de uma `security definer`
--   é justamente o sequestro de `search_path` que a convenção do repositório
--   evita. O ganho desta fatia não vem de mexer nele: mesmo com o `SET`, o custo
--   por LINHA desapareceu. O corpo continua chamando `fn_user_org_ids()` em vez
--   de ler `user_organizations` direto: é ela a fonte única de "quem é membro"
--   (inclui a organização da sessão de suporte ativa) e forkar essa regra para
--   economizar 2 ms por consulta seria repetir a definição de isolamento em dois
--   lugares.
-- · `fn_support_context()`, `fn_user_role_in_org()` e `fn_user_org_ids()` não são
--   tocadas: elas seguem sendo o caminho de quem precisa do papel de UMA
--   organização (as rotas, os comandos, os outros consumidores).

-- A escada por organização, resolvida uma vez por consulta.
--
-- `stable` + `security definer` + search_path blindado, como as irmãs
-- `fn_can_view_conversation`/`fn_can_view_lead`: o corpo lê `user_organizations`
-- e `organizations` (RLS de ambas mostra só o que é do próprio usuário, mas o
-- definer mantém o comportamento independente de quem chama) e o EXECUTE fica
-- com authenticated/service_role.
create or replace function public.fn_conversation_scope()
returns table (organization_id uuid, org_wide_read boolean, sees_unassigned boolean)
language sql stable security definer
set search_path = public
as $$
  select o.organization_id,
         public.fn_user_role_in_org(o.organization_id) in ('viewer','manager','admin')
           or coalesce((select z.settings->>'visibility_mode' from public.organizations z
                        where z.id = o.organization_id), 'own_and_unassigned') = 'all',
         coalesce((select z.settings->>'visibility_mode' from public.organizations z
                   where z.id = o.organization_id), 'own_and_unassigned') = 'own_and_unassigned'
  from public.fn_user_org_ids() as o(organization_id);
$$;

revoke all on function public.fn_conversation_scope() from public, anon;
grant execute on function public.fn_conversation_scope() to authenticated, service_role;

-- A policy: o mesmo resultado da 0035, sem uma chamada por linha.
drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
         select s.organization_id from public.fn_conversation_scope() s where s.org_wide_read
       )
    or (
         assigned_to_user_id = auth.uid()
         and organization_id in (select s.organization_id from public.fn_conversation_scope() s)
       )
    or (
         assigned_to_user_id is null
         and organization_id in (
              select s.organization_id from public.fn_conversation_scope() s where s.sees_unassigned
            )
       )
  );
