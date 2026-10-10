-- O aniversário do contato vira acontecimento do sistema.
--
-- `contacts.birthdate` existe desde cedo e nunca acionou nada: a data ficava
-- guardada, e quem quisesse parabenizar teria de olhar a ficha um por um. Este
-- é o outro lado do invariante 6 do Sistema Vivo — dado que entra e não sai por
-- lugar nenhum.
--
-- ═══ COLUNA GERADA, E NÃO UMA FUNÇÃO DE BUSCA ═══
--
-- A pergunta do cron é "quem faz aniversário HOJE", e ela cai sobre mês e dia,
-- não sobre a data inteira. Sem uma coluna para isso, as saídas seriam uma RPC
-- com `extract` (que o PostgREST alcança, mas que varre a tabela) ou trazer todo
-- contato com data preenchida para filtrar em memória.
--
-- `birthday_md` é o mês e o dia num inteiro (14 de setembro = 914). Gerada e
-- armazenada, ela é indexável, e a varredura diária vira uma busca por igualdade.
--
-- `extract` sobre `date` é immutable, que é o que uma coluna gerada exige.
-- `to_char` NÃO é: ele depende de configuração regional, e o Postgres recusa a
-- coluna. Vale escrever porque a tentação de usá-lo aqui é grande.

alter table public.contacts
  add column if not exists birthday_md integer
  generated always as (
    case
      when birthdate is null then null
      else (extract(month from birthdate)::integer * 100 + extract(day from birthdate)::integer)
    end
  ) stored;

-- Parcial: a maioria dos contatos não tem data de nascimento, e indexar o nulo
-- delas seria pagar espaço por linha que a consulta nunca alcança.
create index if not exists contacts_org_aniversario_idx
  on public.contacts (organization_id, birthday_md)
  where birthday_md is not null;

comment on column public.contacts.birthday_md is
  'Mês e dia do aniversário num inteiro (914 = 14 de setembro), derivado de birthdate. Existe para a varredura diária do cron contact-birthdays poder buscar por igualdade em vez de varrer a tabela.';
