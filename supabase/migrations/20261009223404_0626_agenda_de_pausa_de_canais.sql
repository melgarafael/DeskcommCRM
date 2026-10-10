-- manifest: **Pausa AGENDADA de conexões com retomada automática (issue #2388).** Cria `channel_schedules` — a janela de manutenção (início, fim, um canal ou todos, estado `scheduled/running/done/cancelled` e a lista do que ela pausou) — e passa a gravar a ORIGEM da pausa em `channel_sessions.metadata` (`disabled_by`: `manual` × `schedule`, mais `disabled_schedule_id`): sem a origem, a retomada do fim da janela não distingue a pausa MANUAL feita durante a janela e a sobrescreveria (critério 3). A peça de escrita vira `fn_definir_pausa_de_canal(p_org, p_canal, p_desativado, p_origem, p_agenda)` e a RPC da tela `fn_definir_canal_desativado` mantém a MESMA assinatura de três argumentos e delega para ela com origem `manual` — nenhum chamador muda. Quem aplica é o cron `channel-pause-scheduler` (a cada minuto), pela mesma escrita de hoje: só a chave `disabled`, nada de transporte — a mensagem que chega durante a pausa continua sendo gravada e volta à inbox na retomada (lei do #2318). Idempotente; apêndice igual no `baseline.sql`.
-- 0626: agenda de pausa por conexão, com retomada automática e origem da pausa.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- A pausa só existe como ação manual imediata (0545): ou alguém acorda às 3h
-- para retomar, ou o número fica pausado até segunda ordem — a entrega é
-- gravada e some da inbox em silêncio. Existe hoje UMA chave (`disabled: true`)
-- e nenhuma agenda.
--
-- ─── Por que a ORIGEM da pausa é obrigatória, e não detalhe ─────────────────
--
-- Com uma chave só, "quem pausou?" não tem resposta: a retomada de fim de
-- janela desligaria também o canal que o operador pausou DURANTE a janela
-- (critério 3 da issue) e assumiria a posse de uma pausa manual já existente.
-- Daí as duas chaves novas, gravadas pela MESMA escrita atômica do `disabled`
-- (leitura-modificação-escrita perderia corrida contra a tela — a razão de a
-- 0545 existir): `disabled_by` diz quem pausou; `disabled_schedule_id` diz por
-- QUAL janela. Ausente ou nulo = pausa manual ou chave de banco anterior (sem
-- origem ninguém retoma às cegas).
--
-- ─── Por que a tela não muda de assinatura ──────────────────────────────────
--
-- `fn_definir_canal_desativado(uuid, uuid, boolean)` continua existindo com os
-- mesmos três argumentos e agora delega com origem `manual`: as rotas da
-- Central, o teste do #2318 e a ação em lote do #2387 seguem iguais. Só o cron
-- chama a peça nova, já com a origem explícita.

create table if not exists public.channel_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- `null` = TODOS os canais não arquivados da organização ("para todas").
  channel_session_id uuid references public.channel_sessions(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'running', 'done', 'cancelled')),
  -- O que ESTA agenda pausou: o registro da janela, lido pela retomada e pela tela.
  paused_channel_ids jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_schedules_janela_valida check (ends_at > starts_at)
);

create index if not exists channel_schedules_org_status_idx
  on public.channel_schedules (organization_id, status, starts_at);
-- O que o cron lê por rodada: só as duas situações vivas, pelo início.
create index if not exists channel_schedules_vivas_idx
  on public.channel_schedules (starts_at)
  where status in ('scheduled', 'running');

alter table public.channel_schedules enable row level security;
drop policy if exists tenant_isolation_channel_schedules_select on public.channel_schedules;
create policy tenant_isolation_channel_schedules_select on public.channel_schedules
  for select using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.channel_schedules from public, anon, authenticated;
grant select on public.channel_schedules to authenticated;
grant all on public.channel_schedules to service_role;

-- ─── A peça de escrita, com origem explícita ────────────────────────────────
--
-- Mesmo desenho da 0545: valida, `jsonb_set` com `create_missing=true` (troc só
-- as chaves da pausa, sem sobrescrever `ai_gate`, `ai_gate_mode` e cia.),
-- `where archived_at is null` (arquivado não se pausa, se exclui) e devolve as
-- linhas afetadas — 0 continua significando "canal não existe / arquivado na
-- corrida". `p_origem` é exigido, não default: quem chama declara, e a ambiguidade
-- de assinatura não existe.
create or replace function public.fn_definir_pausa_de_canal(
  p_org uuid,
  p_canal uuid,
  p_desativado boolean,
  p_origem text,
  p_agenda uuid
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_linhas integer;
begin
  if p_desativado is null then
    raise exception 'estado do canal inválido' using errcode = '22023';
  end if;
  if p_origem is distinct from 'manual' and p_origem is distinct from 'schedule' then
    raise exception 'origem de pausa inválida' using errcode = '22023';
  end if;

  update public.channel_sessions
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(
           coalesce(metadata, '{}'::jsonb),
           '{disabled}',
           to_jsonb(p_desativado),
           true
         ),
         -- Retomando, a origem some junto: quem está ligado não tem origem.
         '{disabled_by}',
         case when p_desativado then to_jsonb(p_origem) else 'null'::jsonb end,
         true
       ),
       '{disabled_schedule_id}',
       case
         when p_desativado and p_agenda is not null then to_jsonb(p_agenda)
         else 'null'::jsonb
       end,
       true
     )
   where organization_id = p_org
     and id = p_canal
     and archived_at is null;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

revoke execute on function public.fn_definir_pausa_de_canal(uuid, uuid, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_definir_pausa_de_canal(uuid, uuid, boolean, text, uuid)
  to service_role;

-- A RPC da tela: MESMA assinatura, MESMO efeito, origem `manual`. Delegar é o
-- que garante que a pausa manual continue gravando a origem correta sem que
-- nenhuma rota, teste ou chamador precise mudar (critério 8: o manual segue
-- exatamente como hoje).
create or replace function public.fn_definir_canal_desativado(
  p_org uuid,
  p_canal uuid,
  p_desativado boolean
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return public.fn_definir_pausa_de_canal(p_org, p_canal, p_desativado, 'manual', null);
end;
$$;
