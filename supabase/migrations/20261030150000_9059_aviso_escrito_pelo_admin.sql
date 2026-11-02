-- manifest: Aviso escrito pelo admin da empresa — tabela `avisos` (autor, organizacao, titulo, corpo e janela de publicacao/expiracao). A rota de criacao (papel admin) chama `enviarPushDaOrg()` com o kind `aviso`. Server-only: RLS ligada, sem policy para `authenticated`; escrita/leitura so pelo service role.
create table if not exists public.avisos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  autor_id uuid references auth.users(id) on delete set null,
  titulo text not null,
  corpo text not null,
  publicar_em timestamptz not null default now(),
  expira_em timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists avisos_org_publicar_idx
  on public.avisos (organization_id, publicar_em desc);

alter table public.avisos enable row level security;

revoke all on public.avisos from public, anon, authenticated;
grant select, insert, update, delete on public.avisos to service_role;
