-- manifest: mensagem nova do cliente em conversa aberta e SEM DONO passa a pedir roteamento (conversation.routing_requested) — o gatilho existente só vê o INSERT em conversations, então essa conversa só voltava à distribuição pelo laço de retentativa do worker (#3916)
--
-- 9225 — A MENSAGEM NOVA DO CLIENTE ACORDA A CONVERSA SEM DONO (#3916).
--
-- ═══ O caminho que faltava ═══
--
-- O pedido `conversation.routing_requested` nasce em UM lugar:
-- `trg_conversation_routing_requested` (`after insert on conversations`, com
-- `when` sem dono e `open`/`pending`). Uma conversa que JÁ existe e continua sem
-- dono não muda de estado quando o cliente escreve de novo:
-- `fn_upsert_wa_conversation` só toca `updated_at` no ramo de conflito, e
-- `trg_routing_assignment_changed` é `after update OF assigned_to_user_id,
-- status` — não vê `updated_at`. As duas portas ficam fechadas.
--
-- Consequência medida na issue: a conversa só volta para a distribuição pelo
-- laço de retentativa do worker (`lib/routing/worker.ts`, cron `routing-worker`,
-- 1x/min). Enquanto o laço existe, uma conversa com caso `awaiting_lead`, com a
-- equipe inteira fora do horário ou com o número sem ninguém elegível é
-- reagendada para sempre; se o laço parar, ela fica órfã para sempre. Este é o
-- caminho que faltava para que o laço possa ser desligado depois — e esta fatia
-- NÃO mexe nele: `max_retries`, `backoff_seconds`, `decideRouting` e o worker
-- continuam exatamente como estão.
--
-- ═══ O que passa a existir ═══
--
-- Um gatilho `after insert on messages` que pede roteamento quando a mensagem é
-- do CLIENTE (não da equipe) e a conversa está no pool sem dono. Ele conversa com
-- o que já existe em vez de duplicar a régua:
--
--   * `fn_request_channel_routing` continua sendo a única porta que cria o
--     evento: este gatilho não inventa um segundo formato de payload nem uma
--     segunda noção de "elegível para a fila".
--   * o índice único parcial `event_log_routing_active_unique`
--     (`(organization_id, entity_id)` para `conversation.routing_requested` em
--     `pending`/`processing`) é o que impede a enxurrada: cinco mensagens
--     seguidas caem no MESMO pedido pendente, com `do update` — nenhum INSERT
--     novo, nenhum evento por mensagem.
--   * o `do update` traz `next_attempt_at` para `now()`. É o ponto do desenho:
--     a mensagem nova não cria trabalho, ela ACORDA o que já está na fila. Com o
--     laço em espera de 15 min (o piso do backoff lento), a conversa volta a ser
--     tentada no próximo tick do cron em vez de daqui a um quarto de hora.
--
-- ═══ O que NÃO emite, e por quê ═══
--
--   * conversa COM dono — não é trabalho da fila (mesma régua de
--     `fn_request_channel_routing`: `assigned_to_user_id is not null` sai);
--   * conversa `closed`/`resolved`/`archived` — ela não está no pool. Quando a
--     mensagem do cliente REABRE a conversa, quem emite é
--     `trg_routing_assignment_changed` (a mudança de `status`), como sempre foi:
--     o pedido é UM, porque o índice único acima deduplica os dois caminhos;
--   * grupo — `fn_request_channel_routing` já recusa `is_group` desde a 0482, e
--     repetir a condição aqui evita uma leitura que só poderia terminar em nada;
--   * reação (`type='reaction'`) e histórico importado
--     (`metadata->>'historico_importado' = 'true'`) — a mesma régua de
--     `fn_emit_message_event`/`fn_demanda_abre_no_inbound` (0684/0760): um 👍 ou
--     uma conversa de meses atrás não é fala nova e não pode acordar a fila;
--   * saída da equipe (`direction='outbound'`, inclusive a resposta dada pelo
--     celular, `sent_via='external_device'`) — o gatilho pergunta pelo INBOUND;
--   * número cuja distribuição está DESLIGADA (`channel_routing_policies
--     .distribution_mode = 'manual'` e sem `default_assignee_user_id`): o pedido
--     não nasce — o worker o consumiria com `manual_mode` sem entregar ninguém.
--     Número manual COM destino padrão continua emitindo: ali há para quem
--     entregar, e o worker atribui direto.
--
-- ═══ Custo por mensagem recebida ═══
--
-- Uma instrução SQL, nenhuma chamada de rede: a conversa é lida pelo índice da
-- chave primária e o evento é escrito (ou reusado) na mesma passada. Não é uma
-- leitura nova "por mensagem" no sentido de egress: o worker continua lendo o
-- MESMO evento pendente, e a mensagem que chega em conversa com dono (o caso
-- comum) não escreve nada. A condição de dono/estado é avaliada na própria
-- função do gatilho, dentro do banco — em nenhum momento o caminho de entrada
-- do canal precisa consultar o roteamento para saber se pede.
--
-- Idempotente: `create or replace`, `drop trigger if exists` antes do `create
-- trigger`, e a chamada das travas do suporte no fim (0274) para o caminho da
-- cadeia fechar com o mesmo estado das instalações que já rodam o arquivo.

create or replace function public.fn_pedir_roteamento_na_mensagem()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  -- SECURITY DEFINER é o que permite o INSERT em `event_log` acontecer também
  -- quando quem grava a mensagem é um membro da organização pela API: um
  -- gatilho com os privilégios do invocador faria o INSERT da mensagem falhar
  -- na RLS do barramento, e a mensagem se perderia por causa do aviso.
  insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
  select c.organization_id,'conversation.routing_requested','conversation',c.id,
    jsonb_build_object('organization_id',c.organization_id,'conversation_id',c.id,
      'channel_session_id',c.channel_session_id)
    from public.conversations c
   where c.organization_id=new.organization_id
     and c.id=new.conversation_id
     and c.assigned_to_user_id is null
     and c.is_group=false
     and c.status in('open','pending','claimed','ai_handling')
     and not exists (select 1 from public.channel_routing_policies p
                      where p.organization_id=c.organization_id
                        and p.channel_session_id=c.channel_session_id
                        and p.distribution_mode='manual'
                        and p.default_assignee_user_id is null)
  on conflict(organization_id,entity_id) where event_type='conversation.routing_requested' and status in('pending','processing')
  do update set next_attempt_at=case when event_log.status='pending' then now() else event_log.next_attempt_at end;
  return null;
end;
$$;
revoke all on function public.fn_pedir_roteamento_na_mensagem() from public,anon,authenticated;

drop trigger if exists trg_routing_nova_mensagem_do_cliente on public.messages;
create trigger trg_routing_nova_mensagem_do_cliente
  after insert on public.messages
  for each row
  when (new.direction='inbound'
        and new.type <> 'reaction'
        and coalesce(new.metadata->>'historico_importado','') <> 'true')
  execute function public.fn_pedir_roteamento_na_mensagem();

do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
