-- 0072 — o lastro da IA passa a poder apontar para a chamada que o produziu
--
-- POR QUÊ: a 0071 definiu o lastro como {"run_ids": [...], "trace_ids": [...]},
-- "no formato de flywheel_distiller_proposals.evidence". Mas o único escritor
-- que existe hoje (o turno do agente, em lib/agent-engine/agent/inbound-turn.ts)
-- guardava em `run_ids` um id de **llm_calls** — que é outra tabela, não
-- `ai_agent_runs`.
--
-- O nome mentia sobre o destino do ponteiro. Quem seguisse a trilha (uma pessoa
-- auditando, ou o próprio agente retomando o lead) faria join contra
-- `ai_agent_runs` e receberia VAZIO — sem erro, sem aviso. A promessa do CORE 2
-- é "toda afirmação da IA tem lastro"; lastro que aponta para a tabela errada
-- cumpre a constraint e não cumpre a promessa.
--
-- Agrava-se por ser trilha PERMANENTE: o ensaio de LGPD provou que `evidence`
-- sobrevive à anonimização (só ids, nada de PII). Id de tabela errada num
-- registro que ninguém apaga envelhece mal.
--
-- POR QUE AGORA: 1 escritor, e 0 linhas reais no banco (as 2 existentes são de
-- semente e não casam com nenhuma das tabelas). Depois seria migration MAIS
-- correção de dados.
--
-- POR QUE É SEGURO: esta migration só AFROUXA a constraint — acrescenta uma
-- terceira forma de lastro. Nenhuma linha existente pode passar a violá-la,
-- então o `update.sh` de um clone não quebra. (Foi exatamente o risco que fez
-- recusar uma check constraint em `type` mais cedo nesta entrega; aqui ele não
-- existe, porque lá se apertava e aqui se afrouxa.)

alter table public.crm_lead_activities
  drop constraint if exists crm_lead_activities_ai_needs_evidence;

alter table public.crm_lead_activities
  add constraint crm_lead_activities_ai_needs_evidence check (
    actor_kind <> 'ai'
    or coalesce(jsonb_array_length(evidence->'run_ids'), 0) > 0
    or coalesce(jsonb_array_length(evidence->'trace_ids'), 0) > 0
    or coalesce(jsonb_array_length(evidence->'llm_call_ids'), 0) > 0
  );

comment on column public.crm_lead_activities.evidence is
  'O que SUSTENTA a atividade (N referências), cada chave apontando para UMA tabela: run_ids→ai_agent_runs, trace_ids→o trace do turno, llm_call_ids→llm_calls. Não confundir com source_module/source_id, que é O QUE ORIGINOU (um ponteiro). evidence nunca repete o source_id — origem não é prova.';
