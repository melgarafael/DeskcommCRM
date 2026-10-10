-- 0102 — o retorno cancelado deixa de ser indistinguível do retorno disparado.
--
-- `cron_jobs.enabled = false` significa DUAS coisas hoje: o one-shot disparou
-- (fireOneDue desabilita depois de enfileirar) ou alguém desmarcou. Enquanto as
-- duas forem a mesma linha no banco, o agente não tem como saber, ao retomar,
-- que o humano cancelou o retorno — e o invariante 2 da doutrina (continuidade
-- humano→IA) fica pela metade: o humano decide e a informação não chega do outro
-- lado. Pior: a tela de fila mostraria "concluída" para um retorno que ninguém
-- executou.
--
-- Duas colunas, nenhum default e nenhum backfill inventado: as linhas antigas
-- ficam com `cancelled_at` nulo, que é a verdade disponível — não sabemos quais
-- delas foram canceladas antes desta migration existir, e chutar seria gravar
-- ficção em histórico. `cancel_reason` usa o mesmo nome de
-- `followup_enrollments.cancel_reason`: as duas famílias de acompanhamento
-- passam a falar a mesma palavra.

alter table public.cron_jobs
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text;

comment on column public.cron_jobs.cancelled_at is
  'Quando o retorno foi desmarcado. NULL = nunca cancelado (disparou ou ainda vai disparar). Distingue cancelado de disparado, que enabled=false sozinho não distingue.';
comment on column public.cron_jobs.cancel_reason is
  'Por que foi desmarcado, em texto curto e sem PII. Mesmo vocabulário de followup_enrollments.cancel_reason.';

-- A fila e as capacidades de retenção varrem "o que está agendado para este
-- contato" e "o histórico deste contato". Parcial em enabled porque a pergunta
-- quente é sempre sobre o que ainda vai disparar, e o índice cheio carregaria
-- todo o histórico já consumido da organização.
create index if not exists idx_cron_jobs_retorno_vivo
  on public.cron_jobs (organization_id, contact_id, next_run_at)
  where enabled = true and job_kind = 'followup_turn';

notify pgrst, 'reload schema';
