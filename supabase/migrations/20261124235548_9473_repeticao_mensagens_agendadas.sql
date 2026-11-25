-- manifest: **Repetição das mensagens agendadas (segunda parte da #3118).** A linha de `mensagens_agendadas` passa a guardar a série (recorrência, intervalo, início, término e fuso); a tabela `mensagens_agendadas_envios` guarda o desfecho de cada ocorrência. O cron avança a série para a próxima ocorrência, e a leitura do histórico segue a mesma régua da conversa.
--
-- 9473 — REPETIÇÃO (segunda parte da #3118, issue #4431).
--
-- Uma linha de `mensagens_agendadas` continua sendo a SÉRIE: `scheduled_at` é a
-- próxima ocorrência. Quando o cron encaminha, falha ou cancela uma ocorrência,
-- grava a linha em `mensagens_agendadas_envios` e avança a série. Série sem
-- próxima ocorrência (passou do término) termina com o status final.
--
-- `recorrencia = 'nenhuma'` é o envio único da primeira parte: nada muda para ele.
--
-- LEITURA do histórico: a policy confere a conversa pela RLS dela, igual à da
-- linha da série. ESCRITA: só o servidor (service_role).
--
-- Reaplicável: `if not exists`, `drop ... if exists`.

alter table public.mensagens_agendadas
  add column if not exists recorrencia text not null default 'nenhuma',
  add column if not exists intervalo_dias integer,
  add column if not exists inicio_local text,
  add column if not exists termino_local text,
  add column if not exists tz text not null default 'UTC';

-- As três trocas de restrição vão num único bloco DO: ou todas entram, ou nenhuma
-- (o bloco é uma transação própria; se uma checagem falhar, o rollback volta tudo).
do $$
begin
  alter table public.mensagens_agendadas drop constraint if exists mensagens_agendadas_recorrencia_check;
  alter table public.mensagens_agendadas add constraint mensagens_agendadas_recorrencia_check
    check (recorrencia in ('nenhuma', 'diaria', 'semanal', 'quinzenal', 'mensal', 'trimestral', 'semestral', 'anual', 'a_cada_n_dias'));

  alter table public.mensagens_agendadas drop constraint if exists mensagens_agendadas_intervalo_check;
  alter table public.mensagens_agendadas add constraint mensagens_agendadas_intervalo_check
    check (
      (recorrencia = 'a_cada_n_dias' and intervalo_dias between 1 and 365)
      or (recorrencia <> 'a_cada_n_dias' and intervalo_dias is null)
    );

  alter table public.mensagens_agendadas drop constraint if exists mensagens_agendadas_serie_check;
  alter table public.mensagens_agendadas add constraint mensagens_agendadas_serie_check
    check (recorrencia = 'nenhuma' or (inicio_local is not null and length(btrim(tz)) > 0));
end
$$;

create table if not exists public.mensagens_agendadas_envios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agendamento_id uuid not null references public.mensagens_agendadas(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  prevista_para timestamptz not null,
  status text not null check (status in ('encaminhada', 'falhou', 'cancelada')),
  motivo text,
  message_id uuid references public.messages(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_mensagens_agendadas_envios_conversa
  on public.mensagens_agendadas_envios (conversation_id, prevista_para desc);
-- Uma linha por ocorrência: se um envio passar da trava e duas rodadas fecharem a
-- mesma ocorrência, a segunda gravação cai aqui (23505) em vez de duplicar o histórico.
create unique index if not exists uq_mensagens_agendadas_envios_ocorrencia
  on public.mensagens_agendadas_envios (agendamento_id, prevista_para);

alter table public.mensagens_agendadas_envios enable row level security;

drop policy if exists mensagens_agendadas_envios_select on public.mensagens_agendadas_envios;
create policy mensagens_agendadas_envios_select on public.mensagens_agendadas_envios
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
       where c.id = mensagens_agendadas_envios.conversation_id
         and c.organization_id = mensagens_agendadas_envios.organization_id
    )
  );

revoke all on public.mensagens_agendadas_envios from public, anon, authenticated;
grant select on public.mensagens_agendadas_envios to authenticated;
grant select, insert, update, delete on public.mensagens_agendadas_envios to service_role;
