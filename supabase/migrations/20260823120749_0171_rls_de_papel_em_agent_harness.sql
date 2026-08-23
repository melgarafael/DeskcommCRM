-- 0171: RLS de papel nas ~29 tabelas de infraestrutura do agente (migration 0050)
--
-- A 0169 (contacts) e a 0170 (messages) já fecharam o mesmo gap — RLS só de
-- TENANCY, sem checagem de PAPEL — e a própria 0169 documentou, de propósito,
-- que as tabelas nascidas na migration 0050 (`job_queue`, `send_ledger`,
-- `lead_checkpoints`, `metrics` etc.) ficavam para uma migration seguinte,
-- "pelo mesmo motivo que a 0150 deferiu: são escritas pelo motor/workers via
-- service_role, e apertar tudo no mesmo fôlego trocaria risco de segurança
-- por risco de parada de produção sem o mesmo nível de verificação por
-- tabela". Esta migration é essa verificação, tabela por tabela.
--
-- MÉTODO: para cada uma das 31 tabelas da 0050, `grep -rn '\.from("<tabela>")'
-- app lib workers components` (mais leitura de cada call site achado) para
-- decidir se algum caminho de SESSÃO (cookie/RLS — `createClient` de
-- `lib/supabase/server`, nunca `createAdminClient`) grava na tabela. O
-- worker/agent-engine usa `SUPABASE_DB_URL` via `pg.Pool` cru (doutrina:
-- service_role ou role dedicada `agent_worker`, ambos `bypassrls`) — RLS mais
-- apertada não quebra esse caminho, só fecha o acesso direto via PostgREST
-- com a chave `authenticated`.
--
-- ACHADO — 4 tabelas TÊM escrita por sessão confirmada, com o piso da rota
-- que já a exige (a policy passa a espelhar a API, nunca fica mais frouxa):
--
--   * `agent_inbox_items` — INSERT em
--     `app/api/v1/pipelines/[id]/board/route.ts` (`avisaAmbiguas`, dentro do
--     GET do board) roda no client de SESSÃO e o GET não tem `requireRole`
--     nenhum — só `supabase.auth.getUser()`. Ou seja: hoje QUALQUER membro
--     autenticado do tenant, inclusive `viewer`, já dispara esse INSERT como
--     efeito colateral de abrir o Kanban. Piso do INSERT: `'viewer'` (o mais
--     baixo — `fn_role_at_least(org,'viewer')` é `true` para qualquer membro
--     com papel, então não é regressão nenhuma, só nomeia o que já era
--     verdade). Já o UPDATE (`app/api/v1/ai/inbox/[id]/route.ts`, marcar
--     ack/resolved) exige `requireRole("agent", ...)` — mesmo rodando com
--     client ADMIN por dentro (a policy não entra em jogo ali, mas o piso
--     documentado é esse). Sem DELETE por sessão em lugar nenhum. Por isso
--     esta tabela ganha TRÊS policies (padrão da 0170): `_insert` em
--     `'viewer'`, `_update`/`_delete` em `'agent'` (defesa em profundidade
--     no DELETE, que nenhuma rota de sessão exercita hoje).
--
--   * `lead_checkpoints` — INSERT em
--     `app/api/v1/conversations/[id]/reactivate-bot/route.ts`
--     (`devolverAtendimentoAoAgente` → `gravarCheckpointDeRetomada`), client
--     de sessão, `requireRole("agent", ...)`. Piso: `'agent'`.
--
--   * `lead_state` — UPDATE em
--     `app/api/v1/leads/[id]/next-action/route.ts` (aprovar/descartar a
--     próxima ação proposta pelo agente), client de sessão,
--     `requireRole("agent", ...)`. Piso: `'agent'`.
--
--   * `cron_jobs` — INSERT em
--     `app/api/v1/leads/[id]/reactivation/route.ts` (agendar o envio da
--     retomada aceita pelo humano), client de sessão,
--     `requireRole("agent", ...)`. Piso: `'agent'`.
--
-- SEM escrita por sessão confirmada (só `service_role`/`agent_worker`) nas
-- outras 26 tabelas do loop: `job_queue`, `send_ledger`, `playbook_versions`,
-- `playbook_pointers`, `channel_session_health`, `llm_calls`,
-- `lead_state_transitions`, `metrics`, `channel_knobs`, `pacing_ledger`,
-- `outbound_copies`, `reentry_template_versions`, `reentry_template_pointers`,
-- `lead_notes`, `skill_versions`, `skill_pointers`, `promise_table_versions`,
-- `promise_table_pointers`, `disclosure_template_versions`,
-- `disclosure_template_pointers`, `before_send_traces`,
-- `flywheel_judge_verdicts`, `flywheel_distiller_proposals`,
-- `judge_alignment_pool`, `reentry_knob_versions`, `reentry_knob_pointers`.
-- Mesmo assim, cada uma ganha o piso `'agent'` por DEFESA EM PROFUNDIDADE
-- (item 3 do briefing desta migration): `service_role` sempre ignorou RLS, e
-- é a chave `anon`/`authenticated` batendo direto no PostgREST que a policy
-- nova passa a barrar.
--
-- `watchdog_cursors` (31ª tabela) NÃO muda: a 0050 já a deixou com RLS
-- habilitada e ZERO policies — nenhum papel de sessão alcança de QUALQUER
-- forma, o que já é mais restritivo que qualquer piso de papel poderia ser.
-- Mexer nela criaria uma policy onde hoje não existe nenhuma, afrouxando.
--
-- FORMA: mesmo par da 0169/0170 — `<tabela>_select` fica só-tenancy (todo
-- membro continua LENDO; achado não cobre SELECT) + escrita com
-- `fn_role_at_least(organization_id, 'agent')` (ou `'viewer'` só no INSERT de
-- `agent_inbox_items`, pelo motivo acima), preservando `fn_is_platform_admin()`
-- nos dois lados. Tabelas com `organization_id` NULLABLE (`agent_inbox_items`,
-- `playbook_versions`, `playbook_pointers`, `skill_versions`,
-- `skill_pointers`, `metrics` — comentário original da 0050) mantêm o mesmo
-- comportamento: `null in (...)` nunca é `true`, então linha de plataforma
-- continua invisível e intocável por qualquer client de sessão, papel nenhum.
--
-- Aditiva e idempotente (`drop policy if exists` + `create policy`); sem
-- constraint nova, sem backfill.
--
-- VERIFICADO nesta sessão: `pnpm test:db` (Postgres efêmero via Docker,
-- `pgvector/pgvector:pg17`), aplicando `baseline.sql` em modo install E
-- update — 112 arquivos de teste, 845 testes passando (1 falha esperada, 1
-- skip), saída `test:db verde`. Não há teste de invariante dedicado a estas
-- 30 tabelas ainda (a suíte cobre o schema inteiro, não caçou especificamente
-- "viewer apanha 403 ao gravar em job_queue"), então o verde prova que a
-- migration não quebra NADA do que já existe — não prova, tabela por tabela,
-- que o piso novo bloqueia quem devia ser bloqueado. Essa prova pontual (ex.:
-- `viewer` tentando INSERT em `cron_jobs` e apanhando RLS) fica para quem
-- quiser reforçar com um teste de invariante dedicado.

-- ── As 29 tabelas com o par padrão (select só-tenancy + write em 'agent') ──
do $$
declare
  t text;
begin
  foreach t in array array[
    'job_queue', 'send_ledger',
    'playbook_versions', 'playbook_pointers',
    'channel_session_health', 'llm_calls',
    'lead_checkpoints', 'lead_state', 'lead_state_transitions',
    'metrics', 'channel_knobs', 'pacing_ledger', 'outbound_copies',
    'cron_jobs',
    'reentry_template_versions', 'reentry_template_pointers',
    'lead_notes', 'skill_versions', 'skill_pointers',
    'promise_table_versions', 'promise_table_pointers',
    'disclosure_template_versions', 'disclosure_template_pointers',
    'before_send_traces',
    'flywheel_judge_verdicts', 'flywheel_distiller_proposals',
    'judge_alignment_pool',
    'reentry_knob_versions', 'reentry_knob_pointers'
  ]
  loop
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I', t, t);

    execute format('drop policy if exists %s_select on public.%I', t, t);
    execute format(
      'create policy %s_select on public.%I for select
         using (organization_id in (select public.fn_user_org_ids())
                or public.fn_is_platform_admin())',
      t, t
    );

    execute format('drop policy if exists %s_write on public.%I', t, t);
    execute format(
      'create policy %s_write on public.%I for all
         using (
           (organization_id in (select public.fn_user_org_ids())
             and public.fn_role_at_least(organization_id, ''agent''))
           or public.fn_is_platform_admin()
         )
         with check (
           (organization_id in (select public.fn_user_org_ids())
             and public.fn_role_at_least(organization_id, ''agent''))
           or public.fn_is_platform_admin()
         )',
      t, t
    );
  end loop;
end
$$;

-- ── agent_inbox_items: piso por operação (INSERT em 'viewer', UPDATE/DELETE
-- em 'agent'), pelo motivo documentado no cabeçalho ──

drop policy if exists "tenant_isolation_agent_inbox_items_all" on public.agent_inbox_items;

drop policy if exists "agent_inbox_items_select" on public.agent_inbox_items;
create policy "agent_inbox_items_select" on public.agent_inbox_items
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists "agent_inbox_items_insert" on public.agent_inbox_items;
create policy "agent_inbox_items_insert" on public.agent_inbox_items
  for insert with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'viewer'))
    or public.fn_is_platform_admin()
  );

drop policy if exists "agent_inbox_items_update" on public.agent_inbox_items;
create policy "agent_inbox_items_update" on public.agent_inbox_items
  for update using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  ) with check (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  );

drop policy if exists "agent_inbox_items_delete" on public.agent_inbox_items;
create policy "agent_inbox_items_delete" on public.agent_inbox_items
  for delete using (
    (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent'))
    or public.fn_is_platform_admin()
  );

-- O PostgREST guarda o schema em cache; sem isto as policies novas só valem
-- no próximo reload dele.
notify pgrst, 'reload schema';
