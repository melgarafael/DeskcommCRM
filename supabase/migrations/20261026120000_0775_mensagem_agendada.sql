-- manifest: **Mensagem agendada na conversa (#3118).** Cria `scheduled_messages` (o pacote: conversa, contato, canal, hora marcada no fuso da tela, estado `scheduled/sending/sent/partial/failed/cancelled`, autor humano ou token `dsk_`, `cancel_if_contact_replies`) e `scheduled_message_parts` (as partes, em ordem: texto ≤ 4096 e/ou anexo do bucket, cada uma com o seu `internal_message_id` — a chave anti-duplicata que o `sendMessageHandler` já usa para não repetir envio). O disparo reusa o cron persistente: `cron_jobs.job_kind` e `job_queue.kind` ganham `scheduled_message`, e `fireOneDue` já resolve trava, backoff e aviso. `agent_inbox_items.kind` ganha `scheduled_message_failed` para `partial`/`failed`. O opt-out do contato (`is_blocked` false→true) cancela os pacotes vivos e desliga os crons deles; a anonimização LGPD cancela e apaga o corpo das partes pendentes — pelo MESMO gatilho em `contacts`. Tabelas novas, sem backfill; idempotente; apêndice espelhado no `baseline.sql` (uma vez por constraint de vocabulário, ver comentário lá).

-- 0775 — mensagem agendada na conversa (#3118).
--
-- ─── O que já existia, e por que não serve ─────────────────────────────────
--
--  * fluxo de follow-up (`followup_enrollments`): sequência com esperas para
--    quem foi inscrito — não é UM envio numa hora exata;
--  * `crm_schedule_followup` (`cron_jobs` kind 'at', job_kind 'followup_turn'):
--    na hora enfileira um TURNO do agente, e a IA reescreve; não manda o texto
--    aprovado palavra por palavra, nem anexo;
--  * lembrete de agenda: precisa existir compromisso;
--  * campanha: lote com ritmo, não a conversa de uma pessoa.
--
-- Quem precisa disso agenda por fora (tarefa num computador da equipe) e paga
-- três falhas medidas: depende do aparelho ligado, sai pela metade em silêncio e
-- duplica no reenvio manual. Esta migration é o chão de dados do caminho de
-- dentro do CRM.
--
-- ─── O pacote e as partes ──────────────────────────────────────────────────
--
-- Pacote (`scheduled_messages`) e partes (`scheduled_message_parts`) em duas
-- tabelas, e não uma linha em `messages` com status 'scheduled': cabe UMA parte
-- por linha de `messages`, e aí `partial`, a parada no meio e o "reenviar o que
-- faltou" viram arqueologia de linha. Duas tabelas também mantêm o histórico
-- limpo — o que nunca saiu nunca aparece como mensagem.
--
-- `internal_message_id` é a peça central: o `sendMessageHandler`
-- (`app/api/v1/messages/_handler.ts`) grava `messages.id` com ele e, no 23505,
-- relê a linha e devolve sem reenviar quando ela já está `sent/delivered/read`.
-- A coluna é NOT NULL com default: repetir o handler para a MESMA parte nunca
-- produz segunda mensagem, nem por retry do worker nem por "reenviar" — este é
-- um pacote NOVO, com ids NOVOS, decisão explícita de alguém.
--
-- ─── Estado do pacote ──────────────────────────────────────────────────────
--
-- `scheduled` nasce; `sending` é a reserva do worker (update condicional, 0
-- linhas = já foi ou foi cancelado); `sent` quando TODAS as partes saíram;
-- `partial` quando alguma saiu e outra não; `failed` quando nenhuma saiu;
-- `cancelled` por gente, por opt-out ou por anonimização. A CHECK de
-- `cancelled_at` impede a linha "cancelada sem quando", que é o estado mentiroso
-- que a 0102 tirou do cron.
--
-- ─── Disparo pelo cron que já existe ───────────────────────────────────────
--
-- `cron_jobs` kind 'at' + `job_kind` novo + `payload {scheduled_message_id}`. O
-- `fireOneDue` já segura o row-lock do claim ao commit, desliga o one-shot
-- depois de disparar, aplica backoff (`applyFailure`) e avisa na Central quando
-- esgota. Uma fila própria recriaria os três. `contact_id` é NOT NULL no cron e
-- o agendamento sempre tem contato — a CHECK de coerência do `job_queue` segue
-- valendo sem exceção.
--
-- ⚠️ Sem stagger: `scheduleCronJob` espalha `next_run_at` por hash do contato,
-- e para hora marcada isso é atraso silencioso. Quem escreve o cron aqui é
-- `lib/scheduled-messages/agendar.ts`, com `next_run_at = scheduled_for`.
--
-- ─── Opt-out e LGPD pelo mesmo gatilho ─────────────────────────────────────
--
-- O gatilho de `contacts` que já encerra roteiro em opt-out/handoff
-- (`fn_contato_encerra_roteiro_com_humano_ou_opt_out`) não conhece estas
-- tabelas. Em vez de uma segunda regra espalhada, este gatilho próprio cobre a
-- família nova, e a decisão de LGPD do catálogo
-- (`tests/invariants/lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts`) lê o
-- corpo desta função: `scheduled_messages` é `redigir` por `gatilho`.

create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- Sem cascata dura de contato: a linha é rastro de uma decisão de envio. Quem
  -- apaga o contato (LGPD) passa pelo gatilho abaixo, que cancela e limpa.
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions (id) on delete cascade,
  -- O instante ABSOLUTO e o fuso que a tela usou. O fuso é para exibir; a hora
  -- que vale é `scheduled_for`, e é ela que o cron lê.
  scheduled_for timestamptz not null,
  tz text not null default 'UTC',
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'sent', 'partial', 'failed', 'cancelled')),
  -- Autor: pessoa (tela) OU token `dsk_` (API/MCP). Nenhum dos dois é
  -- obrigatório na coluna porque automação interna pode não ter dono — a
  -- procedência fica no `source`.
  created_by uuid references auth.users (id) on delete set null,
  created_by_token uuid references public.api_tokens (id) on delete set null,
  source text not null default 'inbox' check (source in ('inbox', 'api', 'mcp')),
  -- Ligado = o pacote é cancelado se o contato responder antes da hora. Default
  -- desligado: quem agenda é quem sabe se a resposta ainda interessa.
  cancel_if_contact_replies boolean not null default false,
  cancelled_at timestamptz,
  cancel_reason text,
  last_error text,
  attempts smallint not null default 0,
  -- "Reenviar o que faltou" é um pacote novo, com ids novos; este campo mantém
  -- o rastro de qual pacote ele socorreu.
  original_id uuid references public.scheduled_messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- A pergunta quente da tela é "o que ainda vai sair nesta conversa/contato".
create index if not exists scheduled_messages_vivas_idx
  on public.scheduled_messages (organization_id, conversation_id, scheduled_for)
  where status in ('scheduled', 'sending');
create index if not exists scheduled_messages_contato_idx
  on public.scheduled_messages (organization_id, contact_id, scheduled_for desc);

create table if not exists public.scheduled_message_parts (
  id uuid primary key default gen_random_uuid(),
  scheduled_message_id uuid not null references public.scheduled_messages (id) on delete cascade,
  position smallint not null check (position between 0 and 9),
  body text check (body is null or (length(body) between 1 and 4096)),
  media_storage_path text,
  media_mime text,
  media_size_bytes bigint check (media_size_bytes is null or media_size_bytes > 0),
  -- A CHAVE ANTI-DUPLICATA: vira `messages.id` no envio.
  internal_message_id uuid not null default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  message_id uuid references public.messages (id) on delete set null,
  error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (scheduled_message_id, position),
  -- Parte sem texto e sem arquivo não é parte.
  check (body is not null or media_storage_path is not null)
);

create unique index if not exists scheduled_message_parts_internal_id_idx
  on public.scheduled_message_parts (internal_message_id);

comment on table public.scheduled_messages is
  'Mensagem agendada numa conversa (#3118): o pacote que sai na hora marcada pelo servidor, em partes e na ordem. Distinto do retorno agendado (cron_jobs job_kind=followup_turn), em que a IA reescreve, e do compromisso (calendar_appointments), que ocupa a agenda de alguém.';
comment on column public.scheduled_messages.scheduled_for is
  'O instante absoluto do disparo, em UTC. É o next_run_at do cron_jobs kind=at que dispara o pacote — a hora que a tela mostrou é este mesmo instante no fuso de `tz`.';
comment on column public.scheduled_messages.tz is
  'Fuso usado na tela que agendou, só para exibir. A hora que vale é scheduled_for.';
comment on column public.scheduled_messages.status is
  'scheduled = ainda vai sair; sending = reservado pelo worker (update condicional, 0 linhas = já foi/cancelado); sent = todas as partes saíram; partial = alguma saiu e outra falhou; failed = nenhuma saiu; cancelled = desmarcado por gente, opt-out ou anonimização.';
comment on column public.scheduled_messages.cancel_if_contact_replies is
  'Ligado = se o contato responder antes da hora, o pacote é cancelado (motivo contato_respondeu). Default false: o operador marca quando a resposta torna o envio inútil.';
comment on column public.scheduled_messages.original_id is
  'De qual pacote este é o "reenviar o que faltou". Pacote novo, partes novas e internal_message_id novos: reenviar é decisão explícita, nunca repetição automática.';
comment on table public.scheduled_message_parts is
  'Cada parte de uma mensagem agendada (#3118), enviada na ordem de `position`. A parte só vira sent quando o canal confirmou (external_id gravado).';
comment on column public.scheduled_message_parts.internal_message_id is
  'A chave anti-duplicata: o envio grava messages.id com este valor. Repetir o handler na mesma parte relê a mensagem existente (23505) e NÃO reenvia quando ela já tem recibo.';
comment on column public.scheduled_message_parts.media_storage_path is
  'Anexo já subido ao bucket whatsapp-media na hora de agendar. O cron de retenção de mídia (media-retention) não pode apagar arquivo referenciado por parte pendente.';

alter table public.scheduled_messages enable row level security;
drop policy if exists scheduled_messages_select on public.scheduled_messages;
create policy scheduled_messages_select on public.scheduled_messages
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists scheduled_messages_insert on public.scheduled_messages;
create policy scheduled_messages_insert on public.scheduled_messages
  for insert with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  );
-- Atualizar é cancelar (ou o worker, que fala service_role e não passa por RLS).
drop policy if exists scheduled_messages_update on public.scheduled_messages;
create policy scheduled_messages_update on public.scheduled_messages
  for update using (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    (organization_id in (select public.fn_user_org_ids()))
    and public.fn_role_at_least(organization_id, 'agent')
  );

alter table public.scheduled_message_parts enable row level security;
-- A parte não tem `organization_id` própria: a dona é a linha do pacote.
drop policy if exists scheduled_message_parts_select on public.scheduled_message_parts;
create policy scheduled_message_parts_select on public.scheduled_message_parts
  for select using (
    exists (
      select 1
        from public.scheduled_messages m
       where m.id = scheduled_message_parts.scheduled_message_id
         and m.organization_id in (select public.fn_user_org_ids())
    )
  );

revoke all on public.scheduled_messages from public, anon, authenticated;
grant select, insert, update on public.scheduled_messages to authenticated;
grant all on public.scheduled_messages to service_role;

revoke all on public.scheduled_message_parts from public, anon, authenticated;
grant select on public.scheduled_message_parts to authenticated;
grant all on public.scheduled_message_parts to service_role;

-- ─── Vocabulário dos disparos ──────────────────────────────────────────────
--
-- ⚠️ UMA constraint, UM bloco: no `baseline.sql` a lista completa mora no bloco
-- único (ver `tests/unit/baseline-constraint-reconstruida.test.ts`). Aqui a
-- reconstrução é a da migration, e o teste
-- `tests/unit/kind-check-migration-x-baseline.test.ts` confere valor a valor
-- contra o baseline.

alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply','scheduled_message'));

-- A outra ponta do mesmo vocabulário: `job_queue_turn_needs_contact` diz QUAIS
-- kinds exigem `contact_id`. O cron da mensagem agendada sempre tem contato — o
-- pacote nasce de uma conversa (ou de um contato com conversa única), e o
-- `cron_jobs` só enfileira depois disso. Sem esta reconstrução, o baseline
-- aceitaria `scheduled_message` e a CADEIA recusaria: é o caso do PR #963, em que
-- o clone da VPS bate 23514 no primeiro uso enquanto os testes passam.
-- Vigiado por `tests/unit/check-do-baseline-nao-diverge-da-cadeia.test.ts`.
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply','scheduled_message')) = (contact_id is not null));

alter table public.cron_jobs drop constraint if exists cron_jobs_job_kind_check;
alter table public.cron_jobs add constraint cron_jobs_job_kind_check
  check (job_kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','scheduled_message'));

-- Vocabulário COMPLETO, valor a valor igual ao bloco único do `baseline.sql`:
-- `tests/unit/kind-check-migration-x-baseline.test.ts` compara as duas listas e
-- reprova a migration que reconstrói a constraint ENCOLHENDO o vocabulário.
alter table public.agent_inbox_items drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items add constraint agent_inbox_items_kind_check check (kind in (
  'appointment_outcome_required', 'appointment_recovery_review', 'qr_rescan', 'routing_unassigned',
  'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
  'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
  'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired', 'capabilities_missing',
  'message_send_stuck', 'midia_nao_lida', 'channel_template_review', 'channel_number_alert',
  'promise_unfulfilled', 'contact_proposal_expired', 'budget_warning', 'conhecimento_nao_indexado',
  'voice_call_missed', 'case_stale', 'aviso_de_caso_nao_entregue', 'followup_sem_agente',
  'canal_mudo_sem_numero', 'proposal_expired_notice', 'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
  'proposta_travada', 'proposta_pronta_para_revisao', 'org_reativada', 'jev_pedido_de_humano',
  'jev_parar_de_receber', 'canal_pausado', 'cobranca', 'email_de_login_trocado',
  'task_due', 'task_overdue', 'scheduled_message_failed', 'other'
));

-- ─── Opt-out e anonimização ────────────────────────────────────────────────
--
-- Um gatilho, duas portas de saída: o contato que pede para parar e o contato
-- que é anonimizado. As duas cancelam o pacote vivo (o cron dele inclusive) e a
-- segunda ainda apaga o corpo das partes que nunca saíram — mensagem escrita
-- sobre a pessoa não sobrevive à redação dela.
--
-- SECURITY DEFINER porque o caminho da LGPD pode chegar por um papel que não
-- tem UPDATE nestas tabelas; o corpo só toca linhas do MESMO contato/org da
-- linha que disparou o gatilho.

create or replace function public.fn_contato_encerra_mensagens_agendadas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_motivo text;
begin
  if new.is_anonymized = true and coalesce(old.is_anonymized, false) = false then
    v_motivo := 'Contato anonimizado (LGPD)';
  elsif new.is_blocked = true and coalesce(old.is_blocked, false) = false then
    v_motivo := 'Contato pediu para parar (opt-out)';
  else
    return new;
  end if;

  update public.scheduled_messages
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = v_motivo,
         updated_at = now()
   where organization_id = new.organization_id
     and contact_id = new.id
     and status in ('scheduled', 'sending');

  update public.cron_jobs
     set enabled = false,
         cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(cancel_reason, v_motivo),
         updated_at = now()
   where organization_id = new.organization_id
     and contact_id = new.id
     and enabled = true
     and job_kind = 'scheduled_message';

  -- Só a redação apaga texto: opt-out pede para parar de receber, não para
  -- apagar o que já estava escrito.
  if new.is_anonymized = true and coalesce(old.is_anonymized, false) = false then
    update public.scheduled_message_parts p
       set body = null,
           error_code = coalesce(p.error_code, 'lgpd_redigido')
      from public.scheduled_messages m
     where m.id = p.scheduled_message_id
       and m.organization_id = new.organization_id
       and m.contact_id = new.id
       and p.status = 'pending';
  end if;

  return new;
end
$$;

revoke all on function public.fn_contato_encerra_mensagens_agendadas() from public;
revoke execute on function public.fn_contato_encerra_mensagens_agendadas() from anon;
revoke execute on function public.fn_contato_encerra_mensagens_agendadas() from authenticated;

drop trigger if exists trg_contato_encerra_mensagens_agendadas on public.contacts;
create trigger trg_contato_encerra_mensagens_agendadas
  after update of is_blocked, is_anonymized on public.contacts
  for each row execute function public.fn_contato_encerra_mensagens_agendadas();

notify pgrst, 'reload schema';
