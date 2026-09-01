-- 0162 — INTEGRAÇÃO DE PAGAMENTO (PaySuite: M-Pesa, e-Mola, cartão).
--
-- Duas tabelas, propósitos diferentes, tratamento de acesso diferente:
--
-- `payment_credentials` guarda SÓ segredo (token de API cifrado, segredo de
-- webhook cifrado) — não tem nenhum dado que a tela precise ler direto pelo
-- PostgREST, porque a rota (service role) é quem decifra e quem monta
-- qualquer resposta sanitizada para a tela de configuração. Segue o molde de
-- `platform_branding` (0155): RLS ligada com ZERO policies + `revoke all ...
-- from anon, authenticated` — a forma explícita de dizer que o PostgREST não
-- serve a tabela nenhuma. Não o molde de `tenant_integrations` (mais antiga,
-- pré-datando essa doutrina): aquela ainda tem `GRANT ALL ... TO anon` do
-- dump original e uma policy de SELECT aberta a qualquer membro da
-- organização — não é o padrão a copiar para uma tabela nova que segura
-- segredo de pagamento.
--
-- `payments` é o LOG de transação (valor, status, referência) — isso a tela
-- do lead precisa mostrar (histórico de cobrança), então tem policy de
-- SELECT escopada por organização. Mas ESCRITA só pela rota: a criação de
-- cobrança e a confirmação por webhook rodam com service role, então
-- `revoke insert, update, delete ... from anon, authenticated` — o mesmo
-- desenho da 0160 (`ai_budgets_so_escreve_pela_rota`), só que aqui a tabela
-- NASCE assim, em vez de precisar de uma migration corretiva depois.
--
-- `provider` fixo em 'paysuite' hoje (CHECK de valor único, não lista) —
-- é o único agregador de pagamento moçambicano com API pública que a
-- pesquisa achou; M-Pesa/e-Mola direto ficaram de fora de propósito (e-Mola
-- não tem portal de desenvolvedor público, M-Pesa exige certificação
-- própria). Se um segundo provider entrar, o CHECK vira lista — é
-- alargamento, não precisa de backfill.
--
-- `reference` é a chave de idempotência do NOSSO lado: PaySuite recusa (ou
-- deveria recusar) duas cobranças com a mesma referência, e o UNIQUE local
-- garante que um duplo-clique no botão "Cobrar" não grava duas linhas antes
-- mesmo de chegar ao PaySuite. `provider_payment_id` é o UNIQUE do OUTRO
-- lado: o webhook de confirmação chega por HTTP, que reentrega em caso de
-- timeout — sem o UNIQUE, uma reentrega gravaria dois "pagamento confirmado"
-- para a mesma transação.
--
-- `amount_cents`/`currency` e não um FK só para `crm_leads.value_cents`:
-- o valor cobrado no momento da cobrança pode divergir do valor atual do
-- lead (alguém editou o negócio depois de gerar o link) — o pagamento
-- precisa registrar o que foi COBRADO, não uma referência que muda de
-- significado se o lead mudar depois.

create table if not exists public.payment_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'paysuite' check (provider = 'paysuite'),
  api_token_encrypted bytea not null,
  webhook_secret_encrypted bytea not null,
  webhook_path_token text not null default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'connecting' check (status in ('connecting', 'healthy', 'error')),
  status_reason text,
  last_health_check_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (organization_id, provider)
);

create unique index if not exists payment_credentials_webhook_path_token_idx
  on public.payment_credentials using btree (webhook_path_token);

alter table public.payment_credentials enable row level security;
revoke all on public.payment_credentials from anon, authenticated;
grant select, insert, update on public.payment_credentials to service_role;

create or replace trigger trg_payment_credentials_updated_at
  before update on public.payment_credentials
  for each row execute function public.fn_set_updated_at();


create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.crm_leads(id) on delete set null,
  provider text not null default 'paysuite' check (provider = 'paysuite'),
  provider_payment_id text not null,
  reference text not null,
  method text check (method in ('mpesa', 'emola', 'credit_card')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'MZN' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  checkout_url text,
  raw_webhook_payload jsonb,
  created_by_user_id uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (organization_id, reference),
  unique (organization_id, provider_payment_id)
);

create index if not exists payments_org_idx on public.payments using btree (organization_id);
create index if not exists payments_lead_idx on public.payments using btree (lead_id) where lead_id is not null;

alter table public.payments enable row level security;
revoke insert, update, delete on public.payments from anon, authenticated;

create policy payments_select on public.payments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

create or replace trigger trg_payments_updated_at
  before update on public.payments
  for each row execute function public.fn_set_updated_at();
