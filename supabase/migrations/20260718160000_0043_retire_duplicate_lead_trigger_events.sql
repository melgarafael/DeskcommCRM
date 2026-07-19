-- 0043: trigger de leads para de duplicar lead.created/lead.stage_changed
--
-- O trigger legado trg_emit_event_on_lead_change emitia lead.created e
-- lead.stage_changed (entity_kind='lead', payload pobre) em PARALELO às
-- emissões dos handlers (entity_kind='crm_lead', payload rico) — todo evento
-- de lead nascia em dobro no event_log e o motor de automações precisa
-- filtrar por entity_kind pra não disparar 2x. Ninguém consome a variante do
-- trigger (verificado: nenhum handler registrado, nenhum leitor no app).
--
-- Cirurgia, não amputação: lead.won/lost/reopened/assigned são emitidos SÓ
-- pelo trigger (únicos, úteis p/ futuras notificações) — ficam. Os dois
-- duplicados saem, e o trigger passa a disparar só em UPDATE (INSERT só
-- servia pro lead.created).
--
-- Higiene: eventos duplicados pendentes antigos são marcados como done (nunca
-- terão consumer — o drain os ignoraria pra sempre como backlog morto).
-- Idempotente e portável em psql puro.

create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
begin
  if tg_op = 'INSERT' then
    -- lead.created é emitido pelo createLeadHandler (entity_kind='crm_lead').
    return new;
  end if;

  -- lead.stage_changed é emitido pelo moveLeadHandler (entity_kind='crm_lead').

  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.fn_log_event(new.organization_id, 'lead.won',
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents));
    elsif new.status = 'lost' then
      perform public.fn_log_event(new.organization_id, 'lead.lost',
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason));
    elsif new.status = 'open' then
      perform public.fn_log_event(new.organization_id, 'lead.reopened',
        jsonb_build_object('lead_id', new.id));
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    perform public.fn_log_event(new.organization_id, 'lead.assigned',
      jsonb_build_object('lead_id', new.id, 'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id));
  end if;

  return new;
end$$;

-- INSERT não emite mais nada — dispara só em UPDATE.
drop trigger if exists trg_emit_event_on_lead_change on public.crm_leads;
create trigger trg_emit_event_on_lead_change
  after update on public.crm_leads
  for each row execute function public.fn_emit_event_on_lead_change();

-- Backlog morto: duplicatas antigas do trigger nunca terão consumer.
update public.event_log
  set status = 'done', updated_at = now()
  where status = 'pending'
    and entity_kind = 'lead'
    and event_type in ('lead.created', 'lead.stage_changed');
