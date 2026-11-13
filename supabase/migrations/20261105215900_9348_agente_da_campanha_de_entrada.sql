-- manifest: **A frase do anúncio leva o `agent_id` da campanha de entrada até a conversa que ela trouxe (issue #4024).** Uma coluna nulável em `conversations`: `campaign_entry_agent_id` — o agente declarado pela campanha cujo `match` casou a mensagem que trouxe o contato. A FK é COMPOSTA `(organization_id, campaign_entry_agent_id)` → `ai_agents(organization_id, id)` com `on delete set null (campaign_entry_agent_id)`: agente de OUTRA organização não pode nem ser gravado, e apagar o agente devolve a conversa à régua do número em vez de explodir o `delete` (sem a lista de colunas, o SET NULL tentaria anular `organization_id`, que é NOT NULL). Sem backfill e sem default: conversa que já existe e canal que não usa campanha de entrada continuam, byte a byte, com quem atendia antes.

-- 9348 — a campanha de ENTRADA declara quem atende a conversa.
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
-- continua com `campanha:A`. Reler dali mandaria o turno de toda conversa NOVA
-- desse contato para o agente de A, mesmo sem frase de anúncio nenhuma — que é
-- exatamente o sequestro que a decisão do dono (2026-09-19, "cliente antigo
-- segue com quem já o atendia") proíbe. A decisão é da CONVERSA onde a frase
-- casou, e mora nela.
--
-- ═══ Vale em todo turno da conversa ═══
--
-- Decisão do mantenedor (2026-11-05): a conversa que chegou pela frase fica com
-- o agente da campanha, a mesma regra da campanha de SAÍDA. O turno LÊ a coluna
-- (`select` por `organization_id` + `id`, sem escrita) em vez de carimbar uso.
-- A primeira versão tinha um carimbo de uso único (coluna `claimed_at` em
-- `conversations`) que se gastava no primeiro turno; medido: o turno adiado pela
-- janela anti-ban gastava o carimbo sem responder nada, e a conversa perdia o
-- agente da campanha sem nunca ter sido atendida por ele. Sem escrita não há
-- estado a gastar, e aquela coluna deixou de existir.
--
-- ═══ Compatibilidade ═══
--
-- Coluna NULÁVEL, sem default e sem backfill: nenhuma conversa existente muda
-- de agente, nenhuma tela lê a coluna, e o caminho de quem não tem campanha de
-- entrada cadastrada faz uma leitura indexada por PK e sai (o degrau novo só
-- age quando `campaign_entry_agent_id` não é nulo). Idempotente: `add column if
-- not exists`, constraint recriada por nome — o `update.sh` reaplica o apêndice
-- do `baseline.sql` a cada atualização.

alter table public.conversations
  add column if not exists campaign_entry_agent_id uuid;

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
  'Agente declarado pela campanha de ENTRADA (frase do anúncio) cujo match trouxe este contato. Lido por resolve-turn-agent num degrau acima do roteador, em todo turno desta conversa. Nulo = conversa não veio de campanha de entrada. Migration 9348.';
