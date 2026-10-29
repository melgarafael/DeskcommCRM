-- manifest: fn_nascer_lead_da_conversa devolve null tambem quando o contato e relacionado (crm_lead_links target_kind='contact', link_kind='related') de negocio aberto (fatia 1a da #3669).
-- ---- contato relacionado deixa de criar negócio duplicado (migration 9042) ----
create or replace function public.fn_nascer_lead_da_conversa(
  p_org uuid,
  p_contact uuid,
  p_pipeline uuid,
  p_stage uuid,
  p_title text,
  p_source text,
  p_source_metadata jsonb default '{}'::jsonb,
  p_tags text[] default '{}'::text[]
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Serializa por (organização, contato). Transaction-scoped: liberado no
  -- commit, sem risco de lock vazado.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_contact::text, 0));

  -- NULL significa "já existe", e quem chama traduz isso para `ja_existe`. Não é
  -- erro: é o desfecho correto da segunda mensagem.
  -- O contato pode ser o PRÓPRIO (contact_id = p_contact) OU um RELACIONADO
  -- (crm_lead_links target_kind='contact', link_kind='related') de um negócio
  -- aberto: nos dois casos não se cria outro cartão.
  select id into v_id
    from public.crm_leads l
   where l.organization_id = p_org
     and l.status = 'open'
     and (
       l.contact_id = p_contact
       or exists (
         select 1
           from public.crm_lead_links k
          where k.lead_id = l.id
            and k.organization_id = l.organization_id
            and k.target_kind = 'contact'
            and k.link_kind = 'related'
            and k.target_id = p_contact
       )
     )
   limit 1;

  if v_id is not null then
    return null;
  end if;

  -- A moeda é a da organização. Sem ela o negócio pegava o default da coluna
  -- ('BRL') em QUALQUER organização.
  insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, contact_id, title, source, source_metadata, tags, currency)
  values
    (p_org, p_pipeline, p_stage, p_contact, p_title, p_source, coalesce(p_source_metadata, '{}'::jsonb), coalesce(p_tags, '{}'::text[]),
     coalesce((select o.currency from public.organizations o where o.id = p_org), 'BRL'))
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) from public, anon;
grant  execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) to authenticated, service_role;