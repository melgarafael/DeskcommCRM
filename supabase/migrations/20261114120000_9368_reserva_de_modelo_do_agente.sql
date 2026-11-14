-- A RESERVA DE MODELO CONFIGURÁVEL (#4600).
--
-- manifest: Reserva de modelo por versão do agente (`reserve_provider` + `reserve_model`, NULL = desligado): qualquer provedor cadastrado pode atender a queda que só acontece em cota (429), 5xx e tempo esgotado — nunca em erro de pedido —, uma tentativa, e as duas colunas entram na trava de imutabilidade da versão publicada.
--
-- A política de queda que já existia (`lib/ai/pontos/reserva-da-assinatura.ts`)
-- só sabia cair de UM provedor para outro FIXO: o da assinatura do ChatGPT. Com
-- provedor personalizado, OpenRouter, DeepSeek e afins não havia degrau nenhum —
-- cota estourada (429), 5xx ou tempo esgotado derrubavam o turno e o cliente
-- ficava sem resposta até a cota voltar.
--
-- Estas duas colunas são onde a RESERVA passa a morar: por VERSÃO do agente
-- (imutável depois de publicada, como o resto do conteúdo), e não no agente nem
-- na organização — a reserva é decisão de quem montou aquele prompt/modelo, e a
-- versão é o que a tela publica e o turno lê.
--
-- Duas colunas, e não um jsonb, por dois motivos: o par é conferido no banco
-- (nada de provedor sem modelo) e a trigger de imutabilidade já protege coluna
-- por coluna — em jsonb a reserva escaparia da trava que impede reescrever uma
-- versão publicada.
--
-- DESLIGADA por padrão: as duas colunas nascem NULL, e NULL não é degrau
-- nenhum. Quem não configura nada tem exatamente o comportamento de antes,
-- inclusive o caminho da assinatura, byte a byte.
--
-- Numeração (#4600): medida contra `origin/main` (a maior era 9354) E contra os
-- 118 PRs abertos do repositório oficial na data (a maior era 9367) — o script
-- do repo só enxerga `main`, por isso a segunda medição foi feita à mão via
-- `gh pr list --json files`.

alter table public.ai_agent_versions
  add column if not exists reserve_provider text;

alter table public.ai_agent_versions
  add column if not exists reserve_model text;

-- Provedor sem modelo (ou modelo sem provedor) é configuração pela metade: a
-- chamada cairia num par incompleto e gastaria uma tentativa para colher um erro
-- de configuração. O CHECK recusa o meio-termo; o código, quando encontra o par
-- pela metade em banco legado, não cai (ver `overrideLlmDoAgente`).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_agent_versions_reserva_check'
  ) then
    alter table public.ai_agent_versions
      add constraint ai_agent_versions_reserva_check
      check (
        (reserve_provider is null and reserve_model is null)
        or (
          reserve_provider is not null and btrim(reserve_provider) <> ''
          and reserve_model is not null and btrim(reserve_model) <> ''
        )
      );
  end if;
end $$;

comment on column public.ai_agent_versions.reserve_provider is
  'Migration 9368. Provedor para onde a chamada cai quando o principal falha por '
  'cota (429), servidor (5xx) ou tempo esgotado — qualquer provedor já cadastrado. '
  'NULL (default) = sem reserva, comportamento de antes. Lido em '
  'lib/agent-engine/agent/agent-config.ts e decidido em '
  'lib/ai/pontos/reserva-da-assinatura.ts (decidirQuedaDoModeloDeReserva).';

comment on column public.ai_agent_versions.reserve_model is
  'Migration 9368. Modelo do provedor de reserva. Os dois campos são configurados '
  'juntos (ai_agent_versions_reserva_check): provedor sem modelo é configuração '
  'pela metade e não vira degrau nenhum.';

-- A RESERVA ENTRA NA TRAVA DE IMUTABILIDADE.
--
-- `fn_ai_agent_version_content_immutable` lista as colunas de conteúdo uma a uma,
-- e a reserva é conteúdo: sem estas duas linhas, a service key poderia apontar
-- uma versão PUBLICADA para outro provedor depois de publicada, sem versão draft
-- nova e sem trilha. A cerca `tests/unit/trigger-imutavel-cobre-todas-as-colunas-
-- de-conteudo.test.ts` deriva as colunas do próprio schema e ficaria vermelha.
--
-- O corpo abaixo é o da última definição (9108) mais as duas linhas de reserva.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
-- search_path fixo na PRÓPRIA definição: um create or replace sem a cláusula
-- apaga o alter function ... set search_path da 0521 (invariante
-- tests/invariants/avisos-do-security-advisor.test.ts).
language plpgsql set search_path = '' as $fn$
begin
  if old.status <> 'draft' and (
       new.system_prompt          is distinct from old.system_prompt
    or new.provider               is distinct from old.provider
    or new.model                  is distinct from old.model
    or new.credential_id          is distinct from old.credential_id
    or new.tool_ids               is distinct from old.tool_ids
    or new.trigger_config         is distinct from old.trigger_config
    or new.channel_session_id     is distinct from old.channel_session_id
    or new.max_steps              is distinct from old.max_steps
    or new.token_budget           is distinct from old.token_budget
    or new.cost_budget_cents      is distinct from old.cost_budget_cents
    or new.history_message_window is distinct from old.history_message_window
    or new.history_token_window   is distinct from old.history_token_window
    or new.handoff_keywords       is distinct from old.handoff_keywords
    or new.handoff_tool_enabled   is distinct from old.handoff_tool_enabled
    or new.handoff_legal_enabled  is distinct from old.handoff_legal_enabled
    or new.followup               is distinct from old.followup
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.image_vision_enabled   is distinct from old.image_vision_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.skill_names            is distinct from old.skill_names
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
    or new.reply_min_interval_ms  is distinct from old.reply_min_interval_ms
    or new.voz_enabled            is distinct from old.voz_enabled
    or new.voz_quando             is distinct from old.voz_quando
    or new.reserve_provider       is distinct from old.reserve_provider
    or new.reserve_model          is distinct from old.reserve_model
    or new.version_number         is distinct from old.version_number
    or new.agent_id               is distinct from old.agent_id
    or new.organization_id        is distinct from old.organization_id
  ) then
    raise exception 'ai_agent_versions % é imutável (status=%): mudança de conteúdo = versão draft nova; rollback = revert (clona + publica)',
      old.id, old.status;
  end if;
  return new;
end;
$fn$;
