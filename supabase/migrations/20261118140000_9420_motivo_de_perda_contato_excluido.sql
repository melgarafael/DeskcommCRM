-- manifest: motivo de perda canônico `contact_deleted` — excluir um contato fecha, como perdidos, os cards abertos dele em vez de deixá-los soltos no Kanban (A6).
--
-- Excluir um contato deixava o card aberto no funil, sem contato: a FK
-- `crm_leads.contact_id` é `on delete set null`. A rota de exclusão passa a
-- encerrar cada card ABERTO do contato pela porta de sempre (`encerraDemanda`, a
-- mesma do botão "Perdido") ANTES de apagar a ficha, com o motivo de sistema
-- `contact_deleted` ("Contato excluído").
--
-- O único lugar do banco que conhece os motivos canônicos é o array de
-- `fn_validate_lost_reason_required`; sem o motivo novo nele o gatilho recusaria
-- a perda com 22023 `lost_reason_invalid` e a exclusão do contato não andaria.
-- Corpo idêntico ao da 0513, com o motivo novo no fim do array. Aditiva e
-- idempotente. O motivo CONTA como perda (como `opted_out_of_messages`): as
-- métricas não mudam.

create or replace function public.fn_validate_lost_reason_required() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'moved_to_another_pipeline','opted_out_of_messages','contact_deleted'];
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

revoke execute on function public.fn_validate_lost_reason_required() from public, anon;
grant execute on function public.fn_validate_lost_reason_required() to anon, authenticated, service_role;
