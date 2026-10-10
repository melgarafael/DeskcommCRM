-- 0263 — a etapa de PERDA grava o motivo na MESMA escrita do lote (issue #917).
--
-- ─── O que estava faltando ──────────────────────────────────────────────────
-- `fn_mover_leads_em_lote` (0209) trocava só o `stage_id`. Quando a etapa de
-- destino é de perda, `trg_crm_lead_close_on_stage` fecha o negócio (escreve
-- `status = 'lost'`) e a CHECK `crm_leads_lost_reason_required` recusa a linha.
-- Medido no baseline (pg16, lote de 2 cards abertos para a etapa de perda):
--
--   SQLSTATE=23514 | new row for relation "crm_leads" violates check constraint
--   "crm_leads_lost_reason_required"
--
-- A função é uma transação só — "move todos ou não move nenhum" —, então UM card
-- sem motivo derrubava o LOTE INTEIRO, e a rota só sabia responder 500
-- (`internal_error`) para o operador que acabara de pedir o movimento. Quem está
-- certo é a CHECK: errado era o caminho, que escrevia etapa sem o motivo.
--
-- ─── Por que um PARÂMETRO, e não uma segunda escrita na rota ────────────────
-- O motivo tem de entrar na MESMA escrita que muda a etapa. Uma escrita ANTES
-- tem janela (entre as duas o negócio aparece `lost` sem motivo — o estado que a
-- CHECK existe para impedir) e uma escrita DEPOIS é uma linha já recusada. Quem
-- escreve a etapa do lote é esta função, então é ela que recebe e grava o motivo.
--
-- ⚠️ `coalesce` com o valor da própria linha é o caso do card que JÁ era perdido:
-- trocar um perdido de "Perdido" para "Desistiu" não é uma perda nova, e o motivo
-- que está lá continua valendo (`p_lost_reason` nulo não apaga nada).
--
-- ⚠️ A coluna `lost_reason` só entra na lista do `update` quando HÁ motivo para
-- gravar — daí o SQL dinâmico, e não uma linha fixa com `coalesce`. Não é
-- economia de bytes: tocar a coluna dispara `trg_validate_lost_reason_required`
-- (o trigger é `before update of status, lost_reason`), que confere o valor
-- resultante contra o vocabulário do funil (canônico + `settings.lost_reasons`).
-- Reescrever o valor que já estava na linha recusaria o lote de um card cujo
-- motivo saiu da configuração depois de usado (22023 `lost_reason_invalid`) — um
-- movimento que hoje passa —, enquanto o arrasto do mesmo card, que não toca a
-- coluna, continuaria passando. Dois caminhos respondendo diferente para o mesmo
-- card é justamente o defeito desta issue. Medido: com a coluna sempre na
-- escrita, o lote de um card com motivo aposentado falha; com a coluna
-- condicional, passa.
--
-- ⚠️ O `drop function` ANTES do `create or replace` NÃO é zelo: o PostgreSQL não
-- substitui assinatura. Sem o drop ficam DUAS funções — a de 3 argumentos e a
-- nova de 4 com default —, e toda chamada de 3 argumentos passa a estourar
-- `function public.fn_mover_leads_em_lote(uuid, uuid[], uuid) is not unique`.
--
-- ⚠️ `%` no texto do `format` é marcador: o corpo abaixo não pode conter nenhum
-- (não contém). Quem for editar, confira.
--
-- Sem coluna nova, sem dado tocado, sem backfill: o motivo é parâmetro, e quem
-- não manda motivo se comporta exatamente como antes.
-- Idempotente nos dois sentidos (`drop ... if exists` + `create or replace`).

drop function if exists public.fn_mover_leads_em_lote(uuid, uuid[], uuid);

create or replace function public.fn_mover_leads_em_lote(
  p_organization_id uuid,
  p_lead_ids uuid[],
  p_stage_id uuid,
  p_lost_reason text default null
) returns table (lead_id uuid, from_stage_id uuid, pipeline_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_piso numeric;
  -- Motivo em branco é ausência de motivo, nunca um motivo de uma letra.
  v_motivo text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_coluna_motivo text := '';
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

  -- Só com motivo a gravar a coluna entra na escrita (ver o cabeçalho).
  if v_motivo is not null then
    v_coluna_motivo := ', lost_reason = $4';
  end if;

  return query execute format($f$
  with alvo as (
    select l.id,
           l.stage_id    as from_stage_id,
           l.pipeline_id as pipeline_id,
           -- A ordem do lote no destino é a ordem em que ele estava no quadro:
           -- etapa, depois posição. `id` só desempata para o resultado ser
           -- determinístico (dois cards podem legitimamente empatar hoje —
           -- é justamente o estado que a migration 0209 deixa de produzir).
           row_number() over (order by l.stage_id, l.position_in_stage, l.id) as ordem
      from public.crm_leads l
     where l.organization_id = $1
       and l.id = any($2)
  ),
  movidos as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = $5 + (a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select m.id, m.from_stage_id, m.pipeline_id from movidos m
  $f$, v_coluna_motivo)
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_piso;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA (piso da etapa de destino + 1000 por card, na ordem em que estavam no quadro). Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. `p_lost_reason` (0263, issue #917) grava o motivo da perda na MESMA escrita quando a etapa de destino é de perda — sem ele a CHECK crm_leads_lost_reason_required recusava o lote inteiro com 23514; a coluna só entra na escrita quando há motivo, para não revalidar o valor que já estava na linha. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

revoke all     on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from public;
revoke execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from anon;
grant  execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text)
  to authenticated, service_role;
