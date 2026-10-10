-- 0125 — o agente só opera nos funis MARCADOS (spec 17 passo 3)
--
-- ═══ O PROBLEMA, MEDIDO ═══
--
-- Produção, 2026-08-07: uma ÚNICA organização com **4 funis e 5 agentes**, de
-- negócios diferentes — um SDR de vendas, dois de suporte ao produto e uma
-- atendente de clínica. Os funis: "Pedidos", "Comercial - Andrea",
-- "Comercial - Julia" e "Suporte - IA". Qualquer um dos cinco agentes alcança
-- qualquer um dos quatro funis, hoje.
--
-- Nada disso é hipotético: `crm_move_lead_stage`, `crm_update_lead`,
-- `crm_close_demand` e `crm_manage_tags` recebem o alvo do MODELO e a única
-- checagem de pipeline que existe é de COERÊNCIA (mover dentro do mesmo funil),
-- nunca de autorização.
--
-- ═══ A COLUNA VIVE NA VERSÃO, E ISSO É A DECISÃO ═══
--
-- `ai_agent_versions`, não `ai_agents` nem `crm_pipelines.settings`. A
-- permissão precisa ser VERSIONADA e PUBLICADA junto com o resto do agente: o
-- runtime relê a versão publicada a cada turno, e escopo guardado fora do ciclo
-- rascunho→publicar mudaria o alcance do agente sem ninguém ter publicado nada.
-- Para uma capacidade isso já seria ruim; para uma PERMISSÃO é o defeito
-- principal.
--
-- ═══ NASCE FECHADO, POR DUAS ORIGENS ═══
--
-- `default '{}'` cobre o agente novo; o `?? []` no runtime cobre o clone que
-- ainda não aplicou esta migration. Vazio significa NENHUM funil — a direção
-- segura é agir de menos. Mesma decisão já tomada em `operator_tool_ids`.

alter table public.ai_agent_versions
  add column if not exists pipeline_ids uuid[] not null default '{}'::uuid[];

comment on column public.ai_agent_versions.pipeline_ids is
  'Funis em que ESTE agente pode escrever (mover, editar, encerrar, taguear). Vazio = NENHUM: falha fechada. Escopo de ESCRITA; leitura não é filtrada por aqui (declarado na spec 17 §5).';

-- ---- backfill: o que JÁ funcionava continua funcionando ----
--
-- "Agente novo nasce fechado" e "agente existente vira fechado retroativamente"
-- são coisas MUITO diferentes. Sem este bloco, no dia do deploy todo agente em
-- produção pararia de mexer em card — de uma vez, e em silêncio.
--
-- O escopo inicial é DERIVADO do que cada agente realmente fez: os funis onde
-- ele já registrou atividade. Isso respeita o que funcionava E fecha os funis
-- que ele nunca tocou, que é o objetivo.
--
-- Medido antes de escrever: na produção deste projeto, apenas 1 dos 8 agentes
-- tem histórico (o SDR, no funil "Pedidos"). Os outros 7 nascem fechados sem
-- quebrar nada, porque nunca moveram card nenhum.
--
-- Só para versões PUBLICADAS/rascunho que ainda estão vazias — re-aplicar não
-- reabre escopo que alguém tenha fechado à mão depois.
update public.ai_agent_versions v
   set pipeline_ids = sub.funis
  from (
    select a.actor_agent_id as agent_id,
           array_agg(distinct l.pipeline_id) as funis
      from public.crm_lead_activities a
      join public.crm_leads l on l.id = a.lead_id
     where a.actor_agent_id is not null
     group by a.actor_agent_id
  ) sub
 where v.agent_id = sub.agent_id
   and v.pipeline_ids = '{}'::uuid[];

-- ---- o trigger de imutabilidade para de ignorar metade da configuração ----
--
-- ⚠️ CONSERTO OBRIGATÓRIO NO MESMO ARQUIVO, e não uma limpeza de brinde.
--
-- `fn_ai_agent_version_content_immutable` parava no campo `followup` e não
-- conhecia NENHUMA das nove colunas acrescentadas depois dele. Numa versão já
-- PUBLICADA era possível trocar o modelo do Operador, as ferramentas dele, o
-- corte de mensagens — sem virar versão nova e sem deixar trilha.
--
-- Acrescentar `pipeline_ids` sem consertar isso seria pior que não acrescentar:
-- um escopo de PERMISSÃO editável em produção sem publicar nada é a própria
-- ausência de escopo, com aparência de controle.
create or replace function fn_ai_agent_version_content_immutable() returns trigger
language plpgsql as $fn$
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
    or new.followup               is distinct from old.followup
    -- ↓ as nove que o trigger nunca cobriu, mais a desta migration
    or new.multimodal_input       is distinct from old.multimodal_input
    or new.video_frames_enabled   is distinct from old.video_frames_enabled
    or new.split_messages         is distinct from old.split_messages
    or new.split_max_chars        is distinct from old.split_max_chars
    or new.cases_enabled          is distinct from old.cases_enabled
    or new.operator_enabled       is distinct from old.operator_enabled
    or new.operator_model         is distinct from old.operator_model
    or new.operator_tool_ids      is distinct from old.operator_tool_ids
    or new.pipeline_ids           is distinct from old.pipeline_ids
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
