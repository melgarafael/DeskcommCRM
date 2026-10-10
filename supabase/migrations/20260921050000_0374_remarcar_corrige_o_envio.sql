-- REMARCAR UM COMPROMISSO JÁ ENVIADO CORRIGE O CLIENTE, SOZINHO.
--
-- Recorte do PR #803, de @paulolimajr77 (frente do Meet, fatia 4 — a última).
-- Empilha na fatia 3 (0366): o enfileirador abaixo é o dela, com o motivo e a
-- espera acrescentados.
--
-- ## O defeito, medido pelo autor peça por peça
--
-- O cliente recebia "marcado para 24/09 às 09:30", alguém remarcava, e NADA saía:
--
--   gatilho de remarcar .......... sobe a revisão, NÃO toca em meeting_delivery
--   gatilho de enfileirar ........ só age em `waiting_for_link`; depois de
--                                  enviar o estado é `sent`, então sai sem fazer
--   fn_meet_action('deliver') .... devolve false em estado `sent`
--   a tela ....................... desabilitava o botão com "Link já enviado"
--
-- Nenhuma varredura cobria o buraco: `fn_appointment_confirmation_sweep` só age
-- DEPOIS que o compromisso termina, e o que ela cria é aviso interno na Central,
-- nunca mensagem ao cliente. **A pessoa aparecia no dia errado.**
--
-- O que JÁ funcionava e continua: remarcar ANTES de o trabalhador enviar sai com
-- o horário novo — o texto é montado na hora do envio, de um select fresco.
--
-- ## As três decisões que impedem isto de virar spam
--
-- 1. **Só quem já recebeu.** Em `waiting_for_link`/`queued` a mensagem ainda nem
--    saiu, e vai sair com o horário novo sozinha.
-- 2. **Só os campos que entram no TEXTO** (`starts_at`, `time_zone`). Reagir a
--    qualquer `update` faria uma edição de título mandar mensagem ao cliente.
-- 3. **Espera de 2 minutos** (`nao_antes_de`), e a remarcação seguinte dentro da
--    janela SUBSTITUI a anterior — o job pendente morre no próprio enfileirador.
--    Sem isso, arrastar o compromisso na grade viraria uma mensagem por arrasto.
--
-- ## Uma linha da versão do autor que eu NÃO trouxe, e a medição
--
-- A 0242 dele mata, dentro do enfileirador, o job pendente da geração
-- anterior (`meet_delivery_superseded`). Sabotei: removê-la não muda NENHUM
-- caso — e a razão não é falta de teste, é que a linha é inalcançável.
-- Medido NESTA árvore (é ela que vai ser mesclada, e ela tem um caminho a
-- mais que a `main`: o `:= null` do gatilho novo acima):
--
--   instruções que põem `state='waiting_for_link'` ......... 5
--   dessas, que zeram `meeting_delivery_job_id` junto ...... 5
--
-- O corpo do enfileirador só roda com `state='waiting_for_link'`, então o
-- `job_id` ali é sempre nulo e um `update` chaveado por ele casa zero linha.
-- E a linha nem sai de migration aplicada: ela NÃO existe no enfileirador da
-- `main` — vive só na 0242 do autor, dentro do #803, que segue aberto. Aqui
-- ela simplesmente não foi trazida; nenhuma migration já aplicada foi editada.
--
-- Quem garante a antirrepetição é outra coisa, e ela está provada: o gatilho
-- só age em `sent`, então a segunda remarcação dentro da janela não cria uma
-- segunda correção. Se houver um caminho em que o `job_id` sobrevive, a linha
-- volta com um caso que a exercite.
--
-- ⚠️ O enfileirador NÃO recria o gatilho: `create or replace function` já troca
-- o corpo, e recriar o gatilho reintroduziria a janela de apagar-e-criar que a
-- Onda 1 consertou.
--
-- ⚠️ ENTRA ANTES DO BLOCO DA VARREDURA anon no baseline.
--
-- Idempotente: `create or replace` + `drop trigger if exists`.

create or replace function public.fn_remarcar_corrige_o_envio()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op <> 'UPDATE' then return new; end if;
 -- Cancelado não recebe correção: avisar cancelamento é outra funcionalidade, e
 -- mandar "o horário mudou" de um compromisso que não existe mais é pior que calar.
 if new.status = 'cancelled' then return new; end if;
 -- Só quem JÁ recebeu. Quem está em `waiting_for_link`/`queued` já vai sair com
 -- o horário novo sozinho, porque o texto é montado no envio.
 if coalesce(new.meeting_delivery->>'state','') <> 'sent' then return new; end if;
 -- APENAS os campos que entram no texto da mensagem. Reagir a qualquer `update`
 -- na linha faria uma edição de TÍTULO mandar mensagem ao cliente.
 if row(new.starts_at, new.time_zone) is not distinct from row(old.starts_at, old.time_zone) then
  return new;
 end if;

 new.meeting_delivery := jsonb_build_object(
   'state','waiting_for_link',
   -- Geração nova: é ela que faz um job anterior reprovar na vigência e se
   -- cancelar sozinho, em vez de duas mensagens saírem.
   'generation', gen_random_uuid(),
   'service_boundary', old.meeting_delivery->'service_boundary',
   'channel_session_id', old.meeting_delivery->>'channel_session_id',
   -- Quem autorizou o envio original autoriza a correção: é a mesma intenção,
   -- corrigida. E a vigência RECONFERE no envio se essa pessoa ainda é a
   -- responsável e ainda tem papel — se não for, a correção não sai e abre aviso
   -- na Central, que é o comportamento certo.
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
 -- ⚠️ `status` ENTRA AQUI, e a falta dele era um buraco REAL que só apareceu
 -- ao abrir a entrega para compromisso sem Meet.
 --
 -- A guarda olhava só `meeting_state='cancelled'` — o estado do LINK, não do
 -- compromisso. Enquanto a entrega exigia link pronto isso bastava por
 -- acidente: cancelar o compromisso cancelava o link junto. Sem Meet não há
 -- link para cancelar, e um compromisso CANCELADO passava a enfileirar
 -- entrega. O porteiro do envio recusaria depois (`a.status<>'cancelled'`),
 -- então o cliente não receberia nada — mas o job nasceria para morrer
 -- bloqueado, e a tela mostraria uma entrega a caminho que nunca sai.
 --
 -- Achado do @paulolimajr77, e foi o teste DELE que o pegou aqui.
 if new.status='cancelled' or new.meeting_state='cancelled' or new.meeting_delivery->>'state' in ('blocked','stale') then
  update public.job_queue set status='failed',locked_at=null,locked_by=null,payload='{}',last_error='meet_delivery_stale'
   where organization_id=new.organization_id and id=new.meeting_delivery_job_id and kind='transactional_delivery' and status in ('pending','running');
  return new;
 end if;
 if new.meeting_state='failed' then perform public.fn_meet_notice(new.organization_id,new.id,'meeting_failed');end if;
 -- ⛔ ESPERAR O LINK VALE SÓ ONDE O LOCAL É O MEET.
 --
 -- Esta é a exigência mais fácil de esquecer e a pior de esquecer: num
 -- compromisso PRESENCIAL o `meeting_state` é `not_requested` para sempre,
 -- então a entrega era autorizada, o gatilho passava por aqui, devolvia sem
 -- enfileirar nada, e a entrega ficava em `waiting_for_link` PARA SEMPRE — em
 -- silêncio, sem job, sem aviso e sem erro. Foi o teste do autor que a achou.
 --
 -- Onde o local É o Meet, nada muda: sem link pronto não sai job, porque
 -- mandar uma reunião sem como entrar nela é pior que não mandar.
 if (new.location_kind='google_meet' and new.meeting_state<>'ready')
  or new.meeting_delivery->>'state'<>'waiting_for_link' then return new;end if;
 b:=new.meeting_delivery->'service_boundary';
 if not public.fn_meet_boundary_current(b) then
  update public.calendar_appointments set meeting_delivery=meeting_delivery||'{"state":"stale","error":"service_boundary_stale"}' where organization_id=new.organization_id and id=new.id;
  perform public.fn_meet_notice(new.organization_id,new.id,'service_boundary_stale');return new;
 end if;
 jid:=gen_random_uuid();
 insert into public.job_queue(id,organization_id,contact_id,kind,payload,run_after)
 values(jid,new.organization_id,new.contact_id,'transactional_delivery',jsonb_build_object('appointment_id',new.id,'meeting_request_id',new.meeting_request_id,
  'delivery_generation',new.meeting_delivery->>'generation','service_boundary',b,
  -- O MOTIVO decide a FRASE que o cliente lê. Ausente = `primeiro_envio`,
  -- que é o comportamento de antes desta migration e o certo para toda
  -- entrega que já estava na fila quando ela foi aplicada.
  'motivo',coalesce(new.meeting_delivery->>'motivo','primeiro_envio')),
  -- ANTIRREPETIÇÃO: a correção ESPERA antes de sair, e uma remarcação nova
  -- dentro da janela substitui esta. Sem a espera, arrastar o compromisso na
  -- grade viraria uma mensagem por arrasto.
  coalesce((new.meeting_delivery->>'nao_antes_de')::timestamptz, now()));
 update public.calendar_appointments set meeting_delivery_job_id=jid,meeting_delivery=meeting_delivery||'{"state":"queued"}'
  where organization_id=new.organization_id and id=new.id;
 return new;
end;$$;
revoke all on function public.fn_meet_delivery_enqueue() from public,anon,authenticated;
