-- 0086 — telemetria de busca de conhecimento (Fase 4 do épico do Harness)
--
-- POR QUE UMA TABELA E NÃO `metrics`: a pergunta que o painel precisa responder
-- é "quantas buscas QUASE acertaram", e ela exige o `top_score` da busca ao lado
-- do `threshold` que estava valendo naquele momento. Métrica agregada perde
-- exatamente essa distância, que é o número que vira ação.
--
-- SEM PII, pelo mesmo contrato de `ai_router_decisions` (0085): não gravamos o
-- texto da pergunta. `hits`/`top_score` respondem à pergunta do painel sem
-- carregar conteúdo de conversa para uma tabela de telemetria de retenção longa.

create table if not exists knowledge_searches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_id uuid,
  kb_version_id uuid,
  -- Quantos chunks passaram do limiar. 0 = o agente perguntou e a base não tinha.
  hits int not null default 0,
  -- Similaridade do MELHOR candidato, mesmo que abaixo do limiar. É o que
  -- distingue "a base não tem isso" (top_score baixo) de "a base tem e o limiar
  -- cortou" (top_score logo abaixo do threshold).
  top_score numeric,
  -- O limiar vigente na busca. Guardado junto porque ele é configurável por
  -- agente: comparar `top_score` com o limiar de HOJE mentiria sobre buscas de
  -- ontem.
  threshold numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_knowledge_searches_org_created
  on knowledge_searches (organization_id, created_at desc);

alter table knowledge_searches enable row level security;

drop policy if exists tenant_isolation_knowledge_searches_all on knowledge_searches;
create policy tenant_isolation_knowledge_searches_all on knowledge_searches
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- Defesa em profundidade, mesmo contrato da 0085: a policy já devolve zero linha
-- para JWT anônimo (auth.uid() null => fn_user_org_ids() vazio), mas o grant que
-- o Supabase concede por default privilege não tem razão de existir aqui — esta
-- tabela nunca é lida sem sessão. Idempotente: revogar o que não está lá é no-op.
revoke all on public.knowledge_searches from anon;
