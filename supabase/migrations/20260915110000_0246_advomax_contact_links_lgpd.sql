-- 0246 — a cascata LGPD invalida vínculos CRM ↔ Advomax do contato.
-- A função é reescrita a partir do corpo instalado para evitar duplicar os
-- passos de futuras versões: o bloco entra imediatamente antes da auditoria.
do $$
declare
  v_def text;
  v_step text := E'  -- 7c. documentos recebidos — interromper retries e remover referências ao titular.\n'
    || E'  update crm_document_intake set\n'
    || E'    contact_id = null,\n'
    || E'    pessoa_codigo = null,\n'
    || E'    filename = ''[arquivo anonimizado]'',\n'
    || E'    descricao = null,\n'
    || E'    media_storage_path = '''',\n'
    || E'    status = ''ignored'',\n'
    || E'    advomax_file_id = null,\n'
    || E'    requested_by = null,\n'
    || E'    requested_by_email = null,\n'
    || E'    failure_reason = null,\n'
    || E'    updated_at = now()\n'
    || E'  where organization_id = p_organization_id\n'
    || E'    and contact_id = p_contact_id;\n'
    || E'  get diagnostics v_count = row_count;\n'
    || E'  v_counts := v_counts || jsonb_build_object(''crm_document_intake'', v_count);\n\n'
    || E'  -- 7d. vínculo com o Advomax — remover o ator e invalidar a fila do contato\n'
    || E'  -- anonimizado. O código externo fica sem utilidade quando o titular foi\n'
    || E'  -- redigido; manter o e-mail permitiria reidentificação e retries indevidos.\n'
    || E'  update advomax_contact_links set\n'
    || E'    status = ''unlinked'',\n'
    || E'    created_by_email = null,\n'
    || E'    updated_at = now()\n'
    || E'  where organization_id = p_organization_id\n'
    || E'    and contact_id = p_contact_id;\n'
    || E'  get diagnostics v_count = row_count;\n'
    || E'  v_counts := v_counts || jsonb_build_object(''advomax_contact_links'', v_count);\n\n';
begin
  select pg_get_functiondef(
    'public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)'::regprocedure
  ) into v_def;

  if v_def is null then
    raise exception 'fn_lgpd_cascade_redact_contact not found';
  end if;

  if position('advomax_contact_links' in v_def) = 0 then
    v_def := replace(v_def, '  -- 8. dense audit row', v_step || '  -- 8. dense audit row');
    if position('advomax_contact_links' in v_def) = 0 then
      raise exception 'LGPD cascade audit marker not found';
    end if;
    execute v_def;
  end if;
end;
$$;

revoke all on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid) to service_role;
