-- manifest: **O lote para a etapa de perda não troca mais o motivo de quem JÁ estava perdido (issue #2887).** `fn_mover_leads_em_lote` escrevia `lost_reason = $4` em TODOS os leads do alvo, numa escrita só: o negócio que já estava perdido — inclusive o que já estava parado na própria etapa de perda — tinha o motivo original sobrescrito em silêncio (o `status` não muda, então nenhum evento saía e nada registrava a troca). Agora a coluna só entra na escrita de quem NÃO estava perdido (`status is distinct from 'lost'`); quem já estava perdido é movido por um segundo ramo, com a coluna fora da lista do `update`. O ramo separado não é economia de código: nomear `lost_reason` na lista do `update` dispara `trg_validate_lost_reason_required`, que REVALIDA o valor resultante contra o vocabulário do funil mesmo quando ele não mudou — o `coalesce(lost_reason, $4)` sugerido na issue transformaria o lote de um card cujo motivo saiu da configuração depois de usado num 22023 que derruba o lote INTEIRO (medido em `tests/invariants/lote-nao-sobrescreve-o-motivo-de-quem-ja-estava-perdido.test.ts`). Assinatura, resultado e contrato de atomicidade da função seguem iguais, e o único chamador (a rota `POST /api/v1/leads/bulk`) não muda por causa desta migration. Gate: `tests/invariants/lote-nao-sobrescreve-o-motivo-de-quem-ja-estava-perdido.test.ts` (vermelho na main, verde com o conserto).

-- ---- o lote não troca o motivo de quem já estava perdido (migration 0674, issue #2887) ----
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- A função nasceu (0209) trocando só o `stage_id`, e a 0263 lhe deu
-- `p_lost_reason` para a etapa de perda não recusar o lote inteiro com 23514.
-- Nas duas, a escrita do motivo é uma só para o lote todo:
--
--   if v_motivo is not null then v_coluna_motivo := ', lost_reason = $4';
--
-- `p_lost_reason` é UM motivo para N negócios, e ele caía em TODOS os cards do
-- alvo — inclusive nos que já estavam perdidos e já tinham o motivo DELES. Quem
-- perdeu por preço em março e aparece no lote de hoje sai com o motivo de hoje,
-- sem evento (o `status` não muda), sem linha de timeline e sem auditoria: as
-- três superfícies do produto continuam contando a perda de março, e a coluna
-- passa a dizer outra coisa. Medido no baseline (pg16), lote de um card já
-- perdido + um aberto para a etapa de perda:
--
--   card já perdido, motivo 'price', lote com 'no_response'
--     → lost_reason = 'no_response'   (era 'price')
--
-- ─── O que o conserto faz ───────────────────────────────────────────────────
--
-- Divide a escrita pelo `status` da linha, que é a MESMA pergunta que o
-- `/lose` faz. A rota individual é idempotente por `jaEstava`
-- (`lead.status === 'lost'` → não escreve nada); aqui o card já perdido
-- continua sendo MOVIDO (o lote pediu o movimento, e a timeline do movimento é
-- dele), mas a coluna do motivo fica fora daquela escrita.
--
-- ⚠️ O DISCRIMINADOR É O `status`, NUNCA `lost_reason is null`. O card
-- REABERTO carrega o motivo da perda anterior, e uma perda NOVA o substitui —
-- é o que o `/lose` faz (escreve `lost_reason = input.motivo` sempre que o
-- `status` não é 'lost') e é o que `decideMotivoDaPerda` já autoriza
-- (`motivoAtual` só dispensa motivo NOVO; motivo informado sempre vale).
-- Perguntar pela coluna em vez do `status` deixaria um negócio perdido hoje por
-- "no_response" com o motivo "price" da perda de março.
--
-- ⚠️ POR QUE UM RAMO SEPARADO, e não `coalesce(lost_reason, $4)` (a alternativa
-- que a issue oferece). `trg_validate_lost_reason_required` é
-- `before update of status, lost_reason`: a lista de colunas do `update` decide
-- se ele roda, e o que ele confere é o valor RESULTANTE, não o valor que mudou.
-- Com a coluna sempre na lista, um card cujo motivo saiu de
-- `crm_pipelines.settings.lost_reasons` depois de usado — motivo gravado e
-- legítimo, que a 0263 protege de propósito — é recusado com 22023
-- `lost_reason_invalid`, e como a função é uma transação só, o LOTE INTEIRO
-- falha. O arrasto do MESMO card (que não toca a coluna) continuaria passando:
-- dois caminhos respondendo diferente para o mesmo card é o defeito da #917 com
-- outro nome. Os dois ramos deixam a coluna fora da lista de quem preserva.
--
-- ─── Os chamadores (medido, não presumido) ──────────────────────────────────
--
-- O único chamador de `fn_mover_leads_em_lote` é a rota `POST /api/v1/leads/bulk`
-- (`supabase.rpc("fn_mover_leads_em_lote", …)`) — o arrasto do quadro vai por
-- `PATCH /api/v1/leads/[id]/move`, que escreve a coluna direto e passa por
-- `decideMotivoDaPerda`; a IA não move (`agent-stage-sync.ts` recusa e abre item
-- de inbox). Assinatura (`uuid, uuid[], uuid, text`, com default), colunas de
-- retorno (`lead_id, from_stage_id, pipeline_id`) e atomicidade continuam as
-- mesmas, então nenhum chamador muda — nem o `select` de tipos gerados.
--
-- ⚠️ ATOMICIDADE: os dois ramos são CTEs que MODIFICAM dados na MESMA sentença
-- — um `return query execute` só, um `now()` só, um `alvo` só. Os predicados são
-- disjuntos pelo mesmo `status` lido do mesmo snapshot (`is distinct from 'lost'`
-- e `= 'lost'`), então nenhuma linha é escrita duas vezes; e como `alvo` é o
-- mesmo nos dois ramos, a `ordem` do `row_number()` continua sendo a do lote
-- inteiro — é isso que mantém as posições DISTINTAS entre os dois grupos, a
-- razão de existir da 0209.
--
-- ⚠️ `%` no texto do `format` é marcador: o corpo abaixo não pode conter nenhum
-- além dos três `%s` (não contém). Quem for editar, confira.
--
-- Sem coluna nova, sem backfill, sem dado tocado: quem já estava perdido
-- simplesmente para de ser reescrito. Idempotente (`create or replace`), e a
-- assinatura é a mesma da 0263, então NÃO há `drop function` aqui — quem aplica
-- a cadeia não perde os grants no meio do caminho.

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
  v_filtro_novos text := '';
  v_filtro_preservados text := 'false';
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

  -- Só com motivo a gravar a coluna entra na escrita (0263; ver o cabeçalho) —
  -- e só quem NÃO estava perdido recebe a coluna (#2887). Sem motivo, o ramo dos
  -- novos leva o lote inteiro e o dos preservados não casa nenhuma linha.
  if v_motivo is not null then
    v_coluna_motivo := ', lost_reason = $4';
    v_filtro_novos := ' and l.status is distinct from ''lost''';
    v_filtro_preservados := 'l.status = ''lost''';
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
  novos as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = $5 + (a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1%s
    returning l.id, a.from_stage_id, a.pipeline_id
  ),
  preservados as (
    update public.crm_leads l
       set stage_id          = $3,
           position_in_stage = $5 + (a.ordem * 1000),
           updated_at        = now()
      from alvo a
     where l.id = a.id
       and l.organization_id = $1
       and %s
    returning l.id, a.from_stage_id, a.pipeline_id
  )
  select n.id, n.from_stage_id, n.pipeline_id from novos n
  union all
  select p.id, p.from_stage_id, p.pipeline_id from preservados p
  $f$, v_coluna_motivo, v_filtro_novos, v_filtro_preservados)
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_piso;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA (piso da etapa de destino + 1000 por card, na ordem em que estavam no quadro). Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. `p_lost_reason` (0263, issue #917) grava o motivo da perda na MESMA escrita quando a etapa de destino é de perda — sem ele a CHECK crm_leads_lost_reason_required recusava o lote inteiro com 23514; a coluna só entra na escrita quando há motivo, para não revalidar o valor que já estava na linha. #2887: a coluna só entra na escrita de quem NÃO estava perdido (`status is distinct from ''lost''`) — o negócio que já estava perdido é movido por um segundo ramo sem a coluna, e preserva o motivo dele; reescrever o valor que já estava na linha dispararia trg_validate_lost_reason_required e derrubaria o lote inteiro de um card cujo motivo saiu do vocabulário do funil. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

revoke all     on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from public;
revoke execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) from anon;
grant  execute on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text)
  to authenticated, service_role;
