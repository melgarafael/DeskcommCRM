-- =====================================================================
-- #4802 (item 3) — transferência em massa de negócios ao arquivar ou excluir
-- um funil.
--
-- Duas coisas, e as duas são pré-requisito da mesma escolha do usuário:
--
--   1. `fn_mover_leads_em_lote` passa a gravar `pipeline_id`.
--      Até aqui ela escrevia só `stage_id` — correta para o lote do quadro, que
--      sempre foi dentro do mesmo funil. Para levar N negócios de um funil a
--      outro pelo MESMO caminho (a rota `/api/v1/pipelines/[id]/negocios`), a
--      coluna tem de acompanhar a etapa: sem isso o card ficaria com
--      `pipeline_id` da origem e `stage_id` do destino, e o quadro de origem
--      continuaria listando um negócio cuja etapa não é dele. `pipeline_id` sai
--      da PRÓPRIA etapa de destino, lida no banco — nunca de um parâmetro, que
--      poderia divergir dela. Para os chamadores de hoje (o lote do quadro) o
--      valor gravado é o mesmo que já estava na linha: a escrita é um no-op.
--
--   2. `crm_lead_activities.lead_id` deixa de ser NOT NULL e a FK passa de
--      ON DELETE CASCADE para ON DELETE SET NULL.
--      É o defeito que a escolha "remover os negócios da estrutura, mantendo os
--      contatos e históricos" expõe: apagar um negócio levava junto, em
--      silêncio, TODA a timeline comercial dele. A linha da atividade passa a
--      sobreviver ao negócio — com `contact_id` preenchido (é o mesmo negócio
--      que a gravou), o histórico continua legível do lado do contato, que é o
--      que a issue manda preservar. `crm_leads.contact_id` já era
--      ON DELETE SET NULL, então o contato nunca morreu junto; o histórico era
--      o único elo que sumia.
--
--      ⚠️ NINGUÉM ESCREVE `lead_id` NULO: `emitLeadActivity` sempre o informa.
--      A coluna é anulável para o DELETE do negócio poder anular a referência —
--      é o banco exercendo o SET NULL, não o aplicativo gravando buraco.
-- =====================================================================

-- ── 1. O movimento do lote leva o funil junto com a etapa ──────────────
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
  -- O funil de destino sai da ETAPA, não de um argumento: assim não existe
  -- chamada em que os dois discordem.
  v_pipeline_destino uuid;
begin
  select s.pipeline_id
    into v_pipeline_destino
    from public.crm_stages s
   where s.id = p_stage_id
     and s.organization_id = p_organization_id;

  if v_pipeline_destino is null then
    raise exception 'stage_not_found: a etapa % não é da organização %', p_stage_id, p_organization_id
      using errcode = '23503';
  end if;

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
           pipeline_id       = $6,
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
           pipeline_id       = $6,
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
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_piso, v_pipeline_destino;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA (piso da etapa de destino + 1000 por card, na ordem em que estavam no quadro). Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. `p_lost_reason` (0263, issue #917) grava o motivo da perda na MESMA escrita quando a etapa de destino é de perda. #2887: a coluna só entra na escrita de quem NÃO estava perdido. #4802 (item 3): `pipeline_id` acompanha a etapa — sai da própria etapa de destino —, e é o que permite a transferência em massa de negócios entre funis usar ESTE caminho em vez de um segundo update em massa. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

-- ── 2. O histórico comercial sobrevive ao negócio ──────────────────────
alter table public.crm_lead_activities
  alter column lead_id drop not null;

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_lead_id_fkey;

alter table public.crm_lead_activities
  add constraint crm_lead_activities_lead_id_fkey
  foreign key (lead_id) references public.crm_leads(id) on delete set null;
