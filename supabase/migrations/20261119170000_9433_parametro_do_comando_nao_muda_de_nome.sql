-- manifest: **A atualização que parava em `cannot change name of input parameter "c"` (1.118 → 1.119) passa a se curar sozinha.** O bloco da 0203 no `baseline.sql` recriava `comando_da_conversa(c public.conversations)` COM nome a cada `update.sh`, e só os três `drop` do meio do arquivo desfaziam isso; quando nenhum tinha efeito (objeto dependente, ou duas aplicações do baseline ao mesmo tempo, medidos num pg17 descartável), os `create or replace` sem nome do fim paravam a atualização e o banco ficava com o corpo antigo, invoker e sem o rebaixamento da #4012. Agora nenhuma definição dá nome ao parâmetro, e um `drop` condicional, só quando o parâmetro tem nome, vem ANTES da primeira. Esta migration é esse `drop` mais a definição atual (a da 9331, sem mudança), para a cadeia e para o fim do apêndice: idempotente, sem efeito no banco são. Espelho no `baseline.sql`.
-- ============================================================================
-- O PARÂMETRO DE `comando_da_conversa` NÃO MUDA MAIS DE NOME
--
-- ─── O que quebrava ─────────────────────────────────────────────────────────
-- O Postgres deixa um `create or replace` DAR nome a um parâmetro sem nome, e
-- recusa TROCAR um nome que já existe. O bloco da 0203 no baseline dava o nome
-- `c`; a 0404 e as seguintes redefinem sem nome. Entre os dois, só os `drop`.
--
-- ─── O que esta migration faz ───────────────────────────────────────────────
-- 1. Se a função está com parâmetro nomeado (o banco que parou no meio da
--    1.119), derruba. Um objeto de fora do Deskcomm que dependa dela impede o
--    `drop`, e o erro diz qual é.
-- 2. Redefine a função com o corpo de hoje (o da 9331, sem mudança), SECURITY
--    DEFINER e sem nome, e refaz as duas origens de EXECUTE.
-- No banco são, o passo 1 não faz nada e o passo 2 regrava o mesmo corpo.
-- ============================================================================

do $cura_parametro_c$
declare
  v_fn oid := to_regprocedure('public.comando_da_conversa(public.conversations)');
begin
  if exists (
    select 1 from pg_proc p, unnest(p.proargnames) as a(nome)
     where p.oid = v_fn and a.nome <> ''
  ) then
    drop function public.comando_da_conversa(public.conversations);
  end if;
exception when dependent_objects_still_exist then
  raise exception 'comando_da_conversa(conversations) está com o parâmetro "c" e não pôde ser recriada sem nome, porque estes objetos, que não vêm do Deskcomm, dependem dela: %',
    (select string_agg(distinct pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
       from pg_depend d
      where d.refclassid = 'pg_proc'::regclass and d.refobjid = v_fn and d.deptype = 'n');
end
$cura_parametro_c$;

create or replace function public.comando_da_conversa(public.conversations)
returns text
language sql
stable
security definer
set search_path = public
as $comando$
  select case
    -- Dono, fim e trava decidem ANTES (`fn_comando_da_conversa`) e não passam
    -- pelas perguntas abaixo: elas só alcançam o `automatico`, o único comando
    -- que promete alguém respondendo.
    when base.comando <> 'automatico' then base.comando
    when not public.fn_org_tem_automatico($1.organization_id) then 'ninguem'
    when not public.fn_automatico_da_conversa(
           $1.organization_id,
           $1.channel_session_id,
           $1.contact_id
         )
    then 'aguardando'
    else 'automatico'
  end
  from (
    select
      public.fn_comando_da_conversa(
        $1.status,
        $1.assigned_to_user_id,
        $1.bot_silenced_until,
        -- O bit da LINHA (contato_trava_humano), não subconsulta a contacts:
        -- a migration 0645 moveu a trava para a conversa justamente para
        -- acabar com duas consultas por linha (issue #2739).
        $1.contato_trava_humano,
        false,
        now(),
        coalesce($1.is_group, false)
      ) as comando
  ) as base;
$comando$;

comment on function public.comando_da_conversa(public.conversations)
  is 'Campo calculado exposto pelo PostgREST: ?select=comando_da_conversa e ?comando_da_conversa=in.(...). Resolve o contato e carimba now(); a regra em si é fn_comando_da_conversa, e `automatico` é rebaixado a `ninguem` quando a organização não tem agente no ar (fn_org_tem_automatico) e a `aguardando` quando nenhum agente vai responder este número (fn_automatico_da_conversa) — issue #4012. SECURITY DEFINER desde a 0404 (issue #1571); parâmetro SEM NOME de propósito. Passa is_group desde a 0482.';

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
