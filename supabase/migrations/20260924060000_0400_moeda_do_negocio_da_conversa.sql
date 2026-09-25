-- 0400 — o negócio que nasce da conversa nasce na moeda da organização.
--
-- `fn_nascer_lead_da_conversa` (0256) não passava `currency`, e o insert pegava
-- o default da coluna, 'BRL', em toda organização. Medido numa organização em
-- guarani: 229 de 229 negócios em BRL. O valor do pedido, gravado depois pelo
-- assistente, sairia para a Meta como ₲125.000 lidos em real. A rota REST e a
-- ferramenta do agente já usavam a moeda da organização; faltava este caminho,
-- que é o de TODO negócio nascido de uma mensagem.
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

  select id into v_id
    from public.crm_leads
   where organization_id = p_org
     and contact_id = p_contact
     and status = 'open'
   limit 1;

  -- NULL significa "já existe", e quem chama traduz isso para `ja_existe`. Não é
  -- erro: é o desfecho correto da segunda mensagem.
  if v_id is not null then
    return null;
  end if;

  -- A moeda é a da organização. Sem ela o negócio pegava o default da coluna
  -- ('BRL') em QUALQUER organização, e o valor que o assistente grava depois
  -- saía para a plataforma de anúncio como real: ₲125.000 viravam R$ 125.000.
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

-- O que já nasceu errado. Só negócio SEM valor: sem valor, a moeda não diz nada
-- e alinhar não muda número nenhum. Negócio COM valor fica como está — ali a
-- moeda pode ter sido escolhida à mão, e trocar o rótulo mudaria o que o
-- número significa. Só em organização que declarou moeda diferente do default.
update public.crm_leads l
   set currency = o.currency
  from public.organizations o
 where o.id = l.organization_id
   and o.currency is not null
   and o.currency <> 'BRL'
   and l.currency = 'BRL'
   and l.value_cents is null;
