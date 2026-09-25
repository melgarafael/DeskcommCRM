-- 0383 — cadastro com aprovação: a empresa nova espera o dono da instalação
--
-- Recorte do PR #714, de @betoarts (a fila `registration_requests` é dele).
-- Decisão do dono do produto, doc 24, Decisão 2 = (d): o auto-cadastro com
-- aprovação entra como CHAVE POR INSTALAÇÃO, DESLIGADA POR PADRÃO, ligada na
-- tela `/admin/cadastro`.
--
-- ─── O que muda ─────────────────────────────────────────────────────────────
--
-- 1. `platform_settings.signup_mode` ganha o terceiro valor, `com_aprovacao`.
--    O default continua `aberto`: nenhuma instalação muda ao atualizar.
-- 2. `registration_requests` guarda o pedido de quem confirmou a conta e quer
--    abrir empresa numa instalação `com_aprovacao`. A empresa só nasce quando o
--    administrador da instalação aprova.
--
-- ─── O que ficou de fora do desenho do autor, e por quê ─────────────────────
--
-- - Pedido para ENTRAR numa empresa existente: exigia listar as empresas da
--   instalação a visitante anônimo. Quem entra numa empresa existente entra
--   pelo convite, que é o código que o produto já tem.
-- - Nenhuma coluna de confirmação de e-mail: o e-mail vale confirmado só pelo
--   fluxo normal do provedor de auth, nunca por este pedido.
--
-- ─── Por que RLS sem policy, e não isolamento por organização ───────────────
--
-- O pedido é anterior à organização: ela ainda não existe, então não há
-- `organization_id` que o isole. Mesma decisão de `platform_settings` (0253):
-- RLS ligada e ZERO policies = ninguém alcança pela REST; quem lê e escreve é o
-- servidor, com service_role, depois de `requirePlatformAdmin()` ou da sessão
-- do próprio dono do pedido. Deny-all é mais restritivo que policy de tenant.
--
-- Idempotente: `if not exists`, `drop ... if exists` antes de recriar
-- constraint e trigger. A tabela nasce vazia e a CHECK nova é um superconjunto
-- da anterior, então não há dado a corrigir antes dela.

alter table public.platform_settings
  drop constraint if exists platform_settings_signup_mode;
alter table public.platform_settings
  add constraint platform_settings_signup_mode
  check (signup_mode in ('aberto', 'com_aprovacao', 'so_convite'));

comment on column public.platform_settings.signup_mode is
  'aberto = qualquer pessoa cria conta em /signup e abre a própria empresa (comportamento histórico). com_aprovacao = a conta é criada, mas a empresa só nasce quando o administrador da instalação aprova o pedido em /admin/cadastro (tabela registration_requests). so_convite = só quem chega com convite válido; sem convite, /signup recusa com tela e /auth/confirm NÃO provisiona organização.';

create table if not exists public.registration_requests (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references auth.users(id) on delete cascade,
  requested_organization_name text        not null,
  status                      text        not null default 'pending',
  decided_by                  uuid        references auth.users(id) on delete set null,
  decided_at                  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint registration_requests_status check (status in ('pending', 'approved', 'rejected')),
  constraint registration_requests_decision check (
    (status = 'pending' and decided_at is null)
    or (status in ('approved', 'rejected') and decided_at is not null)
  )
);

comment on table public.registration_requests is
  'Pedido de empresa nova numa instalação em signup_mode = com_aprovacao. Da INSTALAÇÃO, não do tenant (a organização ainda não existe): RLS ligada sem policy, lida e escrita só pelo servidor. Ver lib/auth/registration-requests.ts.';

-- Um pedido pendente por conta: clique repetido no formulário não enfileira
-- duplicata para o administrador.
create unique index if not exists registration_requests_one_pending_per_user
  on public.registration_requests (user_id)
  where status = 'pending';

create index if not exists registration_requests_pending_idx
  on public.registration_requests (created_at)
  where status = 'pending';

alter table public.registration_requests enable row level security;
revoke all on public.registration_requests from anon, authenticated;
grant select, insert, update on public.registration_requests to service_role;

drop trigger if exists trg_registration_requests_touch on public.registration_requests;
create trigger trg_registration_requests_touch
  before update on public.registration_requests
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
