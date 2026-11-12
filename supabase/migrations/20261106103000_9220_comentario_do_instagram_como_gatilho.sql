-- manifest: #4075 — o comentário do Instagram vira fato (channel_comments) e gatilho do motor (instagram.comment)
--
-- ─── O QUE FALTAVA ─────────────────────────────────────────────────────────
--
-- O webhook do canal social lia só evento de MENSAGEM. `comment.*` não tinha
-- leitor: a rota respondia 200 `evento_sem_interesse` e o comentário do cliente
-- era descartado — não havia linha, não havia evento e não havia gatilho a
-- disparar (#4075).
--
-- ─── POR QUE UMA TABELA, e não só o `event_log` ────────────────────────────
--
-- O evento é o gatilho; esta linha é o FATO. O `event_log` é consumido e
-- expurgado (o dreno e a retenção o apagam), então "quem comentou o quê no post
-- X" não sobreviveria nele. E é esta tabela que dá a TRAVA da reentrega: o
-- provedor reenvia o mesmo evento quando não recebe 200, e a chave única
-- `(organization_id, provider, external_id)` faz a segunda entrega não ser
-- fato novo — logo, não gera evento e não dispara uma segunda ação.
--
-- ─── POR QUE SEM POLICY DE ESCRITA PARA A SESSÃO ───────────────────────────
--
-- Quem grava é o servidor, com a service role, dentro do webhook (bypassa RLS).
-- Não há rota de usuário que escreva comentário — abrir INSERT/UPDATE para
-- `authenticated` seria superfície sem uso. A sessão só LÊ: `viewer` em diante
-- vê os comentários da própria organização (mesmo piso de leitura das demais
-- tabelas de canal), e o isolamento é o `organization_id in (fn_user_org_ids())`.
--
-- Idempotente: `create table if not exists`, `create index if not exists`,
-- `drop policy if exists` antes de cada `create policy`.

create table if not exists public.channel_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- A sessão do canal que recebeu: é por ela que o motor sabe se o canal está
  -- desligado (`canalDoEventoDesativado`, #2329) e qual conta do provedor falou.
  channel_session_id uuid not null references public.channel_sessions (id) on delete cascade,
  provider text not null,
  platform text not null,
  -- Id do comentário NO provedor. Chave da reentrega, junto com org e provider.
  external_id text not null,
  post_id text not null,
  author_id text not null,
  author_username text,
  author_name text,
  -- O texto como veio. Nulo é possível (comentário só com anexo), e o gatilho
  -- simplesmente não casa palavra nenhuma nele.
  text text,
  -- A ficha que o canal resolveu para o autor (`<plataforma>:<conta>:<autor>`).
  -- `set null` porque apagar a ficha não pode apagar o histórico do comentário.
  contact_id uuid references public.contacts (id) on delete set null,
  -- Quando o comentário nasceu NO PROVEDOR (não confundir com `created_at`, a
  -- hora em que esta linha entrou no CRM — a reentrega tardia não mente).
  comment_created_at timestamptz,
  created_at timestamptz not null default now(),
  constraint channel_comments_entrega_unica unique (organization_id, provider, external_id)
);

-- "os comentários do post X, mais recentes primeiro" — a leitura da tela e a
-- conferência de que o recorte por post da regra tem índice.
create index if not exists channel_comments_por_post_idx
  on public.channel_comments (organization_id, post_id, comment_created_at desc);

-- "o que este contato comentou" — o lado do contato, que é a entidade do evento.
create index if not exists channel_comments_por_contato_idx
  on public.channel_comments (organization_id, contact_id);

alter table public.channel_comments enable row level security;
revoke all on public.channel_comments from anon;

-- Grant do tamanho do uso, explícito: tabela criada depois de 30/10/2026 nasce
-- inalcançável pela Data API na Supabase da nuvem sem ele. A sessão só LÊ (a
-- policy é de select); quem grava é o servidor, com a service role.
grant select on table public.channel_comments to authenticated;
grant select, insert, update, delete on table public.channel_comments to service_role;

drop policy if exists channel_comments_select on public.channel_comments;
create policy channel_comments_select
  on public.channel_comments
  for select
  using (
    public.fn_is_platform_admin_full()
    or organization_id in (select public.fn_user_org_ids())
  );

-- As travas do modo somente leitura do suporte (migration 0274) são um `do` que
-- enumera o catálogo — alcançam só as tabelas que existiam no instante em que
-- rodaram. Esta tabela nasceu depois, então a instalação nova e a atualização
-- só chegam ao MESMO catálogo se a função for chamada de novo aqui. Sem isto o
-- `baseline-e-cadeia-chegam-ao-mesmo-schema` acusa as três `support_write_*`
-- de um lado só (divergência real, não cosmética): a instalação nova ficaria
-- sem a trava que impede o suporte somente-leitura de ESCREVER no comentário.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;
