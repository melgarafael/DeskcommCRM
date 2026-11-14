-- manifest: **Mensagem de texto agendada para o contato, envio único (#3118, primeira parte; contribuição de @DIOGRO83).** Tabela nova `mensagens_agendadas`: o atendente escolhe texto, dia e hora na conversa, e o cron `api/v1/cron/mensagens-agendadas` encaminha ao envio no horário. A leitura segue a MESMA régua da conversa (a policy confere a linha em `conversations` pela sessão, então quem não enxerga a conversa não enxerga o agendamento). Anonimizar o contato apaga título e texto e cancela o que estava pendente (gatilho na virada de `is_anonymized`). Repetição e a visão de todos os clientes ficam para a segunda parte (doc 314 = A).
--
-- 9336 — MENSAGENS AGENDADAS, PRIMEIRA PARTE (issue #3118, PR #4131).
--
-- Uma linha = um envio. `status` diz onde ele está:
--   agendada    → espera o horário (`scheduled_at`);
--   encaminhada → o cron entregou ao envio; `message_id` aponta a mensagem, e é
--                 o `status` DELA que diz se saiu (a fila do canal não conta
--                 como enviada);
--   falhou      → o envio recusou; `motivo` leva o código, nunca o texto do erro;
--   cancelada   → alguém cancelou, o número estava fora do ar e quem agendou
--                 escolheu não esperar, quem agendou perdeu o acesso, ou o
--                 contato foi anonimizado.
-- `claimed_until` impede que duas rodadas do cron encaminhem o mesmo envio.
--
-- LEITURA: a policy exige a linha da conversa visível pela SESSÃO. A subconsulta
-- em `conversations` passa pela RLS dela, então valem as mesmas regras de
-- visibilidade (papel, `visibility_mode`, setor, participante, contato pessoal)
-- sem copiar nenhuma. ESCRITA: só o servidor (service_role); as rotas conferem a
-- conversa pela sessão antes de gravar.
--
-- LGPD: `fn_mensagens_agendadas_contato_anonimizado` roda na virada de
-- `is_anonymized` (a porta por onde os dois caminhos de anonimização passam),
-- troca o texto por '[redigido]', apaga o título e cancela o que ainda não saiu.
--
-- Reaplicável: `if not exists`, `create or replace`, `drop ... if exists`.

create table if not exists public.mensagens_agendadas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  title text,
  body text not null check (length(btrim(body)) > 0),
  scheduled_at timestamptz not null,
  status text not null default 'agendada'
    check (status in ('agendada', 'encaminhada', 'falhou', 'cancelada')),
  se_desconectado text not null default 'esperar'
    check (se_desconectado in ('esperar', 'cancelar')),
  motivo text,
  message_id uuid references public.messages(id) on delete set null,
  claimed_until timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mensagens_agendadas_org_contato
  on public.mensagens_agendadas (organization_id, contact_id, scheduled_at desc);
create index if not exists idx_mensagens_agendadas_devidas
  on public.mensagens_agendadas (scheduled_at) where status = 'agendada';

alter table public.mensagens_agendadas enable row level security;

drop policy if exists mensagens_agendadas_select on public.mensagens_agendadas;
create policy mensagens_agendadas_select on public.mensagens_agendadas
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.conversations c
       where c.id = mensagens_agendadas.conversation_id
         and c.organization_id = mensagens_agendadas.organization_id
    )
  );

revoke all on public.mensagens_agendadas from public, anon, authenticated;
grant select on public.mensagens_agendadas to authenticated;
grant select, insert, update, delete on public.mensagens_agendadas to service_role;

create or replace function public.fn_mensagens_agendadas_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  update public.mensagens_agendadas
     set body = '[redigido]',
         title = null,
         status = case when status = 'agendada' then 'cancelada' else status end,
         motivo = case when status = 'agendada' then 'contato_anonimizado' else motivo end,
         claimed_until = null,
         updated_at = now()
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end$$;

revoke all on function public.fn_mensagens_agendadas_contato_anonimizado() from public, anon, authenticated;

drop trigger if exists trg_contacts_anonimizado_mensagens_agendadas on public.contacts;
create trigger trg_contacts_anonimizado_mensagens_agendadas
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_mensagens_agendadas_contato_anonimizado();
