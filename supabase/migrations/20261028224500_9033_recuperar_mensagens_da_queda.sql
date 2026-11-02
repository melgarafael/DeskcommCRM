-- manifest: **Quando o número volta de uma queda, as conversas do período entram sozinhas, só de quem tem ficha (Spec 32).** `importacoes_de_historico` ganha `escopo` (`todos`|`so_crm`), `origem` (`manual`|`queda`), `desde`/`ate` (janela com fim), `evento_de_saida_id` (uma importação por queda, índice único parcial) e `numero_esperado` (conferido ao vivo antes de começar). `dias` deixa de ser obrigatório e o CHECK exige uma das duas formas (N dias até agora, ou desde/ate); `status` ganha `aguardando`. Os CHECKs antigos eram inline sem nome: drop pelos nomes automáticos e add com o mesmo nome. Dois kinds na Central (`recuperacao_da_queda`, `cliente_sem_resposta_na_queda`), cada um com índice único parcial de aberto. Linhas existentes ficam `escopo=todos`, `origem=manual` e cumprem os CHECKs novos. Sem backfill. Apêndice no `baseline.sql`.

alter table public.importacoes_de_historico
  add column if not exists escopo text not null default 'todos',
  add column if not exists origem text not null default 'manual',
  add column if not exists desde timestamptz,
  add column if not exists ate timestamptz,
  add column if not exists evento_de_saida_id uuid,
  add column if not exists numero_esperado text;

comment on column public.importacoes_de_historico.escopo is
  'todos = cria ficha para todo chat (a importação de sempre); so_crm = só chats que casam com ficha viva, sem criar nem alterar ficha (Spec 32).';
comment on column public.importacoes_de_historico.origem is
  'manual = o administrador pediu pela tela; queda = aberta sozinha pela volta de uma queda do número (Spec 32).';
comment on column public.importacoes_de_historico.ate is
  'Fim da janela (exclusivo). Filtro local da rodada: o cliente do canal só filtra desde. Na queda, é o instante do evento de volta, nunca depois (senão a recuperação gravaria antes do webhook uma mensagem ao vivo, que ficaria sem resposta).';
comment on column public.importacoes_de_historico.evento_de_saida_id is
  'event_log.id do channel_session.status_changed de saída que abriu esta recuperação. Sem FK de propósito (event_log é log); o índice único garante uma importação por queda.';
comment on column public.importacoes_de_historico.numero_esperado is
  'O número da conexão quando a queda foi detectada. Antes de começar, o cron lê o número ao vivo e compara: se mudou, cancela (o acervo seria de outro aparelho).';

-- A importação da queda usa desde/ate e não tem "dias".
alter table public.importacoes_de_historico alter column dias drop not null;

-- Os CHECKs de status e dias nasceram INLINE e sem nome; o Postgres os chamou
-- importacoes_de_historico_status_check e importacoes_de_historico_dias_check.
-- As linhas existentes cumprem os novos (dias válido, desde/ate vazios).
alter table public.importacoes_de_historico
  drop constraint if exists importacoes_de_historico_status_check;
alter table public.importacoes_de_historico
  add constraint importacoes_de_historico_status_check
  check (status in ('previa', 'aguardando', 'rodando', 'concluida', 'erro', 'cancelada'));

alter table public.importacoes_de_historico
  drop constraint if exists importacoes_de_historico_dias_check;
alter table public.importacoes_de_historico
  add constraint importacoes_de_historico_dias_check
  check (
    (dias in (30, 90, 180, 365) and desde is null and ate is null)
    or (dias is null and desde is not null and ate is not null and desde < ate)
  );

alter table public.importacoes_de_historico
  drop constraint if exists importacoes_de_historico_escopo_check;
alter table public.importacoes_de_historico
  add constraint importacoes_de_historico_escopo_check check (escopo in ('todos', 'so_crm'));

alter table public.importacoes_de_historico
  drop constraint if exists importacoes_de_historico_origem_check;
alter table public.importacoes_de_historico
  add constraint importacoes_de_historico_origem_check check (origem in ('manual', 'queda'));

-- Uma importação por queda: duas passadas do cron ao mesmo tempo não criam duas.
create unique index if not exists importacoes_de_historico_evento_de_saida_idx
  on public.importacoes_de_historico (evento_de_saida_id)
  where evento_de_saida_id is not null;

-- Vocabulário COMPLETO (igual ao bloco único do baseline, cerca
-- kind-check-migration-x-baseline): os dois kinds da Spec 32 entram antes de 'other'.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'aviso_de_caso_nao_entregue',
    'followup_sem_agente',
    'canal_mudo_sem_numero',
    'proposal_expired_notice',
    'proposal_acceptance_rate_drop',
    'proposal_promised_not_created',
    'proposta_travada',
    'proposta_pronta_para_revisao',
    'org_reativada',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'canal_pausado',
    'cobranca',
    'email_de_login_trocado',
    'task_due',
    'task_overdue',
    'assinatura_desconectada',
    'recuperacao_da_queda',
    'cliente_sem_resposta_na_queda',
    'other'
  ));

-- Um aviso aberto por conexão (o resumo é ATUALIZADO numa queda nova) e um por
-- conversa. O `not exists` de insertInboxItem tem corrida; o índice não.
create unique index if not exists agent_inbox_recuperacao_da_queda_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'recuperacao_da_queda';
create unique index if not exists agent_inbox_cliente_sem_resposta_na_queda_aberto_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where status = 'open' and kind = 'cliente_sem_resposta_na_queda';

notify pgrst, 'reload schema';
