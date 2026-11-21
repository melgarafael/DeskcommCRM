-- manifest: **Os negócios de um funil vão para outro funil de uma vez, e o histórico comercial sobrevive ao negócio (issue #4802, item 3).** `fn_mover_leads_em_lote` passa a gravar `pipeline_id` junto com `stage_id`, tirado da PRÓPRIA etapa de destino (nunca de um parâmetro, que poderia divergir dela) — é o que permite `POST /api/v1/pipelines/[id]/negocios` levar N negócios de um funil a outro pelo MESMO caminho do lote do quadro, numa transação só, em vez de um `update` em massa paralelo; para os chamadores de hoje (o lote do quadro) o valor gravado é o que já estava na linha. E `crm_lead_activities.lead_id` deixa de ser `NOT NULL` e a FK passa de `ON DELETE CASCADE` para `ON DELETE SET NULL`: apagar um negócio apagava, em silêncio, toda a timeline comercial dele, e a linha do histórico passa a sobreviver com o `contact_id` dela (é por onde continua legível). Ninguém escreve `lead_id` nulo — `emitLeadActivity` sempre o informa; a coluna é anulável para o DELETE do negócio poder anular a referência. Gate: `lib/pipelines/transferencia-de-negocios.test.ts`, `app/api/v1/pipelines/[id]/negocios/route.test.ts`, `app/app/kanban/_transferir-negocios.test.tsx` e os invariantes de schema.

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
  v_min numeric;
  v_total int;
  -- Motivo em branco é ausência de motivo, nunca um motivo de uma letra.
  v_motivo text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_coluna_motivo text := '';
  v_filtro_novos text := '';
  v_filtro_preservados text := 'false';
  -- #4802 (item 3): o funil de destino sai da ETAPA, não de um argumento: assim
  -- não existe chamada em que os dois discordem.
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

  -- Quantos cards o lote tem DE VERDADE. O predicado é o MESMO do `alvo` da
  -- escrita (organização + ids): contar por `array_length(p_lead_ids)` somaria
  -- id de outra organização — que o `alvo` descarta —, e a posição do primeiro
  -- card sairia de uma conta que inclui card que não vai ser movido.
  select count(*)
    into v_total
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.id = any(p_lead_ids);

  -- Onde o lote ENCOSTA: o primeiro card da etapa de destino, sem contar os que
  -- já estão no lote. `null` é a etapa vazia — e aí o lote ocupa o miolo de
  -- sempre (1000, 2000, …), pelo `coalesce` da escrita.
  select min(l.position_in_stage)
    into v_min
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
           -- #4802 (item 3): o funil vem da ETAPA de destino ($7), nunca de um
           -- argumento que pudesse divergir dela.
           pipeline_id       = $7,
           -- O TOPO da etapa (issue #3461): o lote inteiro encosta ACIMA do
           -- primeiro card e mantém entre si a ordem de origem. $5 é esse
           -- primeiro card; $6, o tamanho do lote. Etapa vazia ($5 nulo) cai
           -- no `coalesce` e ocupa 1000, 2000, … como um card criado à mão.
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
           updated_at        = now()%s
      from alvo a
     where l.id = a.id
       and l.organization_id = $1%s
    returning l.id, a.from_stage_id, a.pipeline_id
  ),
  preservados as (
    update public.crm_leads l
       set stage_id          = $3,
           pipeline_id       = $7,
           position_in_stage = coalesce($5 - (($6 - a.ordem + 1) * 1000), a.ordem * 1000),
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
  using p_organization_id, p_lead_ids, p_stage_id, v_motivo, v_min, v_total, v_pipeline_destino;
end;
$$;

comment on function public.fn_mover_leads_em_lote(uuid, uuid[], uuid, text) is
  'Move um lote de leads para uma etapa dando a cada um posição DISTINTA no TOPO da coluna de destino (issue #3461): o lote encosta acima do primeiro card (`min - 1000` por card, na ordem em que estava no quadro). Etapa vazia continua nascendo em 1000, 2000, … Existe porque gravar a mesma position_in_stage em N linhas quebra o midpoint() do arrasto seguinte (prev === next → NaN) e deixa a ordem do quadro indefinida. `p_lost_reason` (0263, issue #917) grava o motivo da perda na MESMA escrita quando a etapa de destino é de perda. #2887: a coluna só entra na escrita de quem NÃO estava perdido. #4802 (item 3): `pipeline_id` acompanha a etapa — sai da própria etapa de destino —, e é o que permite a transferência em massa de negócios entre funis usar ESTE caminho em vez de um segundo update em massa. Devolve uma linha por card movido, com a etapa de ORIGEM, para o handler emitir a atividade de timeline de cada um.';

-- ── 2. O histórico comercial sobrevive ao negócio ──────────────────────
alter table public.crm_lead_activities
  alter column lead_id drop not null;

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_lead_id_fkey;

alter table public.crm_lead_activities
  add constraint crm_lead_activities_lead_id_fkey
  foreign key (lead_id) references public.crm_leads(id) on delete set null;
