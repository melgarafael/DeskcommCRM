-- manifest: **"Tornar principal" para de perder o rótulo do extra promovido (#4242, item 2).** O rótulo (`contact_phones.rotulo` — "casa", "trabalho") existe só no telefone EXTRA, e a troca de principal o descartava: o extra com rótulo era apagado e o número passava a `contacts`, que não tinha onde guardá-lo. Nova coluna `contacts.phone_label` (text, nullable, sem default) e `fn_tornar_telefone_principal` passa a trocar os rótulos junto com os números — o do extra promovido vira o rótulo do principal e o do principal antigo viaja para o extra que ele vira, porque o rótulo pertence ao NÚMERO, não ao lugar na lista. Aditiva e idempotente (`add column if not exists`, `create or replace`, revoke/grant repetidos); E o rótulo sai junto com o número: quando o principal fica nulo (remoção, anonimização), o gatilho `trg_contacts_rotulo_sai_com_o_numero` zera `phone_label`, como `fn_contacts_um_numero_uma_ficha` já zera tipo e WhatsApp — texto livre não sobra numa ficha sem telefone. O espelho do baseline é um bloco só no apêndice, antes da cascata da 9243 (e portanto da VARREDURA anon), que REDEFINE a função da 9048 em vez de editá-la no lugar. Nenhuma coluna existente muda; nenhuma linha é reescrita.
alter table public.contacts
  add column if not exists phone_label text;

comment on column public.contacts.phone_label is
  'Rótulo do telefone PRINCIPAL ("casa", "trabalho"), como contact_phones.rotulo nos extras. Preenchido por "Tornar principal" com o rótulo do extra promovido (#4242, item 2); o principal antigo leva o rótulo dele para o extra que vira.';

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
  select c.id, c.phone_number, c.phone_type, c.phone_whatsapp, c.phone_label,
         nullif(pg_catalog.regexp_replace(coalesce(c.source_metadata->>'waha_lid', ''), '@.*$', ''), '') as lid
    into v_ficha
    from public.contacts c
   where c.id = p_contato and c.organization_id = p_org
     and c.is_merged_into is null and c.is_anonymized = false
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contato_indisponivel';
  end if;

  select t.id, t.phone_number, t.tipo, t.whatsapp, t.wa_lid, t.rotulo
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
    -- O rótulo anda com o NÚMERO (#4242, item 2): quem foi promovido leva o seu
    -- para o principal, e o principal antigo leva o dele para o extra abaixo.
    phone_label = v_extra.rotulo,
    source_metadata = (source_metadata - 'waha_lid' - 'waha_chat_id')
      || case when v_extra.wa_lid is not null
              then pg_catalog.jsonb_build_object('waha_lid', v_extra.wa_lid)
              else '{}'::jsonb end,
    updated_at = now()
  where id = p_contato and organization_id = p_org;

  if v_ficha.phone_number is not null then
    insert into public.contact_phones
      (organization_id, contact_id, phone_number, tipo, whatsapp, rotulo, origem, wa_lid)
    values
      (p_org, p_contato, public.fn_telefone_canonico(v_ficha.phone_number),
       coalesce(v_ficha.phone_type, public.fn_tipo_do_telefone(v_ficha.phone_number)),
       coalesce(v_ficha.phone_whatsapp, 'nao_sei'), v_ficha.phone_label, 'manual', v_ficha.lid);
  end if;
end;
$$;

revoke execute on function public.fn_tornar_telefone_principal(uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_tornar_telefone_principal(uuid, uuid, uuid) to authenticated, service_role;

-- O rótulo é do NÚMERO: quando o principal some (remoção, anonimização), ele
-- sai junto, como o tipo e o WhatsApp que `fn_contacts_um_numero_uma_ficha` já
-- zera. Sem isto, "casa da mãe" sobraria numa ficha anonimizada.
create or replace function public.fn_contacts_rotulo_sai_com_o_numero()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.phone_label := null;
  return new;
end;
$$;

revoke all on function public.fn_contacts_rotulo_sai_com_o_numero() from public;
revoke execute on function public.fn_contacts_rotulo_sai_com_o_numero() from anon, authenticated;

drop trigger if exists trg_contacts_rotulo_sai_com_o_numero on public.contacts;
create trigger trg_contacts_rotulo_sai_com_o_numero
  before insert or update of phone_number, phone_label on public.contacts
  for each row
  when (new.phone_number is null and new.phone_label is not null)
  execute function public.fn_contacts_rotulo_sai_com_o_numero();

notify pgrst, 'reload schema';
