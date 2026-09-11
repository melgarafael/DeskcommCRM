-- 0233 — a instalação decide se aceita cadastro aberto
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- `/signup` é aberto e não há como fechá-lo pelo produto. Quem vende tenant
-- numa instalação própria precisa que só convidado entre — e hoje a única saída
-- é bloquear a rota no proxy reverso, fora do produto. Medido numa instalação
-- real: a regra de nginx que fazia isso barrou junto o `/signup?invite=…`, isto
-- é, o convite, que é exatamente quem deveria passar. Regra de infraestrutura
-- não sabe o que é um convite; o produto sabe.
--
-- ─── Por que uma tabela singleton, e não uma variável de ambiente ───────────
--
-- Mesmo argumento de `platform_branding` (0155): trocar isso por env exigiria
-- SSH na VPS, editar `.env` e reiniciar a stack. Para o público do kit — quem
-- compra hospedagem e instala sozinho — isso é o mesmo que não ser
-- configurável. A tabela é a fonte; a tela de /admin é a superfície.
--
-- ─── Por que o default é 'aberto' ───────────────────────────────────────────
--
-- Regra 6 da doutrina de packaging: variável nova nasce com o default que
-- PRESERVA o comportamento anterior. Toda instalação que já existe continua
-- aceitando cadastro exatamente como hoje, sem ninguém fazer nada. Quem quer
-- fechar, escolhe — no install.sh ou na tela.
--
-- ─── Sem event_log ──────────────────────────────────────────────────────────
--
-- Nenhum dos handlers de `lib/event-log/register-handlers.ts` cobriria um tipo
-- `platform_settings.*`, e o drain deixa evento sem handler INTOCADO: a linha
-- nasceria `pending` para sempre em todo clone (anti-pattern nº 3 do CLAUDE.md).
-- O registro desta mutação é `audit()`, que tem consumidor real — a tela
-- `/admin/audit`.
--
-- Idempotente e auto-curativa: `create table if not exists`, `drop trigger if
-- exists` antes do `create trigger`, grants/revokes declarativos. A tabela nasce
-- vazia, então não há dado existente a deduplicar antes da constraint.

create table if not exists public.platform_settings (
  id           smallint    primary key default 1,
  signup_mode  text        not null default 'aberto',
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  constraint platform_settings_singleton check (id = 1),
  constraint platform_settings_signup_mode check (signup_mode in ('aberto', 'so_convite'))
);

comment on table public.platform_settings is
  'Configuração da INSTALAÇÃO (não do tenant) — linha única id=1. Hoje só a política de cadastro. Lida/escrita apenas server-side (service_role); a ausência da linha significa o default, que é o comportamento anterior à 0233. Ver lib/auth/politica-de-cadastro.ts.';

comment on column public.platform_settings.signup_mode is
  'aberto = qualquer pessoa cria conta em /signup (comportamento histórico). so_convite = só quem chega com convite válido; sem convite, /signup recusa com tela e /auth/confirm NÃO provisiona organização.';

alter table public.platform_settings enable row level security;

-- ZERO POLICIES, DE PROPÓSITO. Mesma decisão de `platform_branding`: esta linha
-- não pertence a organização nenhuma, então não há predicado de tenant que a
-- isole. RLS ligada sem policy = ninguém alcança pela REST; quem lê é o
-- service_role, que a bypassa, e só a partir do servidor.
revoke all on public.platform_settings from anon, authenticated;
grant select, insert, update on public.platform_settings to service_role;

drop trigger if exists trg_platform_settings_touch on public.platform_settings;
create trigger trg_platform_settings_touch
  before update on public.platform_settings
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
