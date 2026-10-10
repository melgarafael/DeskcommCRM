-- 0335 — O marcador de contato já gravado passa a caixa baixa (issue #1224).
--
-- A partir desta versão a ESCRITA normaliza o marcador do contato nos quatro
-- caminhos — ficha (New/EditContactDialog), importação por CSV
-- (lib/contacts/csv.ts), API (`contactCreateSchema`/`contactPatchSchema`/
-- `contactListQuerySchema`) e `crm_manage_tags` — sempre pela MESMA função que o
-- filtro usa para ler (`lib/contacts/tag-normalizada.ts`). É isso que faz
-- `?tag=vip` encontrar o contato que foi marcado como "VIP".
--
-- O que esta migration alcança é o dado ANTERIOR: marcador de contato gravado em
-- caixa mista (ou com espaço nas pontas) que o filtro não casa — o chip aparece
-- na ficha, o filtro devolve lista vazia, e a sugestão de marcadores chega a
-- oferecer a mesma tag em duas formas. Sem ela o conserto valeria só para o que
-- for gravado a partir da instalação.
--
-- Idempotente: o predicado `is distinct from` só escreve a linha quando o
-- resultado difere do que já está gravado, então a segunda execução (numa VPS que
-- já recebeu a migration e depois aplica o baseline) não altera nenhuma linha.
--
-- A normalização é a mesma da aplicação, na mesma ordem: corta as pontas,
-- minúsculas, teto de 40 caracteres (`TAMANHO_MAXIMO_DA_TAG`), descarta o vazio
-- e tira o repetido. A ordem de primeira aparição é preservada
-- (`with ordinality`), para a ficha do contato continuar mostrando os marcadores
-- na ordem em que estavam.

update public.contacts c
   set tags = sub.normalizados
  from (
    select ct.id, array_agg(ct.tag order by ct.ord) as normalizados
      from (
        -- `c2.id` NA CHAVE: sem ele o `distinct on` é global e guarda UMA
        -- linha por marcador na TABELA INTEIRA — o segundo contato com "VIP"
        -- perde o marcador, e a deduplicação atravessa organizações. A
        -- consulta é válida, roda sem erro e sem aviso; o que denuncia é o
        -- dado. Reproduzido em Postgres 17.6: {VIP,Suporte} virava {suporte}.
        select distinct on (c2.id, left(lower(btrim(u.x)), 40))
               c2.id,
               left(lower(btrim(u.x)), 40) as tag,
               u.ord
          from public.contacts c2
          cross join lateral unnest(c2.tags) with ordinality as u(x, ord)
         where c2.tags is not null
           and left(lower(btrim(u.x)), 40) <> ''
         order by c2.id, left(lower(btrim(u.x)), 40), u.ord
      ) ct
     group by ct.id
  ) sub
 where c.id = sub.id
   and c.tags is distinct from sub.normalizados;

-- Marcador que era só espaço vira lista vazia: a sentença acima não alcança
-- essas linhas (a subconsulta descarta o vazio) e o contato ficaria com um
-- marcador invisível que nenhum filtro casa e nenhuma tela mostra.
update public.contacts c
   set tags = '{}'::text[]
 where c.tags is not null
   and cardinality(c.tags) > 0
   and c.tags is distinct from '{}'::text[]
   and not exists (
     select 1 from unnest(c.tags) as x where left(lower(btrim(x)), 40) <> ''
   );

notify pgrst, 'reload schema';
