-- manifest: **A frase do anúncio leva o `agent_id` da campanha de entrada até o PRIMEIRO turno (issue #4024).** Duas colunas nuláveis em `conversations`: `campaign_entry_agent_id` — o agente declarado pela campanha cujo `match` casou a mensagem que trouxe o contato — e `campaign_entry_agent_claimed_at`, o carimbo de uso único que faz o degrau valer só no primeiro turno. A FK é COMPOSTA `(organization_id, campaign_entry_agent_id)` → `ai_agents(organization_id, id)` com `on delete set null (campaign_entry_agent_id)`: agente de OUTRA organização não pode nem ser gravado, e apagar o agente devolve a conversa à régua do número em vez de explodir o `delete` (sem a lista de colunas, o SET NULL tentaria anular `organization_id`, que é NOT NULL). Sem backfill e sem default: conversa que já existe e canal que não usa campanha de entrada continuam, byte a byte, com quem atendia antes.

-- 9332 — a campanha de ENTRADA declara quem atende o primeiro turno.
--
-- ═══ O que estava faltando ═══
--
-- `lib/ai/elegibilidade/campanha.ts` casa a frase do anúncio ("quero saber mais
-- sobre implantes") com `organizations.settings.campanhas_whatsapp` desde a 0203,
-- mas só isso: o contato ficava ELEGÍVEL (`ai_authorized_reason =
-- campanha:<id>`) e quem respondia era o agente do número. Para quem atende
-- vários nichos no mesmo WhatsApp, a resposta do implante saía pelo agente do
-- outro nicho. O `agent_id` já existia no schema da config e era ignorado —
-- dívida declarada no próprio arquivo.
--
-- ═══ Por que uma COLUNA, e não o `ai_authorized_reason` que já existe ═══
--
-- A `reason` é do CONTATO e é permanente: quem veio pela campanha A em maio
-- continua com `campanha:A`. Reler dali mandaria o primeiro turno de toda
-- conversa NOVA desse contato para o agente de A, mesmo sem frase de anúncio
-- nenhuma — que é exatamente o sequestro que a decisão do dono (2026-09-19,
-- "cliente antigo segue com quem já o atendia") proíbe. A decisão é da CONVERSA
-- onde a frase casou, e mora nela.
--
-- ═══ Por que um carimbo de uso único ═══
--
-- O efeito é só o PRIMEIRO turno. `campaign_entry_agent_claimed_at` é gravado
-- pelo próprio turno que usa o degrau, num `update … returning` atômico (dois
-- workers no mesmo turno não conseguem usar o degrau duas vezes). A partir da
-- segunda mensagem o `campaign_entry_agent_id` continua na linha — é o rastro de
-- por que aquele cliente foi atendido por aquele agente — mas o carimbo já não
-- deixa o degrau valer. Guardar o id em vez de anulá-lo é o que permite
-- responder "por que este atendimento começou com o agente X?" meses depois.
--
-- ═══ Compatibilidade ═══
--
-- Colunas NULÁVEIS, sem default e sem backfill: nenhuma conversa existente muda
-- de agente, nenhuma tela lê as colunas, e o caminho de quem não tem campanha de
-- entrada cadastrada faz uma leitura indexada por PK e sai (o degrau novo só
-- age quando `campaign_entry_agent_id` não é nulo). Idempotente: `add column if
-- not exists`, constraint recriada por nome — o `update.sh` reaplica o apêndice
-- do `baseline.sql` a cada atualização.

alter table public.conversations
  add column if not exists campaign_entry_agent_id uuid,
  add column if not exists campaign_entry_agent_claimed_at timestamptz;

-- FK composta: o par (organização, agente) é o que a conversa referencia, então
-- um `agent_id` de outra organização não entra nem por escrita errada. O
-- `uq_ai_agents_org_id` (organization_id, id) da 0378 é o alvo.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'conversations_campaign_entry_agent_org_fk') then
    alter table public.conversations
      add constraint conversations_campaign_entry_agent_org_fk
      foreign key (organization_id, campaign_entry_agent_id)
      references public.ai_agents (organization_id, id)
      on delete set null (campaign_entry_agent_id);
  end if;
end $$;

comment on column public.conversations.campaign_entry_agent_id is
  'Agente declarado pela campanha de ENTRADA (frase do anúncio) cujo match trouxe este contato. Lido por resolve-turn-agent num degrau acima do roteador, e só enquanto campaign_entry_agent_claimed_at é nulo. Nulo = conversa não veio de campanha de entrada. Migration 9332.';

comment on column public.conversations.campaign_entry_agent_claimed_at is
  'Quando o primeiro turno usou o agente da campanha de entrada (update … returning, uso único). Carimbado = o degrau não vale mais nesta conversa; o campaign_entry_agent_id fica como rastro. Migration 9332.';
