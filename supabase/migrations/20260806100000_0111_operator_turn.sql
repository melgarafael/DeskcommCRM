-- 0111 — o turno do OPERADOR (spec 16 §3.2).
--
-- O papel que MEXE no sistema e nunca fala com o lead. Nasce como kind próprio de
-- job porque o disparo é imposto pelo RUNTIME, por evento — nunca por decisão do
-- modelo que conversa. Um Conversador que "chama" o Operador devolve o problema
-- inteiro: volta a depender de o modelo lembrar, e o turno em que ele não achasse
-- necessário seria um lead parado no funil, em silêncio.
--
-- DOIS CHECKs, não um. O segundo é o que quebra se esquecido: `job_queue` exige
-- coerência entre kind e contact_id, e `operator_turn` TEM contato — sem estender
-- a lista, todo insert viola a constraint e o Operador nunca roda.

-- 1) o kind novo é aceito
alter table job_queue drop constraint if exists job_queue_kind_check;
alter table job_queue add constraint job_queue_kind_check
  check (kind in ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn'));

-- 2) coerência kind ⇔ contato. O nome do CHECK original é anônimo (gerado pelo
-- Postgres) em bancos antigos e nomeado em bancos novos — a busca no catálogo
-- cobre os dois, senão o clone antigo fica com a constraint velha valendo.
alter table job_queue drop constraint if exists job_queue_turn_needs_contact;
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'job_queue'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%contact_id is not null%';
  if c is not null then execute format('alter table job_queue drop constraint %I', c); end if;
end $$;
alter table job_queue add constraint job_queue_turn_needs_contact
  check ((kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn')) = (contact_id is not null));

-- 3) configuração por versão publicada do agente.
--
-- `operator_enabled` nasce FALSE: uma migration não pode ligar sozinha um papel
-- que gasta uma chamada de modelo por turno na chave do self-hoster. Quem liga é
-- o humano, na tela, vendo o que muda.
--
-- `operator_model` NULL = usa o modelo do agente. Um papel que opera pode querer
-- um modelo diferente do que conversa (spec 16 §2, decisão de produto), mas o
-- default não pode exigir que alguém escolha antes de poder experimentar.
alter table ai_agent_versions
  add column if not exists operator_enabled boolean not null default false;
alter table ai_agent_versions
  add column if not exists operator_model text;

comment on column ai_agent_versions.operator_enabled is
  'Spec 16 §3.2: o papel Operador roda após o turno do Conversador. false = o '
  'registro básico segue por código determinístico (estado, follow-up prometido, '
  'timeline); o que se perde é o julgamento sobre as capacidades do catálogo.';
comment on column ai_agent_versions.operator_model is
  'Modelo do papel Operador. NULL = herda o modelo do agente.';

-- 4) vocabulário da Central: promessa declarada e não cumprida.
--
-- A invariante sagrada da spec 16 é "nenhuma promessa deixa de ser cumprida".
-- Sem este kind, a promessa órfã só existiria no log do worker — num contêiner de
-- VPS que o dono do negócio nunca abre. Idempotente: a lista só cresce.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;
alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan','job_dead','event_dead','budget_exceeded','handoff','promotion_review',
    'judge_unaligned','followup_dead','snooze_expired','next_action_ambiguous',
    'risk_backlog_seeded','reactivation_expired','capabilities_missing',
    'message_send_stuck','promise_unfulfilled','other'
  ));
