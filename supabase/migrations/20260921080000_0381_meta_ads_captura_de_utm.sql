-- 0381 · O ref curto que leva as UTMs da landing page até a conversa do WhatsApp.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- Das três fontes de tráfego que chegam ao WhatsApp, duas já rastreiam sozinhas:
-- a campanha de conversão para WhatsApp manda o `referral` nativo no webhook, e
-- o formulário da página faz POST direto ao webhook (`lib/webhooks/inbound.ts`
-- aceita qualquer chave `utm_*`). Sobra a PÁGINA COM BOTÃO DE WHATSAPP, e o
-- motivo é físico: o link `wa.me` não fala com o CRM — ele abre o aplicativo no
-- aparelho da pessoa, e o servidor nunca vê aquele clique. A única coisa que
-- chega depois é o TEXTO da mensagem.
--
-- Hoje esse caso é atendido pelo contrato `[dk1:<base64url>]`
-- (`lib/leads/origem-do-site.ts`), que funciona e CONTINUA valendo — esta
-- migration não o depreca. O que ela troca são os dois custos de USO dele: o
-- lead vê ~200 caracteres de base64 dentro da própria mensagem, e quem monta a
-- página precisa colar um script (o marcador tem de ser gerado por visitante, e
-- link estático não gera nada).
--
-- Com as tabelas abaixo, a página aponta o botão para um endereço do próprio
-- CRM: ele guarda as UTMs do lado do servidor e manda a pessoa ao WhatsApp com
-- `[ref:XXXXXX]` no texto — onze caracteres em vez de duzentos, e nenhum script.
--
-- ─── Não é desenho novo: é a captura do Google Ads espelhada ───────────────
-- A migration 0306 já criou exatamente este par de tabelas para o `gclid`
-- (`google_ads_landing_pages` + `google_ads_click_refs`), e o mecanismo do
-- token curto é o MESMO código (`lib/plataformas-de-anuncio/captura-de-clique.ts`).
-- O que muda é o DADO guardado: lá um clique pago identificado por `gclid`,
-- aqui as UTMs que a página ou a macro de URL do anúncio trouxe na query.
--
-- Duas tabelas e não uma com coluna de plataforma, pela mesma razão do cabeçalho
-- da 0306: cada eixo de captura nasce e funciona sozinho, e mexer no par do
-- Google para acomodar o da Meta faria uma landing page em produção depender de
-- uma alteração de chave primária que ela não pediu.
--
-- ─── Por que RLS ligada com ZERO policies, nas duas ────────────────────────
-- Mesmo desenho de `ad_platform_connections` (0213) e da própria 0306: a anon
-- key vai para o browser, e nenhuma tela lê estas tabelas do lado do cliente. A
-- UTM é dado comercial de quem anuncia (diz quanto e onde a organização gasta),
-- e quem lê é o servidor, com o admin client, filtrando `organization_id` à mão.
--
-- ─── O que fica sem varredor, declarado ─────────────────────────────────────
-- `meta_ads_click_refs` não tem cron de limpeza nesta versão, igual à irmã do
-- Google: uma linha nunca casada (clique que nunca virou mensagem) fica para
-- sempre. Fica registrado como dívida, não como omissão.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Para onde o botão da landing page redireciona
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.meta_ads_landing_pages (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  -- E.164 COM `+`, o mesmo formato de `contacts.phone_number`
  -- (`lib/channels/phone-variants.ts`).
  whatsapp_e164 text not null,
  -- O texto pré-preenchido do link `wa.me`. Contém literalmente `{token}`,
  -- substituído pelo ref do clique no momento do redirect.
  message_template text not null default 'Olá! Vim pelo site. [ref:{token}]',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint meta_ads_landing_pages_template_tem_placeholder
    check (message_template like '%{token}%')
);

comment on table public.meta_ads_landing_pages is
  'Configuração do redirecionamento de captura de UTM, por organização: para qual WhatsApp e com qual texto pré-preenchido a rota pública manda quem clicou no botão da landing page. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated.';
comment on column public.meta_ads_landing_pages.message_template is
  'Precisa conter o literal {token}: é onde o ref do clique é injetado antes do redirect para o wa.me.';

alter table public.meta_ads_landing_pages enable row level security;
revoke all on public.meta_ads_landing_pages from anon, authenticated;
grant select, insert, update, delete on public.meta_ads_landing_pages to service_role;

drop trigger if exists trg_meta_ads_landing_pages_updated_at on public.meta_ads_landing_pages;
create trigger trg_meta_ads_landing_pages_updated_at
  before update on public.meta_ads_landing_pages
  for each row execute function public.fn_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. O par ref↔UTM, do clique até o match com a mensagem
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.meta_ads_click_refs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- O ref curto embutido no texto pré-preenchido — o que a mensagem do WhatsApp
  -- carrega de volta. Mesmo alfabeto e mesmo tamanho do token da 0306, porque é
  -- o mesmo gerador.
  token text not null,
  -- As UTMs já NORMALIZADAS: só as chaves de `CHAVES_DE_UTM`
  -- (`lib/leads/origem-do-site.ts`), com o mesmo teto por valor do `[dk1:]`.
  -- Nunca vazio: um ref que não aponta para origem nenhuma só sujaria a
  -- mensagem do lead, e a rota não chega a gravar nesse caso.
  utm jsonb not null,
  -- A query string inteira que a rota recebeu, sem interpretar — mesma doutrina
  -- de `atribuicao-de-anuncio.ts` (`bruto`): nunca descartar o payload de
  -- origem, é a prova de onde o clique veio.
  query_raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Preenchido quando uma mensagem com este ref chega no WhatsApp e o match
  -- acontece. Um clique só pode ser consumido uma vez, e quem garante isso é a
  -- UPDATE condicional a `matched_at is null`.
  matched_at timestamptz,
  contact_id uuid references public.contacts(id) on delete set null,
  constraint meta_ads_click_refs_utm_nao_vazio check (utm <> '{}'::jsonb)
);

-- Um ref só pode significar uma coisa DENTRO da organização que o criou — mesma
-- disciplina do índice da 0306 e de `ad_platform_connections` (0213): filtrar só
-- por token sem a organização é a classe de bug da #236.
create unique index if not exists meta_ads_click_refs_org_token_uk
  on public.meta_ads_click_refs (organization_id, token);

comment on table public.meta_ads_click_refs is
  'Par ref curto ↔ UTM, criado quando a rota pública recebe o clique do botão da landing page e consultado quando a mensagem do WhatsApp chega com o ref no texto. Vestíbulo do clique antes de existir um contato para carimbar. Server-side only, mesmo desenho de google_ads_click_refs (0306).';
comment on column public.meta_ads_click_refs.utm is
  'Só as chaves de CHAVES_DE_UTM, já normalizadas — o que não é chave de campanha não atravessa.';
comment on column public.meta_ads_click_refs.matched_at is
  'Carimbado no match com a mensagem recebida. Um clique só casa uma vez: a UPDATE que o faz é condicional a matched_at is null.';

alter table public.meta_ads_click_refs enable row level security;
revoke all on public.meta_ads_click_refs from anon, authenticated;
grant select, insert, update, delete on public.meta_ads_click_refs to service_role;
