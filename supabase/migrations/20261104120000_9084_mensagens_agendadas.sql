-- manifest: mensagens agendadas de texto para um contato — série com recorrência, trava anti-duplicado e relatório de envios.
--
-- 9084 — `mensagens_agendadas` guarda a série (texto, contato, número, recorrência e
-- ocorrência corrente em `scheduled_at`). `mensagens_agendadas_envios` guarda o
-- desfecho de cada ocorrência, para o relatório e para conferir o que saiu de fato.
-- O cron `api/v1/cron/mensagens-agendadas` envia; `claimed_until` impede que duas
-- execuções enviem a mesma ocorrência.
--
-- Escrita só pelo servidor (service role). Os papéis do PostgREST leem apenas a
-- própria organização. Apêndice idêntico no fim de `supabase/baseline.sql`.

create table if not exists mensagens_agendadas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  channel_session_id uuid not null references channel_sessions(id) on delete cascade,
  title text,
  body text not null check (length(btrim(body)) > 0),
  recorrencia text not null default 'nenhuma' check (
    recorrencia in ('nenhuma', 'diaria', 'semanal', 'quinzenal', 'mensal', 'trimestral', 'semestral', 'anual', 'a_cada_n_dias')
  ),
  intervalo_dias int check (intervalo_dias is null or (intervalo_dias between 1 and 365)),
  check (recorrencia <> 'a_cada_n_dias' or intervalo_dias is not null),
  inicio_local text not null,
  termino_local text,
  tz text not null default 'UTC',
  scheduled_at timestamptz not null,
  status text not null default 'agendada' check (status in ('agendada', 'concluida', 'cancelada')),
  -- "esperar": número fora do ar mantém a ocorrência. "cancelar": pula a ocorrência e segue a série.
  se_desconectado text not null default 'esperar' check (se_desconectado in ('esperar', 'cancelar')),
  claimed_until timestamptz,
  ultimo_envio_em timestamptz,
  ultimo_erro text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mensagens_agendadas_org_contato
  on mensagens_agendadas (organization_id, contact_id);
create index if not exists idx_mensagens_agendadas_devidas
  on mensagens_agendadas (scheduled_at) where status = 'agendada';

create table if not exists mensagens_agendadas_envios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  agendamento_id uuid not null references mensagens_agendadas(id) on delete cascade,
  prevista_para timestamptz not null,
  desfecho text not null check (desfecho in ('enviada', 'falhou', 'pulada_desconectado')),
  message_id uuid,
  erro text,
  created_at timestamptz not null default now()
);

create index if not exists idx_mensagens_agendadas_envios_agendamento
  on mensagens_agendadas_envios (agendamento_id, created_at desc);

alter table mensagens_agendadas enable row level security;
alter table mensagens_agendadas_envios enable row level security;

drop policy if exists "mensagens_agendadas_select" on mensagens_agendadas;
create policy "mensagens_agendadas_select" on mensagens_agendadas
  for select using (organization_id in (select fn_user_org_ids()));

drop policy if exists "mensagens_agendadas_envios_select" on mensagens_agendadas_envios;
create policy "mensagens_agendadas_envios_select" on mensagens_agendadas_envios
  for select using (organization_id in (select fn_user_org_ids()));

revoke all on mensagens_agendadas from public, anon;
revoke all on mensagens_agendadas_envios from public, anon;
revoke insert, update, delete on mensagens_agendadas from authenticated;
revoke insert, update, delete on mensagens_agendadas_envios from authenticated;
grant select on mensagens_agendadas to authenticated;
grant select on mensagens_agendadas_envios to authenticated;
grant select, insert, update, delete on mensagens_agendadas to service_role;
grant select, insert, update, delete on mensagens_agendadas_envios to service_role;
