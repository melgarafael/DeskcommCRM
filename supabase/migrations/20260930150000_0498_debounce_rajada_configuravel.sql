-- ═══ Debounce de rajada configurável por agente (0498) ═══
--
-- Até aqui a janela que junta as mensagens do MESMO contato numa resposta só
-- era só a env do worker `INBOUND_DEBOUNCE_MS` (default 8000, em
-- lib/agent-engine/env.ts): global à instalação, invisível na tela e exigindo
-- acesso à VPS para mudar. Esta migration leva o valor para a versão do agente
-- (`ai_agent_versions.inbound_debounce_ms`).
--
-- Sem semântica explícita é fácil errar o desenho, então a regra fica escrita:
--   - NULL (default) = usa o `INBOUND_DEBOUNCE_MS` da instalação. Quem só
--     atualiza não muda de comportamento nenhum — regressão zero.
--   - 0 desliga a coalescência de rajada para aquele agente (job imediato).
--   - 1..60000 define a janela em milissegundos, com TETO em 60s para ninguém
--     travar o atendimento sem querer.
-- O teto é reforçado no leitor do worker (`debounceEfetivo` em debounce.ts):
-- a constraint abaixo é a cerca do banco, mas quem decide de verdade é o
-- TypeScript, que clampa o valor contra o teto mesmo para dados sujos.
--
-- Por que coluna e não jsonb: o resto da config "Limites do atendimento" da
-- versão (`max_steps`, `token_budget`, `history_message_window`, …) vive em
-- colunas tipadas nesta tabela, e o PATCH/INSERT da versão as mapeia campo a
-- campo. Nascer jsonb aqui seria divergir do vizinho sem CHECK forte nenhum.

alter table public.ai_agent_versions
  drop constraint if exists ai_agent_versions_inbound_debounce_ms_check;

alter table public.ai_agent_versions
  add column if not exists inbound_debounce_ms integer;

comment on column public.ai_agent_versions.inbound_debounce_ms is
  'Janela de coalescência de rajada inbound em ms para ESTE agente. NULL = usa o INBOUND_DEBOUNCE_MS da instalação; 0 = desliga a coalescência; teto 60s.';

-- 0..60000 (0 desliga; 60000 = 60s, o teto que impede travar o atendimento).
-- O `drop … if exists` antes do `add` torna a migration reaplicável: o
-- `update.sh` de quem já aplicou a 0498 roda o apêndice do baseline de novo, e
-- `add constraint` sem guarda quebraria com 'already exists'. Mesmo par no
-- apêndice do baseline.sql.
alter table public.ai_agent_versions
  add constraint ai_agent_versions_inbound_debounce_ms_check
  check (inbound_debounce_ms is null or (inbound_debounce_ms >= 0 and inbound_debounce_ms <= 60000));