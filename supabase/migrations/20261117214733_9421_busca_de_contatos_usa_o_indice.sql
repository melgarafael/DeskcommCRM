-- manifest: **A busca do Inbox passa a usar o índice de trigrama — e, para isso, o casamento de texto sai de dentro da RLS (#4326, fatia 1, item b).** Medido num Postgres descartável (pg15) com o baseline e 40 mil contatos numa organização, um `agent` membro: a consulta que o handler montava (`busca_sem_acento like` + `phone_number ilike`, mais uma segunda consulta a `contact_phones` para o telefone extra) lia **40.000 linhas** num `Seq Scan` para devolver 1, em **37,0 ms** — o custo cresce com a ORGANIZAÇÃO, não com o que a busca acha. Criar o índice de trigrama **sozinho não muda o plano**: `like`/`ilike` não são `leakproof`, e com RLS na tabela o planejador não pode usá-los como condição de índice antes de avaliar a política (medido: com os índices criados e `analyze` feito, o plano sob `authenticated` segue `Rows Removed by Filter: 40000`; o MESMO SQL como dono da tabela vira `BitmapOr` sobre `idx_contacts_busca_sem_acento_trgm` + `idx_contacts_phone_trgm`, em **0,24 ms**). Daí as duas partes: (1) índices `gin_trgm_ops` em `contacts.phone_number` e `contact_phones.phone_number` — o nome já tinha trigrama desde a 9098, e os btree de telefone não servem para `'%x%'`; (2) `fn_contatos_da_busca(p_org, p_termo, p_digitos, p_limite)` — `security definer`, `stable`, `set search_path = ''` —, que confere a organização contra `fn_user_org_ids()` (quem chega com sessão e não é membro recebe **zero** linha), repete o filtro de organização nas duas tabelas e mantém as regras de hoje (`is_anonymized = false`, a régua de pessoal em parâmetro — `is_personal = p_pessoal`, padrão `false`, e `p_dono` para a aba Pessoal do #4434 — e `is_merged_into is null` no telefone extra); o handler passa a filtrar por `contact_id.in.(...)`, e igualdade de uuid é `leakproof`, então a RLS continua decidindo o que a pessoa vê. Resultado no mesmo conjunto: **8,0 ms** pela função, contra **47,0 ms** com o índice removido — e dos 8,0 ms, **3,7 ms sao a guarda de organizacao** (`fn_user_org_ids()`, o preco de nao confiar no `p_org` que chega) e ~1 ms o overhead do plpgsql; o casamento em si e 0,24 ms. Contrato, colunas e filtros: inalterados. Fora desta fatia, com número medido: a busca de Contatos/seletores (nome + **e-mail** + telefone, `contacts/_handler.ts`) tem a MESMA forma e o MESMO defeito, mas precisa das flags `?pessoais` e `_sem_agenda` que a listagem tem — o índice de e-mail entra junto com ela; e `conversations.last_message_preview`, onde 100 mil conversas com termo raro custam 852 ms e leem 100.700 linhas, e usar trigrama exigiria reimplementar `fn_conversation_scope` fora da política, que é mudança de autorização.

-- 9421 — a busca do Inbox usa o índice de trigrama (issue #4326, fatia 1).
--
-- ═══ O DEFEITO MEDIDO ═══
--
-- Baseline aplicado num Postgres descartável (pg15), 40 mil contatos numa
-- organização, um `agent` membro. A consulta é a que o handler montava
-- (`conversations/_handler.ts`), como `authenticated`, sob RLS:
--
--   busca do Inbox por nome ou telefone (casa 1 ficha):
--     Limit  ->  Seq Scan on contacts
--                Rows Removed by Filter: 40000     Execution Time: 37,0 ms
--
--   o MESMO SQL como dono da tabela (fora da RLS):
--     Limit  ->  BitmapOr
--                  Bitmap Index Scan on idx_contacts_busca_sem_acento_trgm
--                  Bitmap Index Scan on idx_contacts_phone_trgm
--                                                  Execution Time: 0,24 ms
--
--   a função, já no handler:                       Execution Time: 8,0 ms
--     dos quais 3,7 ms são a guarda de organização e ~1 ms o plpgsql
--   o braço do telefone sozinho:                   Execution Time: 0,2 ms
--   a função com o índice do telefone removido:    Execution Time: 47,0 ms
--

-- ═══ POR QUE O ÍNDICE SOZINHO NÃO RESOLVE ═══
--
-- `like`, `ilike` e regex NÃO são `leakproof`. Com RLS ligada na tabela, o
-- planejador só pode empurrar para o índice uma condição `leakproof` antes de
-- avaliar a política — senão uma mensagem de erro de expressão poderia revelar
-- dado de outra organização. Medido: com os índices criados e `analyze` feito,
-- `set role authenticated` mantém `Rows Removed by Filter: 40000`; o MESMO SQL
-- como dono da tabela vira `BitmapOr` sobre os dois índices de trigrama.
--
-- Detalhe operacional que a medição revelou, e que não é defeito do índice: o GIN
-- nasce com `fastupdate = on`, e com a lista pendente grande o planejador cobra a
-- varredura dela. Logo depois de uma carga em massa o índice pode perder para a
-- varredura até o autovacuum limpar: com a lista pendente grande o mesmo plano
-- custa mais, e a diferença some depois de `gin_clean_pending_list` (é por isso
-- que o invariante limpa a lista antes de medir o plano, senão mede a idade da
-- lista em vez do índice).
--
-- Ou seja: o índice está certo; o caminho até ele é que estava tapado.
--
-- ═══ O CONSERTO: O CASAMENTO DE TEXTO SAI DE DENTRO DA POLÍTICA ═══
--
-- A função é `security definer` (dono `postgres`, que não passa por RLS) e:
--
--   · confere `p_org in (select public.fn_user_org_ids())` para quem chega com
--     sessão — a MESMA fonte que a política de `contacts` usa. Organização em
--     que a pessoa não é membro devolve ZERO linhas, nunca erro: a ausência é a
--     resposta. Sem `auth.uid()` (service role, worker, agente), não gateia: a
--     mesma régua de `fn_conversation_assign`;
--   · repete o filtro de organização em cada tabela (`contacts` e
--     `contact_phones`), porque bypass de RLS sem `where` seria vazamento;
--   · repete os filtros de hoje: `is_anonymized = false` (o nome de quem pediu
--     exclusão não volta a ser encontrável), a régua de pessoal em PARÂMETRO
--     (`is_personal = p_pessoal`, padrão `false` — spec 21, etapa 7 —, mais
--     `p_dono`, que é a inversão da aba Pessoal do #4434) e, no telefone EXTRA,
--     a lápide `is_merged_into is null`;
--   · devolve SÓ ids. O handler continua lendo as linhas com o cliente da
--     sessão, por `contact_id in (...)`: igualdade de uuid é `leakproof`, e é a
--     RLS que decide o que aquela pessoa enxerga. A função não amplia
--     visibilidade — ela só acelera QUAIS ids podem casar.
--
-- ═══ O QUE NÃO MUDA ═══
--
-- O termo chega no mesmo formato de antes (`termoSeguroParaOr` +
-- `termoSemAcento`): `%` e `_` digitados vêm escapados com `\`, então o `like`
-- da função tem o mesmo efeito do `ilike` do PostgREST. O nome da agenda do
-- celular (#2439) continua entrando, porque é a terceira parte de
-- `busca_sem_acento` e a lista o mostra, como antes.

create index if not exists idx_contacts_phone_trgm
  on public.contacts using gin (phone_number public.gin_trgm_ops);
create index if not exists idx_contact_phones_phone_trgm
  on public.contact_phones using gin (phone_number public.gin_trgm_ops);

create or replace function public.fn_contatos_da_busca(
  p_org uuid,
  p_termo text default null,
  p_digitos text[] default null,
  p_limite integer default 120,
  -- #4434: pessoal não é achado FORA da aba dele, e DENTRO da aba o sinal
  -- inverte pelo MESMO booleano da lista. `p_dono` acompanha para o pessoal do
  -- colega não entrar — sem ele, `p_pessoal = true` abriria a ficha de todo
  -- mundo. Os dois ficam como PARÂMETRO, e não como constante: era o
  -- `.eq("is_personal", querPessoal)` + o filtro de dono que a consulta do
  -- PostgREST fazia antes desta fatia, e a regra não pode morar em dois lugares.
  p_pessoal boolean default false,
  p_dono uuid default null
) returns table (contact_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_digitos text[] := coalesce(p_digitos, '{}'::text[]);
  v_variante text;
  v_limite integer := greatest(1, least(coalesce(p_limite, 120), 500));
  v_achados uuid[] := '{}'::uuid[];
  v_ids uuid[];
  v_pessoal boolean := coalesce(p_pessoal, false);
begin
  if p_org is null then
    return;
  end if;
  -- Pertencer à organização é condição de ENTRADA, não filtro de saída: quem
  -- tem sessão e não é membro não recebe linha nenhuma (fail closed). A
  -- visibilidade fina (setor, responsável, plataforma) continua sendo a da
  -- política, na leitura final do handler. Sem `auth.uid()` a chamada vem do
  -- servidor (service role, worker, turno do agente), que já bypassa RLS em
  -- todo o schema — é a régua de `fn_conversation_assign`, e gatear aqui
  -- quebraria o MCP sem fechar nada que já não estivesse aberto.
  if auth.uid() is not null and p_org not in (select public.fn_user_org_ids()) then
    return;
  end if;
  if coalesce(p_termo, '') = '' and cardinality(v_digitos) = 0 then
    return;
  end if;

  -- ─── 1. NOME E TELEFONE PRINCIPAL, NUM `or` SÓ ────────────────────────────
  --
  -- Os dois braços têm índice de trigrama (busca_sem_acento desde a 9098,
  -- phone_number nesta migration), e é isso que transforma o `or` num
  -- `BitmapOr`. Um braço sem índice derrubaria o plano inteiro de volta para a
  -- varredura da organização — foi o que aconteceu com a primeira versão desta
  -- função, que testava as variantes de telefone com `exists (select … unnest)`
  -- (medido: `Rows Removed by Filter: 40000` mesmo com os índices no lugar).
  -- Por isso cada variante de telefone virou um comando PRÓPRIO, abaixo.
  if coalesce(p_termo, '') <> '' then
    v_ids := array(
      select c.id
        from public.contacts c
       where c.organization_id = p_org
         and c.is_anonymized = false
         and c.is_personal = v_pessoal
         and (p_dono is null or c.personal_owner_user_id = p_dono)
         and (
           c.busca_sem_acento like '%' || p_termo || '%'
           or c.phone_number ilike '%' || p_termo || '%'
         )
       limit v_limite
    );
    v_achados := v_ids;
  end if;

  -- ─── 2. VARIANTES DE TELEFONE, UMA CONSULTA POR VARIANTE ──────────────────
  --
  -- O handler manda uma variante por vez (`p_digitos`), mas o formato admite
  -- mais de uma. Elas são alternativas na MESMA coluna, então viram comandos
  -- separados em vez de um `or` com um braço que o índice não alcança.
  for v_variante in select distinct x from unnest(v_digitos) as d(x) where x <> '' loop
    v_achados := v_achados || array(
      select c.id
        from public.contacts c
       where c.organization_id = p_org
         and c.is_anonymized = false
         and c.is_personal = v_pessoal
         and (p_dono is null or c.personal_owner_user_id = p_dono)
         and c.phone_number like '%' || v_variante || '%'
       limit v_limite
    );
    v_achados := v_achados || array(
      select c.id
        from public.contact_phones cp
        join public.contacts c on c.id = cp.contact_id
       where cp.organization_id = p_org
         and c.organization_id = p_org
         and c.is_anonymized = false
         and c.is_personal = v_pessoal
         and (p_dono is null or c.personal_owner_user_id = p_dono)
         and c.is_merged_into is null
         and cp.phone_number like '%' || v_variante || '%'
       limit v_limite
    );
  end loop;

  return query select distinct a.id from unnest(v_achados) as a(id) limit v_limite;
end;
$$;

revoke all on function public.fn_contatos_da_busca(uuid, text, text[], integer, boolean, uuid) from public, anon;
grant execute on function public.fn_contatos_da_busca(uuid, text, text[], integer, boolean, uuid) to authenticated, service_role;

comment on function public.fn_contatos_da_busca(uuid, text, text[], integer, boolean, uuid) is
  'Ids de contatos que casam a busca do Inbox (nome sem acento, telefone principal e telefone extra) dentro de uma organização em que quem chama é membro. Existe porque like/ilike não são leakproof e a RLS de contacts impedia o uso do índice de trigrama: o casamento roda aqui, a leitura final continua sob RLS (#4326, fatia 1). `p_pessoal`/`p_dono` carregam a régua da aba Pessoal (#4434): fora dela, pessoal não casa (padrão); dentro, casa — e só a do dono informado.';
