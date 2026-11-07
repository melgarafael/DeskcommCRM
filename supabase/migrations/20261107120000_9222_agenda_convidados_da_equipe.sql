-- manifest: Agenda: convidados da equipe no compromisso (tabela `calendar_appointment_team_guests`, RLS por organização, o convidado não vira dono) e o tipo de agendamento ganha `convidados_padrao` e o interruptor `levar_dados_do_negocio` (#4006). Mudança de convidado marca o compromisso para a próxima ida ao Google — os convidados entram no `attendees` no ENVIO, não na detecção de "alguém mudou o evento".
--
-- 9222 — `calendar_appointment_team_guests` + `calendar_event_types.convidados_padrao`
--
-- O compromisso só sabia convidar o dono, o e-mail da ficha e UM e-mail digitado
-- à mão. Numa equipe com SDR e closer, quem participa e não é o responsável não
-- vê a reunião na própria agenda — nem no Google nem no CRM.
--
-- ─── Por que tabela e não coluna `uuid[]` ────────────────────────────────
--
-- A lista é uma relação (organização, compromisso, pessoa), com unique por par:
-- a mesma pessoa não pode entrar duas vezes, e o par é o que a RLS usa para
-- dizer quem lê. Um array no agendamento não teria FK para o vínculo da pessoa
-- e voltaria a aceitar (e a duplicar) id de OUTRA organização.
--
-- ─── O convidado NÃO vira dono ───────────────────────────────────────────
--
-- `owner_user_id`, carteira, distribuição e métricas continuam do responsável.
-- Esta tabela não participa de nenhuma dessas réguas; ela só responde "quem
-- recebe o convite".
--
-- ─── `removed_at` e não DELETE ───────────────────────────────────────────
--
-- Tirar um convidado precisa REMOVÊ-LO do `attendees` no Google. Apagar a linha
-- apagaria também a memória de que aquele e-mail era gerenciado por nós, e o
-- próximo PATCH não saberia que pode tirá-lo (o `delta` só mexe em convidados
-- que reconhece). A linha fica com `removed_at` preenchido: sai da lista de
-- convites e continua na de gerenciados. Recolocar é `removed_at := null`.
--
-- ─── O que faz a mudança chegar ao Google ────────────────────────────────
--
-- O gatilho `fn_convidados_da_equipe_marcam_google` sobe `google_local_revision`
-- do compromisso. Sem ele, o cron de push não selecionaria a linha: a revisão é
-- o que diz "há mudança local que ainda não foi ao Google" (0225). O `changed`
-- do `fn_google_projection_stamp` não vê esta tabela — de propósito, porque os
-- convidados são montados no ENVIO (e o aceite/recusa deles no Google não é
-- conflito). Só a revisão é tocada: `google_next_attempt_at` e as colunas
-- privadas ficam intactas, então nenhuma guarda de metadata é exercitada.
--
-- Aditiva e idempotente: nenhuma migration antiga é reescrita.

-- ─── 1. O tipo de agendamento ─────────────────────────────────────────────
alter table public.calendar_event_types
  add column if not exists convidados_padrao uuid[] not null default '{}';

alter table public.calendar_event_types
  add column if not exists levar_dados_do_negocio boolean not null default true;

comment on column public.calendar_event_types.convidados_padrao is
  'Pessoas da equipe pré-marcadas em todo compromisso deste tipo (#4006, item 2). A tela pré-marca e a pessoa pode tirar; a IA, a automação e o MCP usam SÓ esta lista — nunca escolhem gente.';
comment on column public.calendar_event_types.levar_dados_do_negocio is
  'Leva negócio, etapa, produtos, cliente e telefone para a descrição do evento do Google (#4006, item 3). Ligado de fábrica: o cliente também é convidado quando a ficha tem e-mail, e todos os convidados veem a descrição — quem escreve coisa interna no nome do negócio desliga.';

-- ─── 2. A tabela ──────────────────────────────────────────────────────────
create table if not exists public.calendar_appointment_team_guests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  appointment_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  -- Preenchido = saiu do convite e continua gerenciado (ver cabeçalho).
  removed_at timestamptz,
  -- Um par (compromisso, pessoa) por linha: recolocar reusa a linha.
  constraint calendar_appointment_team_guests_unico unique (appointment_id, user_id),
  -- FKs COMPOSTAS: o compromisso e a pessoa têm de ser da MESMA organização
  -- desta linha. Sem elas, um id de outra empresa (adivinhado) entraria e o
  -- gatilho abaixo mexeria na revisão de um compromisso alheio.
  constraint calendar_appointment_team_guests_compromisso_fkey
    foreign key (organization_id, appointment_id)
    references public.calendar_appointments(organization_id, id) on delete cascade,
  constraint calendar_appointment_team_guests_membro_fkey
    foreign key (user_id, organization_id)
    references public.user_organizations(user_id, organization_id) on delete cascade
);

create index if not exists calendar_appointment_team_guests_compromisso_idx
  on public.calendar_appointment_team_guests(appointment_id)
  where removed_at is null;
create index if not exists calendar_appointment_team_guests_membro_idx
  on public.calendar_appointment_team_guests(organization_id, user_id);

comment on table public.calendar_appointment_team_guests is
  'Pessoas da equipe convidadas para um compromisso (#4006). O convidado NÃO vira dono: carteira, distribuição e métricas seguem do responsável.';
comment on column public.calendar_appointment_team_guests.removed_at is
  'Saiu do convite mas continua gerenciado: é o que permite ao sync REMOVER o e-mail do attendees no Google.';

-- ─── 3. RLS ───────────────────────────────────────────────────────────────
alter table public.calendar_appointment_team_guests enable row level security;

drop policy if exists calendar_team_guests_select on public.calendar_appointment_team_guests;
create policy calendar_team_guests_select on public.calendar_appointment_team_guests
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists calendar_team_guests_write on public.calendar_appointment_team_guests;
create policy calendar_team_guests_write on public.calendar_appointment_team_guests
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

revoke all on public.calendar_appointment_team_guests from anon;
grant select, insert, update, delete on public.calendar_appointment_team_guests to authenticated;
grant all on public.calendar_appointment_team_guests to service_role;

-- ─── 4. O convidado mudou: o compromisso vai de novo ao Google ────────────
create or replace function public.fn_convidados_da_equipe_marcam_google()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  alvo uuid;
  org uuid;
begin
  alvo := coalesce(new.appointment_id, old.appointment_id);
  org := coalesce(new.organization_id, old.organization_id);
  -- SÓ a revisão publicável: a diferença entre ela e `google_synced_local_revision`
  -- é o que o worker de push filtra (0225/0200). `google_next_attempt_at` fica
  -- como está — tocá-lo passaria pela guarda de metadata privada sem necessidade.
  update public.calendar_appointments
     set google_local_revision = google_local_revision + 1
   where id = alvo and organization_id = org;
  return coalesce(new, old);
end;
$$;
revoke all on function public.fn_convidados_da_equipe_marcam_google() from public, anon, authenticated;

drop trigger if exists trg_convidados_da_equipe_marcam_google on public.calendar_appointment_team_guests;
create trigger trg_convidados_da_equipe_marcam_google
  after insert or update or delete on public.calendar_appointment_team_guests
  for each row execute function public.fn_convidados_da_equipe_marcam_google();

notify pgrst, 'reload schema';
