-- manifest: A busca do Inbox passa a achar "Andréia" digitando "andreia" — e o contrário (issue #3918, fatia 1). `ILIKE` dobra a CAIXA, não o ACENTO (`lower('Á') = 'á'`, que não é `'a'`), então o termo digitado sem acento nunca encontrava o nome acentuado: no Brasil as duas grafias convivem e o cliente parecia não existir no CRM. Entra `unaccent` (extensão disponível na imagem, nunca instalada — `git grep unaccent origin/main -- supabase/` dava 0) com o wrapper `public.f_unaccent(text)` marcado `immutable`, que é o que falta no `unaccent()` da extensão (`STABLE`, porque depende do dicionário — índice e coluna gerada sobre ele falham com "functions in index expression must be marked IMMUTABLE"). A coluna `contacts.busca_sem_acento` é GERADA (`lower(public.f_unaccent(display_name, name, address_book_name))`), e não mantida por gatilho, por um motivo medido: a anonimização (LGPD) zera os campos de nome, e coluna gerada recalcula junto — gatilho que esquecesse a linha deixaria o nome antigo encontrável, que é exatamente o vazamento que a busca já evita com `is_anonymized = false`. Índice `gin_trgm_ops` para o `like '%termo%'` do handler (mesma forma do `idx_contacts_org_name_trgm` que já existe e usa `public.gin_trgm_ops`: nesta instalação as duas extensões moram em `public`). Escopo desta fatia: só a busca de CONVERSAS do inbox; Contatos, funil e seletor têm régua própria (a de regex de contatos, #1835) e ficam fora. Idempotente: `if not exists` nas três DDLs e `create or replace` na função, então roda em install e em update.
create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- O `unaccent()` da extensão é STABLE (depende do dicionário carregado), e o
-- Postgres recusa STABLE em expressão de índice e de coluna gerada com
-- "functions in index expression must be marked IMMUTABLE". Este wrapper é a
-- forma conhecida de fechar isso: corpo de UMA expressão, `immutable`, e o
-- dicionário e a função QUALIFICADOS dentro dele — `set search_path = ''`
-- impede que um schema no caminho mude o que a função resolve (é também o que
-- o lint do Security Advisor cobra de toda função de public).
create or replace function public.f_unaccent(p_texto text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select public.unaccent('public.unaccent'::regdictionary, p_texto);
$$;

-- Função nova em `public` nasce com EXECUTE para PUBLIC (Postgres) e para anon
-- (default privileges do baseline): as duas origens saem. `authenticated` fica
-- porque a coluna gerada abaixo é calculada com o papel de quem grava o contato.
revoke execute on function public.f_unaccent(text) from public, anon;
grant  execute on function public.f_unaccent(text) to authenticated, service_role;

-- Coluna GERADA, e não gatilho: a anonimização (LGPD) zera `display_name`,
-- `name` e `address_book_name`, e o recálculo vem junto — uma coluna mantida à
-- mão ficaria com o nome antigo, que é justamente o que a busca evita não
-- achar depois de anonimizar (`is_anonymized = false` no handler).
--
-- `add column if not exists` reescreve a tabela UMA vez na instalação/update
-- que a aplica (`contacts` é ordem de milhares de linhas, medido em produção).
-- Em troca, a coluna não pode divergir do nome: quem escreve o nome não precisa
-- lembrar dela.
alter table public.contacts
  add column if not exists busca_sem_acento text
  generated always as (
    lower(public.f_unaccent(
      coalesce(display_name, '') || ' ' || coalesce(name, '') || ' ' || coalesce(address_book_name, '')
    ))
  ) stored;

-- Trigrama para o `like '%termo%'` da busca (que sempre tem curinga dos dois
-- lados, então b-tree não serve). Padrão com menos de 3 caracteres não rende
-- trigrama nenhum e cai em varredura — o piso da rota é 2 (`PISO_DA_BUSCA`),
-- então termos de 2 letras continuam varrendo, como hoje.
create index if not exists idx_contacts_busca_sem_acento_trgm
  on public.contacts using gin (busca_sem_acento public.gin_trgm_ops);

notify pgrst, 'reload schema';
