-- 20260928002000_0463_proposta_ai_draft_enabled.sql
--
-- default TRUE, de propósito (spec §16 decisão 3 + §15.1, linhas 578-583):
-- "quem ligou Propostas quer proposta; obrigar a achar uma segunda chave é o
-- jeito de o recurso morrer desligado". Não confundir com a capacidade
-- "Propostas" da ORGANIZAÇÃO (Tarefa 16), que nasce DESLIGADA — são dois
-- níveis diferentes, e só o de cima (organização) nasce off.
alter table public.ai_agent_versions
  add column if not exists proposal_ai_draft_enabled boolean not null default true;

comment on column public.ai_agent_versions.proposal_ai_draft_enabled is
  'O agente pode rascunhar uma proposta sozinho quando ligado. Default TRUE dentro de quem ligou a capacidade "Propostas" — a pessoa sempre revisa e envia (spec §3, §16 decisão 3).';
