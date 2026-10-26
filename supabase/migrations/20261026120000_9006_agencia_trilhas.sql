-- manifest: área da agência, fase 4 — trilha do cliente: modelos de etapas com dependências e regras de prazo, a cópia de cada cliente que vira tarefas e reuniões, avisos do relógio da trilha e o modelo "Cliente recorrente" pronto (Etapas 1 e 2); tabelas da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-trilhas.md.
--
-- Mesmo regime das 9003–9005: sem organization_id (são da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy.
--
-- `depende_de` é uma lista de CHAVES de passo do mesmo modelo (ou da mesma
-- trilha), não de ids: a chave é estável entre o modelo e a cópia, e o
-- desbloqueio compara chaves. A integridade (chave que existe, sem ciclo) é
-- conferida no servidor ao salvar o modelo (lib/agencia/trilhas/regras.ts).

-- ── Modelos ───────────────────────────────────────────────────────────────
create table if not exists public.agencia_trilha_modelos (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  tipo       text not null default 'recorrente',
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now(),
  constraint agencia_trilha_modelos_nome_unico unique (nome),
  constraint agencia_trilha_modelos_tipo check (tipo in ('recorrente','avulsa'))
);

create table if not exists public.agencia_trilha_modelo_passos (
  id           uuid primary key default gen_random_uuid(),
  modelo_id    uuid not null references public.agencia_trilha_modelos(id) on delete cascade,
  chave        text not null,
  etapa        int not null default 1,
  ordem        int not null default 0,
  titulo       text not null,
  descricao    text,
  tipo         text not null default 'tarefa',
  reuniao_tipo text,
  funcao_id    uuid references public.agencia_funcoes(id) on delete set null,
  depende_de   text[] not null default '{}',
  prazo_regra  text not null default 'manual',
  prazo_dias   int,
  prazo_ancora text,
  checklist    text[] not null default '{}',
  executor     text not null default 'humano',
  constraint agencia_trilha_modelo_passos_chave unique (modelo_id, chave),
  constraint agencia_trilha_modelo_passos_chave_formato check (chave ~ '^[a-z0-9_]{2,40}$'),
  constraint agencia_trilha_modelo_passos_tipo check (tipo in ('tarefa','reuniao','marco')),
  constraint agencia_trilha_modelo_passos_reuniao check (tipo <> 'reuniao' or reuniao_tipo in ('apresentacao','fechamento','ativacao','mensal','interna','outra')),
  constraint agencia_trilha_modelo_passos_regra check (prazo_regra in ('manual','apos_liberar','apos_ancora','fim_preparacao')),
  constraint agencia_trilha_modelo_passos_executor check (executor in ('humano','ia')),
  constraint agencia_trilha_modelo_passos_etapa check (etapa between 1 and 9)
);
create index if not exists agencia_trilha_modelo_passos_modelo on public.agencia_trilha_modelo_passos (modelo_id, etapa, ordem);

-- ── A trilha de cada cliente (cópia do modelo) ────────────────────────────
create table if not exists public.agencia_trilhas (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references public.agencia_clientes(id) on delete cascade,
  contratacao_id   uuid references public.agencia_contratacoes(id) on delete set null,
  modelo_id        uuid references public.agencia_trilha_modelos(id) on delete set null,
  modelo_nome      text not null,
  situacao         text not null default 'ativa',
  assinou_pagou_em date,
  contrato_inicio  date,
  contrato_fim     date,
  preparacao_fim   date,
  iniciada_em      timestamptz not null default now(),
  concluida_em     timestamptz,
  criada_por       uuid references auth.users(id) on delete set null,
  constraint agencia_trilhas_situacao check (situacao in ('ativa','concluida','cancelada'))
);
-- Uma trilha ATIVA por cliente: a tela da ficha mostra uma de cada vez.
create unique index if not exists agencia_trilhas_uma_ativa_por_cliente
  on public.agencia_trilhas (cliente_id) where situacao = 'ativa';

create table if not exists public.agencia_trilha_passos (
  id           uuid primary key default gen_random_uuid(),
  trilha_id    uuid not null references public.agencia_trilhas(id) on delete cascade,
  chave        text not null,
  etapa        int not null default 1,
  ordem        int not null default 0,
  titulo       text not null,
  descricao    text,
  tipo         text not null,
  reuniao_tipo text,
  funcao_id    uuid references public.agencia_funcoes(id) on delete set null,
  depende_de   text[] not null default '{}',
  prazo_regra  text not null default 'manual',
  prazo_dias   int,
  prazo_ancora text,
  checklist    text[] not null default '{}',
  executor     text not null default 'humano',
  situacao     text not null default 'bloqueado',
  prazo        timestamptz,
  tarefa_id    uuid references public.agencia_tarefas(id) on delete set null,
  reuniao_id   uuid references public.agencia_reunioes(id) on delete set null,
  liberado_em  timestamptz,
  concluido_em timestamptz,
  concluido_por uuid references auth.users(id) on delete set null,
  constraint agencia_trilha_passos_chave unique (trilha_id, chave),
  constraint agencia_trilha_passos_tipo check (tipo in ('tarefa','reuniao','marco')),
  constraint agencia_trilha_passos_situacao check (situacao in ('bloqueado','liberado','em_andamento','concluido','pulado'))
);
create index if not exists agencia_trilha_passos_tarefa on public.agencia_trilha_passos (tarefa_id) where tarefa_id is not null;
create index if not exists agencia_trilha_passos_reuniao on public.agencia_trilha_passos (reuniao_id) where reuniao_id is not null;
create index if not exists agencia_trilha_passos_abertos on public.agencia_trilha_passos (prazo) where situacao in ('liberado','em_andamento');

-- Cada aviso do relógio da trilha sai uma vez por passo e marco (R10).
create table if not exists public.agencia_avisos_de_trilha (
  passo_id   uuid not null references public.agencia_trilha_passos(id) on delete cascade,
  marco      text not null,
  avisado_em timestamptz not null default now(),
  primary key (passo_id, marco)
);

-- ── Acesso ────────────────────────────────────────────────────────────────
alter table public.agencia_trilha_modelos        enable row level security;
alter table public.agencia_trilha_modelo_passos  enable row level security;
alter table public.agencia_trilhas               enable row level security;
alter table public.agencia_trilha_passos         enable row level security;
alter table public.agencia_avisos_de_trilha      enable row level security;

revoke all on table
  public.agencia_trilha_modelos, public.agencia_trilha_modelo_passos, public.agencia_trilhas,
  public.agencia_trilha_passos, public.agencia_avisos_de_trilha
  from anon, authenticated;

-- ── O modelo que nasce pronto: "Cliente recorrente" (mapa › Etapas 1 e 2) ──
insert into public.agencia_trilha_modelos (nome, tipo) values ('Cliente recorrente', 'recorrente')
on conflict (nome) do nothing;

insert into public.agencia_trilha_modelo_passos
  (modelo_id, chave, etapa, ordem, titulo, descricao, tipo, reuniao_tipo, funcao_id, depende_de, prazo_regra, prazo_dias, prazo_ancora)
select m.id, p.chave, p.etapa, p.ordem, p.titulo, p.descricao, p.tipo, p.reuniao_tipo,
       (select f.id from public.agencia_funcoes f where f.nome = p.funcao), p.depende_de, p.prazo_regra, p.prazo_dias, p.prazo_ancora
from public.agencia_trilha_modelos m
cross join (values
  ('apresentacao',            1,  1, 'Reunião de Apresentação', 'Entender o comércio e o objetivo; gravar a reunião.', 'reuniao', 'apresentacao', null, '{}'::text[], 'manual', null, null),
  ('proposta',                1,  2, 'Preparar apresentação e proposta', 'Para levar ao Fechamento, com o contrato impresso e o link de pagamento.', 'tarefa', null, null, '{apresentacao}'::text[], 'apos_ancora', 6, 'apresentacao'),
  ('fechamento',              1,  3, 'Reunião de Fechamento', 'Uma semana depois da Apresentação.', 'reuniao', 'fechamento', null, '{apresentacao}'::text[], 'apos_ancora', 7, 'apresentacao'),
  ('assinou_pagou',           1,  4, 'Contrato assinado e pago', 'A proposta vale 5 dias depois do Fechamento. Só conta com as duas coisas.', 'marco', null, null, '{fechamento}'::text[], 'apos_ancora', 5, 'fechamento'),
  ('grupo_formulario',        1,  5, 'Criar o grupo no WhatsApp e enviar o formulário de acesso', 'Grupo "Em Movimento - <Empresa>" com o cliente e a equipe.', 'tarefa', null, null, '{assinou_pagou}'::text[], 'apos_liberar', 1, null),
  ('roteiros_ativacao',       1,  6, 'Roteiros prontos para aprovar na Ativação', null, 'tarefa', null, 'Roteirista', '{assinou_pagou}'::text[], 'apos_ancora', 6, 'assinou_pagou'),
  ('ativacao',                1,  7, 'Reunião de Ativação', 'Roteiros para aprovar, acessos das redes ao vivo, explicar as gravações, revisar estratégia e datas.', 'reuniao', 'ativacao', null, '{assinou_pagou}'::text[], 'apos_ancora', 7, 'assinou_pagou'),
  ('identidade_visual',       2,  1, 'Identidade visual padronizada', null, 'tarefa', null, 'Designer', '{assinou_pagou}'::text[], 'apos_liberar', 7, null),
  ('acesso_crm',              2,  2, 'Acesso ao CRM para o cliente', null, 'tarefa', null, 'Programador', '{assinou_pagou}'::text[], 'apos_liberar', 7, null),
  ('roteiros',                2,  3, 'Roteiros do mês', 'Quantidades da contratação.', 'tarefa', null, 'Roteirista', '{ativacao}'::text[], 'apos_liberar', 3, null),
  ('storyboards',             2,  4, 'Storyboards', null, 'tarefa', null, 'Videomaker', '{roteiros}'::text[], 'apos_liberar', 3, null),
  ('captacao',                2,  5, 'Primeira captação (vídeos e fotos)', null, 'tarefa', null, 'Videomaker', '{storyboards}'::text[], 'apos_liberar', 5, null),
  ('subir_material',          2,  6, 'Subir o material para o Drive', 'Subpasta 05 Captações.', 'tarefa', null, 'Videomaker', '{captacao}'::text[], 'apos_liberar', 1, null),
  ('edicao_videos',           2,  7, 'Edição dos vídeos', 'Subpasta 06 Edições.', 'tarefa', null, 'Editor', '{subir_material}'::text[], 'fim_preparacao', null, null),
  ('tratamento_fotos',        2,  8, 'Tratamento das fotos', null, 'tarefa', null, 'Designer', '{subir_material}'::text[], 'fim_preparacao', null, null),
  ('artes',                   2,  9, 'Artes', 'Subpasta 07 Artes.', 'tarefa', null, 'Designer', '{identidade_visual}'::text[], 'fim_preparacao', null, null),
  ('atualizacao_redes',       2, 10, 'Atualização geral das redes', 'Instagram, Facebook, Google, YouTube e TikTok: identidade visual, informações.', 'tarefa', null, 'Social media', '{identidade_visual,subir_material}'::text[], 'fim_preparacao', null, null),
  ('arvore_links',            2, 11, 'Árvore de links', null, 'tarefa', null, 'Social media', '{identidade_visual}'::text[], 'fim_preparacao', null, null),
  ('campanha_reconhecimento', 2, 12, 'Campanha de reconhecimento de marca (Meta Ads e Google Ads)', null, 'tarefa', null, 'Gestor de tráfego', '{edicao_videos,artes}'::text[], 'fim_preparacao', null, null),
  ('campanha_conversao',      2, 13, 'Campanha de conversão (Meta Ads e Google Ads)', null, 'tarefa', null, 'Gestor de tráfego', '{edicao_videos,artes}'::text[], 'fim_preparacao', null, null)
) as p(chave, etapa, ordem, titulo, descricao, tipo, reuniao_tipo, funcao, depende_de, prazo_regra, prazo_dias, prazo_ancora)
where m.nome = 'Cliente recorrente'
on conflict (modelo_id, chave) do nothing;
