-- manifest: **Uma leitura só de "o que está ligado" nesta instalação (#3694).** `fn_cron_recursos_ligados()` devolve, num `jsonb`, uma chave por recurso dizendo se existe TRABALHO para os crons de minuto que hoje consultam a própria tabela e voltam vazios numa instalação parada (campanha, replay de webhook, follow-up vencido, silêncio, fila do follow-up, janela de manutenção, importação de histórico, proposta presa). Medido pelo autor da issue: oito consultas por minuto, 100% vazias. Cada sonda é a MESMA condição da consulta real — ou um superconjunto dela —, então a função nunca responde "desligado" para algo que a rota faria; errar para "ligado" custa só a consulta que já se pagava. `security invoker` (o service_role já lê tudo o que ela lê), `stable`, EXECUTE revogado de public/anon/authenticated. Sem tabela, coluna ou dado novo; idempotente.

-- ============================================================================
-- 9039 — O QUE ESTÁ LIGADO NESTA INSTALAÇÃO, NUMA LEITURA SÓ (#3694)
--
-- Numa instalação sem campanha, sem importação, sem proposta presa e sem
-- follow-up, oito rotas de cron consultavam o banco a cada minuto e voltavam
-- SEMPRE vazias. Medido pelo autor da issue: `campaigns` 2,0/min (239/239
-- vazias), `webhook_events_log` 1,2/min (143/144), o claim do follow-up
-- 1,0/min (120/120), `channel_schedules`, `job_queue`,
-- `followup_flow_pointers`, `importacoes_de_historico` e `crm_proposals` —
-- todas 100% vazias. É egress e CPU pagos para descobrir o mesmo nada, e numa
-- instalação parada é a MAIOR parte do tráfego do PostgREST.
--
-- ─── Por que uma função, e não um `if` por rota ─────────────────────────────
--
-- Cada rota perguntando "tem trabalho?" à própria tabela não economiza nada:
-- a pergunta custa a mesma consulta. O que economiza é perguntar UMA vez por
-- todas — uma ida ao banco por janela de cache (45 s, `MEMO_MS` em
-- `lib/cron/recursos-ligados.ts`), em vez de oito por minuto.
--
-- ─── A régua: nunca dizer "desligado" para quem tem trabalho ────────────────
--
-- Este é o risco da peça inteira, e é pior que a consulta vazia: a rota que
-- sai cedo por engano para de rodar em SILÊNCIO — campanha que não sai,
-- mensagem que não volta, proposta que fica presa. Por isso cada chave é a
-- condição EXATA da consulta que ela substitui, e onde a exatidão custaria
-- caro (`webhook_events_log`) ela é deliberadamente mais larga. O lado seguro
-- do erro é "ligado": pagar a consulta de sempre.
--
--   campanhas        = campanha `running`, ou `scheduled` já vencida
--                      (as duas consultas de `lib/campanhas/rodada.ts`)
--   webhook_replay    = linha `error` transitória do WAHA, SEM o corte de
--                      espera de 2 min de propósito: um superconjunto. A linha
--                      que voltou continua `error` até ser processada, e a
--                      janela de espera é MENOR que o passo do cron.
--   followup          = inscrição vencida e sem lease, de organização ativa —
--                      a mesma condição da CTE de `fn_claim_due_followup_enrollments`
--   followup_silencio = pointer `active` (o que `runSilenceSweep` varre)
--   fila_followup     = job `followup_turn` `pending` (o dreno de texto fixo)
--   pausa_de_canal    = janela `scheduled`/`running` já começada
--                      (`aplicarAgendas` nunca lê o que ainda vai começar)
--   historico         = importação `rodando`
--   propostas         = proposta `enviando` (a presa em potencial)
--
-- ─── Custo ──────────────────────────────────────────────────────────────────
--
-- Um `jsonb_build_object` com oito `exists`. Cada sonda usa o índice que a
-- consulta original já usa (`idx_webhook_events_status_received`,
-- `idx_job_queue_claim`, `idx_followup_enrollments_due_por_org`,
-- `channel_schedules_vivas_idx`, `crm_proposals_org_status_idx`); as tabelas
-- pequenas por instalação (`campaigns`, `importacoes_de_historico`,
-- `followup_flow_pointers`) caem em sequential scan barato, e nenhuma delas
-- trafega linha. Sai um statement de poucos microssegundos por janela, onde
-- hoje saem oito requisições HTTP com `select` de colunas, `order by` e embed.
--
-- ─── Por que `security invoker` ─────────────────────────────────────────────
--
-- Quem chama é o cron, com o service_role — que já lê todas estas tabelas. Uma
-- `definer` daria a esta função um poder que ninguém precisa e a exporia à
-- varredura de hardening sem motivo. `set search_path` fixo mesmo assim: a
-- função é `public`, e o Security Advisor cobra search_path em toda função.
-- ============================================================================

create or replace function public.fn_cron_recursos_ligados()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    -- Campanha: a rodada só age em `running` e em `scheduled` vencida.
    'campanhas', exists (
      select 1
        from public.campaigns c
       where c.status = 'running'
          or (c.status = 'scheduled' and c.scheduled_at is not null and c.scheduled_at <= now())
    ),
    -- Webhook: superconjunto de propósito — sem o corte de `ESPERA_MS`, para
    -- que a linha recém-arquivada nunca fique invisível para o replay.
    'webhook_replay', exists (
      select 1
        from public.webhook_events_log w
       where w.provider = 'waha'
         and w.status = 'error'
         and w.error_message like 'transitoria:%'
    ),
    -- Follow-up: a condição da CTE `fila` do claim, incluindo o lease e a
    -- organização operante (migration 0501).
    'followup', exists (
      select 1
        from public.followup_enrollments e
       where e.status in ('active', 'waiting_reply', 'dormente')
         and e.next_eval_at <= now()
         and (e.claimed_until is null or e.claimed_until < now())
         and exists (
           select 1 from public.organizations o
            where o.id = e.organization_id
              and o.status = 'active'
         )
    ),
    -- Silêncio: o sweep varre por pointer ativo.
    'followup_silencio', exists (
      select 1 from public.followup_flow_pointers p where p.status = 'active'
    ),
    -- A fila do follow-up (dreno de texto fixo sem agent-worker).
    'fila_followup', exists (
      select 1
        from public.job_queue j
       where j.kind = 'followup_turn'
         and j.status = 'pending'
    ),
    -- A janela de manutenção: `aplicarAgendas` só lê o que já começou.
    'pausa_de_canal', exists (
      select 1
        from public.channel_schedules s
       where s.status in ('scheduled', 'running')
         and s.starts_at <= now()
    ),
    -- A importação do histórico do WhatsApp (#999).
    'historico', exists (
      select 1 from public.importacoes_de_historico i where i.status = 'rodando'
    ),
    -- A proposta que ficou presa em `enviando`.
    'propostas', exists (
      select 1 from public.crm_proposals p where p.status = 'enviando'
    )
  );
$$;

comment on function public.fn_cron_recursos_ligados() is
  'O que está LIGADO nesta instalação: uma chave por recurso dos crons de minuto (#3694). Cada chave é a condição exata da consulta que ela substitui — ou um superconjunto dela —, porque "desligado" por engano para uma rota em silêncio. Quem não tem nada a fazer sai cedo sem tocar o PostgREST.';

revoke execute on function public.fn_cron_recursos_ligados() from public, anon, authenticated;
grant execute on function public.fn_cron_recursos_ligados() to service_role;
