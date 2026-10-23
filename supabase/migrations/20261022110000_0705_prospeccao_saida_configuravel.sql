-- manifest: prospecting_candidates.automatic_sends + exit_offered_at + exit_offer_message_id — saída da prospecção na 1ª ou na 2ª mensagem; a reserva volta quando a mensagem que a leva falha
alter table public.prospecting_candidates
  add column if not exists automatic_sends smallint not null default 0,
  add column if not exists exit_offered_at timestamptz;

-- A reserva da saída aponta para a MENSAGEM que leva o rodapé, não para a
-- tentativa de envio. Quem decide se essa mensagem sai não é quem a contou: o
-- handler, o watchdog (`redriveQueued`) e o webhook de status gravam `failed`
-- depois, cada um no seu processo. Quando a mensagem apontada vira `failed`, a
-- saída NÃO foi oferecida: a contagem e a reserva voltam, e a auditoria ganha a
-- linha de compensação (o audit log é append-only; o `exit_offered` já gravado
-- fica, e esta linha diz que ele não se cumpriu). Sem isto, uma mensagem
-- `queued` que o watchdog falhava deixava a tela em "Saída oferecida" e a
-- mensagem seguinte saía sem PARAR: o contato nunca recebia a saída.
-- O gatilho não faz HTTP; só reescreve duas linhas do próprio tenant.
alter table public.prospecting_candidates
  add column if not exists exit_offer_message_id uuid references public.messages(id) on delete set null;
create index if not exists prospecting_candidates_exit_offer_message_idx
  on public.prospecting_candidates (exit_offer_message_id) where exit_offer_message_id is not null;

create or replace function public.fn_prospeccao_saida_volta_com_a_mensagem()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  with desfeita as (
    update public.prospecting_candidates
       set automatic_sends = greatest(automatic_sends - 1, 0),
           exit_offered_at = null,
           exit_offer_message_id = null,
           updated_at = now()
     where organization_id = new.organization_id
       and exit_offer_message_id = new.id
    returning id
  )
  insert into public.api_audit_log (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
  select new.organization_id, 'prospecting.exit_offer_withdrawn', 'prospecting_candidate', d.id, true,
         jsonb_build_object('message_id', new.id, 'conversation_id', new.conversation_id, 'error_code', new.error_code)
    from desfeita d;
  return null;
end; $fn$;
revoke execute on function public.fn_prospeccao_saida_volta_com_a_mensagem() from public, anon, authenticated;

drop trigger if exists trg_prospeccao_saida_volta_com_a_mensagem on public.messages;
create trigger trg_prospeccao_saida_volta_com_a_mensagem
  after update of status on public.messages
  for each row
  when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function public.fn_prospeccao_saida_volta_com_a_mensagem();
