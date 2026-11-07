-- manifest: **Módulo conectado, F2 — o schema do token do módulo (spec 33, decisões 1, 3 e 4).** `api_tokens` ganha `extension_installation_id` (FK para `extension_installations`) e `module_slug`; `created_by` passa a aceitar nulo, com a CHECK `api_tokens_dono_check` (`created_by is not null or extension_installation_id is not null`: token sem dono não existe) e o índice único parcial `api_tokens_modulo_vivo_idx` em `(organization_id, extension_installation_id)` para tokens vivos de módulo (um vivo por par organização × instalação). Duas tabelas só de servidor, RLS ligada e NENHUMA policy, privilégio só a `service_role`: `extension_installation_secrets` (o segredo da instalação, cifrado; apagar a instalação apaga o segredo, apagar quem girou só zera `rotated_by`) e `extension_token_nonces` (anti-repetição da assinatura de busca; chave `(installation_id, nonce)` e índice em `seen_at` para a limpeza). Nenhuma função aqui (as funções são a migration seguinte). Espelho idempotente no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116). Prova em `tests/invariants/extensoes-token-modulo.test.ts`.
-- ============================================================================
-- 9117 — MÓDULO CONECTADO, F2: o schema do token do módulo.
--
-- Um módulo `connected` busca um token curto (`dsk_…`) provando que tem o segredo da instalação. O
-- token é uma linha de `api_tokens` como qualquer outra (o teto de 50 por organização e a validação
-- do bearer continuam valendo), mas o DONO dele é a instalação do módulo, não uma pessoa:
--
-- 1. `api_tokens.extension_installation_id` e `module_slug` identificam o token de módulo.
--    `created_by` deixa de ser `NOT NULL` (a FK `ON DELETE RESTRICT` para `auth.users` continua para
--    token de pessoa). Quem instalou ser apagado NÃO pode apagar nem bloquear o token do módulo:
--    token de módulo nasce com `created_by` nulo. A CHECK `api_tokens_dono_check` garante que nenhuma
--    linha fica sem dono (nem pessoa, nem instalação).
-- 2. Índice único parcial: no máximo UM token vivo (sem `revoked_at`) por organização e instalação.
--    A ativação reserva a vaga e a busca troca o hash dessa mesma linha (plano da F2, emenda 1).
-- 3. `extension_installation_secrets`: o segredo da instalação, cifrado (AES-GCM, no app). Uma linha
--    por instalação. Tabela de servidor: RLS ligada, SEM policy, sem privilégio para anon/authenticated.
-- 4. `extension_token_nonces`: o nonce de cada busca assinada, para recusar repetição dentro da
--    janela do carimbo. O índice em `seen_at` serve a limpeza oportunista feita pela própria busca.
--
-- Idempotente: `add column if not exists`, `drop not null` (já nulo = sem efeito), CHECK com drop + add,
-- `create ... if not exists`. Dados existentes não violam nada: toda linha antiga tem `created_by`.

alter table public.api_tokens
  add column if not exists extension_installation_id uuid references public.extension_installations(id),
  add column if not exists module_slug text;

alter table public.api_tokens alter column created_by drop not null;

alter table public.api_tokens drop constraint if exists api_tokens_dono_check;
alter table public.api_tokens add constraint api_tokens_dono_check
  check (created_by is not null or extension_installation_id is not null);

create unique index if not exists api_tokens_modulo_vivo_idx
  on public.api_tokens (organization_id, extension_installation_id)
  where revoked_at is null and extension_installation_id is not null;

create table if not exists public.extension_installation_secrets (
  installation_id uuid primary key references public.extension_installations(id) on delete cascade,
  ciphertext text not null,
  rotated_at timestamptz not null default now(),
  rotated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.extension_token_nonces (
  installation_id uuid not null references public.extension_installations(id) on delete cascade,
  nonce text not null,
  seen_at timestamptz not null default now(),
  primary key (installation_id, nonce)
);
create index if not exists extension_token_nonces_seen_at on public.extension_token_nonces(seen_at);

alter table public.extension_installation_secrets enable row level security;
alter table public.extension_token_nonces enable row level security;
revoke all on public.extension_installation_secrets, public.extension_token_nonces
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.extension_installation_secrets, public.extension_token_nonces
  to service_role;

notify pgrst, 'reload schema';
