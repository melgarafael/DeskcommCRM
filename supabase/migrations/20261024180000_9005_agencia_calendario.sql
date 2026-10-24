-- manifest: área da agência, fase 3 — reuniões da agência (Apresentação, Fechamento, Ativação…), participantes, convidados do cliente, lembretes uma vez por marco, Agenda Google na mesma conexão do Drive e o WhatsApp ao cliente; tabelas da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-calendario.md.
--
-- Mesmo regime das 9003/9004: sem organization_id (são da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy — toda
-- leitura e escrita passa pelo servidor depois do guarda de permissão.

-- ── Reuniões ──────────────────────────────────────────────────────────────
create table if not exists public.agencia_reunioes (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null,
  titulo           text not null,
  cliente_id       uuid references public.agencia_clientes(id) on delete set null,
  inicio           timestamptz not null,
  fim              timestamptz not null,
  formato          text not null default 'online',
  local            text,
  pauta            text,
  ata              text,
  situacao         text not null default 'marcada',
  avisar_cliente   boolean not null default true,
  google_event_id  text,
  google_link      text,
  google_erro      text,
  meet_url         text,
  gravacao_url     text,
  origem_id        uuid references public.agencia_reunioes(id) on delete set null,
  -- Quando o horário atual foi definido: lembrete de marco anterior a isto não dispara.
  horario_em       timestamptz not null default now(),
  criada_em        timestamptz not null default now(),
  atualizada_em    timestamptz not null default now(),
  criada_por       uuid references auth.users(id) on delete set null,
  constraint agencia_reunioes_tipo check (tipo in ('apresentacao','fechamento','ativacao','mensal','interna','outra')),
  constraint agencia_reunioes_formato check (formato in ('online','presencial','ligacao')),
  constraint agencia_reunioes_situacao check (situacao in ('marcada','realizada','remarcada','cancelada','nao_compareceu')),
  constraint agencia_reunioes_horario check (fim > inicio)
);
create index if not exists agencia_reunioes_inicio on public.agencia_reunioes (inicio);
create index if not exists agencia_reunioes_cliente on public.agencia_reunioes (cliente_id);

create table if not exists public.agencia_reunioes_membros (
  reuniao_id uuid not null references public.agencia_reunioes(id) on delete cascade,
  membro_id  uuid not null references public.agencia_membros(id) on delete cascade,
  primary key (reuniao_id, membro_id)
);
create index if not exists agencia_reunioes_membros_membro on public.agencia_reunioes_membros (membro_id);

create table if not exists public.agencia_reunioes_convidados (
  id         uuid primary key default gen_random_uuid(),
  reuniao_id uuid not null references public.agencia_reunioes(id) on delete cascade,
  nome       text not null,
  whatsapp   text,
  email      text,
  ordem      int not null default 0
);
create index if not exists agencia_reunioes_convidados_reuniao on public.agencia_reunioes_convidados (reuniao_id);

-- Cada marco de lembrete uma vez (K7). Remarcar apaga as linhas da reunião.
create table if not exists public.agencia_lembretes_de_reuniao (
  reuniao_id uuid not null references public.agencia_reunioes(id) on delete cascade,
  marco      text not null,
  avisado_em timestamptz not null default now(),
  primary key (reuniao_id, marco)
);

-- ── Configuração ──────────────────────────────────────────────────────────
alter table public.agencia_config add column if not exists reunioes_lembretes int[] not null default '{1440,60}';
alter table public.agencia_config drop constraint if exists agencia_config_lembretes;
alter table public.agencia_config add constraint agencia_config_lembretes
  check (reunioes_lembretes <@ array[10080,2880,1440,180,60,30,15]);

-- A conexão Google da agência guarda o que o Google concedeu, para saber se a Agenda veio junto.
alter table public.agencia_drive add column if not exists escopos text[] not null default '{}';

-- O WhatsApp da agência ganha o motivo `reuniao` (mensagem ao cliente).
alter table public.agencia_envios_whatsapp drop constraint if exists agencia_envios_motivo;
alter table public.agencia_envios_whatsapp add constraint agencia_envios_motivo
  check (motivo in ('convite', 'aviso', 'teste', 'reuniao'));

-- ── Acesso ────────────────────────────────────────────────────────────────
alter table public.agencia_reunioes              enable row level security;
alter table public.agencia_reunioes_membros      enable row level security;
alter table public.agencia_reunioes_convidados   enable row level security;
alter table public.agencia_lembretes_de_reuniao  enable row level security;

revoke all on table
  public.agencia_reunioes, public.agencia_reunioes_membros,
  public.agencia_reunioes_convidados, public.agencia_lembretes_de_reuniao
  from anon, authenticated;
