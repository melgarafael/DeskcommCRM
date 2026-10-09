-- manifest: A chave que liga e desliga a passagem para pessoa por ASSUNTO JURÍDICO passa a morar na versão do agente: coluna nova `handoff_legal_enabled` em `ai_agent_versions` (padrão ligado) e a trava de imutabilidade cobrindo a coluna (PR #2156, issue #2097).
-- 0616 — Passar para uma pessoa por assunto jurídico vira escolha POR AGENTE
-- (#2097, #2156). Atendia-se a um escritório de advocacia onde "processo",
-- "advogado" e "Procon" são o vocabulário normal do cliente: o agente publicado
-- passava a conversa quase sempre, e não concluía a qualificação. A decisão do
-- mantenedor foi deixar a EMPRESA desligar esse caminho, com quatro condições —
-- e três delas moram exatamente nesta migration.
--
--   1. LIGADO PARA TODO MUNDO POR PADRÃO (`not null default true`): quem não
--      mexer continua com o resultado de hoje, byte a byte.
--   2. A ESCOLHA É POR AGENTE, na versão publicada — porque é ela quem atende
--      de verdade. Uma mesma empresa pode ter um agente de triagem jurídica
--      (onde "processo" é assunto normal) e um de cobrança (onde "Procon" é
--      sinal de problema). A chave mora na versão porque a versão publicada é
--      imutável: mudar é criar rascunho e publicar, como qualquer outro ajuste.
--   3. SÓ ADMIN MUDA — sem código novo: toda escrita de versão já exige admin
--      (`ensureAdmin` nas server actions e `role: "admin"` nas rotas).
--   4. O PEDIDO EXPLÍCITO DE PESSOA NÃO MUDA: `detectHumanHandoffRequest` e
--      `handoff_keywords` continuam sempre ligados. Nada nesta migration toca
--      neles.
--
-- O efeito NÃO é remover a ferramenta `request_human_handoff`: é trocar a
-- descrição dela quando a chave está desligada (`inbound-turn.ts`), para que o
-- modelo não passe a conversa só por assunto jurídico. Os demais caminhos —
-- irritação percebida pelo Jev, opt-out, teto de gasto, caso escalado pela
-- equipe — não são alcançados pelo interruptor.
--
-- DEFENSE-IN-DEPTH: a coluna entra também em
-- `fn_ai_agent_version_content_immutable` (a ÚLTIMA definição, a da 0503, com
-- `set search_path = ''`). Sem isso, uma versão já publicada ficaria editável
-- nesta coluna para a service key, e a cerca
-- `tests/unit/trigger-imutavel-cobre-todas-as-colunas-de-conteudo.test.ts`
-- reprovaria — o esquecimento é exatamente o que aquela cerca mede.
--
-- Idempotente por construção (`add column if not exists`, `comment on column`,
-- `create or replace`, `drop ... if exists` antes do `create` do trigger): o
-- mesmo bloco está no fim do `supabase/baseline.sql`, que é o que o
-- `install.sh`/`update.sh` do self-host aplica. Descrevo aqui, não no
-- `MANIFEST.md` — ele virou histórico em 02/10/2026.

alter table public.ai_agent_versions
  add column if not exists handoff_legal_enabled boolean not null default true;

comment on column public.ai_agent_versions.handoff_legal_enabled is
  'Assunto jurídico é motivo de passar a conversa para uma pessoa? Padrão LIGADO; só admin muda, e a mudança é publicar uma versão nova do agente. Não afeta o pedido explícito de pessoa nem as palavras de passagem.';

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
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
    or new.knowledge_source_ids   is distinct from old.knowledge_source_ids
    or new.proposal_ai_draft_enabled is distinct from old.proposal_ai_draft_enabled
    or new.inbound_debounce_ms    is distinct from old.inbound_debounce_ms
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

drop trigger if exists trg_ai_agent_versions_content_immutable on public.ai_agent_versions;
create trigger trg_ai_agent_versions_content_immutable
  before update on public.ai_agent_versions
  for each row execute function fn_ai_agent_version_content_immutable();

notify pgrst, 'reload schema';
