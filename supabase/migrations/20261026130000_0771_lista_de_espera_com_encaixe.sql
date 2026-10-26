-- manifest: Lista de espera com encaixe (#3414) — `calendar_waitlist` guarda o "quero encaixe" (serviço, profissional, janelas, antecedência, validade, urgência e ordem de chegada) que hoje vive no caderno da recepção; `source` do compromisso ganha `waitlist`, para a vaga segurada dizer de onde nasceu. Nenhuma instalação muda sozinha: tabela nova sem leitor antigo e sem backfill.
--
-- 0771 — a lista de espera, e o encaixe em fila.
--
-- ─── O defeito ─────────────────────────────────────────────────────────────
--
-- Toda desmarcação abre um horário, e o "se abrir um encaixe, eu quero" de quem
-- pediu antes não existe em lugar nenhum do produto: fica no caderno ou na
-- memória de quem atende. Resultado medido em clínica, salão e estúdio: horário
-- vago que ninguém ocupa, e o cliente que queria vir sem saber que abriu.
--
-- O CRM já tem o resto. Eventos de `appointment.cancelled`, `crm_find_free_slots`,
-- `crm_book_appointment`, e — o mais importante — o pedido que fica `pending`,
-- OCUPA o horário e SOLTA sozinho no prazo (`pending_expires_after_minutes`,
-- rota `agenda-expira-pendentes`). O que faltava é a MARCA: esta pessoa quer
-- encaixe.
--
-- ─── O que entra, e por que cada coluna é coluna ───────────────────────────
--
--   · `event_type_id` — o serviço. A DURAÇÃO vem do molde
--     (`calendar_event_types.duration_minutes`), nunca do que a pessoa disse:
--     encaixe de 30 min num buraco de 20 min é a agenda prometendo o que não
--     cabe.
--   · `owner_user_id` — profissional pedido. NULL = qualquer um que atenda, que
--     é o caso mais comum e o que a recepção faz à mão.
--   · `janelas` — as faixas que servem ("seg–sex de manhã"), no MESMO formato do
--     `schedule` do roteamento (`{dow, start, end}`, dow 0 = domingo). Reusar o
--     formato evita um terceiro vocabulário de janela neste repo. Lista VAZIA =
--     qualquer horário: aqui a régua é a da lista de espera, não a da jornada
--     (`horarios-livres.ts`), porque quem não restringiu não pode ser excluído.
--   · `antecedencia_minima_horas` — "só consigo com 2 dias". Soma por MAIOR com o
--     `minimum_notice_minutes` do serviço, nunca por menor.
--   · `valido_ate` — "até sexta". NULL = sem prazo.
--   · `urgencia` — a fila é por urgência e, no empate, por ordem de chegada
--     (`created_at`). Sem esta coluna, a lista só saberia chegar primeiro.
--   · `status` + `oferta_*` — a vaga segurada. `offered` carrega o compromisso
--     `pending` e o prazo; a coerência dos dois é CHECK, não disciplina de código.
--
-- ─── Por que a oferta é um compromisso `pending` e não um estado paralelo ───
--
-- Porque `pending` já faz as três coisas que a oferta precisa: ocupa o horário
-- (some da lista de livres), recusa uma segunda marcação no mesmo instante e
-- tem prazo que solta sozinho. Um segundo mecanismo de reserva divergiria do
-- primeiro no primeiro conserto, e o sintoma seria o agente oferecendo horário
-- que a tela mostra ocupado. Por isso esta migration NÃO cria tabela de oferta:
-- cria a fila, e a oferta usa o compromisso que já existe.
--
-- ─── Uma inscrição viva por contato e serviço ─────────────────────────────
--
-- Índice único PARCIAL em (`waiting`, `offered`): pedir duas vezes o mesmo
-- encaixe não duplica a pessoa na fila, e o segundo pedido volta como "já
-- estava" em vez de erro. Fora desses dois estados a pessoa pode se inscrever de
-- novo — quem foi atendida semana passada quer poder pedir de novo.
--
-- ─── Reaplicação ──────────────────────────────────────────────────────────
--
-- `create table if not exists`, `create index if not exists`, `drop policy if
-- exists` antes de cada policy, e o `check` de `source` trocado dentro de um
-- bloco `do` com `to_regclass` (o `update.sh` roda o baseline sem
-- ON_ERROR_STOP: `drop` e `add` soltos deixariam a constraint sem guarda se o
-- `add` falhasse). Sem backfill e sem linha nova no MANIFEST — a descrição mora
-- no cabeçalho acima.

-- ─── 1 · a fila ────────────────────────────────────────────────────────────
create table if not exists public.calendar_waitlist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Quem espera e por quê. `cascade` nos três: apagar o contato ou o molde apaga
  -- a inscrição, porque uma inscrição sem serviço não é fila — é lixo que
  -- ninguém consegue atender.
  contact_id uuid not null references public.contacts(id) on delete cascade,
  event_type_id uuid not null references public.calendar_event_types(id) on delete cascade,

  -- O profissional pedido. `set null` = "qualquer um": perder o vínculo com a
  -- pessoa não pode tirar o pedido do cliente da fila.
  owner_user_id uuid references auth.users(id) on delete set null,

  -- `{dow: 0..6, start: "HH:MM", end: "HH:MM"}`. Vazio = qualquer horário.
  janelas jsonb not null default '[]'::jsonb,
  antecedencia_minima_horas smallint not null default 0,
  valido_ate timestamptz,
  urgencia smallint not null default 0,

  status text not null default 'waiting',

  -- A vaga segurada. Quando o prazo vence sem resposta, o compromisso é
  -- desmarcado e a inscrição volta para `waiting` — quem sai da fila é
  -- `valido_ate`, não o silêncio de uma oferta.
  oferta_appointment_id uuid references public.calendar_appointments(id) on delete set null,
  oferta_expira_em timestamptz,
  ofertada_em timestamptz,

  observacoes text,

  -- A autoria segue o vocabulário de `calendar_appointments.created_by_kind`
  -- (menos `sync`, que é o espelho do Google e não inscreve ninguém).
  created_by_kind text not null default 'user',
  created_by_user_id uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint calendar_waitlist_status_check check (status in (
    'waiting','offered','booked','expired','cancelled'
  )),
  constraint calendar_waitlist_created_by_kind_check check (created_by_kind in (
    'user','ai','system','contact'
  )),
  -- jsonb é dado solto: a forma mínima é do banco, o conteúdo é da aplicação.
  constraint calendar_waitlist_janelas_e_lista check (jsonb_typeof(janelas) = 'array'),
  constraint calendar_waitlist_antecedencia_sensata
    check (antecedencia_minima_horas between 0 and 720),
  constraint calendar_waitlist_urgencia_sensata check (urgencia between -5 and 5),
  -- Regra de negócio em constraint SEPARADA da de vocabulário, como no
  -- compromisso: duas constraints casando `status in (...)` na mesma coluna
  -- fazem o extrator do invariante de vocabulário se recusar a escolher.
  constraint calendar_waitlist_oferta_coerente check (
    (status <> 'offered')
    or (oferta_appointment_id is not null and oferta_expira_em is not null)
  )
);

-- A fila é lida por organização e status, na ORDEM da chamada (urgência desc,
-- chegada asc): o índice entrega pronta a ordem que a decisão usa.
create index if not exists calendar_waitlist_fila_idx
  on public.calendar_waitlist (organization_id, urgencia desc, created_at)
  where status = 'waiting';

-- Uma inscrição VIVA por contato e serviço. Parcial nos dois estados porque
-- `booked`, `expired` e `cancelled` são história — e história pode repetir.
create unique index if not exists calendar_waitlist_viva_por_contato_servico_idx
  on public.calendar_waitlist (organization_id, contact_id, event_type_id)
  where status in ('waiting', 'offered');

-- A varredura de prazo: "quais ofertas venceram".
create index if not exists calendar_waitlist_ofertas_a_vencer_idx
  on public.calendar_waitlist (oferta_expira_em)
  where status = 'offered';

-- A pergunta que o cancelamento faz — "este compromisso era a vaga segurada de
-- alguém?" — precisa achar a linha pelo compromisso.
create index if not exists calendar_waitlist_oferta_appointment_idx
  on public.calendar_waitlist (oferta_appointment_id)
  where oferta_appointment_id is not null;

comment on table public.calendar_waitlist is
  'O "quero encaixe" de um contato por serviço: janelas que servem, antecedência mínima, validade, urgência e a vaga segurada quando uma abre. Distinto de calendar_appointments, que é o horário COMBINADO — a linha daqui é a intenção, e vira compromisso `pending` quando a vaga é oferecida.';
comment on column public.calendar_waitlist.janelas is
  'Faixas que servem, no formato do schedule do roteamento ({dow: 0=domingo..6=sábado, start: "HH:MM", end: "HH:MM"}). Lista vazia = qualquer horário. O atendimento INTEIRO tem de caber na faixa: 11:30 num serviço de 60 min não cabe em 09:00–12:00.';
comment on column public.calendar_waitlist.antecedencia_minima_horas is
  'Antecedência mínima da pessoa para aceitar um encaixe, em horas (0 = serve hoje). Soma por MAIOR com calendar_event_types.minimum_notice_minutes — quem precisa de 48h não é chamado para daqui a 3h.';
comment on column public.calendar_waitlist.valido_ate is
  'Até quando a inscrição vale. NULL = sem prazo. É o que tira alguém da fila; uma oferta sem resposta NÃO tira — a pessoa volta para waiting.';
comment on column public.calendar_waitlist.urgencia is
  'Desempate da fila, maior primeiro (a ordem de chegada desempata depois). Negativo para quem pode esperar.';
comment on column public.calendar_waitlist.oferta_appointment_id is
  'O compromisso `pending` que SEGURA a vaga oferecida a esta pessoa. `pending` porque é o estado que já ocupa o horário e já tem prazo que solta sozinho. NULL fora de `offered`.';
comment on column public.calendar_waitlist.oferta_expira_em is
  'Prazo da oferta. Vencido, o compromisso é desmarcado e a vaga passa para o próximo da fila. Obrigatório em `offered` (CHECK), porque oferta sem prazo é horário preso.';

-- ─── 2 · a vaga segurada diz de onde nasceu ───────────────────────────────
-- `source` do compromisso passa a aceitar `waitlist`. A coluna é a ORIGEM da
-- linha — quem a criou —, e uma vaga segurada nasce do produto (o encaixe), não
-- de uma pessoa clicando (`ui`), de uma ferramenta (`mcp`) nem do Google
-- (`google_sync`). Gravar `ui` aqui faria a timeline e o aviso dizerem que
-- alguém marcou, quando ninguém marcou.
do $$
begin
  if to_regclass('public.calendar_appointments') is null then
    return;
  end if;
  alter table public.calendar_appointments
    drop constraint if exists calendar_appointments_source_check;
  alter table public.calendar_appointments
    add constraint calendar_appointments_source_check check (source in (
      'ui','mcp','google_sync','public_page','waitlist'
    ));
end
$$;

-- ─── 3 · RLS: a fila é da organização, como a agenda ──────────────────────
alter table public.calendar_waitlist enable row level security;
drop policy if exists tenant_isolation_calendar_waitlist_all on public.calendar_waitlist;
drop policy if exists calendar_waitlist_select on public.calendar_waitlist;
create policy calendar_waitlist_select on public.calendar_waitlist
  for select using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids()))
  );
drop policy if exists calendar_waitlist_write on public.calendar_waitlist;
create policy calendar_waitlist_write on public.calendar_waitlist
  using (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin_full()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );
revoke all on public.calendar_waitlist from anon;

notify pgrst, 'reload schema';
