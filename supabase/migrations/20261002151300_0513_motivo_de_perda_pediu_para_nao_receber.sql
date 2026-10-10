-- 0513 — Motivo de perda próprio para quem responde PARAR (PR #2049, de @paulolimajr77).
--
-- O #2049 passa a fechar sozinho, como perdido, todo negócio aberto do contato
-- que pediu para não receber mensagens. Com o motivo que existia
-- (`requested_by_customer`, "Cliente solicitou cancelamento") a tela dizia algo
-- que o cliente não pediu: pedir silêncio não é cancelar — e no funil padrão a
-- coluna de perda se chama "Cancelado". Decisão do dono do produto (doc 85,
-- 02/out, opção B): motivo próprio e verdadeiro, `opted_out_of_messages`
-- ("Pediu para não receber mensagens"), em todo negócio aberto do contato.
--
-- O motivo CONTA como perda (diferente de `moved_to_another_pipeline`, 0266):
-- é oportunidade que foi embora de verdade. Por isso `fn_attendant_metrics` e
-- `fn_atrito_metrics` não mudam — elas só excluem a transferência.
--
-- O único lugar do banco que conhece os motivos canônicos é o array de
-- `fn_validate_lost_reason_required`; sem ele o trigger recusaria a perda com
-- 22023 `lost_reason_invalid` e o negócio ficaria aberto. Corpo idêntico ao da
-- 0426, com o motivo novo no fim do array. Aditiva e idempotente.

create or replace function public.fn_validate_lost_reason_required() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'moved_to_another_pipeline','opted_out_of_messages'];
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
