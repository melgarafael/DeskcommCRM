-- manifest: **O telefone de ficha vazia passa a emitir `contact.phone_added` também em `fn_upsert_wa_contact` (#3315).** O gatilho "quando um contato ganhar um telefone" (0670) só rodava pelo PATCH de contatos e pela captura (`#3307`); `fn_upsert_wa_contact` preenchia `phone_number` de ficha vazia em silêncio. A função passa a chamar `public.emit_event('contact.phone_added', 'contact', …)` na MESMA transação e SÓ na transição de vazio para preenchido — `phone_number = v_alt` (promoção de grafia do MESMO número) NÃO emite, e `perform` não faz HTTP (doutrina: função de banco nunca faz HTTP). Trava a linha (`for update`) antes de ler o estado anterior, senão a corrida com outro webhook poderia medir o vazio que já não existe. **`fn_mesclar_contatos` NÃO emite, de propósito:** as duas fichas já existiam e o número já estava no CRM (na ficha do perdedor), então emitir repetiria a automação para a mesma pessoa e o mesmo número; além disso a junção roda sob a sessão do usuário (rota `/api/v1/contacts/merge`) e o `emit_event` recusa `contact.phone_added` vindo de `authenticated` (0670) — emitir ali quebraria a junção pela tela. Idempotente: `create or replace` com assinatura, `search_path` e grants INALTERADOS; espelho idêntico no apêndice do `baseline.sql`, antes da VARREDURA anon. Gates: `tests/invariants/telefone-ganho-nos-caminhos-sql.test.ts`.

create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
  v_digits text;
  v_alt text;
  v_telefone_antes text;
begin
  -- Celular BR de 12 dígitos (local 6–9) ganha o nono. A grafia sem o 9 fica
  -- em v_alt só para a BUSCA — não se escreve mais.
  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
      v_alt := '+' || v_digits;
      v_phone := '+55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
    elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
      v_phone := '+' || v_digits;
      v_alt := '+55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
    end if;
  end if;

  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid and is_merged_into is null
     limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and phone_number in (v_phone, v_alt)
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
  end if;

  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    -- (#3315) O estado ANTES da gravação, com a linha JÁ travada: é ele que
    -- decide se houve TRANSIÇÃO de vazio para preenchido. `phone_number = v_alt`
    -- não é transição — é a promoção da grafia de 12 para a canônica de 13, do
    -- MESMO número que já estava na ficha, e não "um contato ganhou telefone".
    select phone_number into v_telefone_antes
      from public.contacts where id = v_id for update;

    update public.contacts set
      -- Promove 12→13 quando é a MESMA pessoa e o canônico está livre.
      -- Outro número (pessoa diferente) continua intocável.
      phone_number = case
        when v_phone is not null and (phone_number is null or phone_number = v_alt) then v_phone
        else phone_number
      end,
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id;

    -- (#3315) `contact.phone_added` sai da MESMA transação da gravação, e só
    -- quando ELA preencheu a ficha que estava vazia — a regra que este gatilho
    -- dispara lê o contato para decidir, e a guarda `no_phone` mata com
    -- `no_phone` quem chega sem número. Emitir antes da gravação entregaria à
    -- regra um contato ainda vazio — e o defeito é MUDO.
    --
    -- Sem disparo em dobro: emitiu aqui, o `update` de `lib/channels/zernio/ingest.ts`
    -- (que exige `phone_number is null`) já não casa linha nenhuma e não emite.
    if v_phone is not null and v_telefone_antes is null then
      perform public.emit_event(
        'contact.phone_added', 'contact', v_id,
        jsonb_build_object('phone_number', v_phone), '{}'::jsonb, p_org);
    end if;

    return v_id;
  end if;

  begin
    insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
    values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
      case when v_lid is not null
        then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
        else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
      nullif(p_notify, ''))
    returning id into v_id;
    return v_id;
  exception when unique_violation then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null
       and (
         (v_phone is not null and phone_number = v_phone)
         or (v_alt is not null and phone_number = v_alt)
         or (v_lid is not null and wa_lid = v_lid)
       )
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
    return v_id;
  end;
end; $$;
