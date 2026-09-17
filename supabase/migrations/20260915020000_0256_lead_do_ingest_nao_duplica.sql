-- Três mensagens seguidas deixam de virar três negócios.
--
-- ═══ O DEFEITO, MEDIDO EM PRODUÇÃO ═══
--
-- `lib/leads/nascimento-do-lead.ts` faz check-then-act: consulta se o contato já
-- tem lead aberto e, se não tiver, insere. Entre a consulta e o insert não há
-- nada — então duas mensagens que chegam juntas passam as duas pela consulta
-- antes de qualquer insert concluir, e nascem dois cards.
--
-- Medido numa instalação real: um contato mandou três mensagens seguidas e
-- virou **três negócios**, os três criados em `17:07`, no mesmo funil e na mesma
-- etapa. Não é caso raro: é o jeito normal de escrever no WhatsApp — "oi",
-- "tudo bem?", "queria marcar".
--
-- O CLAUDE.md já prescreve o remédio para a classe ("`unique` + captura do
-- 23505"), e ele não tinha sido aplicado aqui.
--
-- ═══ POR QUE NÃO UM ÍNDICE ÚNICO ═══
--
-- `unique (organization_id, contact_id) where status = 'open'` resolveria a
-- corrida e quebraria um caso legítimo junto: um cliente PODE ter dois negócios
-- abertos ao mesmo tempo (duas propostas, dois serviços diferentes), criados à
-- mão pela tela ou pela API. A regra "um aberto por contato" é do INGEST, não do
-- CRM — e prendê-la no schema a imporia a todos os caminhos.
--
-- ═══ O LOCK POR CONTATO ═══
--
-- `pg_advisory_xact_lock` serializa apenas as entradas do MESMO contato na mesma
-- organização, e some sozinho no fim da transação. Duas mensagens de contatos
-- diferentes não esperam uma pela outra; duas do mesmo contato, sim — e a
-- segunda encontra o lead que a primeira acabou de criar.
--
-- `hashtextextended` com os dois ids no texto: o espaço de advisory lock é
-- global no banco, e misturar org e contato numa chave só evita que duas
-- organizações colidam por acaso.
--
-- ⚠️ A FUNÇÃO NÃO DECIDE NADA além disso. Funil, etapa, título, tags e origem
-- continuam sendo decididos em TypeScript, onde já estavam e onde são
-- testáveis — ela recebe tudo pronto. Mover a política para cá criaria uma
-- segunda fonte para as regras de entrada do funil.

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

  insert into public.crm_leads
    (organization_id, pipeline_id, stage_id, contact_id, title, source, source_metadata, tags)
  values
    (p_org, p_pipeline, p_stage, p_contact, p_title, p_source, coalesce(p_source_metadata, '{}'::jsonb), coalesce(p_tags, '{}'::text[]))
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) from public, anon;
grant  execute on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) to authenticated, service_role;

comment on function public.fn_nascer_lead_da_conversa(uuid, uuid, uuid, uuid, text, text, jsonb, text[]) is
  'Cria o lead de entrada do ingest serializando por (organização, contato) com advisory lock. Devolve NULL quando já existe um aberto. Existe porque o check-then-act em TypeScript deixava três mensagens seguidas virarem três negócios; um índice único resolveria a corrida e quebraria o caso legítimo de dois negócios abertos criados à mão.';
