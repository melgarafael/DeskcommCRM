-- manifest: área da agência, fase 6 — modelos de contrato com campos, contratos gerados (texto final guardado, valor em centavos, validade da proposta), assinatura pela ZapSign e pagamento pela InfinitePay (opcionais, com token cifrado e segredo dos webhooks); tabelas da instalação, só o servidor lê e escreve
--
-- Spec: docs/agencia/SPEC-contratos.md.
--
-- Mesmo regime das 9003–9007: sem organization_id (são da INSTALAÇÃO), RLS
-- ligada, `revoke all` explícito de anon/authenticated e nenhuma policy.

create table if not exists public.agencia_contrato_modelos (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  corpo         text not null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint agencia_contrato_modelos_nome unique (nome)
);

create table if not exists public.agencia_contratos (
  id                  uuid primary key default gen_random_uuid(),
  cliente_id          uuid not null references public.agencia_clientes(id) on delete cascade,
  contratacao_id      uuid references public.agencia_contratacoes(id) on delete set null,
  modelo_id           uuid references public.agencia_contrato_modelos(id) on delete set null,
  modelo_nome         text not null,
  titulo              text not null,
  texto               text not null,
  valor_mensal_cents  bigint not null default 0,
  moeda               text not null default 'BRL',
  forma_pagamento     text,
  dia_vencimento      int,
  prazo_meses         int not null default 3,
  fechamento_em       date not null default current_date,
  valido_ate          date not null,
  situacao            text not null default 'rascunho',
  assinado_em         timestamptz,
  pago_em             timestamptz,
  concluido_em        timestamptz,
  zapsign_doc_token   text,
  zapsign_link        text,
  zapsign_situacao    text,
  pagamento_link      text,
  pagamento_order_nsu text,
  pagamento_slug      text,
  pagamento_recibo    text,
  drive_file_id       text,
  grupo_chat_id       text,
  criado_por          uuid references auth.users(id) on delete set null,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  constraint agencia_contratos_situacao check (situacao in ('rascunho','enviado','concluido','recusado','cancelado')),
  constraint agencia_contratos_valor check (valor_mensal_cents >= 0),
  constraint agencia_contratos_vencimento check (dia_vencimento is null or dia_vencimento between 1 and 31),
  constraint agencia_contratos_prazo check (prazo_meses between 1 and 120),
  constraint agencia_contratos_moeda check (moeda ~ '^[A-Z]{3}$')
);
create index if not exists agencia_contratos_cliente on public.agencia_contratos (cliente_id, criado_em desc);
create unique index if not exists agencia_contratos_zapsign on public.agencia_contratos (zapsign_doc_token) where zapsign_doc_token is not null;
create unique index if not exists agencia_contratos_order_nsu on public.agencia_contratos (pagamento_order_nsu) where pagamento_order_nsu is not null;

-- As integrações (K3): token da ZapSign e segredo dos webhooks cifrados (lib/crypto/aes_gcm.ts).
alter table public.agencia_config add column if not exists zapsign_token_ct   bytea;
alter table public.agencia_config add column if not exists zapsign_token_iv   bytea;
alter table public.agencia_config add column if not exists zapsign_token_tag  bytea;
alter table public.agencia_config add column if not exists zapsign_sandbox    boolean not null default false;
alter table public.agencia_config add column if not exists infinitepay_handle text;
alter table public.agencia_config add column if not exists webhook_segredo_ct  bytea;
alter table public.agencia_config add column if not exists webhook_segredo_iv  bytea;
alter table public.agencia_config add column if not exists webhook_segredo_tag bytea;

alter table public.agencia_contrato_modelos enable row level security;
alter table public.agencia_contratos        enable row level security;

revoke all on table public.agencia_contrato_modelos, public.agencia_contratos from anon, authenticated;

-- O modelo inicial (K1): um ponto de partida, para ser trocado pelo texto que a agência usa.
insert into public.agencia_contrato_modelos (nome, corpo) values (
  'Prestação de serviços de marketing (modelo inicial)',
  $modelo$CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE MARKETING DIGITAL

CONTRATANTE: {{cliente.razao_social}}, inscrita no CNPJ sob o nº {{cliente.cnpj}}, com sede em {{cliente.endereco}}, neste ato representada por {{cliente.responsavel}}.

CONTRATADA: {{agencia.nome}}.

CLÁUSULA 1 — DO OBJETO
A CONTRATADA prestará à CONTRATANTE os seguintes serviços: {{contratacao.servicos}}.
Quantidades mensais: {{contratacao.quantidades}}.

CLÁUSULA 2 — DO PRAZO
O contrato tem prazo mínimo de {{contrato.prazo_meses}} meses, contados a partir do dia 1 do mês em que se inicia a prestação, conforme a data de assinatura e pagamento.

CLÁUSULA 3 — DO VALOR E DO PAGAMENTO
Pelos serviços, a CONTRATANTE pagará {{contrato.valor_mensal}} por mês, por {{contrato.forma_pagamento}}, com vencimento todo dia {{contrato.dia_vencimento}}.

CLÁUSULA 4 — DA VALIDADE DA PROPOSTA
Esta proposta é válida até {{contrato.validade}}. O início dos trabalhos depende da assinatura deste contrato e do pagamento da primeira parcela.

CLÁUSULA 5 — DOS ACESSOS
A CONTRATANTE fornecerá os acessos corporativos às contas necessárias, que serão guardados de forma cifrada e devolvidos organizados em relatório.

{{cliente.cidade}}, {{contrato.data}}.$modelo$
) on conflict (nome) do nothing;
