-- 0306 · O `gclid` nunca chegava ao WhatsApp — e sem clique capturado não há
-- o que reportar de volta pro Google.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- `lib/plataformas-de-anuncio/registry.ts` (0213) já declara por que `google_ads`
-- não tem transporte de conversão: "não existe extrator de gclid" — e a razão é
-- que não existe LANDING PAGE que capture o clique do anúncio e o carregue para
-- dentro da conversa do WhatsApp. Ao contrário do "Clique para o WhatsApp" da
-- Meta, o Google Ads não tem um mecanismo nativo equivalente: um anúncio de
-- pesquisa do Google leva a uma URL comum, não a uma conversa já aberta.
--
-- Esta migration cria as DUAS peças de dado que fecham esse buraco:
--
--  1. `google_ads_landing_pages` — para ONDE a página de captura redireciona
--     (o número de WhatsApp e o texto pré-preenchido da organização).
--  2. `google_ads_click_refs` — o PAR `token curto ↔ gclid`, criado no momento
--     do clique e consultado quando a mensagem chega no WhatsApp com o token
--     embutido no texto. É o "cano" que carrega o clique até a conversa.
--
-- ─── Por que duas tabelas, e não colunas em `ad_platform_connections` ──────
-- `ad_platform_connections` (0213) existe para a credencial que REPORTA venda
-- de volta pro Google — accessToken, developer token, customer id. Nenhuma
-- dessas colunas é necessária para uma organização simplesmente TER uma
-- landing page funcionando: captura de clique não exige a organização ter
-- conectado nada na API do Google Ads ainda, e amarrar as duas coisas na
-- mesma linha faria a landing page depender de uma credencial que ela não usa.
-- Mesmo raciocínio do cabeçalho de `credenciais-de-leitura.ts`: tabelas
-- separadas porque os dois eixos têm ciclos de vida e pré-requisitos
-- diferentes — aqui o eixo de CAPTURA nasce e funciona sozinho, antes e
-- independente do eixo de CONVERSÃO.
--
-- `google_ads_click_refs` é tabela própria (não uma coluna a mais em
-- `contacts` ou em `crm_leads`) porque o par token↔gclid existe ANTES de
-- qualquer contato existir — é criado no clique, no anúncio, minutos ou horas
-- antes de a pessoa abrir o WhatsApp e mandar a primeira mensagem. Guardar
-- isso preso a um `contact_id` que ainda não existe não é possível; a tabela
-- é o "vestíbulo" que existe só até o match acontecer.
--
-- ─── Por que RLS ligada com ZERO policies, nas duas ────────────────────────
-- Mesmo desenho de `ad_platform_connections`/`ad_insights_connections`:
-- a anon key vai para o browser, e nenhuma tela deste CRM
-- precisa ler estas tabelas do lado do cliente. O `gclid` é dado de
-- rastreamento do cliente de quem anuncia — vazá-lo por engano não é da
-- mesma gravidade que um token de acesso, mas continua sendo dado que só o
-- servidor tem motivo para tocar, e manter os dois eixos deste feature no
-- mesmo padrão evita um terceiro modelo de acesso para alguém copiar errado
-- depois.
--
-- ─── O que fica sem varredor, declarado ─────────────────────────────────────
-- `google_ads_click_refs` não tem cron de limpeza nesta versão: uma linha
-- nunca casada (clique que nunca virou mensagem) fica para sempre. O volume é
-- pequeno (um clique de anúncio não é um evento de alta frequência para a
-- maioria das instalações) e o dado não é hiper-sensível. Fica registrado como
-- dívida, não como omissão — o mesmo tratamento que `app/api/v1/marca/logo/route.ts`
-- dá para os órfãos de storage.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Para onde a landing page redireciona
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.google_ads_landing_pages (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- E.164 COM `+`, o mesmo formato de `contacts.phone_number`
  -- (`lib/channels/phone-variants.ts`).
  whatsapp_e164 text not null,
  -- O texto pré-preenchido do link `wa.me`. Contém literalmente `{token}`,
  -- substituído pelo código do clique no momento do redirect — é assim que o
  -- código chega até a mensagem que a pessoa manda, sem ela precisar digitar
  -- nada.
  message_template text not null default 'Olá! Vim pelo anúncio e quero saber mais. [ref:{token}]',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint google_ads_landing_pages_template_tem_placeholder
    check (message_template like '%{token}%')
);

comment on table public.google_ads_landing_pages is
  'Configuração da landing page de captura de gclid, por organização: para qual WhatsApp e com qual texto pré-preenchido ela redireciona. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated — não guarda segredo, mas nenhuma tela lê pelo client ainda.';
comment on column public.google_ads_landing_pages.message_template is
  'Precisa conter o literal {token}: é onde o código do clique é injetado antes do redirect para o wa.me.';

alter table public.google_ads_landing_pages enable row level security;
revoke all on public.google_ads_landing_pages from anon, authenticated;
grant select, insert, update, delete on public.google_ads_landing_pages to service_role;

drop trigger if exists trg_google_ads_landing_pages_updated_at on public.google_ads_landing_pages;
create trigger trg_google_ads_landing_pages_updated_at
  before update on public.google_ads_landing_pages
  for each row execute function public.fn_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. O par token↔gclid, do clique até o match com a mensagem
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.google_ads_click_refs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Código curto embutido no texto pré-preenchido — o que a mensagem do
  -- WhatsApp carrega de volta. NÃO é o gclid: o gclid pode conter caracteres
  -- que a formatação do WhatsApp ou a digitação humana corrompem, e expor o
  -- gclid cru no texto da conversa também o vaza para qualquer app instalado
  -- no aparelho do lead com acesso ao histórico. Curto e opaco de propósito.
  token text not null,
  gclid text not null,
  -- A query string inteira que a landing page recebeu, sem interpretar —
  -- mesma doutrina de `atribuicao-de-anuncio.ts` (`bruto`): nunca descartar o
  -- payload de origem, é a prova de onde o clique veio.
  query_raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Preenchido quando uma mensagem com este token chega no WhatsApp e o match
  -- acontece. Diferente de `contacts.source_metadata` (que só grava no
  -- PRIMEIRO toque do contato), este carimbo é sobre o CLIQUE: um clique só
  -- pode ser consumido uma vez, e é isto que a UPDATE condicional em
  -- `lib/plataformas-de-anuncio/google/atribuicao.ts` garante.
  matched_at timestamptz,
  contact_id uuid references public.contacts(id) on delete set null
);

-- Um token só pode significar uma coisa DENTRO da organização que o criou —
-- mesma disciplina do índice de `ad_platform_connections` (0213): filtrar só
-- por token sem a organização é a classe de bug da #236.
create unique index if not exists google_ads_click_refs_org_token_uk
  on public.google_ads_click_refs (organization_id, token);

comment on table public.google_ads_click_refs is
  'Par token curto ↔ gclid, criado quando a landing page recebe um clique de anúncio e consultado quando a mensagem do WhatsApp chega com o token no texto. Vestíbulo do clique antes de existir um contato para carimbar. Server-side only, mesmo desenho de google_ads_landing_pages.';
comment on column public.google_ads_click_refs.token is
  'Código opaco no texto pré-preenchido do wa.me — não o gclid cru, que fica só nesta linha.';
comment on column public.google_ads_click_refs.matched_at is
  'Carimbado no match com a mensagem recebida. Um clique só casa uma vez: a UPDATE que o faz é condicional a matched_at is null.';

alter table public.google_ads_click_refs enable row level security;
revoke all on public.google_ads_click_refs from anon, authenticated;
grant select, insert, update, delete on public.google_ads_click_refs to service_role;
