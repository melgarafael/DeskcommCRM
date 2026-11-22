-- manifest: **A busca do Inbox passa a usar o `idx_messages_body_trgm` — e, para isso, o casamento de texto sai de dentro da RLS.** Medido num Postgres descartável (pg15) com o baseline e 200.000 mensagens em 5.000 conversas de uma organização, como `authenticated`: a consulta que `lib/inbox/busca-em-mensagens.ts` montava lia as 200.000 linhas num `Seq Scan` (197.753 avaliações da política de `conversations`) e custava **2.110 ms** (mediana de 3 execuções; 2.076–2.200) para devolver 3; o MESMO SQL como dono da tabela é `Bitmap Index Scan on idx_messages_body_trgm` em **0,42 ms**. Criar o índice sozinho não muda o plano sob RLS: `ilike`, `like` e regex **não são `leakproof`**, e o planejador só pode empurrar para o índice uma condição `leakproof` antes de avaliar a política — senão uma mensagem de erro de expressão revelaria dado de outra organização (medido: com o índice criado e `analyze` feito, uma policy `organization_id = <org>`, ela própria `leakproof`, ainda deixa o plano em `Seq Scan` com 199.997 linhas removidas; a policy `true`, que não gera qual de segurança, volta ao `Bitmap Index Scan` em 0,20 ms; e a igualdade de uuid, que É `leakproof`, continua usando índice sob a mesma RLS). Daí `fn_mensagens_da_busca(p_org, p_termo, p_limite)` — `security definer`, `stable`, `set search_path = ''` —, que confere a organização contra `fn_user_org_ids()` (quem chega com sessão e não é membro recebe **zero** linha), repete o filtro de organização e as regras de hoje (`revoked_at is null`, `metadata->>crm_hidden_at is null`) e devolve **só ids**, do mais recente para o mais antigo sob o teto; o módulo relê as linhas com o client da SESSÃO por `id in (...)` e igualdade de uuid é `leakproof`, então a RLS continua decidindo o que a pessoa vê. Resultado no mesmo conjunto e no mesmo papel: **4,3 ms** (mediana de 5; 4,2–6,7) no termo raro, contra 2.110 ms — e **39,2 ms** no termo que casa 10% (`%pedido%`), contra 2.077 ms; a função sozinha é 0,04 ms de GIN (`Bitmap Index Scan on idx_messages_body_trgm`, 3 linhas) e o resto é a leitura por id sob RLS. É o mesmo molde de `fn_contatos_da_busca` (#4326, migration 9421). Fora desta fatia: a policy de `messages` não muda, e a busca NÃO ganha régua própria — quem decide visibilidade continua sendo `messages_select`.

-- 9458 — a busca do Inbox usa o índice de trigrama (#1355, fatia 1, item 1 do
-- parecer de 14/11).
--
-- ═══ O DEFEITO MEDIDO ═══
--
-- Baseline aplicado num Postgres descartável (pg15), 200.000 mensagens em 5.000
-- conversas de UMA organização (heap de 49 MB, GIN de 24 MB), um `manager`
-- membro — a consulta que o módulo monta, com a MESMA predicate da rota,
-- rodando como `authenticated` sob RLS:
--
--   Limit
--     ->  Sort  (Sort Key: sent_at DESC)
--           ->  Seq Scan on messages
--                 Filter: (revoked_at IS NULL) AND (organization_id = …)
--                         AND (fn_is_platform_admin() OR (SubPlan 17))
--                         AND (body ~~* '%tangerina%') AND …
--                 Rows Removed by Filter: 199.997
--                 SubPlan 17 -> Index Scan using conversations_pkey
--                               loops=197.753        Execution Time: 2.110 ms
--
--   o MESMO SQL como dono da tabela (fora da RLS):
--     Limit -> Sort -> Bitmap Heap Scan on messages
--                        -> Bitmap Index Scan on idx_messages_body_trgm
--                                                Execution Time: 0,42 ms
--
--   a função, já no caminho do módulo (authenticated):  4,3 ms (mediana de 5)
--   termo que casa 10% (`%pedido%`):  2.077 ms antes  ->  39,2 ms depois
--   a função sozinha (o GIN):                           0,04 ms
--
-- O custo não é a varredura: são as 197.753 avaliações da POLICY, uma por linha
-- candidata — a busca paga a visibilidade de TODA a organização para devolver 3
-- mensagens.

-- ═══ POR QUE O ÍNDICE SOZINHO NÃO RESOLVE ═══
--
-- `ilike`, `like` e regex NÃO são `leakproof` (pg_proc.proleakproof = false em
-- texticlike/textlike/texticregexeq/textregexeq, e nos operadores de similaridade
-- do pg_trgm). Com RLS ligada na tabela, o planejador só pode empurrar para o
-- índice uma condição `leakproof` antes de avaliar a política — senão uma
-- mensagem de erro de expressão (`division by zero`, cast inválido) revelaria
-- dado de outra organização. Medido, nesta mesma base, com o índice no lugar:
--
--   policy `organization_id = <org>` (ela própria leakproof)
--     ->  Parallel Seq Scan, Rows Removed by Filter: 66.666 por worker, 86,7 ms
--   policy `true` (nenhum qual de segurança gerado)
--     ->  Bitmap Index Scan on idx_messages_body_trgm, 0,20 ms
--   `where conversation_id = <uuid>` como `authenticated` (igualdade de uuid é
--   leakproof)
--     ->  Index Scan using idx_messages_conversation_sent
--
-- Ou seja: o índice está certo; o caminho até ele é que está tapado. Nenhuma
-- variante de índice de trigrama conserta isso — todos os operadores que o
-- `gin_trgm_ops` atende são não-leakproof.

-- ═══ O CONSERTO: O CASAMENTO DE TEXTO SAI DE DENTRO DA POLÍTICA ═══
--
-- A função é `security definer` (dono `postgres`, que não passa por RLS) e:
--
--   · confere `p_org in (select public.fn_user_org_ids())` para quem chega com
--     sessão — a MESMA fonte que a política usa. Organização em que a pessoa
--     não é membro devolve ZERO linhas, nunca erro: a ausência é a resposta.
--     Sem `auth.uid()` (service role, worker, turno do agente), não gateia: a
--     mesma régua de `fn_conversation_assign` e de `fn_contatos_da_busca`;
--   · repete o filtro de organização (bypass de RLS sem `where` seria
--     vazamento) e as regras de hoje: `revoked_at is null` e
--     `metadata->>crm_hidden_at is null` — o fio não mostra essas mensagens, e
--     a busca não pode devolvê-las pela porta dos fundos;
--   · devolve SÓ ids, do mais recente para o mais antigo (`sent_at desc` sob o
--     teto). O módulo continua lendo as linhas com o cliente da SESSÃO, por
--     `id in (...)`: igualdade de uuid é `leakproof`, e é a RLS que decide o
--     que aquela pessoa enxerga. A função não amplia visibilidade — ela só
--     acelera QUAIS ids podem casar.
--
-- ═══ O QUE NÃO MUDA ═══
--
-- A policy de `messages` (0035/0726) fica como está: nenhuma segunda régua é
-- escrita aqui. O termo chega no mesmo formato de antes (o módulo troca `*` por
-- `%`, como o PostgREST fazia no `ilike`), `%` e `_` digitados continuam
-- escapados com `\`, e o teto de conversas (40) não muda.

create or replace function public.fn_mensagens_da_busca(
  p_org uuid,
  p_termo text default null,
  p_limite integer default 200
) returns table (message_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limite integer := greatest(1, least(coalesce(p_limite, 200), 1000));
  v_padrao text;
begin
  if p_org is null or coalesce(p_termo, '') = '' then
    return;
  end if;
  -- Pertencer à organização é condição de ENTRADA, não filtro de saída: quem
  -- tem sessão e não é membro não recebe linha nenhuma (fail closed). A
  -- visibilidade fina (responsável, setor, plataforma) continua sendo a da
  -- política, na leitura final do módulo, por `id in (...)`.
  if auth.uid() is not null and p_org not in (select public.fn_user_org_ids()) then
    return;
  end if;
  v_padrao := '%' || p_termo || '%';
  return query
    select m.id
      from public.messages m
     where m.organization_id = p_org
       and m.body ilike v_padrao
       and m.revoked_at is null
       and m.metadata->>'crm_hidden_at' is null
     order by m.sent_at desc
     limit v_limite;
end;
$$;

revoke all on function public.fn_mensagens_da_busca(uuid, text, integer) from public, anon;
grant execute on function public.fn_mensagens_da_busca(uuid, text, integer) to authenticated, service_role;

comment on function public.fn_mensagens_da_busca(uuid, text, integer) is
  'Ids de mensagens que casam a busca do Inbox (substring no corpo, sem revogada e sem oculta) dentro de uma organização em que quem chama é membro. Existe porque ilike não é leakproof e a RLS de messages impedia o uso do idx_messages_body_trgm: o casamento roda aqui, a leitura final continua sob RLS (#1355, fatia 1).';

notify pgrst, 'reload schema';
