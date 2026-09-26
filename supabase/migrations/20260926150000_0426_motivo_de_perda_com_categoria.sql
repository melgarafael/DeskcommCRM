-- 0426 — Motivo de perda com categoria e a etapa de onde o negócio saiu (issue #1537).
--
-- Três mudanças que a proposta "motivos de perda com categoria, filtro e relatório"
-- precisa para existir:
--
--  1. `crm_leads.lost_from_stage_id` — em que etapa ABERTA o negócio morreu. Sem
--     ela o relatório responde "40% por preço", mas não "40% por preço NA ETAPA
--     DE PROPOSTA": o lead vai para a etapa `is_lost` e a etapa anterior só
--     sobrava na timeline. Aditiva, nasce `null` em toda linha existente (nenhuma
--     perda antiga tem origem registrada — derivar retroativamente seria inventar
--     dado), FK `ON DELETE SET NULL` (apagar a etapa solta o ponteiro em vez de
--     recusar a exclusão do funil).
--
--  2. `fn_crm_lead_close_on_stage` passa a gravar essa origem na transição para
--     `lost`. É o MESMO gatilho que já derive `status` e `closed_at` da etapa —
--     não nasce um segundo gatilho para a mesma transição, porque dois gatilhos
--     BEFORE na mesma linha são executados em ordem de nome e a regra de
--     origem passaria a depender de quem roda primeiro. Todo caminho de perda
--     MOVE a etapa (quadro, `fn_mover_leads_em_lote` 0209, `fn_lote_de_perda`
--     0263, encerramento) e este gatilho é o único escritor de `status` (P-02),
--     então a transição SEM troca de etapa não existe.
--
--  3. `fn_validate_lost_reason_required` compara o RÓTULO quando o item de
--     `settings.lost_reasons` é `{ label, categoria }`. `jsonb_array_elements_text`
--     de um objeto devolveria o JSON inteiro, e o trigger recusaria com 22023 um
--     motivo que a própria tela acabou de oferecer — o funil inteiro ficaria sem
--     poder perder negócio. Texto puro continua valendo igual (critério de aceite:
--     funil com `lost_reasons` em texto funciona sem migração de dado).
--
-- Aditiva e idempotente. Nenhum dado existente é reescrito e nenhum funil é
-- migrado: categoria ausente é estado legítimo (resolve no padrão do produto em
-- `CATEGORIA_PADRAO_DO_MOTIVO`, ou fica sem categoria no relatório).

alter table public.crm_leads
  add column if not exists lost_from_stage_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_crm_leads_lost_from_stage'
      and conrelid = 'public.crm_leads'::regclass
  ) then
    alter table public.crm_leads
      add constraint fk_crm_leads_lost_from_stage
      foreign key (lost_from_stage_id)
      references public.crm_stages(id)
      on delete set null;
  end if;
end $$;

create or replace function public.fn_crm_lead_close_on_stage() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_is_won  boolean;
  v_is_lost boolean;
begin
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.status   is not distinct from old.status then
    return new;
  end if;

  select is_won, is_lost into v_is_won, v_is_lost
    from public.crm_stages where id = new.stage_id;

  if v_is_won then
    new.status := 'won';
    new.closed_at := coalesce(new.closed_at, now());
  elsif v_is_lost then
    new.status := 'lost';
    new.closed_at := coalesce(new.closed_at, now());
    -- #1537: a etapa ABERTA que este negócio deixou. Só na transição: um card
    -- já perdido movido entre etapas de perda mantém a origem verdadeira, e um
    -- INSERT direto na etapa de perda não tem origem de onde sair.
    if tg_op = 'UPDATE' and old.status is distinct from 'lost' then
      new.lost_from_stage_id := coalesce(new.lost_from_stage_id, old.stage_id);
    end if;
  else
    if tg_op = 'UPDATE' and old.status in ('won','lost') then
      new.status := 'open';
      new.closed_at := null;
      -- Reabriu: a origem da perda passada não pertence a um negócio aberto.
      -- Se morrer de novo, a nova transição grava a nova origem.
      new.lost_from_stage_id := null;
    end if;
  end if;
  return new;
end$$;

create or replace function public.fn_validate_lost_reason_required() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'moved_to_another_pipeline'];
  v_pipeline_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    -- #1537: `lost_reasons` aceita texto puro E `{ label, categoria }`; o que se
    -- compara é o RÓTULO nos dois formatos.
    select coalesce(
      array(
        select case when jsonb_typeof(e) = 'object'
                    then nullif(e ->> 'label', '')
                    else nullif(e #>> '{}', '') end
          from jsonb_array_elements(settings->'lost_reasons') as t(e)
      ), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (v_canonical) or new.lost_reason = any (v_pipeline_extra)) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;

-- Autocontido (mesmo desenho da 0417): a assinatura não muda e os grants da
-- instalação já existem, mas o arquivo repete as duas origens de EXECUTE.
revoke execute on function public.fn_crm_lead_close_on_stage() from public, anon;
revoke execute on function public.fn_validate_lost_reason_required() from public, anon;
grant execute on function public.fn_crm_lead_close_on_stage() to anon, authenticated, service_role;
grant execute on function public.fn_validate_lost_reason_required() to anon, authenticated, service_role;
