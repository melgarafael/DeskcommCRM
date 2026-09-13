-- 0242 — remarcar um compromisso ja enviado CORRIGE o cliente
--
-- MEDIDO no codigo em 2026-09-12, seguindo a cadeia peca por peca: o cliente
-- recebia "marcado para 24/09 as 09:30", alguem remarcava, e NADA saia.
--
--   gatilho de remarcar .......... sobe a revisao, NAO toca em meeting_delivery
--   gatilho de enfileirar ........ so age em `waiting_for_link`; depois de
--                                  enviar o estado e `sent`, entao sai sem fazer
--   fn_meet_action('deliver') .... devolve false em estado `sent`
--   a tela ....................... desabilita o botao com "Link ja enviado"
--
-- Nenhuma varredura cobria o buraco: `fn_appointment_confirmation_sweep` so age
-- DEPOIS que o compromisso termina, e o que ela cria e aviso interno na Central,
-- nunca mensagem ao cliente. A pessoa aparecia no dia errado.
--
-- O QUE JA FUNCIONAVA E CONTINUA: remarcar ANTES de o trabalhador enviar sai com
-- o horario NOVO — o texto e montado na hora do envio, de um select fresco.

create or replace function public.fn_remarcar_corrige_o_envio()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op <> 'UPDATE' then return new; end if;
 -- Cancelado nao recebe correcao: avisar cancelamento e outra funcionalidade, e
 -- mandar "o horario mudou" de um compromisso que nao existe mais e pior que
 -- calar.
 if new.status = 'cancelled' then return new; end if;
 -- So quem JA recebeu. Quem esta em `waiting_for_link`/`queued` ja vai sair com
 -- o horario novo sozinho, porque o texto e montado no envio.
 if coalesce(new.meeting_delivery->>'state','') <> 'sent' then return new; end if;
 -- APENAS os campos que entram no texto da mensagem. Reagir a qualquer `update`
 -- na linha faria uma edicao de TITULO mandar link ao cliente.
 if row(new.starts_at, new.time_zone) is not distinct from row(old.starts_at, old.time_zone) then
  return new;
 end if;

 new.meeting_delivery := jsonb_build_object(
   'state','waiting_for_link',
   -- Geracao nova: e ela que faz um job anterior reprovar na vigencia e se
   -- cancelar sozinho, em vez de duas mensagens sairem.
   'generation', gen_random_uuid(),
   'service_boundary', old.meeting_delivery->'service_boundary',
   'channel_session_id', old.meeting_delivery->>'channel_session_id',
   -- Quem autorizou o envio original autoriza a correcao: e a mesma intencao,
   -- corrigida. E a vigencia RECONFERE no envio se essa pessoa ainda e a
   -- responsavel e ainda tem papel — se nao for, a correcao nao sai e abre aviso
   -- na Central, que e o comportamento certo.
   'authorized_by', old.meeting_delivery->'authorized_by',
   'source_operation_id', gen_random_uuid(),
   'motivo','remarcado',
   'nao_antes_de', (now() + interval '2 minutes')::text);
 new.meeting_delivery_job_id := null;
 return new;
end;$$;
revoke execute on function public.fn_remarcar_corrige_o_envio() from public, anon, authenticated;

drop trigger if exists trg_remarcar_corrige_o_envio on public.calendar_appointments;
create trigger trg_remarcar_corrige_o_envio
  before update on public.calendar_appointments
  for each row execute function public.fn_remarcar_corrige_o_envio();

-- O enfileirador passa a respeitar a espera e a carregar o motivo.
-- NAO recria o gatilho: `create or replace function` ja troca o corpo, e recriar
-- o gatilho reintroduziria a janela de apagar-e-criar que a Onda 1 consertou.
create or replace function public.fn_meet_delivery_enqueue()
returns trigger language plpgsql security definer set search_path=public as $$
declare jid uuid; b jsonb;
begin
 -- A MESMA ORDEM DE TRAVA das ~20 irmãs: contato PRIMEIRO, job_queue depois.
 -- Sem esta linha, este gatilho já segurava a linha do compromisso (é BEFORE/
 -- AFTER na própria calendar_appointments) e ia travar job_queue sem o mutex do
 -- contato, enquanto fn_meet_redact_contact (0229) pega o mutex do contato e só
 -- então mexe em job_queue. Duas ordens opostas sobre os mesmos dois recursos =
 -- deadlock (40P01) sob concorrência, e quem paga é o cliente com anonimização
 -- LGPD acontecendo enquanto um link de reunião é entregue.
 perform public.fn_service_lock(new.organization_id,new.contact_id);
 if new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 if new.meeting_state<>'ready' or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 -- Um job pendente da geracao anterior morre AQUI, e nao e deixado para a
 -- vigencia descobrir. Assim a antirrepeticao vale mesmo com o trabalhador
 -- parado: cinco arrastos seguidos deixam UM job vivo, nao cinco.
 update public.job_queue set status='failed',locked_by=null,locked_at=null,last_error='meet_delivery_superseded'
  where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b,
  -- O motivo decide a FRASE que o cliente le. Sem ele, `primeiro_envio` —
  -- que e o comportamento de antes, e o certo para toda entrega ja na fila.
  'motivo',coalesce(new.meeting_delivery->>'motivo','primeiro_envio')),
  -- ANTIRREPETICAO: a correcao espera antes de sair, e uma remarcacao nova
  -- dentro da janela substitui esta. Sem espera, arrastar o compromisso na
  -- grade viraria uma mensagem por arrasto.
  coalesce((new.meeting_delivery->>'nao_antes_de')::timestamptz, now()));
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
