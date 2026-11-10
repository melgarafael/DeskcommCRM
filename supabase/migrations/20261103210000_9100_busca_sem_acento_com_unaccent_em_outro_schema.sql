-- manifest: A busca sem acento do Inbox (9098, #3924) passa a funcionar quando a extensão `unaccent` JÁ existe em outro schema — o caso do Supabase na nuvem, onde o painel liga extensões em `extensions`. A 9098 escrevia `public.unaccent('public.unaccent'::regdictionary, …)` fixo; com a extensão em `extensions` o `create extension if not exists unaccent` não faz nada, e o resultado medido num pg17 descartável foi pior que a coluna faltando: com `contacts` vazia o baseline instala com rc=0 (o `pg_dump` desliga `check_function_bodies`) e TODO insert em `contacts` passa a falhar com `text search dictionary "public.unaccent" does not exist` — a ingestão do WhatsApp para de criar contato; com `contacts` povoada o `add column` falha e o `update.sh`, sem `ON_ERROR_STOP`, segue com a tabela sem a coluna e a busca do Inbox em erro. Agora um bloco `DO` lê o schema da extensão em `pg_extension` e (re)cria `public.f_unaccent(text)` apontando para ele; a extensão só é criada (em `public`) quando não existe em lugar nenhum, e NUNCA é movida (`alter extension … set schema` quebraria quem mais depende dela). Coluna e índice vêm DEPOIS da função, então existem ao fim de todo install e update. Idempotente e auto-curativa: reaplicar redesenha a função com o schema daquele momento. Mesmo bloco, idêntico, no apêndice do `supabase/baseline.sql`, no lugar do bloco da 9098 (que recriava o corpo quebrado a cada `update.sh`).
create extension if not exists unaccent with schema public;
create extension if not exists pg_trgm with schema public;

-- O `unaccent()` da extensão é STABLE (depende do dicionário carregado), e o
-- Postgres recusa STABLE em expressão de índice e de coluna gerada. O wrapper
-- `immutable` fecha isso, com função e dicionário QUALIFICADOS e
-- `search_path = ''`.
--
-- O schema NÃO é fixo: é o de onde a extensão mora NESTA instalação. `public`
-- num banco que a recebeu daqui; `extensions` num Supabase que a ligou pelo
-- painel antes. Escrever `public.` fixo (a 9098) quebra o segundo caso — e
-- quebra calado, porque o `pg_dump` do baseline desliga `check_function_bodies`
-- e a função é criada sem conferir que o dicionário existe.
do $$
declare
  v_schema text;
begin
  select n.nspname into strict v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'unaccent';

  execute format(
    $f$
    create or replace function public.f_unaccent(p_texto text)
    returns text
    language sql
    immutable
    strict
    parallel safe
    set search_path = ''
    as $corpo$
      select %1$I.unaccent(%2$L::regdictionary, p_texto);
    $corpo$
    $f$,
    v_schema,
    format('%I.unaccent', v_schema)
  );
end
$$;

-- Função em `public` nasce com EXECUTE para PUBLIC (Postgres) e para anon
-- (default privileges do baseline): as duas origens saem. `authenticated` fica
-- porque a coluna gerada abaixo é calculada com o papel de quem grava o contato.
revoke execute on function public.f_unaccent(text) from public, anon;
grant  execute on function public.f_unaccent(text) to authenticated, service_role;

-- Coluna GERADA (e não gatilho): a anonimização (LGPD) zera os campos de nome e
-- o recálculo vem junto. Num banco onde a 9098 falhou ao adicioná-la, é aqui
-- que ela nasce; onde já existe, `if not exists` não reescreve a tabela.
alter table public.contacts
  add column if not exists busca_sem_acento text
  generated always as (
    lower(public.f_unaccent(
      coalesce(display_name, '') || ' ' || coalesce(name, '') || ' ' || coalesce(address_book_name, '')
    ))
  ) stored;

create index if not exists idx_contacts_busca_sem_acento_trgm
  on public.contacts using gin (busca_sem_acento public.gin_trgm_ops);

notify pgrst, 'reload schema';
