-- manifest: **A pessoa relacionada de um negócio aberto não abre outro negócio quando escreve (fatia 1 da #3669).** `fn_nascer_lead_da_conversa` devolvia NULL ("já existe") só quando o contato era o PRINCIPAL de um negócio aberto (`crm_leads.contact_id`). Quem estava ligado ao negócio como pessoa relacionada (`crm_lead_links`, `target_kind='contact'`, `link_kind='related'` — a lista "Pessoas relacionadas" do dossiê, #1506/#3083) ganhava um card novo na primeira mensagem, sem relação com o do cliente. Na venda B2B isso é o comprador, o gerente ou o fixo da loja escrevendo de outro número: medido numa carteira de ≈930 clientes, 36 cards "(2º número)" abertos à mão para contornar e 4 conversas num dia caindo em card novo. Agora a segunda consulta (só quando não há negócio aberto como principal) procura o contato entre as pessoas relacionadas de negócio ABERTO da mesma organização; achou, devolve NULL, e a ingestão registra `ja_existe` como já faz. Sem tabela nova: o vínculo é o que a #3083 já escreve. Sem índice novo: `idx_crm_lead_links_org_target (organization_id, target_kind, target_id)` cobre a busca. Assinatura, `security invoker`, advisory lock, moeda e grants INALTERADOS (cópia da 0400 com uma consulta a mais). Idempotente (`create or replace`); espelho idêntico no apêndice do `baseline.sql`, antes da VARREDURA anon. Prova em `tests/invariants/pessoa-relacionada-nao-abre-outro-negocio.test.ts`.
--
-- 9045 — A PESSOA RELACIONADA DE UM NEGÓCIO ABERTO NÃO ABRE OUTRO NEGÓCIO.
--
-- O que NÃO muda: o contato principal continua em `crm_leads.contact_id`; quem
-- não usa "Pessoas relacionadas" não passa pela consulta nova com resultado
-- nenhum; negócio GANHO ou PERDIDO não segura ninguém (a pessoa que volta a
-- escrever depois do fechamento é demanda nova, igual ao principal); e nada aqui
-- toca `fn_upsert_wa_contact`, a identidade do canal, as conversas ou o envio.
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

  -- 9045: o contato também pode ser uma PESSOA RELACIONADA de um negócio
  -- aberto (#3083) — o comprador, o gerente, o fixo da loja. Esse negócio já é
  -- a demanda dele; um card novo seria o "(2º número)" que a #3669 descreve.
  -- Segunda consulta, e não um OR na primeira: o caso comum (principal) segue
  -- no índice de sempre, e esta só roda para quem não tem negócio próprio.
  if v_id is null then
    select l.id into v_id
      from public.crm_lead_links k
      join public.crm_leads l on l.id = k.lead_id
     where k.organization_id = p_org
       and k.target_kind = 'contact'
       and k.link_kind = 'related'
       and k.target_id = p_contact
       and l.organization_id = p_org
       and l.status = 'open'
     limit 1;
  end if;

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
