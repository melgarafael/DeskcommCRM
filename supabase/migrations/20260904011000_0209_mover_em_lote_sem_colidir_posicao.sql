-- 0209 · Mover em lote deixa de empilhar todos os cards na MESMA posição.
--
-- ─── O sintoma ───────────────────────────────────────────────────────────────
-- `components/kanban/BulkActionBar.tsx` manda UM escalar para o lote inteiro
-- (`position_in_stage: 1_000_000`) e `POST /api/v1/leads/bulk` o grava com um
-- `update ... in (ids)`. Trinta cards movidos de uma vez terminam com o MESMO
-- número na coluna de destino.
--
-- `position_in_stage` é fractional indexing (numeric, nunca int): quem decide
-- onde um card entra é `midpoint(prev, next)` em `lib/kanban/fractional-indexing.ts`,
-- e esse arquivo já documenta o que acontece quando os dois vizinhos são iguais:
--
--     if (prev === next) return NaN;   // "caller should trigger global rebalance"
--
-- Não existe esse rebalance. Então, depois de um lote, arrastar um card para
-- ENTRE dois dos cards movidos calcula `midpoint(1000000, 1000000)` = NaN, e o
-- NaN sobe no PATCH como posição. Antes disso a ordem entre os N já é arbitrária
-- (empate resolvido pelo plano de execução), então o quadro se reordena sozinho
-- a cada refetch. Os dois defeitos vêm da mesma linha: um número para N linhas.
--
-- ─── Por que uma função, e não N updates no route handler ────────────────────
-- Posições distintas exigem um valor por linha. Pelo PostgREST isso é ou um
-- `upsert` (que exigiria mandar todas as colunas NOT NULL de volta — cada lote
-- vira uma chance de sobrescrever o que não foi lido) ou N chamadas `.update()`
-- — até 50 idas ao banco, e, pior, um lote que falha na 17ª deixa 16 cards
-- movidos e 14 parados, sem ninguém para desfazer.
--
-- Uma função resolve os dois: `row_number()` dá o valor por linha, e o `update`
-- único faz do lote uma transação só — move todos ou não move nenhum.
--
-- ─── O que ela faz ───────────────────────────────────────────────────────────
-- Empilha o lote ao FIM da etapa de destino, espaçado de 1000 em 1000 (o mesmo
-- STEP de `fractional-indexing.ts`), preservando a ordem em que os cards estavam
-- no quadro. Ao fim, porque é a semântica que a tela já tinha: o `1_000_000`
-- fixo estava sempre acima de qualquer posição real. O piso é o maior valor JÁ
-- ocupado na etapa de destino IGNORANDO os cards do próprio lote — sem isso, um
-- card que já está no destino serviria de piso para si mesmo e o lote nasceria
-- por cima dele a cada reexecução.
--
-- ─── Segurança ───────────────────────────────────────────────────────────────
-- `security INVOKER` de propósito: a RLS de `crm_leads` continua sendo o piso, e
-- nada aqui precisa vê-la de fora. `p_organization_id` é o escopo explícito que
-- a doutrina exige (org resolvida do cookie pelo handler, NUNCA do body) — a RLS
-- sozinha deixaria um ator com duas organizações tocar as duas de uma vez.
-- As DUAS origens de EXECUTE são revogadas (doutrina, item 9): `revoke from
-- public` não tira o grant direto que `anon` herda do ALTER DEFAULT PRIVILEGES,
-- e `revoke from anon` não tira o grant a PUBLIC dado na criação.
--
-- Aditiva e idempotente: `create or replace`, nenhuma coluna, nenhum dado
-- tocado na aplicação.

create or replace function public.fn_mover_leads_em_lote(
  p_organization_id uuid,
  p_lead_ids uuid[],
  p_stage_id uuid
) returns table (lead_id uuid, from_stage_id uuid, pipeline_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_piso numeric;
begin
  -- `coalesce(..., 0)` cobre a etapa vazia; o DEFAULT da coluna é 1000, então
  -- o primeiro card de um lote para uma etapa vazia cai em 1000, como um card
  -- criado à mão.
  select coalesce(max(l.position_in_stage), 0)
    into v_piso
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.stage_id = p_stage_id
     and not (l.id = any(p_lead_ids));

  return query
  with alvo as (
    select l.id,
           l.stage_id    as from_stage_id,
           l.pipeline_id as pipeline_id,
           -- A ordem do lote no destino é a ordem em que ele estava no quadro:
           -- etapa, depois posição. `id` só desempata para o resultado ser
           -- determinístico (dois cards podem legitimamente empatar hoje —
           -- é justamente o estado que esta migration deixa de produzir).
           row_number() over (order by l.stage_id, l.position_in_stage, l.id) as ordem
      from public.crm_leads l
     where l.organization_id = p_organization_id
       and l.id = any(p_lead_ids)
  ),
  movidos as (
    update public.crm_leads l
       set stage_id          = p_stage_id,
           position_in_stage = v_piso + (a.ordem * 1000),
           updated_at        = now()
      from alvo a
     where l.id = a.id
       and l.organization_id = p_organization_id
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select m.id, m.from_stage_id, m.pipeline_id from movidos m;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA (piso da etapa de destino + 1000 por card, na ordem em que estavam no quadro). Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

revoke all     on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid) from public;
revoke execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid) from anon;
grant  execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid)
  to authenticated, service_role;
