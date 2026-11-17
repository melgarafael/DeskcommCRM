-- 9355 — a passagem explícita entre agentes vale pelo turno seguinte (#4318).
--
-- manifest: conversations.active_agent_transfer_at — carimbo da passagem explícita (ação `transferir-agente` e ferramenta `transfer_to_agent`); igual a `active_agent_set_at` enquanto o agente passado ainda não atendeu turno roteado, e é essa igualdade que impede o classificador de desfazer a passagem no turno seguinte.
--
-- O DEFEITO MEDIDO (issue #4318, main 528fa159bf). Com roteador ativo e sticky
-- ligado, a passagem explícita gravava `active_ai_agent_id`/`active_intent` e
-- nada mais. No turno seguinte o classificador continuava rodando e a regra 2 de
-- `destinoDoVeredito` devolvia `reclassified` quando vinha uma intenção
-- diferente com confiança >= `min_confidence` — a primeira mensagem do cliente
-- que o classificador entendesse como outro assunto desfazia a decisão que uma
-- pessoa (ou o próprio agente) tinha pedido.
--
-- O CONSERTO é a coluna abaixo, gravada pela passagem com o MESMO `now()` de
-- `active_agent_set_at`. Dois carimbos iguais = "passagem pendente": o turno
-- seguinte honra quem recebeu a conversa e NÃO reclassifica. O primeiro turno
-- roteado reescreve `active_agent_set_at` (`inbound-turn.ts`) e consome a
-- marca; do segundo em diante o classificador volta a mandar, para o roteador
-- não virar inerte. Não há prazo inventado nem escrita extra por turno: a
-- comparação é entre duas colunas da MESMA linha, lidas na consulta que o turno
-- já fazia.
--
-- SEM BACKFILL, de propósito: `null` significa "não há passagem pendente", que é
-- o estado correto para toda conversa anterior a esta migration — a passagem só
-- protege o turno seguinte, e nenhuma delas tem turno seguinte para proteger.
alter table conversations add column if not exists active_agent_transfer_at timestamptz;

comment on column conversations.active_agent_transfer_at is
  'Quando a conversa foi passada de propósito para outro agente de IA (#4318). Gravado no mesmo instante de active_agent_set_at; iguais = passagem pendente, que vence o classificador no turno seguinte. O primeiro turno roteado reescreve active_agent_set_at e consome a marca.';
