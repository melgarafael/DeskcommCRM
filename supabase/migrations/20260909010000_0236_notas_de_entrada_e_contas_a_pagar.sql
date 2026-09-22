-- ============================================================================
-- 0236 — NOTAS DE ENTRADA (NF-e emitida contra o CNPJ) + CONTAS A PAGAR
--
-- `fiscal_entradas`: uma linha por NF-e de fornecedor puxada da SEFAZ
-- (distribuição de DF-e, modelo 55). `chave` é a identidade: o mesmo XML
-- nunca vira duas linhas (unique por org), nem com duplo clique nem com
-- retry da sincronização. O XML completo só chega DEPOIS da manifestação
-- do destinatário (regra da SEFAZ, não nossa) — por isso `xml`/`itens_json`
-- nascem nulos e o status anda: nova → manifestada → importada (ou
-- ignorada, quando a nota não é da operação: desfazimento honesto).
--
-- `fiscal_entrada_cursor`: o `ultNSU` por organização. A próxima
-- sincronização continua daqui — sem ele, cada clique baixaria tudo de
-- novo e a SEFAZ bloquearia o CNPJ por consumo indevido (cStat 656).
--
-- `financial_pagaveis`: a conta a pagar por parcela da nota (espelho das
-- `financial_receivables` da 0233, sem pedido próprio). `contact_id` é
-- NULLABLE com snapshot (`fornecedor_nome/cnpj` na linha): criar contato
-- exige telefone e o fornecedor pode não ter — o financeiro não pode
-- depender disso. Sem duplicata na nota, nasce 1 parcela com vencimento
-- na emissão (à vista implícito).
--
-- RLS molde 0204/0233: leitura org; escrita das entradas+cursor agent+
-- (operacional); escrita do pagável manager+ (dinheiro é decisão
-- gerencial — mesmo piso das recebíveis).
-- ============================================================================

create table if not exists public.fiscal_entradas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chave text not null check (chave ~ '^\d{44}$'),
  nsu bigint not null,
  emitente_cnpj text not null,
  emitente_nome text not null,
  emitente_ie text,
  numero integer,
  serie text,
  dh_emi timestamptz,
  valor_total_cents bigint not null default 0 check (valor_total_cents >= 0),
  xml text,
  itens_json jsonb not null default '[]'::jsonb,
  cobranca_json jsonb not null default '[]'::jsonb,
  manifestacao text check (manifestacao in ('ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada')),
  manifestada_em timestamptz,
  status text not null default 'nova'
    check (status in ('nova', 'manifestada', 'importada', 'ignorada')),
  contact_id uuid references public.contacts(id) on delete set null,
  estoque_processado_em timestamptz,
  financeiro_processado_em timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A mesma chave nunca vira duas entradas, nem com duplo clique nem com
-- retry: a sincronização faz upsert por esta trava.
create unique index if not exists fiscal_entradas_org_chave_key
  on public.fiscal_entradas (organization_id, chave);

create index if not exists fiscal_entradas_status_idx
  on public.fiscal_entradas (organization_id, status);
create index if not exists fiscal_entradas_emissao_idx
  on public.fiscal_entradas (organization_id, dh_emi);

create table if not exists public.fiscal_entrada_cursor (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  ult_nsu bigint not null default 0,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.financial_pagaveis (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  entrada_id uuid references public.fiscal_entradas(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  fornecedor_nome text,
  fornecedor_cnpj text,
  parcela_n integer not null check (parcela_n > 0),
  total_parcelas integer not null check (total_parcelas > 0),
  valor_original_cents bigint not null check (valor_original_cents >= 0),
  vencimento date not null,
  status text not null default 'aberto'
    check (status in ('aberto', 'parcial', 'pago', 'cancelado')),
  forma_pagamento text,
  observacoes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotência da geração: a mesma (nota, parcela) nunca vira dois
-- pagáveis. Manual (entrada_id nulo) fica sem a trava, com auditoria.
create unique index if not exists financial_pagaveis_entrada_parcela_key
  on public.financial_pagaveis (organization_id, entrada_id, parcela_n)
  where entrada_id is not null;

create index if not exists financial_pagaveis_contato_idx
  on public.financial_pagaveis (organization_id, contact_id);
create index if not exists financial_pagaveis_vencimento_idx
  on public.financial_pagaveis (organization_id, vencimento);
create index if not exists financial_pagaveis_status_idx
  on public.financial_pagaveis (organization_id, status);
create index if not exists financial_pagaveis_entrada_idx
  on public.financial_pagaveis (organization_id, entrada_id);

alter table public.fiscal_entradas enable row level security;
alter table public.fiscal_entrada_cursor enable row level security;
alter table public.financial_pagaveis enable row level security;

drop policy if exists fiscal_entradas_select on public.fiscal_entradas;
create policy fiscal_entradas_select on public.fiscal_entradas
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists fiscal_entradas_write on public.fiscal_entradas;
create policy fiscal_entradas_write on public.fiscal_entradas
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists fiscal_entrada_cursor_select on public.fiscal_entrada_cursor;
create policy fiscal_entrada_cursor_select on public.fiscal_entrada_cursor
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists fiscal_entrada_cursor_write on public.fiscal_entrada_cursor;
create policy fiscal_entrada_cursor_write on public.fiscal_entrada_cursor
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'agent'))
  );

drop policy if exists financial_pagaveis_select on public.financial_pagaveis;
create policy financial_pagaveis_select on public.financial_pagaveis
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists financial_pagaveis_write on public.financial_pagaveis;
create policy financial_pagaveis_write on public.financial_pagaveis
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline
-- alcança TODA tabela criada depois dele — sem o revoke, os XMLs dos
-- fornecedores ficam legíveis pela anon key, que vai para o browser.
revoke all on public.fiscal_entradas from anon;
grant select, insert, update, delete on public.fiscal_entradas to authenticated;
grant all on public.fiscal_entradas to service_role;

revoke all on public.fiscal_entrada_cursor from anon;
grant select, insert, update, delete on public.fiscal_entrada_cursor to authenticated;
grant all on public.fiscal_entrada_cursor to service_role;

revoke all on public.financial_pagaveis from anon;
grant select, insert, update, delete on public.financial_pagaveis to authenticated;
grant all on public.financial_pagaveis to service_role;

drop trigger if exists trg_fiscal_entradas_updated_at on public.fiscal_entradas;
create trigger trg_fiscal_entradas_updated_at
  before update on public.fiscal_entradas
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_financial_pagaveis_updated_at on public.financial_pagaveis;
create trigger trg_financial_pagaveis_updated_at
  before update on public.financial_pagaveis
  for each row execute function public.fn_set_updated_at();

comment on table public.fiscal_entradas is
  'NF-e de entrada (fornecedor emitiu contra o CNPJ): resumo vira linha, XML completo só depois da manifestação. Chave única por org.';
comment on table public.fiscal_entrada_cursor is
  'Cursor da distribuição DF-e por org (ultNSU). Sem ele, cada sincronização baixaria tudo de novo.';
comment on table public.financial_pagaveis is
  'Conta a pagar por parcela da nota de entrada. Sem duplicata, 1 parcela com vencimento na emissão.';
