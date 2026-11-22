-- manifest: **Conecta a CONTA Resend da organização — tabela própria `organization_resend_accounts` (PK `organization_id` 1:1) com `api_key` em `bytea` CIFRADA (AES-256-GCM), `api_key_last4` + `from_email`, RLS habilitada SEM policy (#3287, fatia da conta própria, proposta do mantenedor @SPYDeEp1).** Com a conta conectada o e-mail da AUTOMAÇÃO sai pelo `from` da organização (`lib/automation/actions/send-email.ts` → `lib/email/resend-da-organizacao.ts`); sem conta o roteador da plataforma entrega byte a byte como hoje (invariância medida). E-mail de SISTEMA (convite, senha, LGPD) nunca passa por ela. O domínio é conferido na API de domínios da Resend ANTES de gravar → recusa `dominio_nao_verificado` com o domínio, não erro cru (critério E). Tabela em vez de `organizations.settings` porque `settings` é jsonb lido por vários `select("settings")` e uma chave ali vaza no primeiro payload de tela; RLS sem policy deixa a chave fora do client de sessão (critério D). Idempotente (`create table if not exists`, `enable row level security` e `revoke` repetem sem erro). **Com apêndice idempotente no `baseline.sql`:** inclui a criação e o fechamento de privilégios que chegam ao install/update do self-host. `MANIFEST.md` é histórico e não recebe linha.
-- 0795 — CONTA RESEND DA ORGANIZAÇÃO (#3287, fatia da conta própria).
--
-- A organização conecta a CONTA Resend DELA: a chave (cifrada) mora POR
-- organização, e o domínio do remetente é o que ela verificou na Resend. Quando
-- conectada, o e-mail da automação sai pela conta da organização
-- (`lib/automation/actions/send-email.ts` → `lib/email/resend-da-organizacao.ts`);
-- sem conta, o envio continua exatamente como hoje (o roteador da plataforma).
--
-- ── Por que TABELA, e não `organizations.settings` ────────────────────────────
--
-- Duas razões medidas, não de gosto:
--
--  1. SEGREDO. `settings` é jsonb lido por vários select("settings") — do
--     layout, da tela de marca, do remetente da automação (fatia 1, #3287).
--     Uma chave de API em jsonb vaza no primeiro payload de tela que mandar o
--     objeto inteiro. Aqui a coluna é `bytea` CIFRADA e a RLS nasce SEM policy:
--     nem o client de sessão nem `select("*")` de settings alcançam a chave.
--     Quem lê o estado para a tela lê SÓ `from_email` + `api_key_last4`
--     (critério D: chave nunca vaza em log nem em payload de tela).
--
--  2. ESCRITORES. `organizations.settings` tem vários donos que leem o jsonb
--     INTEIRO e o regravam (`fn_definir_marca_da_organizacao` substitui o
--     objeto `branding` inteiro). Um quarto escritor com o mesmo padrão seria o
--     anti-pattern que a própria action da marca documenta. Uma tabela própria,
--     com `upsert` na PK, não disputa jsonb com ninguém.
--
-- ── Cifra ────────────────────────────────────────────────────────────────────
--
-- AES-256-GCM pela aplicação (`lib/crypto/aes_gcm.ts`), a MESMA infra de
-- `ai_provider_credentials` e do arquivo de instalação: IV e tag próprios por
-- linha, `api_key_last4` só para a tela identificar qual chave está conectada.
-- A chave de cifragem (`AI_CRED_AES_KEY`) é da INSTALAÇÃO; a organização é a
-- linha — uma organização não lê a cifra da outra porque cada uma tem a sua.
create table if not exists organization_resend_accounts (
  organization_id uuid primary key references organizations (id) on delete cascade,
  api_key_ciphertext bytea not null,
  api_key_iv bytea not null,
  api_key_tag bytea not null,
  -- Só os 4 últimos caracteres: é o que a tela mostra ("chave …8c2f") para
  -- identificar a chave sem nunca devolver a chave.
  api_key_last4 text not null,
  -- O endereço de REMETENTE no domínio VERIFICADO da conta da organização.
  from_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS FECHADA de propósito: nenhuma policy. `anon` e `authenticated` não leem
-- nem gravam; só o service_role (que faz bypass) — e é ele que a action de
-- envio (worker) e a de conexão usam. A tela lê o estado pela action/rota com
-- admin client, selecionando só as colunas seguras.
alter table organization_resend_accounts enable row level security;

revoke all on organization_resend_accounts from public, anon, authenticated;

-- O worker recebe só CRUD, sem depender do DEFAULT ALL da instalação.
revoke all on organization_resend_accounts from service_role;
grant select, insert, update, delete on organization_resend_accounts to service_role;
