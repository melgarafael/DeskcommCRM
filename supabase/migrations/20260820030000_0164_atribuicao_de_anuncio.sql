-- 0164 — atribuição de anúncio: de qual campanha um contato do WhatsApp veio.
--
-- `contacts.source`/`source_metadata` já existiam (nasceram genéricos, tipo
-- 'whatsapp'); esta migration não cria coluna, só a função que os preenche
-- com o dado do anúncio quando a primeira mensagem vem de um clique em
-- "Clique para o WhatsApp" (Meta Ads). Função e não UPDATE direto do
-- aplicativo porque o merge de `source_metadata` (preservar `waha_lid`,
-- `waha_chat_id`, `notify_name` que `fn_upsert_wa_contact` já gravou) e a
-- guarda de PRIMEIRO TOQUE (nunca reescrever depois de estampado) precisam
-- ser UMA operação atômica — duas mensagens quase simultâneas do mesmo
-- contato novo não podem correr a corrida de ler+mesclar+escrever em JS.
create or replace function public.fn_estampar_atribuicao_de_anuncio(
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
    -- Primeiro toque: se já tem `ad_platform`, este UPDATE casa zero linhas.
    -- Silencioso de propósito — não é erro, é "já sabíamos de onde veio".
    and source_metadata->>'ad_platform' is null;
end;
$$;

alter function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) owner to postgres;

-- Duas origens de EXECUTE, item 9 do CLAUDE.md: o grant direto a anon do
-- ALTER DEFAULT PRIVILEGES do baseline (revoke from public não remove) e o
-- grant a PUBLIC que toda função nasce com (revoke from anon não remove).
-- Só o backend chama isto (admin client, no ingest de canal) — nenhum papel
-- de sessão precisa.
revoke execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_estampar_atribuicao_de_anuncio(uuid, text, jsonb) to service_role;
