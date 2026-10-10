-- Convite de time deixa de ser só um token HMAC sem lastro.
--
-- Até aqui o convite pendente não existia em lugar nenhum do banco: o token é
-- stateless (`lib/auth/invite-token.ts`), a linha em `user_organizations` só
-- nasce no aceite (`fn_accept_team_invite`), e o único rastro de "convidei
-- alguém" era uma linha `member.invited` no `api_audit_log`. Consequência:
--   - a tela de Equipe não mostrava convite pendente nenhum;
--   - "o e-mail saiu?" só se respondia lendo `metadata.email_dispatched` do
--     audit, que a UI não lê;
--   - REVOGAR um convite era impossível — não há como cancelar um token
--     stateless sem um registro contra o qual verificar no aceite.
--
-- `team_invites` é esse registro. O `id` da linha é o `invite_id` que vai
-- dentro do token, então o aceite (server action) casa os dois e pode recusar
-- um convite revogado mesmo com o token ainda dentro da validade.
--
-- STATUS (pendente/aceito/expirado/revogado) NÃO é coluna — é derivado de
-- `accepted_at`/`revoked_at`/`expires_at` em `lib/team/convites.ts` (doutrina
-- DIRC: Calcular). Guardar o status seria um quarto campo para manter em sincronia
-- com os três que já contam a história.
--
-- Idempotente: `if not exists` em tabela e índices, `drop policy if exists`
-- antes de cada policy e do trigger — o `update.sh` de um clone reaplica o
-- apêndice do baseline inteiro sem erro.

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Guardado já em minúsculas pelo app (`issueInvite`). O índice único usa
  -- `lower(email)` mesmo assim, para o caso de uma inserção fora desse caminho.
  email text not null,

  role text not null,

  -- Mesma forma de `user_organizations.interface_settings` (migration 0221) — a
  -- escolha de áreas viaja assinada no token e é aplicada no aceite; guardá-la
  -- aqui é o que deixa a tela mostrar "Simplificada/Completa/Personalizada"
  -- antes de a pessoa aceitar.
  interface_settings jsonb not null default '{"preset":"completa"}'::jsonb,

  -- FK de verdade para quem convidou (anti-pattern nº 1). `inviter_name` é um
  -- SNAPSHOT do nome legível no momento do convite — o schema `auth` não é
  -- acessível via PostgREST, e resolver cada `invited_by` pela GoTrue admin API
  -- a cada carga da lista seria N chamadas de rede por render.
  invited_by uuid references auth.users(id) on delete set null,
  inviter_name text,

  -- O e-mail REALMENTE saiu? `false` = a tela mostra o aviso e o link copiável
  -- ali mesmo, em vez de o admin achar que enviou.
  email_dispatched boolean not null default false,

  created_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  resend_count integer not null default 0,
  expires_at timestamptz not null,

  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,

  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,

  updated_at timestamptz not null default now(),

  constraint team_invites_role_check check (role in ('viewer','agent','manager','admin')),
  constraint team_invites_email_nao_vazio check (length(btrim(email)) > 0)
);

-- A consulta da tela: os convites de uma organização, mais novo primeiro.
create index if not exists team_invites_org_created_idx
  on public.team_invites (organization_id, created_at desc);

-- No máximo UM convite em aberto por e-mail por organização. Reconvidar o mesmo
-- e-mail enquanto há um pendente vira RENOVAÇÃO da mesma linha (o app trata o
-- 23505). Aceito ou revogado libera o slot — reconvidar depois cria linha nova
-- e o histórico fica.
create unique index if not exists team_invites_um_pendente_por_email_idx
  on public.team_invites (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table public.team_invites enable row level security;

-- Leitura: membro manager+ da organização (viewer/agent não administram time),
-- ou platform admin.
drop policy if exists team_invites_select on public.team_invites;
create policy team_invites_select on public.team_invites
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- Escrita (emitir, renovar, revogar): admin da organização, ou platform admin.
-- O aceite roda como o CONVIDADO, que ainda não é membro — ele passa pelo
-- service_role (server action), que ignora RLS.
drop policy if exists team_invites_write on public.team_invites;
create policy team_invites_write on public.team_invites
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline alcança
-- TODA tabela criada depois dele — inclusive esta. Sem o revoke, os e-mails
-- convidados ficam legíveis pela anon key, que vai para o browser.
revoke all on public.team_invites from anon;
grant select, insert, update, delete on public.team_invites to authenticated;
grant all on public.team_invites to service_role;

drop trigger if exists trg_team_invites_updated_at on public.team_invites;
create trigger trg_team_invites_updated_at
  before update on public.team_invites
  for each row execute function public.fn_set_updated_at();

comment on table public.team_invites is
  'Convite de time PENDENTE e seu histórico. O id da linha = invite_id do token HMAC; o aceite (app/actions/team/acceptInvite.ts) casa os dois e recusa convite revogado. Status é derivado, não coluna.';
comment on column public.team_invites.inviter_name is
  'Snapshot do nome de quem convidou. auth.users não é acessível via PostgREST; resolver na hora seria N chamadas GoTrue por render.';
comment on column public.team_invites.email_dispatched is
  'false = o envio de e-mail falhou (ou não há e-mail configurado). A tela mostra o aviso e o link copiável.';
