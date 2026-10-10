-- manifest: **Contato "sempre atendimento humano" nasce no banco (issue 2379): `contacts.ai_opt_out` com default desligado e índice parcial — a marca PERMANENTE, separada da trava de handoff.** A devolução automática (`lib/escalacao/retomada.ts`, cron `handoff-devolucao`) limpava `contacts.force_human` e trazia a conversa de volta para a IA sem ninguém decidir; a coluna nova é o que ela passa a consultar antes de mexer em qualquer coisa. Quem marcou/quando fica em auditoria + timeline, sem coluna extra (mesma decisão do `is_personal`, spec 21 §3.6). Idempotente: `add column if not exists`, `create index if not exists`. Apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0624 — a trava permanente "sempre atendimento humano" (issue 2379).
--
-- `ai_opt_out boolean DEFAULT false NOT NULL` (espelha `is_personal`): o contato
-- nasce atendido pela IA, e só vira "sempre humano" por gesto explícito de
-- gerente/dono na rota `POST /api/v1/contacts/[id]/always-human`.
--
-- POR QUE COLUNA NOVA e não reusar `force_human`:
--
--   * `contacts.force_human` é a trava de HANDOFF — ela nasce quando o agente
--     escala (`performHumanHandoff`) e morre quando um humano devolve o comando
--     (`devolverAtendimentoAoAgente`, o único escritor de `force_human = false`
--     do repositório). Misturar os dois faria toda escalação automática virar
--     permanente, que é o oposto do pedido.
--   * A issue 2379 mediu exatamente isso: "mesmo a trava do contato é desfeita
--     na primeira devolução". O que falta não é uma trava mais forte, é uma
--     marca que a devolução NÃO desfaça.
--
-- As duas convivem: armar `ai_opt_out` também liga `force_human` (é o gate que
-- o worker, o harness e o `before-send` já leem — a IA para NA HORA), e
-- `ai_opt_out` é o pred que impede qualquer caminho de desligar essa trava.
-- Cada guard passa a ler as DUAS colunas de propósito: se um escritor futuro
-- limpar `force_human` por engano, a marca permanente continua barrando a IA sozinha.

alter table public.contacts
  add column if not exists ai_opt_out boolean default false not null;

comment on column public.contacts.ai_opt_out is
  'Contato marcado "sempre atendimento humano" (issue 2379): a IA nunca responde este contato e NENHUM caminho de devolução (manual ou automática) desfaz a marca — só um humano a desliga pela rota always-human. Separada de force_human, que é a trava de handoff e continua sendo desfeita pela devolução. Quem marcou/quando fica em auditoria + timeline.';

create index if not exists idx_contacts_org_ai_opt_out
  on public.contacts (organization_id)
  where (ai_opt_out = true);

notify pgrst, 'reload schema';
