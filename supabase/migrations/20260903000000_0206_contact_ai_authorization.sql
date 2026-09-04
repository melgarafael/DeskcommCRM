-- 0206 · Elegibilidade da IA por ORIGEM do lead — o "deny by default" por canal.
--
-- ## O defeito
--
-- O DeskcommCRM responde `allow by default`: publicou agente para a sessão de
-- WhatsApp, a IA atende TODO mundo que mandar mensagem — não há gate de
-- elegibilidade em lugar nenhum. `lib/channels/pos-entrada.ts` emite
-- `ai_agent.dispatch_requested` para todo inbound novo; `lib/agent-engine/edge/
-- crm/drain.ts` só checa se existe agente publicado para a sessão. Num número
-- que também é o WhatsApp pessoal/comercial do dono — clientes atuais,
-- fornecedores, contatos pessoais, conversas antigas —, isso é a IA assumindo
-- conversa que era de gente.
--
-- ## A correção
--
-- Gate OPT-IN por canal: `channel_sessions.metadata.ai_gate = 'allowlist'`
-- (ausente / `'open'` = comportamento de hoje, nenhum self-hoster afetado). Com
-- o gate ligado, a IA só responde quando o CONTATO está explicitamente
-- autorizado — e é isso que estas duas colunas guardam.
--
--   ai_authorized_at      quando a autorização foi concedida (NULL = não autorizado)
--   ai_authorized_reason  de onde veio: 'respondi:<form>:<submission>',
--                         'campanha:<id>', 'automacao:<rule>', 'retomada_manual'
--
-- Contact-level, como `force_human` (a trava oposta): a elegibilidade é sobre
-- "esta pessoa é um lead que podemos abordar automaticamente", não sobre um
-- thread. Uma janela de validade (`AI_ALLOWLIST_TTL_DAYS`, default 21) impede
-- que submissão antiga reative a IA meses depois — o turno autorizado renova o
-- carimbo enquanto a conversa está viva.
--
-- Aditiva e idempotente: colunas anuláveis, sem default, sem constraint. Nenhuma
-- linha existente passa a violar nada; o `update.sh` de um clone não quebra. RLS
-- é row-level e já cobre `contacts` (`tenant_isolation_contacts_all`) — coluna
-- nova não precisa de policy.

alter table public.contacts
  add column if not exists ai_authorized_at timestamptz;

alter table public.contacts
  add column if not exists ai_authorized_reason text;

comment on column public.contacts.ai_authorized_at is
  'Elegibilidade da IA (gate opt-in channel_sessions.metadata.ai_gate=allowlist): quando o contato foi autorizado a ser atendido automaticamente. NULL = não autorizado, a IA não responde. Renovado a cada turno autorizado enquanto a conversa está viva.';

comment on column public.contacts.ai_authorized_reason is
  'Origem da autorização de IA: respondi:<form>:<submission> | campanha:<id> | automacao:<rule> | retomada_manual.';

notify pgrst, 'reload schema';
