-- 0380 · O anúncio tem nome, e o CRM só tinha o número dele.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- O contato que chega por clique-para-WhatsApp traz o id do anúncio e mais nada:
-- a plataforma não manda nome de campanha, de conjunto nem de anúncio no
-- `referral`. A ficha do contato mostra `120210000000000`, que não responde
-- pergunta nenhuma — quem opera tráfego precisa de "Black Friday · Mulheres
-- 25-34 · Vídeo depoimento v3" para decidir o que manter no ar.
--
-- Os nomes existem, mas só na API da plataforma, e só se alguém perguntar.
--
-- ─── Por que uma tabela de CACHE, e não uma consulta por abertura de ficha ───
-- Isto NÃO é otimização prematura: é a condição para a feature funcionar um dia
-- inteiro. A conta sondada responde `ads_api_access_tier: "development_access"`
-- (medido, e registrado no cabeçalho de lib/plataformas-de-anuncio/meta/insights.ts),
-- que é o degrau de cota mais baixo da plataforma.
--
-- A conta é simples: um anúncio que presta gera centenas de contatos. Sem cache,
-- cada abertura de ficha é uma chamada nova — e a mesma pergunta, sobre o MESMO
-- anúncio, repetida por cada contato que ele trouxe. A cota acaba no primeiro
-- dia de uso real, e o que o operador vê não é "acabou a cota": é a ficha sem
-- nome de campanha, do mesmo jeito que antes desta feature existir.
--
-- Um anúncio raramente é renomeado, e quando é, o nome novo aparece na próxima
-- leitura que encontrar a linha vencida. `fetched_at` guarda QUANDO se perguntou
-- — a idade aceitável é decisão do código que lê, não do schema, porque ela muda
-- com o degrau de cota da conta e não com a forma do dado.
--
-- ─── Por que server-side only, e não policy de tenant ───────────────────────
-- Quarta tabela do eixo de anúncios com o desenho de `ad_platform_connections`
-- (0213), `ad_insights_connections` (0214) e as duas de captura do Google (0306):
-- RLS ligada, ZERO policies, grants de anon/authenticated revogados.
--
-- Nome de campanha e de criativo é dado comercial — a estratégia de mídia de
-- quem anuncia, que um concorrente pagaria para ler. A anon key VAI PARA O
-- BROWSER, e tabela com RLS ligada, sem policy e sem grant não é servida pelo
-- PostgREST de jeito nenhum: só o `service_role`, que vive no servidor.
--
-- Deny-all é MAIS restritivo que isolamento por tenant, não menos. Quem lê esta
-- tabela é a rota do servidor, com o admin client filtrando `organization_id` à
-- mão — o mesmo padrão de `ad_conversion_dispatches`.
--
-- Gate: `tests/invariants/credencial-de-anuncios-e-server-side.test.ts`, que
-- mede privilégio E comportamento (`permission denied` sob `set role`).
--
-- ─── Por que `organization_id` no índice único ──────────────────────────────
-- O id do anúncio é da plataforma, não nosso, e duas organizações podem alcançar
-- a MESMA conta de anúncios (uma agência e o cliente dela). Sem a organização na
-- chave, a segunda a resolver leria a linha da primeira — e passaria a mostrar,
-- na ficha do contato dela, o nome que o vizinho deu ao anúncio. É a mesma lição
-- da #236 que `credenciais-de-leitura.ts` documenta.
--
-- Nenhuma função nova em `public` ⇒ nenhuma superfície `security definer` nova
-- ⇒ o item 9 da doutrina de migrations não é acionado por este arquivo.

create table if not exists public.ad_hierarchy_cache (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Mesmo vocabulário agnóstico da 0213/0214: a plataforma que hospeda o
  -- anúncio, não o nome do endpoint que a lê.
  platform text not null,
  -- Os identificadores são da plataforma e chegam como texto. Sem FK, pelo mesmo
  -- motivo de `ad_insights_connections.default_account_id`: o anúncio pode ser
  -- apagado lá sem aviso nenhum aqui.
  ad_id text not null,
  ad_name text,
  adset_id text,
  adset_name text,
  campaign_id text,
  campaign_name text,
  -- QUANDO se perguntou. Nulo nunca: uma linha sem esta data não diz se o nome
  -- é de hoje ou do ano passado, e o leitor não teria como decidir se repergunta.
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_hierarchy_cache_platform_conhecida
    check (platform in ('meta_ads', 'google_ads'))
);

-- Uma linha por anúncio por plataforma por organização. É o índice que o upsert
-- da releitura usa como alvo do `on conflict`.
create unique index if not exists ad_hierarchy_cache_org_platform_ad_uk
  on public.ad_hierarchy_cache (organization_id, platform, ad_id);

comment on table public.ad_hierarchy_cache is
  'Nome do anúncio, do conjunto e da campanha, guardados por id de anúncio. Existe porque a conta de anúncios opera em cota baixa e um único anúncio gera centenas de contatos: sem cache, cada ficha aberta gastaria uma chamada para repetir a mesma pergunta. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated.';
comment on column public.ad_hierarchy_cache.ad_id is
  'O identificador do anúncio na plataforma — o mesmo que a ingestão grava em contacts.source_metadata.ad_id. Sem FK: o anúncio é da plataforma e pode ser apagado lá sem aviso.';
comment on column public.ad_hierarchy_cache.fetched_at is
  'Quando a hierarquia foi lida da plataforma. A idade aceitável é decisão do código que lê, não do schema: ela muda com o degrau de cota da conta, e não com a forma do dado.';

alter table public.ad_hierarchy_cache enable row level security;
revoke all on public.ad_hierarchy_cache from anon, authenticated;
grant select, insert, update, delete on public.ad_hierarchy_cache to service_role;

drop trigger if exists trg_ad_hierarchy_cache_updated_at on public.ad_hierarchy_cache;
create trigger trg_ad_hierarchy_cache_updated_at
  before update on public.ad_hierarchy_cache
  for each row execute function public.fn_set_updated_at();
