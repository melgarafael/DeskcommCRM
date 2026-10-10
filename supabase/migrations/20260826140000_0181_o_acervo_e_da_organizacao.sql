-- ============================================================================
-- 0181 — O ACERVO É DA ORGANIZAÇÃO; O AGENTE ESCOLHE O QUE LÊ.
--
-- ─── O que estava errado ──────────────────────────────────────────────────
--
-- A base de conhecimento PERTENCIA a um agente (`ai_knowledge_sources.agent_id`
-- NOT NULL, FK CASCADE) e o acervo do agente era UMA versão monolítica
-- (`ai_agents.active_kb_version_id`, escalar, com `ai_kbv_one_active_per_agent`
-- impondo uma ativa por agente). Desses dois fatos saem, em cadeia:
--
--   * **Não dá para compartilhar material.** Duas equipes com o mesmo manual de
--     trocas precisam de duas cópias, indexadas duas vezes, pagas duas vezes.
--   * **UM documento por categoria por agente**, por causa do índice único
--     `(agent_id, source_type) WHERE is_active`. Todo arquivo enviado vira
--     `source_type='policy'`, então o SEGUNDO PDF de qualquer organização
--     colide com 23505.
--   * **Pipelines competindo pelo mesmo ponteiro.** `ingestConversationsBatch`
--     cria a própria versão e chama `activate_kb_version`, que DESATIVA a
--     versão de FAQ do mesmo agente. O worker de FAQ faz o inverso. Quem
--     indexou por último apaga o acervo do outro, em silêncio.
--   * **Apagar o agente apagava a base** (FK CASCADE nas duas tabelas).
--
-- ─── A inversão ───────────────────────────────────────────────────────────
--
-- A fonte passa a ser da ORGANIZAÇÃO. `agent_id` continua na coluna, agora
-- NULLABLE e `ON DELETE SET NULL`, como registro histórico de "foi criada a
-- partir deste agente" — não mais como dono.
--
-- Quem lê o quê passa a ser escolha da VERSÃO PUBLICADA do agente, em
-- `ai_agent_versions.knowledge_source_ids uuid[]`. É o molde exato de
-- `pipeline_ids` (migration 0125) e pela mesma razão escrita lá: escopo fora do
-- ciclo rascunho→publicar muda o alcance do agente sem ninguém ter publicado
-- nada. `active_kb_version_id` está hoje exatamente nessa situação.
--
-- A coluna `uuid[]` na versão, e não tabela de junção, porque o runtime lê a
-- config do agente em UMA query sem cache (`agent-config.ts`, join de
-- `ai_agent_versions` pelo `published_version_id`): acrescentar `v.<coluna>`
-- custa zero round-trip; junção custa uma query a mais por turno atendido.
--
-- ─── O ponteiro de índice vira POR FONTE ──────────────────────────────────
--
-- `ai_knowledge_sources.active_kb_version_id` — cada material aponta para o
-- índice DELE. Reindexar a FAQ deixa de derrubar o catálogo, e a competição
-- descrita acima deixa de existir por construção, não por disciplina.
--
-- **As versões legadas continuam valendo, e é por isso que o backfill é
-- barato.** Uma versão antiga contém chunks de VÁRIAS fontes (o worker
-- reconstruía tudo junto), e não há como atribuí-la a uma só. Não é preciso: o
-- predicado da busca é `chunk.kb_version_id = fonte.active_kb_version_id AND
-- chunk.knowledge_source_id = fonte.id`. Uma versão compartilhada devolve, para
-- cada fonte, exatamente os chunks daquela fonte. `knowledge_source_id` na
-- versão fica NULLABLE para sempre: nas novas ele é proveniência, nas antigas
-- é honestamente desconhecido.
--
-- ─── Vocabulário de `source_type`: o CHECK sai ────────────────────────────
--
-- Ele tinha 6 valores com DOIS pares de sinônimos (`conversation`/
-- `conversations`, `catalog`/`nuvemshop_catalog`) e nenhum valor para
-- "documento avulso" — a categoria que o produto mais precisa. Pelo precedente
-- da 0127 (que derrubou os CHECKs de `provider` pelo mesmo motivo: cada valor
-- novo virava migration, e o clone com valor legado quebrava no `update.sh`), o
-- vocabulário vai para constante TypeScript compartilhada
-- (`lib/ai/rag/tipos-de-fonte.ts`) e a coluna fica FORA do invariante
-- `vocabulario-banco-x-typescript`, que só cobre colunas que JÁ têm CHECK.
--
-- ─── Ordem, que aqui não é detalhe ────────────────────────────────────────
--
-- O índice único `(agent_id, source_type)` é derrubado ANTES do backfill de
-- vocabulário: `catalog` e `nuvemshop_catalog` viram os dois `catalogo`, e um
-- agente que tivesse os dois colidiria no meio da migration — quebrando o
-- `update.sh` do clone, que roda SEM `ON_ERROR_STOP`, em silêncio.
--
-- ─── Segurança, de brinde e não por acaso ─────────────────────────────────
--
-- As quatro tabelas de RAG ficaram de fora do aperto da 0150 e ainda têm policy
-- `ALL` só-tenancy mais `GRANT ALL ... TO anon`. Medido no relatório da
-- comunidade e reproduzível: o PostgREST é exposto ao browser por construção, e
-- um membro papel `viewer` DELETA `ai_chunks` da própria organização com o JWT
-- dele. Como esta migration já mexe nas quatro, elas entram no par
-- SELECT-tenancy + escrita-com-`fn_role_at_least` no formato 0150.
--
-- Idempotente e auto-curativa: `if not exists`, `create or replace`,
-- `drop ... if exists`, e todo dado corrigido ANTES da constraint que o exige.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A fonte deixa de ser propriedade de um agente
-- ---------------------------------------------------------------------------

-- Primeiro o índice que impede o backfill de vocabulário (ver "Ordem" acima).
drop index if exists public.ai_knowledge_sources_unique_per_agent;

alter table public.ai_knowledge_sources
  alter column agent_id drop not null;

-- CASCADE → SET NULL: apagar o agente não pode levar junto o material da
-- empresa. O acervo sobrevive ao assistente que o criou.
alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_agent_id_fkey;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_agent_id_fkey
  foreign key (agent_id) references public.ai_agents(id) on delete set null;

comment on column public.ai_knowledge_sources.agent_id is
  'HISTÓRICO: o agente a partir do qual a fonte foi criada. NÃO é dono — desde a 0181 quem lê o quê é `ai_agent_versions.knowledge_source_ids`. Nullable e ON DELETE SET NULL de propósito.';

-- A VERSÃO DE ÍNDICE TAMBÉM DEIXA DE PERTENCER A UM AGENTE.
--
-- `agent_id` era NOT NULL aqui, e um material da organização (sem agente
-- nenhum) não tinha como ser indexado: `createKnowledgeVersion` batia em
-- "null value in column agent_id violates not-null constraint" — medido na
-- prova de tela, com o material parado em `indexando` para sempre.
--
-- E o CASCADE sai junto, por uma razão pior: os chunks apontam para a VERSÃO
-- (`ai_chunks.kb_version_id ... on delete cascade`), então apagar o agente
-- levava a versão, e a versão levava os trechos — o material da EMPRESA sumia
-- porque alguém apagou um assistente. `SET NULL`: a versão pertence à fonte.
alter table public.ai_knowledge_versions
  alter column agent_id drop not null;

alter table public.ai_knowledge_versions
  drop constraint if exists ai_knowledge_versions_agent_id_fkey;
alter table public.ai_knowledge_versions
  add constraint ai_knowledge_versions_agent_id_fkey
  foreign key (agent_id) references public.ai_agents(id) on delete set null;

comment on column public.ai_knowledge_versions.agent_id is
  'HISTÓRICO: o agente a partir do qual esta indexação foi disparada. Nullable desde a 0181 — a versão pertence à FONTE, e o acervo é da organização.';

-- ---------------------------------------------------------------------------
-- 2. Vocabulário de tipo: sinônimos somem, "documento" nasce
-- ---------------------------------------------------------------------------

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_source_type_check;

update public.ai_knowledge_sources
   set source_type = case source_type
         when 'policy'            then 'documento'
         when 'conversation'      then 'conversas'
         when 'nuvemshop_catalog' then 'catalogo'
         when 'catalog'           then 'catalogo'
         else source_type
       end
 where source_type in ('policy', 'conversation', 'nuvemshop_catalog', 'catalog');

comment on column public.ai_knowledge_sources.source_type is
  'Vocabulário ABERTO (sem CHECK, precedente da 0127). A lista que a tela oferece vive em lib/ai/rag/tipos-de-fonte.ts: faq | documento | conversas | catalogo.';

-- ---------------------------------------------------------------------------
-- 3. Nome: de campo decorativo a identidade do material
-- ---------------------------------------------------------------------------
--
-- `name` nasceu com default `''` e o produto nunca o exigiu. Agora que a
-- organização pode ter N materiais, o nome é COMO a pessoa os distingue na tela
-- e no seletor do agente. Batizar o que está sem nome ANTES do índice único.

update public.ai_knowledge_sources
   set name = case source_type
         when 'faq'       then 'Perguntas frequentes'
         when 'documento' then 'Documento'
         when 'conversas' then 'Conversas anteriores'
         when 'catalogo'  then 'Catálogo de produtos'
         else 'Material'
       end || ' ' || left(id::text, 8)
 where coalesce(btrim(name), '') = '';

-- Desempate de homônimos que já existam (dois agentes com "FAQ da loja").
-- O índice único abaixo os rejeitaria e o `update.sh` do clone morreria aqui.
with duplicados as (
  select id,
         row_number() over (
           partition by organization_id, lower(btrim(name))
           order by created_at, id
         ) as n
    from public.ai_knowledge_sources
   where is_active
)
update public.ai_knowledge_sources s
   set name = s.name || ' (' || left(s.id::text, 4) || ')'
  from duplicados d
 where d.id = s.id
   and d.n > 1;

create unique index if not exists ai_knowledge_sources_nome_unico_por_org
  on public.ai_knowledge_sources (organization_id, lower(btrim(name)))
  where is_active;

-- ---------------------------------------------------------------------------
-- 4. Arquivar desliga de verdade
-- ---------------------------------------------------------------------------
--
-- O DELETE da rota gravava `status='archived'` e deixava `is_active` em true —
-- nenhuma linha do repo jamais escreveu `is_active = false`. Com o índice único
-- por (agent_id, source_type) isso tornava o "slot" permanentemente ocupado por
-- uma fonte arquivada. O índice já saiu; a incoerência dos dois campos fica.

update public.ai_knowledge_sources
   set is_active = false
 where status = 'archived' and is_active;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_arquivada_nao_e_ativa;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_arquivada_nao_e_ativa
  check (not is_active or status <> 'archived');

-- ---------------------------------------------------------------------------
-- 5. Estados que o produto JÁ produz e a tela não sabia mostrar
-- ---------------------------------------------------------------------------
--
-- `last_index_status` aceitava success|partial|failed. Faltavam os dois estados
-- reais: "está indexando agora" (que a tela mostra como "Não indexado", neutro,
-- indistinguível de nunca ter tentado) e "não indexei porque não há chave de
-- embedding" — que hoje não é gravado em lugar nenhum: o worker devolve
-- `skipped: openai_key_missing` para o próprio log e a linha da fonte segue
-- dizendo `status='ready'` para sempre.
--
-- Reconstruído em UM bloco só (lição do #159, registrada no baseline para
-- `agent_inbox_items_kind_check`): a mesma constraint remontada em N blocos
-- quebra o `update.sh` de todo clone que já tenha linha com vocabulário
-- posterior. Aditiva — só ALARGA o conjunto aceito.

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_last_index_status_check;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_last_index_status_check
  check (last_index_status is null or last_index_status = any (array[
    'success', 'partial', 'failed', 'indexando', 'sem_credencial'
  ]));

-- ---------------------------------------------------------------------------
-- 6. O índice passa a ser POR FONTE
-- ---------------------------------------------------------------------------

alter table public.ai_knowledge_sources
  add column if not exists active_kb_version_id uuid;

alter table public.ai_knowledge_versions
  add column if not exists knowledge_source_id uuid;

-- Proveniência do embedding. Sem ela, "a base foi indexada com um modelo e é
-- consultada com outro" é exatamente a falha que o registro de pontos de IA
-- descreve como silenciosa: a busca continua respondendo e devolve lixo.
alter table public.ai_knowledge_versions
  add column if not exists embedding_model text;
alter table public.ai_knowledge_versions
  add column if not exists embedding_dims integer;

comment on column public.ai_knowledge_versions.knowledge_source_id is
  'A fonte que esta versão indexa. NULL nas versões anteriores à 0181, que continham chunks de várias fontes — e continuam válidas: a busca casa (kb_version_id, knowledge_source_id) por fonte.';
comment on column public.ai_knowledge_versions.embedding_model is
  'Modelo com que os vetores desta versão foram calculados. NULL = anterior à 0181. A busca recusa a fonte cuja versão foi indexada com outro modelo — recall quebrado em silêncio é pior que fonte de fora.';

-- Ponteiros pendurados: FK só depois de limpar. Um `active_kb_version_id`
-- apontando para versão apagada é hoje indistinguível de "base vazia" — zero
-- chunk, zero erro.
update public.ai_agents a
   set active_kb_version_id = null
 where a.active_kb_version_id is not null
   and not exists (select 1 from public.ai_knowledge_versions v where v.id = a.active_kb_version_id);

delete from public.ai_chunks c
 where not exists (select 1 from public.ai_knowledge_versions v where v.id = c.kb_version_id);

alter table public.ai_agents
  drop constraint if exists ai_agents_active_kb_version_id_fkey;
alter table public.ai_agents
  add constraint ai_agents_active_kb_version_id_fkey
  foreign key (active_kb_version_id) references public.ai_knowledge_versions(id) on delete set null;

alter table public.ai_chunks
  drop constraint if exists ai_chunks_kb_version_id_fkey;
alter table public.ai_chunks
  add constraint ai_chunks_kb_version_id_fkey
  foreign key (kb_version_id) references public.ai_knowledge_versions(id) on delete cascade;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_active_kb_version_id_fkey;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_active_kb_version_id_fkey
  foreign key (active_kb_version_id) references public.ai_knowledge_versions(id) on delete set null;

alter table public.ai_knowledge_versions
  drop constraint if exists ai_knowledge_versions_knowledge_source_id_fkey;
alter table public.ai_knowledge_versions
  add constraint ai_knowledge_versions_knowledge_source_id_fkey
  foreign key (knowledge_source_id) references public.ai_knowledge_sources(id) on delete cascade;

-- ---- backfill: o que JÁ funcionava continua funcionando ----
--
-- Cada fonte herda a versão ATIVA do agente dela, mas SÓ se aquela versão
-- realmente contiver chunks daquela fonte. Apontar sem conferir daria a uma
-- fonte nunca indexada um ponteiro para o índice de outra, e a busca devolveria
-- zero — com aparência de configurada.
update public.ai_knowledge_sources s
   set active_kb_version_id = v.id
  from public.ai_knowledge_versions v
 where v.agent_id = s.agent_id
   and v.organization_id = s.organization_id
   and v.is_active
   and s.active_kb_version_id is null
   and exists (
     select 1 from public.ai_chunks c
      where c.kb_version_id = v.id and c.knowledge_source_id = s.id
   );

-- Uma versão ativa por FONTE substitui uma versão ativa por AGENTE. O índice
-- antigo é justamente o que impedia duas fontes indexadas ao mesmo tempo.
-- NULLs são distintos entre si no Postgres, então as versões legadas
-- (`knowledge_source_id is null`) não competem entre si.
drop index if exists public.ai_kbv_one_active_per_agent;
create unique index if not exists ai_kbv_uma_ativa_por_fonte
  on public.ai_knowledge_versions (knowledge_source_id)
  where is_active and knowledge_source_id is not null;

create index if not exists ai_knowledge_sources_org_idx
  on public.ai_knowledge_sources (organization_id, is_active);
create index if not exists ai_knowledge_versions_org_idx
  on public.ai_knowledge_versions (organization_id, knowledge_source_id);

-- ---------------------------------------------------------------------------
-- 7. O agente escolhe o que lê
-- ---------------------------------------------------------------------------

alter table public.ai_agent_versions
  add column if not exists knowledge_source_ids uuid[] not null default '{}'::uuid[];

comment on column public.ai_agent_versions.knowledge_source_ids is
  'Materiais que ESTE agente consulta. Vazio = NENHUM (falha fechada): ele conversa normalmente e a ferramenta de busca some do turno. Molde e racional de `pipeline_ids` (0125): escopo mora na versão publicada.';

-- Backfill: o agente continua lendo exatamente o que já era dele.
update public.ai_agent_versions v
   set knowledge_source_ids = sub.fontes
  from (
    select agent_id, array_agg(id order by created_at) as fontes
      from public.ai_knowledge_sources
     where is_active and agent_id is not null
     group by agent_id
  ) sub
 where v.agent_id = sub.agent_id
   and v.knowledge_source_ids = '{}'::uuid[];

-- ---- o trigger de imutabilidade aprende a coluna nova ----
--
-- OBRIGATÓRIO no mesmo arquivo, e não limpeza de brinde: um escopo de leitura
-- editável numa versão PUBLICADA sem virar versão nova é a própria ausência de
-- escopo, com aparência de controle. Mesma frase da 0125, mesmo motivo.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();

-- ---------------------------------------------------------------------------
-- 8. A busca passa a aceitar VÁRIAS fontes
-- ---------------------------------------------------------------------------
--
-- `retrieve_top_k_chunks` recebe UM `p_kb_version_id` escalar e continua
-- existindo — o worker legado e a capacidade MCP a chamam, e derrubá-la aqui
-- transformaria uma migration de schema numa parada de produção.
--
-- A nova preserva as duas decisões que o chamador depende:
--   * quem corta pelo limiar é o TypeScript (o caller passa o piso −1), para
--     conseguir enxergar o melhor candidato REPROVADO. Sem esse número, "a base
--     não tem essa informação" e "a base tem e o corte está apertado demais"
--     chegam iguais a quem pergunta, e são problemas com consertos opostos;
--   * o gate de membership só morde quando há `auth.uid()`. O engine roda com
--     role `bypassrls` e nunca faz `set role`, então para ele o isolamento é o
--     `organization_id = $1` escrito à mão — como já era.
--
-- `p_embedding_model`: quando informado, exclui a fonte cujo índice foi
-- calculado com OUTRO modelo. Vetores de modelos diferentes não são
-- comparáveis; incluí-los não dá erro, só devolve trecho errado com nota alta.
create or replace function public.fn_buscar_trechos_das_fontes(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40,
  p_embedding_model text default null
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_das_fontes: caller must be an active member of the organization';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    s.name as source_name,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_sources s
    on s.id = c.knowledge_source_id
   and s.organization_id = c.organization_id
  join public.ai_knowledge_versions v
    on v.id = c.kb_version_id
  where c.organization_id = p_organization_id
    and s.id = any(p_source_ids)
    and s.is_active
    and s.status = 'ready'
    and c.kb_version_id = s.active_kb_version_id
    and (
      p_embedding_model is null
      or v.embedding_model is null
      or v.embedding_model = p_embedding_model
    )
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;

comment on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) is
  'Top-K por similaridade de cosseno sobre os materiais que o agente pode ler (0181). SECURITY DEFINER + filtro programático de organização — quem chama valida o tenant.';

-- Função nova em `public` nasce EXPOSTA por DUAS origens: o grant a PUBLIC que
-- o Postgres dá a qualquer função, e o `ALTER DEFAULT PRIVILEGES ... TO anon` do
-- baseline. Tratar só uma deixa a função alcançável pela anon key, que vai no
-- bundle do browser.
revoke execute on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) from public, anon;
grant  execute on function public.fn_buscar_trechos_das_fontes(uuid, uuid[], public.vector, integer, real, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. O catálogo de modelos aprende que embedding existe
-- ---------------------------------------------------------------------------
--
-- `ai_models` não tinha NENHUM modelo de embedding, e é por isso que o painel de
-- provedores não conseguia oferecer chave para os pontos `embedding_indexar` e
-- `embedding_consultar` — não havia o que listar.

alter table public.ai_models
  add column if not exists supports_embedding boolean not null default false;
alter table public.ai_models
  add column if not exists embedding_dims integer;

insert into public.ai_models
  (provider, model_id, display_name, description,
   input_price_per_million_cents, output_price_per_million_cents,
   supports_tools, supports_embedding, embedding_dims)
values
  ('openai', 'text-embedding-3-small', 'Text Embedding 3 Small',
   'O modelo que indexa e consulta o seu material. Trocar exige reindexar tudo de uma vez.',
   2, 0, false, true, 1536)
on conflict (provider, model_id) do update set
  supports_embedding = excluded.supports_embedding,
  embedding_dims     = excluded.embedding_dims,
  supports_tools     = excluded.supports_tools;

-- ---------------------------------------------------------------------------
-- 10. RBAC nas quatro tabelas de RAG (formato da 0150)
-- ---------------------------------------------------------------------------
--
-- Elas ficaram de fora do aperto da 0150 e ainda estão como o relatório de
-- segurança da comunidade descreveu: policy `ALL` só-tenancy mais `GRANT ALL
-- ... TO anon`. Um membro papel `viewer` DELETA a base de conhecimento da
-- própria organização falando direto com o PostgREST, com o JWT dele — sem
-- passar por rota nossa, que exige `manager`.
--
-- Escrita em `manager` para as duas tabelas que a tela edita
-- (`ai_knowledge_sources`, `ai_faq_items`, espelhando o `requireRole("manager")`
-- das rotas) e em `admin` para as duas que SÓ o motor escreve (`ai_chunks`,
-- `ai_knowledge_versions`) — ninguém as edita pelo browser em caminho legítimo.
-- SELECT continua só-tenancy nas quatro: o viewer precisa LER, senão a tela
-- quebra.

-- ---- fontes ----
drop policy if exists tenant_isolation_ai_knowledge_sources_all on public.ai_knowledge_sources;

drop policy if exists tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_select on public.ai_knowledge_sources
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources;
create policy tenant_isolation_ai_knowledge_sources_write on public.ai_knowledge_sources
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
    or public.fn_is_platform_admin()
  );

-- ---- itens de FAQ ----
drop policy if exists tenant_isolation_ai_faq_items_all on public.ai_faq_items;

drop policy if exists tenant_isolation_ai_faq_items_select on public.ai_faq_items;
create policy tenant_isolation_ai_faq_items_select on public.ai_faq_items
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_ai_faq_items_write on public.ai_faq_items;
create policy tenant_isolation_ai_faq_items_write on public.ai_faq_items
  for all using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  );

-- ---- versões de índice ----
drop policy if exists tenant_isolation_ai_kbv_all on public.ai_knowledge_versions;

drop policy if exists tenant_isolation_ai_kbv_select on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_select on public.ai_knowledge_versions
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_kbv_write on public.ai_knowledge_versions;
create policy tenant_isolation_ai_kbv_write on public.ai_knowledge_versions
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- ---- trechos ----
drop policy if exists tenant_isolation_ai_chunks_all on public.ai_chunks;

drop policy if exists tenant_isolation_ai_chunks_select on public.ai_chunks;
create policy tenant_isolation_ai_chunks_select on public.ai_chunks
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists tenant_isolation_ai_chunks_write on public.ai_chunks;
create policy tenant_isolation_ai_chunks_write on public.ai_chunks
  for all using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin'))
    or public.fn_is_platform_admin()
  );

-- `anon` é a chave que vai no bundle do browser, de um visitante NÃO logado.
-- Nenhuma das quatro tem caminho legítimo por ela.
revoke all on table public.ai_knowledge_sources  from anon;
revoke all on table public.ai_knowledge_versions from anon;
revoke all on table public.ai_chunks             from anon;
revoke all on table public.ai_faq_items          from anon;

-- Apagar a base de conhecimento de uma organização passa a deixar rastro.
drop trigger if exists trg_ai_knowledge_sources_audit on public.ai_knowledge_sources;
create trigger trg_ai_knowledge_sources_audit
  after insert or update or delete on public.ai_knowledge_sources
  for each row execute function public.fn_audit_log_row();

-- ---------------------------------------------------------------------------
-- 11. A Central de avisos aprende que material pode não entrar na base
-- ---------------------------------------------------------------------------
--
-- Faltava o laço de retorno (invariante 7 do Sistema Vivo). Quando a indexação
-- não acontece — sem chave de embedding, extração de PDF que falha, todos os
-- chunks recusados — o worker devolvia `skipped`/`error` para o próprio log, o
-- drain tratava `skipped` como sucesso, e a linha da fonte continuava dizendo
-- `status='ready'`. O dono do negócio subia o material, a tela dizia "Não
-- indexado" (neutro, indistinguível de "ainda não tentei") e nada nunca
-- acontecia.
--
-- O irmão direto já existe: `midia_nao_lida` avisa quando falta a chave da
-- OpenAI para transcrever áudio. Mesma chave, mesmo tipo de silêncio, e este
-- lado era mudo.
--
-- UM kind e não dois (`sem_credencial` + `falhou`): quem lê a Central quer
-- saber que o material não entrou; POR QUE não entrou é o corpo do aviso. Dois
-- kinds obrigariam a tela a ter duas frases para a mesma consequência.
--
-- ESTE bloco reconstrói a constraint com a lista COMPLETA de propósito:
-- `tests/unit/kind-check-migration-x-baseline.test.ts` exige que a ÚLTIMA
-- migration que a reconstrói termine igual ao baseline, valor a valor.
-- Reconstruir com lista menor apaga vocabulário para quem aplica migrations em
-- ordem, e o INSERT do valor perdido passa a violar a constraint em silêncio.

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'other'
  ));

-- ---------------------------------------------------------------------------
-- 12. A telemetria de busca aprende QUEM perguntou e SOBRE O QUÊ
-- ---------------------------------------------------------------------------
--
-- `knowledge_searches` registrava organização, job, versão de índice, número de
-- acertos, melhor nota e limiar. Faltava o que a torna acionável: QUAL
-- assistente perguntou e em QUAIS materiais. Sem isso, "o recall está ruim" não
-- tem como virar "o recall está ruim NAQUELE material", que é o conserto.
--
-- `kb_version_id` passa a aceitar NULL porque a busca deixou de ser sobre UMA
-- versão: ela é sobre um conjunto de materiais, cada um com o índice dele.
--
-- A decisão declarada no cabeçalho da 0086 continua valendo: esta tabela NÃO
-- guarda o texto da pergunta. Acrescentar ids é compatível com ela; acrescentar
-- a pergunta seria PII contra a decisão.

alter table public.knowledge_searches
  alter column kb_version_id drop not null;

alter table public.knowledge_searches
  add column if not exists agent_id uuid references public.ai_agents(id) on delete set null;

alter table public.knowledge_searches
  add column if not exists knowledge_source_ids uuid[] not null default '{}'::uuid[];

comment on column public.knowledge_searches.knowledge_source_ids is
  'Materiais consultados nesta busca. Vazio nas linhas anteriores à 0181, quando a busca era sobre uma única versão de índice.';

notify pgrst, 'reload schema';
