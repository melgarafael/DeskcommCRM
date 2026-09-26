-- ============================================================================
-- 2026-09-26 — 0433: OS AVISOS DO JEV NA CENTRAL (onda 3 do Jev, bloco 3.2)
--
-- O Jev percebe, onde a regra de hoje não viu nada, dois pedidos do cliente:
-- falar com uma pessoa, e parar de receber mensagens. Quando a empresa escolhe
-- "Avisar a equipe" numa dessas tarefas, ele abre UM aviso na Central por
-- conversa e pedido — e só isso: nunca passa a conversa, nunca cala o agente,
-- nunca bloqueia o contato, nunca responde o cliente. Quem passa a conversa
-- continua sendo a regra de hoje ou uma pessoa; quem bloqueia o contato é só a
-- regra de hoje, quando o próprio cliente manda o STOP.
--
-- O QUE ESTA MIGRATION FAZ, em três partes:
--
-- 1. Abre vocabulário: `jev_pedido_de_humano` e `jev_parar_de_receber` no CHECK
--    de `agent_inbox_items.kind`. Um kind por pedido, e não `other`: a Central
--    dá rótulo e destino por kind (lib/ai/inbox-destino.ts) e o `other` não leva
--    a uma conversa. A LISTA VEM INTEIRA, derivada do `supabase/baseline.sql`
--    no momento do commit: `add constraint` substitui, e uma lista parcial
--    apagaria o aviso de outra feature em silêncio
--    (tests/unit/kind-check-migration-x-baseline.test.ts compara as duas).
--
-- 2. Um aviso por conversa e pedido é do banco: índice único parcial, sem
--    status, e o pedido novo reabre o aviso que existe (parte 2, abaixo).
--
-- 3. O aviso fecha sozinho quando o pedido foi atendido por qualquer caminho:
--    a conversa encerrada fecha os dois; a conversa com uma pessoa (assumida
--    ou passada) fecha o de falar com uma pessoa; o contato bloqueado fecha o
--    de parar de receber (parte 3, abaixo). O "Marcar resolvido" da Central
--    continua valendo.
--
-- Idempotente. As funções de gatilho nascem revogadas de public, anon e
-- authenticated — ninguém as chama. O mesmo texto está no apêndice do
-- `supabase/baseline.sql`.
-- ============================================================================

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
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'other'
));

-- 2. UM AVISO POR CONVERSA E PEDIDO, NO BANCO. Índice único parcial em
--    (organização, kind, conversa) para os dois kinds do Jev, SEM status — o
--    precedente é o `agent_inbox_routing_unique` do `routing_unassigned`. Com o
--    status fora do índice, o "Reabrir" nunca encontra um segundo aberto, e o
--    pedido novo sobre o mesmo aviso o REABRE em vez de abrir outro (o gravador,
--    lib/ai/decisao/pedidos.ts, faz o insert e trata o 23505). A busca antes da
--    escrita, que havia antes, deixava dois drenos simultâneos abrirem dois.
--    Antes do índice, os repetidos saem (fica o aberto, e o mais novo): só o
--    banco de quem rodou este PR antes do conserto os tem, mas o `update.sh`
--    de qualquer clone não pode quebrar aqui.
delete from public.agent_inbox_items a
 using (
   select id, row_number() over (
            partition by organization_id, kind, ref_id
            order by (status = 'open') desc, created_at desc, id desc
          ) as n
     from public.agent_inbox_items
    where kind in ('jev_pedido_de_humano','jev_parar_de_receber')
 ) d
 where a.id = d.id and d.n > 1;
create unique index if not exists agent_inbox_jev_pedido_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where kind in ('jev_pedido_de_humano','jev_parar_de_receber');

-- 3. O AVISO FECHA QUANDO O PEDIDO FOI ATENDIDO, por qualquer caminho.
--    A conversa saiu dos estados abertos (encerrada): os dois avisos.
--    A conversa ficou com uma pessoa — alguém assumiu, ou ela foi PASSADA:
--    `performHumanHandoff` (a regra de hoje, o descadastro ambíguo, a
--    ferramenta `request_human_handoff` do modelo), o orquestrador do clima e
--    a atribuição manual gravam `last_handoff_at` e calam o robô
--    (`bot_silenced_until` no futuro) — fecha SÓ o de falar com uma pessoa.
--    O de parar de receber segue aberto aí: o texto dele pede que a equipe
--    assuma E peça ao cliente o PARAR, e fechá-lo no primeiro passo sumiria
--    com o lembrete de um pedido de descadastro antes do passo que o atende.
--    No contato: bloqueado (`is_blocked` passa a true — o único escritor é o
--    STOP do próprio cliente, na entrada da mensagem, lib/channels/pos-entrada.ts;
--    ninguém da equipe bloqueia à mão), fecha o de parar de receber de todas
--    as conversas dele.
--    Gatilhos próprios, e não o de atribuição da 0228: aquele só dispara em
--    `assigned_to_user_id`/`status`, e a passagem nem sempre muda o status.
--    Nenhum faz HTTP; os dois filtram a organização da própria linha.
create or replace function public.fn_fechar_avisos_do_jev_da_conversa()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved',resolved_at=now()
   where organization_id=new.organization_id and ref_kind='conversation' and ref_id=new.id
     and kind in('jev_pedido_de_humano','jev_parar_de_receber') and status<>'resolved';
 elsif new.assigned_to_user_id is not null
    or (new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at)
    or (new.bot_silenced_until > now() and new.bot_silenced_until is distinct from old.bot_silenced_until) then
  update public.agent_inbox_items set status='resolved',resolved_at=now()
   where organization_id=new.organization_id and ref_kind='conversation' and ref_id=new.id
     and kind='jev_pedido_de_humano' and status<>'resolved';
 end if;
 return new;
end;
$$;
revoke all on function public.fn_fechar_avisos_do_jev_da_conversa() from public,anon,authenticated;
drop trigger if exists trg_fechar_avisos_do_jev_da_conversa on public.conversations;
create trigger trg_fechar_avisos_do_jev_da_conversa
 after update of assigned_to_user_id,status,bot_silenced_until,last_handoff_at on public.conversations
 for each row execute function public.fn_fechar_avisos_do_jev_da_conversa();

create or replace function public.fn_fechar_aviso_do_jev_ao_bloquear()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=new.organization_id and kind='jev_parar_de_receber' and ref_kind='conversation'
    and status<>'resolved'
    and ref_id in(select v.id from public.conversations v where v.organization_id=new.organization_id and v.contact_id=new.id);
 return new;
end;
$$;
revoke all on function public.fn_fechar_aviso_do_jev_ao_bloquear() from public,anon,authenticated;
drop trigger if exists trg_fechar_aviso_do_jev_ao_bloquear on public.contacts;
create trigger trg_fechar_aviso_do_jev_ao_bloquear
 after update of is_blocked on public.contacts
 for each row when (new.is_blocked and old.is_blocked is distinct from true)
 execute function public.fn_fechar_aviso_do_jev_ao_bloquear();

notify pgrst, 'reload schema';
