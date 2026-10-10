-- As proteções de tabela de organização saem do laço do baseline para funções
-- SEM PARÂMETRO — o mecanismo que a ADR-0002 (D5) exige para que uma tabela
-- criada DEPOIS do baseline nasça protegida.
--
-- Lei: docs/adr/0002-tabelas-de-modulo-num-banco-so.md, decisão D5:
--   "Essas rotinas saem do laço do baseline para funções sem parâmetro,
--    chamadas pelo baseline e pela provisionadora."
--
-- É a segunda metade do conserto que a 0274 começou. Lá, as três policies
-- restritivas do modo somente-leitura do suporte eram um `do $$` avulso no meio
-- do arquivo — uma enumeração só alcança a tabela que existe no instante em que
-- ela roda. Aqui são as outras três proteções: RLS ligada, `revoke all … from
-- anon` e o isolamento por organização.
--
-- ─── a regra de seleção, e por que ela NÃO é "toda tabela com organization_id"
--
-- Selecionar toda tabela de organização seria a leitura óbvia — e foi medida,
-- num pg17 descartável com o `supabase/baseline.sql` de `ed42ad119` aplicado
-- com ON_ERROR_STOP=1 (18/09/2026). As 119 tabelas de organização deste banco:
--
--     sem RLS ligada .......................................   0
--     com algum privilégio ainda concedido a `anon` ........  49
--     com RLS ligada e ZERO policies (server-only) .........   8
--     sem a policy ampla `tenant_isolation_<t>_all` ........  66
--
-- Uma varredura cega pelos 119 mudaria o comportamento do baseline em três
-- direções, e duas delas são regressão de segurança:
--
--   * revogaria `anon` de 49 tabelas que as listas enumeradas do baseline nunca
--     tocaram — melhora plausível, mas é MUDANÇA, e não é o que esta migration
--     se propõe a fazer;
--   * daria a policy ampla às 8 tabelas server-only (`platform_support_sessions`,
--     `extension_operations`, `channel_connection_requests`, …), cujo contrato é
--     exatamente RLS ligada SEM policy — abriria cada uma a todo membro da org;
--   * atropelaria as policies POR PAPEL de 66 tabelas. O próprio baseline avisa
--     disso na linha de `ai_routers`/`ai_router_members`: recriar a policy ampla
--     ali "fazia cada update.sh reabrir escrita a qualquer membro da organização".
--
-- A régua certa é o estado de quem AINDA NÃO FOI DECIDIDO, e ele tem um
-- discriminador exato: **RLS desligada**. Medido no mesmo banco, uma tabela de
-- organização recém-criada (o que a provisionadora de um módulo produz) nasce
--
--     relrowsecurity = false · anon com SELECT · authenticated com INSERT · 0 policies
--
-- e nenhuma das 119 tabelas do baseline está nesse estado (a linha "sem RLS
-- ligada = 0" acima, que `tests/invariants/rls-completude-varredura.test.ts` já
-- cobra como invariante obrigatório). Então a varredura sobre `not
-- relrowsecurity` é, por construção, **no-op no baseline de hoje** e **exata**
-- para a tabela de módulo de amanhã.
--
-- Consequência declarada: o módulo que quiser uma tabela server-only, ou com
-- policy por papel, liga a RLS ELE MESMO dentro da provisionadora. A partir daí
-- esta rotina não a enxerga, e as policies dele são as que valem.
--
-- ─── por que as listas enumeradas do baseline continuam onde estão ───────────
--
-- Porque trocá-las por esta varredura no MEIO do arquivo mudaria o resultado: no
-- ponto de cada laço, tabela nenhuma garante já ter RLS — a medição acima é do
-- estado FINAL. Substituí-las exige medir o catálogo em cada um daqueles pontos,
-- e isso é mudança de comportamento, não extração. O que esta migration entrega
-- é a rotina auto-curativa chamada DEPOIS de tudo, no mesmo lugar e pelo mesmo
-- motivo que a 0274: quem vier criar tabela de organização sem as proteções é
-- curado no mesmo run em que o defeito nasceria.
--
-- ─── quem pode chamar ────────────────────────────────────────────────────────
--
-- Só quem aplica o schema, que é o dono das tabelas: `alter table … enable row
-- level security` e `create policy` exigem ser dono. Nenhuma das duas é
-- `security definer` — executada por outro papel, falharia no primeiro comando.
-- A provisionadora de módulo (essa sim `security definer`, ADR D2/D4) as chama
-- de dentro, rodando como o dono, que é o caminho previsto.
--
-- Mesmo assim o EXECUTE sai das DUAS origens (CLAUDE.md, migrations item 9): o
-- grant a PUBLIC que o Postgres dá ao criar a função, e o grant DIRETO do
-- `alter default privileges … grant all on functions to anon` do baseline, que
-- alcança também `authenticated` e `service_role`. `revoke from public` não
-- remove o primeiro; `revoke from anon` não remove o segundo.

create or replace function public.fn_proteger_tabelas_de_organizacao()
returns void
language plpgsql
set search_path = public
as $f$
declare r record;
begin
 for r in
   select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
      and exists (
        select 1 from pg_attribute a
         where a.attrelid = c.oid
           and a.attname = 'organization_id'
           and a.attnum > 0
           and not a.attisdropped)
    order by c.relname
 loop
   execute format('alter table public.%I enable row level security', r.relname);
   execute format('revoke all on public.%I from anon', r.relname);
   -- Mesma forma do laço enumerado do baseline, inclusive o `drop policy if
   -- exists` antes do `create`: reaplicar converge para o mesmo catálogo.
   execute format('drop policy if exists tenant_isolation_%s_all on public.%I', r.relname, r.relname);
   execute format(
     'create policy tenant_isolation_%s_all on public.%I for all
        using (organization_id in (select * from public.fn_user_org_ids()))
        with check (organization_id in (select * from public.fn_user_org_ids()))',
     r.relname, r.relname);
 end loop;
end $f$;

-- O ponto de entrada que a provisionadora de um módulo chama no FIM do corpo
-- dela, na MESMA transação em que criou as tabelas (ADR D5). É uma função só
-- para que o módulo não precise conhecer a lista de proteções nem a ordem
-- delas — e a ORDEM importa: as travas do suporte (0274) leem o privilégio de
-- `authenticated` em cada tabela para decidir entre as três policies
-- restritivas e o contrato server-only, então elas vêm DEPOIS de a RLS e o
-- isolamento estarem no lugar.
create or replace function public.fn_proteger_modulo_provisionado()
returns void
language plpgsql
set search_path = public
as $f$
begin
  perform public.fn_proteger_tabelas_de_organizacao();
  perform public.fn_aplicar_travas_de_suporte();
end $f$;

revoke execute on function public.fn_proteger_tabelas_de_organizacao() from public, anon, authenticated, service_role;
revoke execute on function public.fn_proteger_modulo_provisionado() from public, anon, authenticated, service_role;

do $f$ begin perform public.fn_proteger_tabelas_de_organizacao(); end $f$;
