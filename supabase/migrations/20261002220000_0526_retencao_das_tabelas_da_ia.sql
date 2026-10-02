-- ============================================================================
-- 2026-10-02 — 0526: AS TABELAS APPEND-ONLY DA IA GANHAM PRAZO
--
-- ═══ O DEFEITO MEDIDO ═══
--
-- Sete tabelas que a IA escreve a cada turno ou a cada envio não tinham poda
-- nenhuma. Medido na main antes desta migration:
--
--     $ grep -n -i "delete from.*\b<tabela>\b" supabase/baseline.sql
--     (zero linhas para llm_calls, metrics, skill_activations,
--      ai_router_decisions, pacing_ledger, outbound_copies, lead_checkpoints)
--
-- E `lib/agent-engine/spinning/store.ts` dizia na própria prosa: "cresce sem
-- poda, como pacing_ledger". O plano free do Supabase tem 500 MB; quanto cada
-- uma pesa numa instalação se mede com o ranking de `pg_total_relation_size`
-- de `docs/runbooks/custo-e-cota-do-supabase.md` §4.
--
-- ═══ O MOLDE: O MESMO DA 0167 (LEIA O CABEÇALHO DELA) ═══
--
-- Cada função abaixo é `security definer` e repete as cinco razões pelas quais
-- uma função assim não vira porta: (a) NÃO TEM SELETOR DE LINHA — nenhum
-- parâmetro de organização, contato, sessão ou id; o único predicado vindo de
-- fora é a idade; (b) o PISO MORA NO CORPO (`greatest(coalesce(...), piso)`),
-- então nem quem tem a service key apaga aquém dele POR ESTA FUNÇÃO (um
-- DELETE direto não passa por ela, ver (d)); (c) revogada de PUBLIC,
-- anon e authenticated — só `service_role` executa; (d) não amplia o raio de
-- quem já tem a chave (service_role já tem DELETE nestas tabelas); (e) o cron
-- `data-retention` registra `retention.sweep_run` com a contagem de cada rodada.
-- Lotes (`p_limite`, teto 10000) pelo mesmo motivo da 0167: DELETE grande num
-- banco de cliente trava a tabela pelo tempo do backlog.
--
-- ═══ O QUE CADA UMA PRESERVA, CONFERIDO NO CÓDIGO QUE LÊ ═══
--
-- 1. TELEMETRIA DA IA (`llm_calls`, `metrics`, `skill_activations`,
--    `ai_router_decisions`) — padrão 400 dias, piso 100. A tela que mais olha
--    para trás olha 90 dias (`MAX_RANGE_DAYS` em app/api/v1/ai/usage e
--    app/api/v1/ai/evolution; `90d` no painel de plataforma); o orçamento olha o
--    mês corrente (`fn_gasto_de_ia_do_mes`); o alerta de cache olha `windowMs`.
--    EXCEÇÃO DECLARADA: `llm_calls` com `legacy_invocation_id` NÃO sai. O
--    backfill da 0130 (no baseline, reaplicado por todo `update.sh`) recopia de
--    `ai_invocations` toda linha que não tiver par em `llm_calls` — apagar a
--    cópia faria cada atualização ressuscitá-la e cada cron apagá-la de novo,
--    com o gatilho de orçamento disparando no meio. `ai_invocations` está
--    congelada desde a 0130, então o conjunto preservado é finito.
--
-- 2. RITMO DE ENVIO (`pacing_ledger`) — padrão 2, piso 2 dias. Os dois leitores
--    (`loadPacingState` em lib/agent-engine/pacing/store.ts e
--    `lerEstadoDoPacing` em ledger-supabase.ts) perguntam só duas coisas: o
--    último envio do número, em qualquer dia, e quantos saíram desde a
--    meia-noite local (no máximo 24 h atrás). Por isso a ÚLTIMA linha de cada
--    número nunca sai, em nenhuma idade: sem ela o espaçamento do próximo envio
--    não teria de onde medir.
--
-- 3. CÓPIAS ENVIADAS (`outbound_copies`) — padrão 30, piso 7 dias, e NUNCA as
--    últimas `windowSize` do número. `loadRecentCopies` lê
--    `order by sent_at desc limit windowSize`, com `windowSize` do
--    `channel_knobs.spinning_knobs` ou 20 (`SPINNING_DEFAULTS`). A função
--    guarda o MAIOR entre 20 e o knob: um knob menor que 20 é superconjunto
--    seguro, e um knob inválido cai no 20 exatamente como `parseSpinningKnobs`
--    cai. Knob acima de 10000 (só editável à mão no banco) tira o número da
--    poda inteiro — guardar tudo é o lado seguro do gate anti-ban. Encolher
--    esta tabela também encolhe uma cópia de texto enviado que fica FORA da
--    cascata de LGPD (ela não tem `contact_id`).
--
-- 4. CHECKPOINTS (`lead_checkpoints`) — padrão 180, piso 30 dias, e só o que
--    foi SUPERADO. Três guardas além da idade:
--      • nunca o último da FRONTEIRA. `latestCheckpoint` (inbound-turn.ts) lê o
--        mais recente por (organização, contato, conversation_id,
--        service_revision, demanda_id, demanda_revision) com
--        `is not distinct from`; os demais leitores (`conversa-do-caso/
--        leitura.ts`, a resposta do caso, o handoff, a retomada, o score, o
--        flywheel) leem o mais recente de um recorte MAIS GROSSO — e o mais
--        recente de um recorte grosso é, por construção, o mais recente da
--        sua própria fronteira fina. Guardar o último de cada fronteira fina
--        cobre todos;
--      • nunca o de um job vivo. `checkpointDoJob` (o Operador) lê pelo
--        `payload->>'origin_job_id'` do job `operator_turn`; e um job
--        `pending`/`running` ainda pode ler o que ele mesmo escreveu;
--      • só passou do prazo quem é mais velho que o piso.
--    Toda demanda referenciada por algum checkpoint continua referenciada (o
--    último da fronteira dela fica), então o saneamento de demanda duplicada do
--    baseline, que procura demanda sem checkpoint, não muda de veredito.
--
-- ═══ O QUE NÃO ENTRA, DE PROPÓSITO ═══
--
-- `event_log` NÃO é podado: é o livro-razão de idempotência dos gatilhos de
-- tempo (lead-time-triggers, aniversários). Apagar a linha faria o gatilho
-- achar que nunca disparou e reenviar WhatsApp.
--
-- Idempotente: `create index if not exists` com nome próprio da poda (casa por
-- nome — um nome genérico poderia existir num clone com outra definição),
-- `create or replace function`, `revoke`/`grant` reemitidos. Nenhuma
-- constraint nova, então não há dado a corrigir antes.
-- ============================================================================

-- Índices de poda: sem eles o DELETE por idade vira seq scan diário. Nenhuma
-- das sete tinha índice começando pelo relógio da poda.
create index if not exists idx_llm_calls_expurgo_created_at
  on public.llm_calls (created_at) where legacy_invocation_id is null;
create index if not exists idx_metrics_expurgo_created_at
  on public.metrics (created_at);
create index if not exists idx_skill_activations_expurgo_created_at
  on public.skill_activations (created_at);
create index if not exists idx_ai_router_decisions_expurgo_created_at
  on public.ai_router_decisions (created_at);
create index if not exists idx_pacing_ledger_expurgo_sent_at
  on public.pacing_ledger (sent_at);
create index if not exists idx_outbound_copies_expurgo_sent_at
  on public.outbound_copies (sent_at);
create index if not exists idx_lead_checkpoints_expurgo_created_at
  on public.lead_checkpoints (created_at);

-- 1. Telemetria da IA: quatro tabelas, um prazo. Cada tabela leva até
--    `p_limite` linhas por chamada e o retorno é a SOMA — "soma < limite"
--    implica que nenhuma das quatro encheu o lote, que é a condição de parada
--    do laço do cron.
create or replace function public.fn_expurgar_telemetria_de_ia_vencida(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 400), 100);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_corte timestamptz := now() - make_interval(days => v_dias);
  v_n int;
  v_total int := 0;
begin
  with vencidas as (
    select c.id from public.llm_calls c
     where c.created_at < v_corte and c.legacy_invocation_id is null
     order by c.created_at limit v_limite
  )
  delete from public.llm_calls c using vencidas v where c.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select m.id from public.metrics m
     where m.created_at < v_corte
     order by m.created_at limit v_limite
  )
  delete from public.metrics m using vencidas v where m.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select s.id from public.skill_activations s
     where s.created_at < v_corte
     order by s.created_at limit v_limite
  )
  delete from public.skill_activations s using vencidas v where s.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  with vencidas as (
    select r.id from public.ai_router_decisions r
     where r.created_at < v_corte
     order by r.created_at limit v_limite
  )
  delete from public.ai_router_decisions r using vencidas v where r.id = v.id;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;
revoke execute on function public.fn_expurgar_telemetria_de_ia_vencida(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_telemetria_de_ia_vencida(int,int) to service_role;

-- 2. Ritmo de envio: a última linha de cada número nunca sai.
create or replace function public.fn_expurgar_ritmo_de_envio_vencido(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 2), 2);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  -- O "existe um mais novo" fica no `where`, ANTES do `limit` (a lição da
  -- 0167): filtrar depois faria um lote só de últimas linhas devolver 0 e o
  -- cron parar com backlog atrás.
  with vencidas as (
    select p.id from public.pacing_ledger p
     where p.sent_at < now() - make_interval(days => v_dias)
       and exists (
         select 1 from public.pacing_ledger n
          where n.organization_id = p.organization_id
            and n.channel_session_id = p.channel_session_id
            and n.sent_at > p.sent_at
       )
     order by p.sent_at limit v_limite
  )
  delete from public.pacing_ledger p using vencidas v where p.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_expurgar_ritmo_de_envio_vencido(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_ritmo_de_envio_vencido(int,int) to service_role;

-- 3. Cópias enviadas: nunca as últimas `windowSize` do número.
create or replace function public.fn_expurgar_copias_enviadas_vencidas(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 30), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with janelas as (
    -- A janela de cada número, como `loadSpinningKnobs` a resolveria, nunca
    -- menor que o padrão de 20 (`SPINNING_DEFAULTS.windowSize`).
    select ck.organization_id, ck.channel_session_id,
           -- O `case` repete o filtro de propósito: com a CTE embutida no
           -- plano, nada garante que o `where` rode antes do cast.
           greatest(20, case when jsonb_typeof(ck.spinning_knobs->'windowSize') = 'number'
                             then ceil((ck.spinning_knobs->>'windowSize')::numeric) end) as janela
      from public.channel_knobs ck
     where jsonb_typeof(ck.spinning_knobs) = 'object'
       and jsonb_typeof(ck.spinning_knobs->'windowSize') = 'number'
  ),
  vencidas as (
    select o.id from public.outbound_copies o
      left join janelas j
        on j.organization_id = o.organization_id and j.channel_session_id = o.channel_session_id
     where o.sent_at < now() - make_interval(days => v_dias)
       and coalesce(j.janela, 20) <= 10000
       and (
         select count(*) from (
           select 1 from public.outbound_copies n
            where n.organization_id = o.organization_id
              and n.channel_session_id = o.channel_session_id
              and n.sent_at > o.sent_at
            -- `least` ANTES do cast: o Postgres não promete avaliar o `<= 10000`
            -- acima primeiro, e um knob de 1e20 estouraria o `::int` aqui.
            limit least(coalesce(j.janela, 20), 10000)::int
         ) mais_novas
       ) >= coalesce(j.janela, 20)
     order by o.sent_at limit v_limite
  )
  delete from public.outbound_copies o using vencidas v where o.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_expurgar_copias_enviadas_vencidas(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_copias_enviadas_vencidas(int,int) to service_role;

-- 4. Checkpoints: só o superado, de job morto, passado do prazo.
create or replace function public.fn_expurgar_checkpoints_superados(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dias int := greatest(coalesce(p_retencao_dias, 180), 30);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagadas int;
begin
  with jobs_vivos as materialized (
    -- Como texto: o `origin_job_id` vem de payload jsonb, e um cast para uuid
    -- derrubaria a poda inteira na primeira linha malformada.
    select j.id::text as ref from public.job_queue j
     where j.status in ('pending', 'running')
    union
    select j.payload->>'origin_job_id' from public.job_queue j
     where j.status in ('pending', 'running') and j.payload ? 'origin_job_id'
  ),
  vencidas as (
    select k.id from public.lead_checkpoints k
     where k.created_at < now() - make_interval(days => v_dias)
       and exists (
         select 1 from public.lead_checkpoints n
          where n.organization_id = k.organization_id
            and n.contact_id = k.contact_id
            and n.conversation_id is not distinct from k.conversation_id
            and n.service_revision is not distinct from k.service_revision
            and n.demanda_id is not distinct from k.demanda_id
            and n.demanda_revision is not distinct from k.demanda_revision
            and n.seq > k.seq
       )
       and (k.job_id is null
            or not exists (select 1 from jobs_vivos v where v.ref = k.job_id::text))
     order by k.created_at limit v_limite
  )
  delete from public.lead_checkpoints k using vencidas v where k.id = v.id;
  get diagnostics v_apagadas = row_count;
  return v_apagadas;
end;
$$;
revoke execute on function public.fn_expurgar_checkpoints_superados(int,int) from public, anon, authenticated;
grant  execute on function public.fn_expurgar_checkpoints_superados(int,int) to service_role;

notify pgrst, 'reload schema';
