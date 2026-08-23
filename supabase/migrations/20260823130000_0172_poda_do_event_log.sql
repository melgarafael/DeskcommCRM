-- 0172 — event_log GANHA PODA. O MOLDE É A 0167, A LACUNA É NOVA.
--
-- ═══ O DEFEITO MEDIDO (auditoria técnica desta sessão) ═══
--
--     $ grep -rn "from(\"event_log\")" app lib workers | grep -i delete
--     (zero linhas)
--
-- `event_log` é o bus interno do CRM (COMMENT ON TABLE): triggers e Server
-- Actions inserem via `emit_event()`, workers consomem e marcam `status`. A
-- 0167 podou `job_queue` e expurgou `api_audit_log` — as duas outras tabelas
-- que crescem sozinhas numa instalação parada — e deixou `event_log` de fora
-- de propósito (fora do escopo daquela issue). `event_log` é a terceira: todo
-- status de mensagem outbound (`message.sending`/`message.sent`/
-- `message.failed`/`message.outbound`) e cada `lead.*` emitido pelo trigger
-- `trg_emit_event_on_lead_change` viram uma linha permanente, e nada a apaga.
--
-- ═══ QUEM CONSOME O QUE — levantado nesta sessão, não suposto ═══
--
-- `event_type` tem consumidor real (linha chega a `done`/`dead` via
-- `lib/event-log/drain.ts` + `lib/event-log/register-handlers.ts`, ou via
-- worker dedicado): `message.received`, `ai.sentiment_alert`,
-- `ai.handoff_triggered`, `ai.handoff_resolved`, `lgpd.data_request_received`,
-- `lgpd.redact_received`, `media.derive_requested`, `media.persist_requested`,
-- `nuvemshop.product_synced`, `knowledge_source.updated`, `lead.created`,
-- `lead.stage_changed`, `lead.tag_added`, `contact.tag_added`,
-- `ai.case_opened`, `ai.case_closed`, `conversation.routing_requested`
-- (`lib/routing/worker.ts`) e `ai_agent.dispatch_requested`
-- (`lib/agent-engine/edge/crm/drain.ts`). Estes são exatamente os que este
-- expurgo alcança quando terminam.
--
-- ÓRFÃOS — emitidos por `fn_log_event`/`fn_emit_message_event`
-- (`fn_emit_event_on_lead_change`), SEM handler registrado em lugar nenhum:
-- `message.sending`, `message.sent`, `message.failed`, `message.outbound`,
-- `lead.won`, `lead.lost`, `lead.reopened`, `lead.assigned`. Ficam `pending`
-- para sempre — `lib/event-log/drain.ts` só seleciona `event_type` que tem
-- handler registrado (`getRegisteredHandlers()`), e nenhum destes oito tem.
--
-- Destes, `lead.won`/`lead.lost`/`lead.assigned` batem com categorias JÁ
-- declaradas em `NOTIFICATION_CATEGORIES` (`lib/schemas/settings.ts`:
-- `lead_won`, `lead_lost`, `lead_assigned`) — cheiro de feature de notificação
-- pensada e não terminada. Por doutrina (`CLAUDE.md` — "não invente regra de
-- negócio"), esta migration NÃO implementa o consumer que falta: fica
-- registrado aqui, emitindo, sem handler, para quem decidir o próximo passo.
-- `lead.reopened` e os quatro `message.*` não têm nenhuma categoria ou feature
-- correspondente — são histórico puro (o status da mensagem já vive em
-- `messages.status`; o `event_log` é só um eco redundante dele).
--
-- ═══ POR QUE O EXPURGO NÃO TOCA NOS ÓRFÃOS `pending` — E O QUE ISSO DEIXA EM ABERTO ═══
--
-- Esta função segue A MESMA regra "o que tem dono não sai" da 0167:
-- `pending`/`processing` NUNCA saem, não importa a idade — `pending` é
-- trabalho que ainda pode sair (o drain reclama pelo relógio), `processing`
-- está com um worker agora. Os oito órfãos acima são exatamente o caso em que
-- essa regra, sendo categórica e não probabilística, deixa uma lacuna real:
-- como NUNCA chegam a `done`/`dead`, o expurgo por idade não os alcança, e o
-- crescimento que a auditoria mediu para eles especificamente CONTINUA. Trocar
-- essa regra por uma que também apague `pending` de tipo sem handler exigiria
-- ou (a) uma lista de tipos "seguros" codificada em SQL — o tipo de regra de
-- negócio hardcoded que a doutrina pede para não inventar aqui — ou (b) um
-- consumer no-op registrado no TypeScript para fechá-los normalmente, que é
-- mudança de comportamento de runtime, fora do escopo desta migration (só
-- schema/expurgo). Fica como achado separado para uma migration/PR dedicado:
-- registrar um handler no-op para os quatro `message.*` + `lead.reopened`
-- (audit puro, sem WIP associado) fecharia o ciclo sem tocar nos três
-- `lead.won`/`lead.lost`/`lead.assigned` (possível WIP de notificação).
--
-- ═══ O QUE ESTE EXPURGO RESOLVE HOJE, SEM ESPERAR A LACUNA ACIMA ═══
--
-- A maioria do volume de `event_log` HOJE são eventos COM handler — mensagens
-- inbound, mudanças de lead, dispatch de IA — e todos eles, ao terminar,
-- ficavam em `done`/`dead` para sempre. Isso já é a maior parte do
-- crescimento medido, e esta migration resolve exatamente essa parte, do
-- mesmo jeito que a 0167 resolveu para `job_queue`.
--
-- ═══ RETENÇÃO: MESMOS NÚMEROS DA `job_queue`, KNOB PRÓPRIO ═══
--
-- `event_log` é bus operacional, não trilha legal/LGPD (isso é
-- `api_audit_log`, retenção de 5 anos) — herda os números da `job_queue`
-- (padrão 90 dias, piso 7), não os da auditoria. Piso de 7 dias porque o único
-- consumidor de `event_log` sem janela própria é `health/circuit.ts`
-- (`lib/agent-engine/health/circuit.ts:152`), que lê `ai_agent.dispatch_requested`
-- e já é janelado (`windowMs`, default 6h — muito abaixo de 7 dias, mesmo
-- raciocínio já provado pela 0167 para `send_ledger`). Knob PRÓPRIO
-- (`EVENT_LOG_RETENTION_DAYS`, não o de `job_queue`) porque as duas tabelas
-- crescem em ritmos diferentes: um clone com tráfego pesado de WhatsApp gera
-- `event_log` (um evento por mensagem) muito mais rápido que `job_queue` (um
-- job por turno de conversa) — números vivem em `lib/retencao/politica.ts`
-- (`RETENCAO_EVENT_LOG_DIAS_PADRAO`/`_PISO`).
--
-- ═══ O QUE TEM DONO NÃO SAI, AQUI TAMBÉM ═══
--
-- `automation_rule_runs.event_id references event_log(id) on delete set null`
-- é a ÚNICA FK que aponta para `event_log` (conferido: nenhuma outra tabela
-- referencia `event_log` por FK). `on delete set null` — não `restrict`, não
-- `cascade` — então apagar o evento NUNCA falha nem leva o run junto; o run de
-- automação e o log de `actions_result` ficam, só perdem o ponteiro para o
-- evento original. `app/api/v1/automation-rules/runs/[runId]/resend/route.ts`
-- JÁ trata esse caso (`event_id is null` ⇒ 409 `event_gone`) — o produto já
-- antecipava evento apagado antes desta migration existir. Por isso, ao
-- contrário da 0167 (que precisou de um `not exists` contra `agent_inbox_items`
-- ANTES do `limit`), `event_log` não tem um "aviso aberto" equivalente para
-- proteger: não há tabela nenhuma com `ref_kind='event_log'`.
--
-- Idempotente: `create or replace` + `create index if not exists` + `revoke`
-- (no-op quando o privilégio já não existe). Nenhuma constraint nova.

-- Índice de poda — mesmo motivo da 0167: sem ele, o DELETE por idade vira seq
-- scan diário na tabela inteira. Parcial nos dois status terminais de
-- `event_log` (`event_log_status_check`: pending, processing, done, dead) —
-- exatamente o conjunto que a poda visita.
create index if not exists idx_event_log_poda
  on public.event_log (created_at)
  where status in ('done', 'dead');

create or replace function public.fn_podar_event_log(
  p_retencao_dias int default null,
  p_limite int default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Piso de 7 dias: ver cabeçalho — health/circuit.ts é o único consumidor sem
  -- janela própria, e a dele (default 6h) fica bem abaixo disso.
  v_dias int := greatest(coalesce(p_retencao_dias, 90), 7);
  v_limite int := least(greatest(coalesce(p_limite, 1000), 1), 10000);
  v_apagados int;
begin
  with candidatos as (
    select e.id
      from public.event_log e
     where e.status in ('done', 'dead')
       and e.created_at < now() - make_interval(days => v_dias)
     order by e.created_at
     limit v_limite
  )
  delete from public.event_log e
   using candidatos c
   where e.id = c.id;
  get diagnostics v_apagados = row_count;
  return v_apagados;
end;
$$;

-- As DUAS origens de EXECUTE (doutrina de migrations, item 9): `revoke from
-- public` não tira o grant DIRETO que `ALTER DEFAULT PRIVILEGES ... TO anon`
-- do baseline dá a toda função nova; `revoke from anon` não tira o grant a
-- PUBLIC que o Postgres dá na criação. `authenticated` entra porque nenhuma
-- tela chama esta função com sessão de usuário.
revoke execute on function public.fn_podar_event_log(int, int)
  from public, anon, authenticated;
grant execute on function public.fn_podar_event_log(int, int) to service_role;

-- O COMMENT afirmava só o papel de bus; passa a apontar para quem poda —
-- afirmação de estado que envelhece vira ponteiro (CLAUDE.md).
comment on table public.event_log is
  'Bus interno do CRM. Triggers e ServerActions inserem via emit_event(). Workers '
  'consomem via lib/event-log/drain.ts (ou worker dedicado) e marcam status. '
  'done/dead expurgados por public.fn_podar_event_log (piso de 7 dias) a partir do '
  'cron app/api/v1/cron/data-retention. pending/processing nunca saem — inclusive '
  'os event_type sem handler registrado, que por isso ficam pending para sempre '
  '(achado documentado no cabeçalho da migration 0172).';

notify pgrst, 'reload schema';
