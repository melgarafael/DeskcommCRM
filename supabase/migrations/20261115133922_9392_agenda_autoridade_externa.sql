-- manifest: **Compromisso e tipo de atendimento podem ter um sistema externo como autoridade (#4227, etapa 1 de 2 do doc 356).** `calendar_appointments` ganha `authority` (`'local'` de fábrica), `external_status` e `external_connection_id`; `calendar_event_types` ganha `external_provider`, `external_id` e `external_connection_id`, com identidade única por organização. A sessão (authenticated/anon) não cria linha externa nem muda essa identidade — só o servidor (service_role e security definer). Compromisso externo não entra na fila do Google, e o desfecho que o servidor grava a partir da autoridade externa não exige confirmação humana nem vira fato certificado. Sem integração ligada, toda linha é `'local'` e nada muda. Prova em `tests/invariants/agenda-autoridade-externa.test.ts`.
--
-- 9392 — A AGENDA ACEITA UMA AUTORIDADE DE FORA (#4227, etapa 1 de 2).
--
-- Peça genérica, recortada do PR #4227 de @jadsonlsouza (migrations 9215,
-- 9216 e 9218 dele), sem nada de um fornecedor: a etapa 2 (o módulo opcional
-- da integração com o sistema de clínicas) se pluga aqui. O que fica de fora
-- de propósito, e por quê:
--
--   * `fn_google_appointment` NÃO é redefinida. O PR a copiava inteira para
--     recusar o `claim` de compromisso externo; a única porta do cron é a view
--     `calendar_service_google_push_queue`, e o outro caminho do executor
--     (`calendar-executor.ts`) só alcança compromisso que já tem
--     `google_event_id` — linha externa nasce sem ele. Filtrar a fila basta, e
--     não duplica 12 KB de função que já tem quatro definições no baseline.
--   * A guarda NÃO bloqueia editar nem apagar a linha externa no banco, só a
--     IDENTIDADE dela. Bloquear tudo (como o PR) quebraria quem já escreve em
--     `calendar_appointments` em nome do usuário por security definer — fundir
--     fichas reaponta `contact_id`, anonimizar reescreve o texto — e apagar um
--     contato cascateia. A recusa de remarcar/cancelar pela agenda mora no
--     handler (`app/api/v1/agenda/agendamentos/_handler.ts`), que é a porta da
--     tela e da IA.
--   * "Sessão" segue a régua da 9389 (`current_user in ('authenticated','anon')`):
--     service_role e security definer passam.

-- ═══ As colunas ═══
alter table public.calendar_appointments
  add column if not exists authority text not null default 'local',
  add column if not exists external_status text,
  add column if not exists external_connection_id uuid;
alter table public.calendar_event_types
  add column if not exists external_provider text,
  add column if not exists external_id text,
  add column if not exists external_connection_id uuid;

-- Coerência em constraint própria (a de vocabulário fica no TypeScript: o nome
-- do provedor é vocabulário aberto, cada módulo traz o seu). Toda linha anterior
-- é `'local'` com as colunas novas nulas, então nada a corrigir antes.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_appointments_autoridade_coerente'
                  and conrelid = 'public.calendar_appointments'::regclass) then
    alter table public.calendar_appointments add constraint calendar_appointments_autoridade_coerente check (
      (authority = 'local') = (external_connection_id is null)
      and (authority <> 'local' or external_status is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'calendar_event_types_origem_externa_coerente'
                  and conrelid = 'public.calendar_event_types'::regclass) then
    alter table public.calendar_event_types add constraint calendar_event_types_origem_externa_coerente check (
      (external_provider is null) = (external_id is null)
      and (external_provider is null) = (external_connection_id is null)
    );
  end if;
end $$;

create unique index if not exists calendar_event_types_external_identity_uq
  on public.calendar_event_types (organization_id, external_provider, external_connection_id, external_id)
  where external_provider is not null;

-- ═══ A identidade externa só é gravada pelo servidor ═══
create or replace function public.fn_guard_autoridade_do_compromisso()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT'
               then new.authority <> 'local' or new.external_connection_id is not null or new.external_status is not null
               else row(new.authority, new.external_connection_id, new.external_status)
                    is distinct from row(old.authority, old.external_connection_id, old.external_status)
          end) then
    raise exception 'agenda_autoridade_reservada'
      using errcode = '42501',
            detail = 'authority, external_status e external_connection_id são gravados só pelo servidor.';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_autoridade_do_compromisso() from public, anon, authenticated;
grant execute on function public.fn_guard_autoridade_do_compromisso() to service_role;
drop trigger if exists trg_guard_autoridade_do_compromisso on public.calendar_appointments;
create trigger trg_guard_autoridade_do_compromisso
  before insert or update of authority, external_status, external_connection_id
  on public.calendar_appointments for each row execute function public.fn_guard_autoridade_do_compromisso();

create or replace function public.fn_guard_origem_externa_do_tipo()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT'
               then new.external_provider is not null or new.external_id is not null or new.external_connection_id is not null
               else row(new.external_provider, new.external_id, new.external_connection_id)
                    is distinct from row(old.external_provider, old.external_id, old.external_connection_id)
          end) then
    raise exception 'agenda_origem_do_tipo_reservada'
      using errcode = '42501',
            detail = 'external_provider, external_id e external_connection_id são gravados só pelo servidor.';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_guard_origem_externa_do_tipo() from public, anon, authenticated;
grant execute on function public.fn_guard_origem_externa_do_tipo() to service_role;
drop trigger if exists trg_guard_origem_externa_do_tipo on public.calendar_event_types;
create trigger trg_guard_origem_externa_do_tipo
  before insert or update of external_provider, external_id, external_connection_id
  on public.calendar_event_types for each row execute function public.fn_guard_origem_externa_do_tipo();

-- ═══ Desfecho vindo da autoridade externa ═══
-- Corpo idêntico ao da 0224, mais o ramo marcado. Sem ele, o servidor não
-- consegue espelhar `completed`/`no_show` vindo de fora: o gatilho exige
-- `auth.uid()` de quem atende. O desfecho espelhado NÃO vira fato certificado
-- (`outcome_*` ficam nulos), igual ao legado importado no INSERT. A régua de
-- "servidor" aqui é o `role` da sessão, porque esta função é security definer e
-- `current_user` dentro dela é sempre o dono.
create or replace function public.fn_appointment_stamp()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; actor uuid;
begin
 if new.contact_id is not null and not exists(select 1 from public.contacts where id=new.contact_id and organization_id=new.organization_id) then
  raise exception 'appointment_contact_scope' using errcode='23503'; end if;
 if new.conversation_id is not null and not exists(select 1 from public.conversations where id=new.conversation_id and organization_id=new.organization_id and contact_id=new.contact_id and not is_group and (auth.uid() is null or public.fn_can_view_conversation(organization_id,assigned_to_user_id))) then
  raise exception 'appointment_conversation_scope' using errcode='23503'; end if;
 if tg_op='INSERT' then
  new.revision:=1;
  -- Legado importado sem autoria não vira fato certificado.
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
  return new;
 end if;
 changed:=row(new.starts_at,new.ends_at,new.status,new.contact_id,new.conversation_id) is distinct from row(old.starts_at,old.ends_at,old.status,old.contact_id,old.conversation_id);
 new.revision:=old.revision+case when changed then 1 else 0 end;
 new.revision_started_at:=case when changed then clock_timestamp() else old.revision_started_at end;
 if changed then new.confirmation_next_at:=null; end if;
 if new.status is distinct from old.status and new.status in ('completed','no_show') then
  -- 9392: autoridade externa, gravada pelo servidor — espelho, não certificação.
  if new.authority<>'local' and coalesce(nullif(current_setting('role',true),''),'none') not in ('authenticated','anon') then
   new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
   new.outcome_recorded_at:=null;
   return new;
  end if;
  actor:=auth.uid();
  if actor is null or not public.fn_role_at_least(new.organization_id,'agent') or not public.fn_support_write_allowed(new.organization_id) then
   raise exception 'appointment_human_confirmation_required' using errcode='42501'; end if;
  if new.starts_at>now() then raise exception 'appointment_not_started' using errcode='22023'; end if;
  new.outcome_user_id:=actor; new.outcome_recorded_at:=clock_timestamp();
  new.outcome_source_kind:=case when new.outcome_message_id is null then 'user' else 'contact_message' end;
  if new.outcome_message_id is not null and not exists(
   select 1 from public.messages m join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
   where m.id=new.outcome_message_id and m.organization_id=new.organization_id and m.contact_id=new.contact_id
    and (new.conversation_id is null or m.conversation_id=new.conversation_id)
    and m.direction='inbound' and m.service_revision is not null and m.service_revision=c.service_revision
    and m.demanda_id is not distinct from c.current_demanda_id and m.created_at>=old.revision_started_at
    and not c.is_group and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
  ) then raise exception 'appointment_message_not_evidence' using errcode='42501'; end if;
 elsif changed then
  new.outcome_source_kind:=null; new.outcome_user_id:=null; new.outcome_message_id:=null;
  new.outcome_recorded_at:=null;
 else
  new.outcome_source_kind:=old.outcome_source_kind;
  -- SET NULL por retenção da FK é erosão de referência, não nova autoria.
  new.outcome_user_id:=case when new.outcome_user_id is null and not exists(select 1 from auth.users where id=old.outcome_user_id) then null else old.outcome_user_id end;
  new.outcome_message_id:=case when new.outcome_message_id is null and not exists(select 1 from public.messages where id=old.outcome_message_id and organization_id=old.organization_id) then null else old.outcome_message_id end;
  new.outcome_recorded_at:=old.outcome_recorded_at;
 end if;
 return new;
end; $$;
revoke all on function public.fn_appointment_stamp() from public,anon,authenticated;

-- ═══ Compromisso externo não vai ao Google ═══
-- A view da 9358 com uma condição a mais no fim do WHERE; colunas iguais, então
-- `create or replace` serve e a ACL se mantém (grants repetidos por garantia).
create or replace view public.calendar_service_google_push_queue with (security_invoker=true) as
 select a.id,a.organization_id,
  case when a.service_occurrence_id is null and not a.service_block then a.owner_user_id else coalesce(link.user_id,dest.user_id) end owner_user_id,
  a.needs_google_push,a.google_event_id,a.google_conflict,a.google_next_attempt_at,
  a.status,a.ends_at
 from public.calendar_appointments a
 left join public.calendar_connections link on link.organization_id=a.organization_id and link.id=a.google_connection_id
 left join public.calendar_connection_calendars k on k.organization_id=a.organization_id and k.id=a.service_destination_calendar_id
 left join public.calendar_connections dest on dest.organization_id=k.organization_id and dest.id=k.connection_id
 where ((a.service_occurrence_id is null and not a.service_block) or a.service_publication_mode<>'none')
  and not exists(select 1 from public.contacts c where c.organization_id=a.organization_id and c.id=a.contact_id and c.is_anonymized)
  and a.status in ('pending','confirmed','cancelled')
  and a.ends_at>now()-interval '1 day'
  and a.authority='local';
revoke all on public.calendar_service_google_push_queue from public,anon,authenticated;
grant select on public.calendar_service_google_push_queue to service_role;
notify pgrst, 'reload schema';
