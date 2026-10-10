-- 0114: ai_invocations.agent_id passa a aceitar NULL
--
-- Issue #160, reportada por @jmpo medindo a própria VPS. `ai_invocations` é a
-- fonte das telas de consumo e custo de IA (`/api/v1/ai/usage`,
-- `/api/v1/admin/usage`, `lib/ai/usage/aggregate.ts`, `UsageTable`,
-- `TenantOverview`). Ele achou a tabela com **zero linhas** numa instalação com
-- 176 mensagens em 24h, e o log repetindo:
--
--   [ai-invocations] insert failed
--   invalid input syntax for type uuid: ""   (invocation_kind: sentiment_classify)
--
-- O classificador de sentimento roda MESMO sem agente ativo — ele lê o agente só
-- para descobrir o threshold e cai no default quando não acha, o que está certo.
-- Mas na hora de auditar mandava `agent_id: agent?.id ?? ""`, e a coluna era
-- `uuid NOT NULL`. Como o insert é fire-and-forget, nada quebrava na cara de
-- ninguém: o custo era pago ao provider e não aparecia em tela nenhuma.
--
-- "Sem agente ativo" não é estado exótico: é o estado NORMAL de quem ainda não
-- publicou o agente. O onboarding cria e a publicação é um passo à parte —
-- entre os dois, a instalação tem mensagem chegando e nenhum agente ativo.
--
-- DAS DUAS SAÍDAS, esta é a que descreve a realidade: existe invocação de IA
-- que não pertence a agente nenhum. A alternativa (não logar quando não há
-- agente) trocaria um bug silencioso por uma LACUNA silenciosa — o dono seguiria
-- pagando por algo invisível, que é o dano que a issue nomeia.
--
-- As telas não quebram: `/api/v1/ai/usage` só filtra por `agent_id` quando o
-- parâmetro vem, e a agregação sem filtro soma tudo. Linha sem agente passa a
-- aparecer no total, que é exatamente o que faltava.
--
-- Idempotente: `drop not null` em coluna que já aceita null é no-op.

alter table public.ai_invocations
  alter column agent_id drop not null;

comment on column public.ai_invocations.agent_id is
  'Agente que originou a invocação. NULL = invocação de IA sem agente dono '
  '(ex.: classificador de sentimento numa org sem agente publicado). O custo '
  'existe e precisa aparecer nas telas de consumo — ver issue #160.';
