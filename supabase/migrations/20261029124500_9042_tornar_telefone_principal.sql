-- manifest: **"Tornar principal" troca um telefone extra pelo principal numa operação só (Spec 31, parte B2, item 6).** Função `fn_tornar_telefone_principal(p_org, p_contato, p_extra)`: o extra vira `contacts.phone_number` levando tipo, WhatsApp e o `lid` dele; o principal antigo vira extra (origem `manual`) levando os dele. Numa transação, com a ficha travada, e na ordem que a regra "um número, uma ficha" (9041) aceita: o extra sai antes de o principal mudar, e o principal antigo entra como extra depois. `waha_chat_id` sai do `source_metadata` (era o chat do número antigo). SECURITY INVOKER: quem chama é a rota pela sessão do usuário, e a RLS de `contacts` e `contact_phones` vale; a rota exige papel `agent`. Recusa (`P0002`) extra que não é desta ficha, ficha mesclada ou anonimizada. Idempotente: `create or replace` + revoke/grant. Espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon. Prova em `tests/invariants/tornar-telefone-principal.test.ts`.
create or replace function public.fn_tornar_telefone_principal(p_org uuid, p_contato uuid, p_extra uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ficha record;
  v_extra record;
begin
  select c.id, c.phone_number, c.phone_type, c.phone_whatsapp,
         nullif(pg_catalog.regexp_replace(coalesce(c.source_metadata->>'waha_lid', ''), '@.*$', ''), '') as lid
    into v_ficha
    from public.contacts c
   where c.id = p_contato and c.organization_id = p_org
     and c.is_merged_into is null and c.is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_indisponivel';
  end if;

  select t.id, t.phone_number, t.tipo, t.whatsapp, t.wa_lid
    into v_extra
    from public.contact_phones t
   where t.id = p_extra and t.organization_id = p_org and t.contact_id = p_contato
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'telefone_extra_indisponivel';
  end if;

  -- O extra sai ANTES: senão o principal novo colidiria com ele mesmo.
  delete from public.contact_phones where id = v_extra.id and organization_id = p_org;

  update public.contacts set
    phone_number = v_extra.phone_number,
    phone_type = v_extra.tipo,
    phone_whatsapp = v_extra.whatsapp,
    source_metadata = (source_metadata - 'waha_lid' - 'waha_chat_id')
      || case when v_extra.wa_lid is not null
              then pg_catalog.jsonb_build_object('waha_lid', v_extra.wa_lid)
              else '{}'::jsonb end,
    updated_at = now()
  where id = p_contato and organization_id = p_org;

  if v_ficha.phone_number is not null then
    insert into public.contact_phones
      (organization_id, contact_id, phone_number, tipo, whatsapp, origem, wa_lid)
    values
      (p_org, p_contato, public.fn_telefone_canonico(v_ficha.phone_number),
       coalesce(v_ficha.phone_type, public.fn_tipo_do_telefone(v_ficha.phone_number)),
       coalesce(v_ficha.phone_whatsapp, 'nao_sei'), 'manual', v_ficha.lid);
  end if;
end;
$$;

revoke execute on function public.fn_tornar_telefone_principal(uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_tornar_telefone_principal(uuid, uuid, uuid) to authenticated, service_role;
