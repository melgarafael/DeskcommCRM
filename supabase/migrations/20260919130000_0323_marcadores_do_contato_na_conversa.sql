-- 0323 — os marcadores do CONTATO alcançam o filtro de conversas (campo calculado)
--
-- ═══ O QUE ISTO DESTRAVA ═══
--
-- O Inbox tem duas caixas de marcador no mesmo painel: a do contato
-- (`contacts.tags`, a mesma da ficha e da campanha) e a da conversa
-- (`conversations.tags`, onde a IA também escreve). O filtro `?tag=` da lista
-- lia só a da conversa, e marcar o cliente para depois procurá-lo devolvia
-- "nenhuma conversa" (PR #1206). O filtro passa a casar as duas:
--
--   or=(tags.cs.{vip},tags_do_contato.cs.{vip})
--
-- ═══ POR QUE UM CAMPO CALCULADO ═══
--
-- O PostgREST trata uma função `f(public.conversations)` como coluna virtual da
-- tabela — dá para filtrá-la dentro de um `or=`, que é o que o filtro precisa.
-- As alternativas medidas pior:
--   · resolver os `contact_id` marcados e mandar `contact_id.in.(…)`: a lista
--     viaja na URL e tem teto (~186 ids no Kong); acima dele, conversas somem do
--     filtro SEM aviso;
--   · `!inner` no contato embutido: filtra só o lado do contato, não compõe um
--     OU com a caixa da conversa.
--
-- ═══ SEGURANÇA ═══
--
-- SECURITY INVOKER (o padrão): a RLS de `contacts` vale para quem chama. O
-- handler da lista já filtra `organization_id` da conversa, e o contato vem pela
-- FK `conversations_contact_id_fkey`. As DUAS origens de EXECUTE são revogadas:
-- o grant a PUBLIC da criação e o grant direto a anon do `ALTER DEFAULT
-- PRIVILEGES` do baseline (CLAUDE.md, doutrina de migrations, item 9).
--
-- Idempotente: `create or replace` + revoke/grant repetíveis.

create or replace function public.tags_do_contato(c public.conversations)
  returns text[]
  language sql
  stable
  set search_path = public
as $$
  select ct.tags from public.contacts ct where ct.id = c.contact_id
$$;

comment on function public.tags_do_contato(public.conversations) is
  'Campo calculado do PostgREST: os marcadores do contato da conversa. Permite ao filtro ?tag= do Inbox casar conversations.tags OU contacts.tags num único or= (migration 0323).';

revoke execute on function public.tags_do_contato(public.conversations) from public, anon;
grant  execute on function public.tags_do_contato(public.conversations) to authenticated, service_role;

notify pgrst, 'reload schema';
