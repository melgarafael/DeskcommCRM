-- 0344 — `fn_estampar_atribuicao_de_anuncio` passa a exigir a ORGANIZAÇÃO (issue #1248).
--
-- A função é `security definer` e o único limite era o `p_contact` que o CHAMADOR
-- mandava: o `where` era `id = p_contact and source_metadata->>'ad_platform' is null`,
-- sem nenhuma checagem de `organization_id`. O grant é só para `service_role`
-- (revoke de public/anon/authenticated), então quem chama é o backend — e o
-- backend resolve o contato do canal, não o dono dele. Uma chamada com o contato
-- de OUTRA organização (id vazado, bug de resolução de contato no ingest, replay
-- de webhook com id trocado) estampava o anúncio no contato alheio: escrita
-- cross-tenant por caminho que a RLS não vê, porque roda como definer.
--
-- A organização passa a ser parâmetro OBRIGATÓRIO e o `where` casa
-- `organization_id = p_org`: contato de outra organização casa zero linhas,
-- silenciosamente, como o primeiro-toque (a função não levanta erro — quem
-- estampa anúncio não pode derrubar o atendimento por causa de atribuição).
--
-- A assinatura antiga de TRÊS argumentos é derrubada ANTES do create: com as duas
-- no catálogo, a chamada de três chaves resolveria na ANTIGA e a organização nunca
-- chegaria ao `where` — o mesmo defeito medido na 0336.
drop function if exists public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb);

create or replace function public.fn_estampar_atribuicao_de_anuncio(
  p_org uuid,
  p_contact uuid,
  p_platform text,
  p_metadata jsonb
) returns void
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  update public.contacts
  set
    source = p_platform,
    source_metadata = source_metadata || p_metadata,
    updated_at = now()
  where id = p_contact
    and organization_id = p_org
    and source_metadata->>'ad_platform' is null;
end;
$$;

comment on function public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb) is
  'Grava de qual anúncio (Meta Ads / Google Ads / site) um contato veio — só na primeira vez. `source_metadata = source_metadata || p_metadata` faz merge, nunca sobrescreve o que fn_upsert_wa_contact já gravou (waha_lid, waha_chat_id, notify_name). A guarda `source_metadata->>''ad_platform'' is null` é o primeiro-toque: clicar em outro anúncio meses depois, numa conversa já aberta, não reescreve de onde a pessoa veio originalmente — o UPDATE casa zero linhas, silenciosamente. `organization_id = p_org` (issue #1248): a organização é obrigatória e o contato de OUTRA organização casa zero linhas — escrita cross-tenant barrada no `where`, não no chamador. security definer + revoke de anon/authenticated: só o backend (admin client no ingest de canal) chama isto.';

revoke execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, uuid, text, jsonb) to service_role;

notify pgrst, 'reload schema';
