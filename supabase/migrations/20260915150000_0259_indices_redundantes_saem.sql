-- 0259 — três índices que não pagam o próprio aluguel
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- O advisor de desempenho apontou "índice duplicado em `ai_models`" numa VPS de
-- cliente. A varredura do baseline confirmou o caso e achou mais dois do mesmo
-- feitio — índice cujo trabalho JÁ é feito por outro, integralmente.
--
-- Índice redundante não é neutro: ele custa em TODO insert e update da tabela e
-- ocupa disco. Numa VPS de 1 vCPU e disco pequeno — que é o alvo do kit
-- self-host — isso é pago todo dia.
--
-- Não é verdade que o planner os ignorava. Os dois de prefixo (casos 2 e 3)
-- são menores, e quando existem ele os PREFERE. Medido em pg17, 20 000 vínculos
-- em 2 000 leads, busca por `lead_id`: com os dois índices, `Bitmap Index Scan`
-- no de uma coluna (216 kB, custo 4,36); só com o largo, o mesmo plano no de
-- quatro (1464 kB, custo 4,49; total 39,00 → 39,13). A busca segue servida por
-- índice; troca-se um índice menor na leitura por um índice a menos em toda
-- escrita.
--
-- ─── Os três, e por que cada um é redundante ────────────────────────────────
--
-- 1. `ai_models_provider_model_unique (provider, model_id)`, criado pela
--    migration 0127, contra a constraint `ai_models_unique (provider, model_id)`
--    que já existia no schema original. Mesmas colunas, mesma ordem, os dois
--    UNIQUE. A 0127 acrescentou o índice e não removeu a constraint — é o que o
--    advisor viu. **Some o índice, fica a constraint**: constraint é a forma mais
--    forte (dá nome à violação, aparece em `pg_constraint`, não pode ser
--    derrubada por engano com `drop index`), e nenhum código cita qualquer um
--    dos dois nomes.
--
-- 2. `idx_crm_lead_links_lead (lead_id)` contra
--    `uniq_crm_lead_links_lead_target_link (lead_id, target_kind, target_id,
--    link_kind)`. Um btree responde por qualquer PREFIXO das suas colunas, e
--    `lead_id` é o primeiro do unique: toda consulta que o índice de uma coluna
--    atende, o de quatro atende também.
--
-- 3. `calendar_connections_org_pessoa_idx (organization_id, user_id)` contra
--    `calendar_connections_conta_key (organization_id, user_id, provider,
--    account_email)`. Mesmo argumento de prefixo.
--
-- ─── Por que cada drop vai dentro de um guard ───────────────────────────────
--
-- Só é seguro derrubar o índice se o substituto estiver LÁ. Num clone onde a
-- `ai_models_unique` tenha sido removida à mão, o índice da 0127 é a única coisa
-- impedindo dois cadastros do mesmo modelo — derrubá-lo abriria a porta para a
-- duplicata que a 0127 foi criada para fechar.
--
-- Os casos 2 e 3 pedem o mesmo cuidado, e o argumento "o índice largo é
-- declarado no mesmo baseline" não bastava: DECLARADO não é EXISTE. O
-- `update.sh` roda sem `ON_ERROR_STOP`, então uma criação que falhou em silêncio
-- num clone deixaria a tabela sem índice nenhum para a busca. O `DO` confere o
-- substituto antes de cada drop.

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'ai_models_unique'
       and conrelid = 'public.ai_models'::regclass
  ) then
    drop index if exists public.ai_models_provider_model_unique;
  end if;

  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'crm_lead_links'
       and indexname = 'uniq_crm_lead_links_lead_target_link'
  ) then
    drop index if exists public.idx_crm_lead_links_lead;
  end if;

  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'calendar_connections'
       and indexname = 'calendar_connections_conta_key'
  ) then
    drop index if exists public.calendar_connections_org_pessoa_idx;
  end if;
end $$;
