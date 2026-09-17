-- O seletor de etiqueta do Inbox passa a oferecer as etiquetas QUE EXISTEM.
--
-- Até aqui, `GET /api/v1/conversation-tags` lia apenas
-- `organizations.settings.canonical_conversation_tags` — uma lista curada à mão.
-- Medido numa instalação real: o seletor oferecia 8 etiquetas de semente,
-- NENHUMA conversa tinha etiqueta, filtrar por qualquer uma devolvia zero, e a
-- etiqueta que a lista de conversas EXIBIA não estava entre as 8. O operador vê
-- uma etiqueta na tela e não consegue filtrar por ela.
--
-- Função, e não consulta direta: o PostgREST não expressa `distinct unnest`.
--
-- ─── ⛔ security INVOKER, e isto não é detalhe de estilo ──────────────────────
--
-- A função recebe a organização por ARGUMENTO e é concedida a `authenticated` —
-- logo é RPC alcançável por qualquer pessoa logada. Com `security definer` ela
-- leria a organização que o chamador pedisse: leitura cross-tenant, a classe de
-- defeito que um relatório da comunidade explorou na v1.0.0 (`emit_event` e
-- `retrieve_top_k_chunks`, consertados na 0149).
--
-- O próprio produto já tinha escrito o aviso, no comentário de
-- `fn_gasto_de_ia_do_mes`:
--
--     "security invoker: recebe a organização por argumento e não valida
--      membership, então definer aqui seria leitura cross-tenant."
--
-- Sob invoker, quem isola é a RLS de `conversations`
-- (`tenant_isolation_conversations_all` via `fn_user_org_ids()`), e o `p_org`
-- deixa de ser fronteira de segurança para ser o que sempre devia ter sido: um
-- filtro. Quem passar o uuid de outra organização recebe zero linhas, pelo
-- banco, sem depender de a rota se comportar.
--
-- ⚠️ Isso TROCA O GUARDIÃO: `tests/invariants/hardening-definer-varredura.test.ts`
-- só varre funções `definer`, e `definer-valida-membership.test.ts` cobre uma
-- lista FIXA de duas funções. Nenhum dos dois alcança esta. O gate dela é
-- `tests/invariants/tags-em-uso-aparecem-no-filtro.test.ts`, com caso de
-- isolamento entre DUAS organizações e caso de recusa ao `anon`.
--
-- Sem coluna nova, sem constraint, sem backfill. Índice: reaproveita o
-- `idx_conversations_tags_gin`, que já existe.

create or replace function public.fn_tags_de_conversa_em_uso(p_org uuid)
returns table (tag text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct t
  from public.conversations c, unnest(c.tags) as t
  where c.organization_id = p_org
    and c.tags is not null
  order by t
  -- Teto: numa organização bagunçada a união poderia crescer sem limite, e esta
  -- lista vai para um seletor de tela.
  limit 200;
$$;

-- Função nova em `public` nasce EXPOSTA — as DUAS origens de EXECUTE (CLAUDE.md):
-- (A) o `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do baseline,
--     que vale para toda função criada depois dele e que `revoke from public` NÃO
--     remove;
-- (B) o grant a PUBLIC que o Postgres dá a qualquer função ao criá-la, que
--     `revoke from anon` NÃO remove.
-- Tratar só uma deixa a função alcançável pela anon key, que vai para o browser.
revoke execute on function public.fn_tags_de_conversa_em_uso(uuid) from public, anon;
grant  execute on function public.fn_tags_de_conversa_em_uso(uuid) to authenticated, service_role;
