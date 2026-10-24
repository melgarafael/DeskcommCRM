-- manifest: Carimba saídas na fronteira observada ao inserir para que escolhas curtas recuperem ofertas entregues sem misturar atendimentos.
-- Não reatribui histórico: legado só é lido mediante recibo/job comprovados.
create or replace function public.fn_message_outbound_service_boundary()
returns trigger language plpgsql set search_path=public as $$
declare c public.conversations%rowtype; d public.demandas%rowtype;
begin
 if new.direction<>'outbound' then return new; end if;
 select * into c from public.conversations
  where id=new.conversation_id and organization_id=new.organization_id
    and contact_id=new.contact_id for update;
 if not found or c.is_group then return new; end if;
 -- Uma saída atrasada do aparelho não pertence automaticamente ao período atual.
 if c.service_started_at is null or coalesce(new.sent_at,new.created_at,clock_timestamp())<c.service_started_at
    or c.status in ('closed','resolved','archived') then return new; end if;
 if c.current_demanda_id is not null then
  select * into d from public.demandas where id=c.current_demanda_id
   and organization_id=c.organization_id and contact_id=c.contact_id;
  if not found or d.fechada_em is not null then return new; end if;
 end if;
 if new.service_revision is not null and
   (new.service_revision<>c.service_revision
    or (new.demanda_id is not null and (new.demanda_id is distinct from c.current_demanda_id
      or new.demanda_revision is distinct from d.revision))) then
  raise exception 'service_boundary_stale' using errcode='PT409';
 end if;
 new.service_revision:=c.service_revision;
 new.demanda_id:=c.current_demanda_id;
 new.demanda_revision:=d.revision;
 return new;
end $$;
revoke execute on function public.fn_message_outbound_service_boundary() from public, anon, authenticated;
grant execute on function public.fn_message_outbound_service_boundary() to service_role;
drop trigger if exists trg_message_outbound_service_boundary on public.messages;
create trigger trg_message_outbound_service_boundary before insert on public.messages
 for each row execute function public.fn_message_outbound_service_boundary();
