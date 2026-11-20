-- manifest: **Importar blueprint de respostas rápidas: conferir e gravar numa transação só (#1995).** A função `fn_importar_blueprint_de_respostas_rapidas(p_org, p_itens)` toma `pg_advisory_xact_lock` por ORGANIZAÇÃO, conta as respostas compartilhadas dela e — só se não houver nenhuma — grava o lote inteiro, tudo na MESMA transação. A rota deixa de fazer contagem e insert em duas requisições ao PostgREST: dois POST simultâneos do mesmo arquivo passavam os dois pela conferência e duplicavam as respostas; agora o segundo espera a trava, vê a organização ocupada e recebe `aplicado: false` (o 409 da rota). `security invoker`, sem `security definer`: a RLS `message_templates_write` (manager+) continua sendo a autoridade, e `anon` não executa. O item sem texto (recurso de áudio, cujo arquivo não viaja no blueprint) também não entra aqui. Aditiva e idempotente; apêndice igual no `baseline.sql`.
-- ============================================================================
-- 9091 — IMPORTAR BLUEPRINT: CONFERIR E GRAVAR NUMA TRANSAÇÃO SÓ (#1995)
--
-- ─── O defeito que isto fecha ───────────────────────────────────────────────
--
-- A rota fazia `select count(*)` e, se a organização estivesse vazia,
-- `insert` — duas requisições HTTP ao PostgREST, sem transação e sem trava.
-- Dois POST simultâneos do mesmo arquivo chegavam os dois ao insert antes de
-- qualquer escrita aparecer na tabela: a organização terminava com 2× as
-- respostas. Não há índice único em `message_templates` que barre repetição
-- (o conteúdo não é chave: título e corpo iguais são legítimos), então o
-- remédio não é constraint — é a conferência e a escrita serem UMA operação.
--
-- ─── Por que uma FUNÇÃO, e não "um insert condicional" ──────────────────────
--
-- `insert ... where not exists` não existe em SQL, e o PostgREST não encadeia
-- duas instruções na mesma transação. Uma função chamada por RPC é a única
-- forma de ter, no mesmo commit: a trava, a conferência e a escrita. A trava
-- é `pg_advisory_xact_lock` (e não `session`): ela solta no fim da transação
-- da RPC, inclusive quando a função levanta exceção.
--
-- ─── Por que a trava é da ORGANIZAÇÃO, e por que com sal ────────────────────
--
-- O recurso disputado é "esta organização ainda não tem respostas rápidas
-- compartilhadas" — não o ator, não o arquivo. Duas pessoas diferentes
-- importando ao mesmo tempo disputam exatamente esse recurso, então a chave é
-- `p_org`. O sufixo `:blueprint` (e o sal fixo 1995, o número da issue) separa
-- este espaço de nomes dos outros advisory locks do produto: colidir com a
-- trava de um contato ou de um canal só faria as duas operações esperarem uma
-- à outra sem motivo.
--
-- ─── Por que `security invoker` ─────────────────────────────────────────────
--
-- Quem chama é a rota, com o cliente do USUÁRIO: a RLS de `message_templates`
-- já exige `manager+` para linha compartilhada e organização do próprio
-- membro. Com `security definer` a função viraria uma porta dos fundos que
-- aceita qualquer `p_org` de qualquer chamador — inclusive do navegador, que
-- pode chamar a RPC direto. Invoker mantém a mesma autoridade de antes: o que
-- mudou é o número de transações, não quem pode gravar.
-- ============================================================================

create or replace function public.fn_importar_blueprint_de_respostas_rapidas(
  p_org uuid,
  p_itens jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_existentes integer;
  v_gravadas integer;
begin
  if p_org is null then
    raise exception 'organizacao_obrigatoria' using errcode = '22004';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'itens_invalidos' using errcode = '22023';
  end if;

  -- A TRAVA, antes da leitura: quem chega depois espera a transação do
  -- primeiro terminar — e portanto enxerga o que ele gravou.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':blueprint', 1995));

  -- A CONFERÊNCIA. Mesmo filtro do guarda da rota: só linhas COMPARTILHADAS
  -- (`owner_user_id is null`) contam. Resposta pessoal de alguém não impede a
  -- organização de receber o blueprint.
  select count(*) into v_existentes
    from public.message_templates
   where organization_id = p_org
     and owner_user_id is null;

  if v_existentes > 0 then
    -- Sem exceção: "já tem" é desfecho PREVISTO, e a rota o traduz no 409.
    return jsonb_build_object('aplicado', false, 'importadas', 0);
  end if;

  -- A ESCRITA, na mesma transação da conferência. `ordem` é a posição no
  -- array (a fração da origem não significa nada aqui). `midias` nasce vazia:
  -- o caminho no bucket é de OUTRA organização.
  insert into public.message_templates (
    organization_id,
    owner_user_id,
    title,
    body,
    shortcut,
    mostrar_na_barra,
    ordem,
    midias,
    created_by_user_id
  )
  select
    p_org,
    null,
    item ->> 'titulo',
    coalesce(item ->> 'corpo', ''),
    nullif(item ->> 'atalho', ''),
    coalesce((item ->> 'mostrar_na_barra')::boolean, true),
    (ordinalidade - 1)::numeric,
    '[]'::jsonb,
    -- Quem importou é o autor das linhas, como no `POST` da rota de criação:
    -- sem isto o rastro da resposta fica nulo e ninguém sabe de onde ela veio.
    auth.uid()
  from jsonb_array_elements(p_itens) with ordinality as t(item, ordinalidade)
  -- O ITEM SEM TEXTO NÃO ENTRA. `body` vazio é legal na CRIAÇÃO (#2833: a
  -- linha de áudio ganha o arquivo por `POST /:id/midias`), mas o blueprint
  -- não leva mídia — importá-lo criaria uma resposta sem texto e sem arquivo.
  -- A rota já filtra e CONTA o que ficou de fora; aqui é a mesma regra, para
  -- que nenhum caminho (nem uma chamada direta à RPC) crie a linha vazia.
  where coalesce(btrim(item ->> 'corpo'), '') <> '';

  get diagnostics v_gravadas = row_count;

  return jsonb_build_object('aplicado', true, 'importadas', v_gravadas);
end;
$$;

comment on function public.fn_importar_blueprint_de_respostas_rapidas(uuid, jsonb) is
  'Aplica um blueprint de respostas rápidas (#1995) sob trava por organização: conferência e gravação na mesma transação, para que dois imports simultâneos não dupliquem. Devolve { aplicado, importadas }; item sem texto não é gravado.';

-- Quem executa é quem já poderia escrever pela RLS: `authenticated` (a rota usa
-- o cliente do usuário) e `service_role`. `anon` não tem o que fazer aqui.
revoke all on function public.fn_importar_blueprint_de_respostas_rapidas(uuid, jsonb)
  from public, anon;
grant execute on function public.fn_importar_blueprint_de_respostas_rapidas(uuid, jsonb)
  to authenticated, service_role;

-- Assinatura nova no schema exposto: sem isto a RPC só aparece no próximo reload.
notify pgrst, 'reload schema';
