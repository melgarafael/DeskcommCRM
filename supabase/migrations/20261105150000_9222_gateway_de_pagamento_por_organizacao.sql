-- manifest: **A organização passa a escolher o gateway de pagamento dela (#4058, fatia 1).** Hoje o provedor de cobrança é da INSTALAÇÃO (`platform_config` + `lib/cobranca/configuracao.ts`) e serve para o revendedor cobrar as empresas; não existe nada que deixe a empresa cobrar o cliente dela. Esta fatia cria `organization_payment_gateways` (uma linha por organização, chave primária `organization_id`): provedor (`stripe`/`asaas`), modo derivado da chave, credencial e segredo de webhook cifrados com AES-256-GCM (`AI_CRED_AES_KEY`, mesmo envelope de `voip_trunk_settings`/`external_db_connections`, só `last4` exposto) e `is_active` para desligar sem apagar. A ausência de linha — ou `is_active = false` — HERDA a configuração da instalação; a herança mora no resolvedor (`lib/pagamentos/gateway-da-organizacao.ts`), não no banco. Catálogo de produtos, envio da cobrança na conversa e comprovante são fatias seguintes desta issue.
-- ---- gateway de pagamento por organização (migration 9222) ----
--
-- Issue #4058, FATIA 1 — a CONFIGURAÇÃO do gateway, por organização.
--
-- ─── A dor ────────────────────────────────────────────────────────────────
--
-- O provedor de pagamento deste repo é da INSTALAÇÃO. `lib/cobranca/configuracao.ts`
-- lê `COBRANCA_PROVEDOR`, `STRIPE_SECRET_KEY`/`ASAAS_API_KEY` e os segredos de
-- webhook de `platform_config`, e é assim porque a cobrança que existe hoje é a
-- do REVENDEDOR cobrando as empresas hospedadas: uma conta de gateway só, a da
-- instalação. Quem atende pelo CRM, porém, vende para o cliente DELE — e o
-- dinheiro tem de cair na conta dele, não na do dono da VPS.
--
-- ─── A decisão ────────────────────────────────────────────────────────────
--
-- Uma linha por organização (chave primária `organization_id`, mesmo padrão de
-- `voip_trunk_settings`): não é lista de gateways, é A configuração. Campos:
--
--   provider    text   'stripe' | 'asaas' — vocabulário par do ts
--                       (`lib/pagamentos/vocabulario.ts`), cobrado pelo
--                       invariante vocabulario-banco-x-typescript;
--   mode        text   'teste' | 'producao' — DERIVADO do prefixo da chave no
--                       momento de salvar. Não é digitado: um campo livre aqui
--                       permitiria gravar "produção" com chave de teste e
--                       mandar o cliente pagar num link que não cobra;
--   api_key_*           credencial do provedor (ciphertext/iv/tag/last4);
--   webhook_secret_*    segredo do aviso do provedor, OPCIONAL: o Asaas aceita
--                       token gerado na tela dele, e nem toda organização
--                       configura webhook no primeiro dia. As quatro colunas
--                       andam juntas ou não existem (CHECK abaixo);
--   is_active           desligar sem apagar. Apagar não é opção: a credencial
--                       é história de cobrança, e a próxima fatia grava a
--                       referência da configuração em cada cobrança.
--
-- ─── A cifra é a do repo, não uma nova ────────────────────────────────────
--
-- AES-256-GCM de `lib/crypto/aes_gcm.ts` (chave `AI_CRED_AES_KEY`), o mesmo
-- envelope de `ai_provider_credentials`, `voip_trunk_settings` e
-- `external_db_connections`: três colunas bytea por segredo e `last4` em claro
-- para a tela identificar a chave sem recebê-la. NÃO é `fn_encrypt_oauth`
-- (pgcrypto): quem chama o provedor é o Node, então a chave de cifra tem de
-- estar no processo — mandar o segredo em claro ao banco só para decifrá-lo
-- depois não fecha. Sem `AI_CRED_AES_KEY` a leitura falha FECHADA (o resolvedor
-- devolve `credencial_ilegivel`), nunca em claro e nunca herdando a credencial
-- da instalação: herdar aqui mandaria a venda do cliente para a conta de outra
-- pessoa.
--
-- ─── Por que a leitura é de qualquer membro, e a escrita só de admin ──────
--
-- Saber QUAL provedor a empresa usa não é segredo (a tela de cobrança precisa
-- disso para o atendente não prometer um link que não existe); a CREDENCIAL é,
-- e ela nunca sai do servidor — a view `organization_payment_gateways_safe`
-- omite as sete colunas cifradas. Escrita é `admin`: o mesmo nível de
-- `ai_provider_credentials` e do trunk SIP. Trocar a chave aqui muda para onde
-- o dinheiro da empresa vai.
--
-- Idempotente: `create table if not exists`, `create or replace view`,
-- `drop policy if exists` antes de cada policy.

create table if not exists public.organization_payment_gateways (
  organization_id uuid primary key references public.organizations(id) on delete cascade,

  provider text not null,
  mode text not null,

  -- AES-256-GCM (`lib/crypto/aes_gcm.ts`): nunca há coluna em claro.
  api_key_encrypted bytea not null,
  api_key_iv bytea not null,
  api_key_tag bytea not null,
  api_key_last4 text not null,

  -- Opcionais, mas as quatro andam juntas (CHECK). Segredo de webhook não é
  -- obrigatório para COBRAR; sem ele o aviso do provedor não é conferido, e o
  -- resolvedor devolve `webhookSecret: null` — a fatia do aviso decide o que
  -- fazer com isso, e não herda o segredo da instalação (o aviso da instalação
  -- é de outra conta).
  webhook_secret_encrypted bytea,
  webhook_secret_iv bytea,
  webhook_secret_tag bytea,
  webhook_secret_last4 text,

  is_active boolean not null default true,

  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint organization_payment_gateways_provedor_conhecido
    check (provider = ANY (ARRAY['stripe', 'asaas']::text[])),
  constraint organization_payment_gateways_modo_conhecido
    check (mode = ANY (ARRAY['teste', 'producao']::text[])),
  constraint organization_payment_gateways_segredo_coerente
    check (
      (webhook_secret_encrypted is null
        and webhook_secret_iv is null
        and webhook_secret_tag is null
        and webhook_secret_last4 is null)
      or (webhook_secret_encrypted is not null
        and webhook_secret_iv is not null
        and webhook_secret_tag is not null
        and webhook_secret_last4 is not null)
    )
);

comment on table public.organization_payment_gateways is
  'Gateway de pagamento PRÓPRIO da organização (issue #4058, fatia 1): com qual provedor ela cobra o cliente dela. Ausência de linha ou is_active = false herda a configuração da instalação. Credencial e segredo de webhook são cifrados com AES-256-GCM (AI_CRED_AES_KEY) e nunca saem do servidor: a tela lê organization_payment_gateways_safe.';
comment on column public.organization_payment_gateways.provider is
  'Provedor da organização: stripe | asaas. Par do CHECK e de PROVEDORES_DE_PAGAMENTO em lib/pagamentos/vocabulario.ts (tests/invariants/vocabulario-banco-x-typescript.test.ts).';
comment on column public.organization_payment_gateways.mode is
  'teste | producao, DERIVADO do prefixo da chave ao salvar. Campo digitado deixaria gravar producao com chave de teste e mandar o cliente pagar num link que nao cobra.';
comment on column public.organization_payment_gateways.api_key_last4 is
  'Últimos 4 caracteres da credencial, em claro, para a tela identificar qual chave está configurada sem receber a chave.';
comment on column public.organization_payment_gateways.is_active is
  'Desligar sem apagar: a configuracao volta a herdar a da instalacao e a credencial continua na linha, porque cobranca ja emitida aponta para ela.';

alter table public.organization_payment_gateways enable row level security;

drop policy if exists tenant_isolation_organization_payment_gateways_select on public.organization_payment_gateways;
create policy tenant_isolation_organization_payment_gateways_select on public.organization_payment_gateways
  for select
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_organization_payment_gateways_write on public.organization_payment_gateways;
create policy tenant_isolation_organization_payment_gateways_write on public.organization_payment_gateways
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- Privilégio explícito: a partir de 30/10/2026 a Supabase provisiona o default
-- ACL de `public` revogado, então tabela nova sem GRANT próprio nasce
-- inalcançável pela Data API (42501). `authenticated` recebe os quatro comandos
-- que a RLS acima pressupõe; `service_role` recebe tudo porque é o servidor que
-- cifra, decifra e chama o provedor. `anon`, nada.
revoke all on public.organization_payment_gateways from anon;
grant select, insert, update, delete on public.organization_payment_gateways to authenticated;
grant all on public.organization_payment_gateways to service_role;

-- View segura: NUNCA expõe as sete colunas cifradas. security_invoker = true
-- para a RLS da tabela base valer através dela — uma view SECURITY DEFINER aqui
-- entregaria a configuração de uma organização para a outra.
drop view if exists public.organization_payment_gateways_safe;
create view public.organization_payment_gateways_safe
  with (security_invoker = true)
  as
  select organization_id, provider, mode, api_key_last4,
         webhook_secret_last4, is_active, updated_by, created_at, updated_at
  from public.organization_payment_gateways;

revoke all on public.organization_payment_gateways_safe from anon;
grant select on public.organization_payment_gateways_safe to authenticated;
grant select on public.organization_payment_gateways_safe to service_role;

-- Sem gatilho de auditoria de linha (`fn_audit_log_row`): ele grava
-- `coalesce(new.id, old.id)` e esta tabela não tem `id` — a PK é
-- `organization_id`, como em `voip_trunk_settings`. A trilha desta configuração
-- é escrita pela rota, com metadados escolhidos (`pagamento.gateway_configurado`
-- e `pagamento.gateway_desligado`), e não carrega ciphertext.
drop trigger if exists trg_organization_payment_gateways_updated_at on public.organization_payment_gateways;
create trigger trg_organization_payment_gateways_updated_at
  before update on public.organization_payment_gateways
  for each row execute function public.fn_set_updated_at();

-- ── Travas de suporte (migration 0274) ────────────────────────────────────
-- Tabela criada DEPOIS do fim do baseline tem de chamar a função no fim do
-- bloco, senão a instalação nova fica sem as policies `support_write_*` nela e
-- o acompanhamento administrativo não alcança a tabela (ou alcança sem a
-- restrição). Só quem aplica o schema chama: a função não é security definer.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';
