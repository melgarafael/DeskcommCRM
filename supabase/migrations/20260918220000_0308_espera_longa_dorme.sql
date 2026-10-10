-- 0308 — a espera longa dorme: status `dormente` para o nó `wait` imune à resposta
--
-- ═══ O QUE ISTO DESTRAVA ═══
--
-- Uma cadência de retorno ("volte a falar com a cliente daqui a 28 dias") não
-- cabia num fluxo. Duas coisas a matavam, as duas em silêncio:
--
--   1. `lib/followup/reactivity.ts` — quando o contato manda mensagem, a
--      inscrição parada num `wait` ou é CANCELADA (`cancel_on_reply`) ou ACORDA
--      com `inbound_woke`, e acordar CORTA o timer. Numa espera de 28 dias os
--      dois desfechos estão errados: a cliente de manutenção fala com o estúdio
--      várias vezes no período, e falar não é motivo para antecipar nem para
--      desistir do retorno.
--   2. O índice único anti-spam — uma espera de 28 dias ocuparia a vaga do
--      contato na organização inteira e o trancaria fora de qualquer outra
--      cadência por um mês.
--
-- Por isso a regra vivia no PROMPT do agente, mandando chamar
-- `crm_schedule_followup` (que grava em `cron_jobs`, é imune e não ocupa vaga).
-- Prompt não é lugar de cadência: não dá para editar o prazo, ver quem está
-- esperando, nem medir o que aconteceu.
--
-- ═══ POR QUE UM STATUS, E NÃO UMA COLUNA `imune` ═══
--
-- A imunidade é propriedade do NÓ (`wait.immune_to_reply`, no grafo pinado). O
-- status é a PROJEÇÃO dessa decisão na linha, escrita pelo mesmo mecanismo que
-- já projeta `waiting_reply` hoje (`wake_status` em node-handlers/engine). Uma
-- coluna booleana seria uma segunda verdade sobre o mesmo fato, e as duas
-- divergiriam no primeiro republish.
--
-- E é o status que faz a feature custar ZERO na reatividade: `LIVE_STATUSES` em
-- `reactivity.ts` não inclui `dormente`, então a inscrição dormente simplesmente
-- não é carregada — nenhuma query nova por mensagem recebida, nenhum grafo lido
-- ali. O opt-out é a exceção deliberada: STOP/LGPD alcança o dormente também.
--
-- ═══ O ÍNDICE ÚNICO NÃO MUDA, E ISSO É O PONTO ═══
--
-- `idx_followup_enrollments_one_live` enumera os status que OCUPAM vaga
-- ('active','waiting_reply','paused_handoff','paused_manual'). `dormente` fica
-- de fora por construção — a vaga é liberada sem uma linha de DDL sobre o
-- índice, e o guard anti-empilhamento continua exatamente com a força de antes
-- para os status que já cobria. Não mexa nele aqui.
--
-- Re-aplicável: os dois CHECKs só AMPLIAM o conjunto aceito, o predicado novo do
-- índice do claim cobre todas as linhas do antigo, e nenhum banco tem `dormente`
-- antes desta migration — não há o que deduplicar nem backfillar.

-- ---- 1. vocabulário de status ----------------------------------------------
--
-- Sai pelo CATÁLOGO, não pelo nome: num clone que passou por dump/restore o nome
-- gerado pode não ser o deste repo, e dropar por nome fixo falharia em silêncio
-- (o `add constraint` tropeçaria no duplicado, o `exception when
-- duplicate_object` engoliria, e o banco ficaria com o CHECK ANTIGO recusando
-- `dormente` num UPDATE que a aplicação considera válido). Mesmo cuidado da 0145.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'followup_enrollments'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%paused_manual%'
       and pg_get_constraintdef(con.oid) not like '%dormente%'
  loop
    execute format('alter table public.followup_enrollments drop constraint %I', c.conname);
  end loop;
end $$;

do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_status_valido
    check (status in ('active','waiting_reply','dormente','paused_handoff','paused_manual','completed','cancelled','dead'));
exception when duplicate_object then null; end $$;

-- ---- 2. coerência de relógio -----------------------------------------------
--
-- `dormente` entra na perna COM relógio: é o `next_eval_at` que o acorda, pelo
-- mesmo claim de sempre. Um dormente sem relógio seria uma inscrição que nunca
-- mais anda e que ninguém vê parar — exatamente o que este CHECK existe para
-- tornar impossível.
do $$ begin
  alter table public.followup_enrollments
    add constraint followup_enrollments_relogio_coerente
    check (
      (status in ('active','waiting_reply','dormente') and next_eval_at is not null)
      or (status in ('paused_handoff','paused_manual','completed','cancelled','dead'))
    );
exception when duplicate_object then null; end $$;

-- ---- 3. o claim tem de enxergar o dormente ---------------------------------
--
-- ⚠️ É AQUI QUE ESTA MIGRATION FALHA CALADA se alguém a encurtar. Sem `dormente`
-- nas duas listas da função, a inscrição dorme e NUNCA acorda: nada reclama a
-- linha, nada reprova, e o retorno simplesmente não acontece no dia 28.
create index if not exists idx_followup_enrollments_due_por_org
  on public.followup_enrollments (organization_id, next_eval_at)
  where status in ('active','waiting_reply','dormente');

create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    -- Sem a condição de claim aqui de propósito: o lateral abaixo a aplica, e uma
    -- organização cujos vencidos estão todos com lease apenas devolve zero linhas.
    select distinct organization_id
      from followup_enrollments
     where status in ('active','waiting_reply','dormente')
       and next_eval_at <= now()
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply','dormente')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    -- O rodízio: posição 1 de todas as organizações, depois a 2 de todas, etc.
    -- Empate na mesma posição vai para quem esperou mais.
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- A condição de lease É REPETIDA AQUI, e não é redundante com a CTE `fila`.
     -- Sem ela, duas conexões simultâneas reclamam as MESMAS linhas: a segunda
     -- espera o lock da primeira, e quando ele sai o Postgres (READ COMMITTED)
     -- reavalia só o WHERE do UPDATE — que não olhava `claimed_until` — e grava
     -- por cima. O `skip locked` da CTE não salva: as duas materializam a mesma
     -- lista antes de qualquer lock existir. Medido: interseção de 5 em 5 no
     -- invariante de concorrência (followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
grant execute on function fn_claim_due_followup_enrollments(int, int) to service_role;
