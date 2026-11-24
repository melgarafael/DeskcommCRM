-- manifest: **Os negócios EM ANDAMENTO de um funil vão para outro funil de uma vez, e o histórico comercial sobrevive ao negócio (issue #4802, item 3; doc de decisão 400, opção B).** `fn_mover_leads_em_lote` passa a gravar `pipeline_id` junto com `stage_id`, tirado da PRÓPRIA etapa de destino (nunca de um parâmetro, que poderia divergir dela) — é o que permite `POST /api/v1/pipelines/[id]/negocios` levar os negócios ABERTOS de um funil a outro pelo MESMO caminho do lote do quadro, numa transação só; ganhos e perdidos ficam no funil de origem (P-01 revista só para o aberto; P-02 sem exceção, o gatilho de fechamento não muda). Para os chamadores de hoje (o lote do quadro, que recusa etapa de outro funil com `pipeline_immutable_use_clone`) o valor gravado é o que já estava na linha. `crm_lead_activities.lead_id` deixa de ser `NOT NULL` e a FK passa de `ON DELETE CASCADE` para `ON DELETE SET NULL`: a linha do histórico sobrevive ao negócio pelo `contact_id`, que é por onde a anonimização da LGPD a encontra. Por isso, ANTES da troca, o `contact_id` vazio é preenchido com o do negócio, e um gatilho `BEFORE DELETE` em `crm_leads` (`fn_crm_lead_apaga_historico_sem_contato`, sem HTTP, revogada de public/anon/authenticated) apaga junto com o negócio a linha que continua sem contato — como o CASCADE fazia —; e um segundo gatilho `BEFORE DELETE` em `contacts` (`fn_contato_apaga_historico_sem_negocio`, mesmo molde, `search_path` vazio) apaga junto com o contato a linha que já tinha perdido o negócio, porque `crm_lead_activities_contact_id_fkey` é `ON DELETE SET NULL` e ela ficaria sem negócio e sem contato. São os dois casos medidos no invariante da anonimização: o negócio apagado com o contato anonimizado depois, e o negócio apagado com o contato apagado depois. A policy de leitura ganha o braço da linha órfã (organização inteira, `org_wide_read`). Gate: `tests/invariants/historico-do-negocio-apagado-e-legivel.test.ts`, `tests/invariants/historico-do-negocio-apagado-anonimiza.test.ts`, `lib/pipelines/transferencia-de-negocios.test.ts`, `app/api/v1/pipelines/[id]/negocios/route.test.ts`.

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
-- A LGPD encontra o histórico pelo CONTATO ou pelo NEGÓCIO
-- (`fn_lgpd_cascade_redact_contact`, seção 4). Com o negócio apagado, só o
-- contato sobra — então a troca para SET NULL vem com duas guardas, nesta ordem:
--
--   a) o `contact_id` vazio do histórico que JÁ existe é preenchido com o do
--      negócio (mudança de etapa pelo quadro, anexo e pagamento gravavam sem
--      contato até esta versão);
--   b) a linha que mesmo assim não tem contato nenhum é apagada JUNTO com o
--      negócio, pelo gatilho abaixo — exatamente o que o CASCADE fazia com ela.
--      `security definer` porque `authenticated` não tem DELETE nesta tabela
--      (timeline é só-escrita para o aplicativo), como a ação de FK do CASCADE
--      também não pedia; sem seletor: só apaga linha do PRÓPRIO negócio que está
--      sendo apagado, e o gatilho não é chamável pela REST. Não faz HTTP.
create or replace function public.fn_crm_lead_apaga_historico_sem_contato()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.crm_lead_activities a
   where a.lead_id = old.id
     and a.organization_id = old.organization_id
     and a.contact_id is null;
  return old;
end;
$$;
revoke execute on function public.fn_crm_lead_apaga_historico_sem_contato() from public, anon;
revoke execute on function public.fn_crm_lead_apaga_historico_sem_contato() from authenticated;

drop trigger if exists trg_crm_leads_apaga_historico_sem_contato on public.crm_leads;
create trigger trg_crm_leads_apaga_historico_sem_contato
  before delete on public.crm_leads
  for each row execute function public.fn_crm_lead_apaga_historico_sem_contato();

-- O outro lado do mesmo buraco: o negócio sai primeiro, a linha fica só com o
-- `contact_id`, e DEPOIS o contato é apagado. `crm_lead_activities_contact_id_fkey`
-- é ON DELETE SET NULL, então a linha ficaria sem negócio e sem contato — fora do
-- alcance da anonimização para sempre. O gatilho apaga, junto com o contato, a
-- linha que só ele segurava; vale para todo caminho que apaga contato, não só
-- para `fn_apagar_contato_com_historico`. Linha que ainda tem negócio fica (o
-- SET NULL a deixa com o negócio, e o gatilho de `crm_leads` acima a alcança se o
-- negócio sair depois). Mesmo molde do de cima: definer porque `authenticated`
-- não tem DELETE na timeline, sem seletor, não é chamável pela REST, sem HTTP.
create or replace function public.fn_contato_apaga_historico_sem_negocio()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.crm_lead_activities a
   where a.lead_id is null
     and a.contact_id = old.id
     and a.organization_id = old.organization_id;
  return old;
end;
$$;
revoke execute on function public.fn_contato_apaga_historico_sem_negocio() from public, anon;
revoke execute on function public.fn_contato_apaga_historico_sem_negocio() from authenticated;

drop trigger if exists trg_contacts_apaga_historico_sem_negocio on public.contacts;
create trigger trg_contacts_apaga_historico_sem_negocio
  before delete on public.contacts
  for each row execute function public.fn_contato_apaga_historico_sem_negocio();

update public.crm_lead_activities a
   set contact_id = l.contact_id
  from public.crm_leads l
 where a.lead_id = l.id
   and a.organization_id = l.organization_id
   and a.contact_id is null
   and l.contact_id is not null;

alter table public.crm_lead_activities
  alter column lead_id drop not null;

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_lead_id_fkey;

alter table public.crm_lead_activities
  add constraint crm_lead_activities_lead_id_fkey
  foreign key (lead_id) references public.crm_leads(id) on delete set null;

-- ── 3. O histórico que sobreviveu ao negócio continua LEGÍVEL ──────────
-- A FK da seção 2 é o que faz a linha sobreviver; sozinha, ela deixa o histórico
-- na tabela e invisível: `crm_lead_activities_select` exige o lead-pai
-- (`EXISTS ... where l.id = lead_id`), e com `lead_id` anulado o `EXISTS` é falso
-- para todo mundo — medido: o admin da própria empresa conta 0 pelo contato.
-- Reaproveitar o escopo do negócio é o que dá sentido a "mantendo contatos e
-- históricos": a linha passa a ser lida pela ORGANIZAÇÃO dela, e só por quem já
-- lê a organização inteira (`org_wide_read` em `fn_lead_scope`). Agente restrito
-- continua sem vê-la — abrir para ele seria abrir por um braço novo tudo o que o
-- `EXISTS` fecha.
drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
create policy "crm_lead_activities_select" on public.crm_lead_activities
  for select using (
    exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_activities.lead_id
        and (
          (select public.fn_is_platform_admin())
          or l.organization_id in (
               select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
             )
          or (
               l.owner_user_id = auth.uid()
               and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
             )
          or (
               l.owner_user_id is null
               and l.organization_id in (
                    select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                  )
             )
        )
    )
    or (
      crm_lead_activities.lead_id is null
      and (
        (select public.fn_is_platform_admin())
        or crm_lead_activities.organization_id in (
             select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
           )
      )
    )
  );
