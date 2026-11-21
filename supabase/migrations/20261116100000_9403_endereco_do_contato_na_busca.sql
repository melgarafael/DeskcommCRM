-- manifest: A busca de Contatos passa a achar a pessoa pelo ENDEREÇO dela (issue #3494). As sete colunas de endereço chegaram na 9041 e a ficha passou a preenchê-las pelo CEP, mas elas ficaram fora da busca: quem tinha o CEP na mão — o caso mais comum de quem atende — não achava o contato, porque o `?search=` só olhava nome, e-mail, telefone e CPF. Entra a coluna GERADA `contacts.endereco_sem_acento` (`street` + `district` + `city`), na MESMA forma da `busca_sem_acento` da 9098: `f_unaccent` marcado `immutable` (o `unaccent()` da extensão é STABLE e o Postgres recusa STABLE em coluna gerada), `lower(...)` e `coalesce` por campo. Coluna gerada e não gatilho pela mesma razão medida lá: a anonimização (LGPD) zera os campos de endereço e o recálculo vem junto — coluna mantida à mão ficaria com a rua antiga encontrável depois de anonimizar. Índice `gin_trgm_ops` para o `like '%termo%'` do handler, que sempre tem curinga dos dois lados. `number`, `complement` e `state` ficam FORA da coluna: número de imóvel e complemento são ruído em busca textual (\"120\" casa meio cadastro) e a UF tem duas letras — o CEP, que é o identificador do imóvel, entra pela rota própria de 8 dígitos no handler. Idempotente: `if not exists` nas duas DDLs, então roda em instalação e em atualização.
alter table public.contacts
  add column if not exists endereco_sem_acento text
  generated always as (
    lower(public.f_unaccent(
      coalesce(street, '') || ' ' || coalesce(district, '') || ' ' || coalesce(city, '')
    ))
  ) stored;

-- Trigrama para o `like '%termo%'` da busca (curinga dos dois lados não usa
-- b-tree). O piso da rota é 2 caracteres; padrão abaixo de 3 não rende trigrama
-- e varre, como já acontece com a coluna de nome.
create index if not exists idx_contacts_endereco_sem_acento_trgm
  on public.contacts using gin (endereco_sem_acento public.gin_trgm_ops);

notify pgrst, 'reload schema';
