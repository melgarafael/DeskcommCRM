-- 0213 · A venda fechava no CRM e o anúncio nunca ficava sabendo.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- Desde a 0164 o sistema CAPTURA de qual anúncio o contato veio: o `ctwa_clid`
-- é estampado em `contacts.source_metadata` pelo `fn_estampar_atribuicao_de_anuncio`,
-- com guarda de primeiro toque. Esse dado era SÓ DE ESCRITA — nada o lia de
-- volta. Quem paga tráfego ficava com a metade inútil do par: sabia de onde o
-- lead veio e não conseguia dizer à plataforma quais leads viraram dinheiro,
-- que é exatamente o sinal de que o otimizador precisa para achar mais gente
-- como quem comprou.
--
-- ─── Por que ORGANIZAÇÃO, e não instalação ──────────────────────────────────
-- Diferente de `platform_google_oauth` (0201), que é singleton porque o
-- `redirect_uri` sai do `NEXT_PUBLIC_APP_URL` da instalação. Aqui o objeto é a
-- CONTA DE ANÚNCIOS: o dataset e o token pertencem ao negócio que anuncia. Uma
-- agência que hospeda dois clientes na mesma VPS tem dois datasets, e um
-- singleton faria a venda de um cliente ser reportada na conta do outro.
--
-- E o eixo é INDEPENDENTE do canal de mensagem: dá para receber lead de anúncio
-- clique-para-WhatsApp num número servido por qualquer transporte. Guardar esta
-- credencial em `channel_sessions` amarraria "reportar venda" a "ter canal
-- oficial conectado" — e quebraria justamente quem mais usa esse tipo de anúncio.
--
-- ─── Por que RLS LIGADA com ZERO policies ───────────────────────────────────
-- Mesmo desenho de `platform_google_oauth` (0201) e pelo mesmo motivo: a anon
-- key VAI PARA O BROWSER. Tabela com RLS ligada, sem policy nenhuma e com os
-- grants de anon/authenticated revogados não é servida pelo PostgREST de jeito
-- nenhum — só o `service_role`, que vive no servidor, a alcança.
--
-- O token de conversões escreve na conta de anúncios do cliente. Vazá-lo deixa
-- terceiro injetar conversão falsa e envenenar o otimizador de quem paga.
--
-- ─── A cifra é a que já existe ──────────────────────────────────────────────
-- `fn_encrypt_oauth`/`fn_decrypt_oauth` (0041), as mesmas de `calendar_connections`,
-- de `channel_sessions` e do `lib/webhooks/secrets.ts`. Nenhuma função nova em
-- `public` ⇒ nenhuma superfície `security definer` nova ⇒ o item 9 da doutrina
-- de migrations não é acionado por este arquivo.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A conexão com a plataforma de anúncios
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ad_platform_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Slug agnóstico do vocabulário de `PlataformaDeAnuncio` (0164). NÃO é nome de
  -- transporte: `meta_ads` é a plataforma que hospeda o anúncio, e continua a
  -- mesma se o endpoint de conversões mudar de forma amanhã.
  platform text not null,
  -- O destino das conversões na plataforma. Nome do campo é genérico de
  -- propósito: cada plataforma chama o seu de um jeito.
  dataset_id text,
  access_token_encrypted bytea,
  -- Código de teste do painel da plataforma. Enquanto preenchido, o evento vai
  -- marcado como teste e NÃO conta para otimização — é o que deixa validar o
  -- encanamento sem sujar a conta.
  test_event_code text,
  -- Desligar sem apagar a credencial. Apagar é outro botão: confundir os dois
  -- faria quem só queria pausar ter de reconseguir o token na Meta.
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint ad_platform_connections_platform_conhecida
    check (platform in ('meta_ads', 'google_ads'))
);

-- Uma conexão por plataforma por organização. Sem isto, dois saves distraídos
-- deixariam duas linhas e o handler leria a errada em silêncio — o mesmo modo de
-- falha que a #236 mediu em `channel_sessions` e que a 0165 fechou com índice.
create unique index if not exists ad_platform_connections_org_platform_uk
  on public.ad_platform_connections (organization_id, platform);

comment on table public.ad_platform_connections is
  'Conexão da organização com a plataforma de anúncios, para reportar conversões offline. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. O token nunca volta ao browser; a tela devolve apenas se existe.';
comment on column public.ad_platform_connections.access_token_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra de calendar_connections e channel_sessions. Nunca gravar em claro: sem a chave mestra o save recusa.';
comment on column public.ad_platform_connections.test_event_code is
  'Enquanto preenchido, os eventos vão marcados como teste e não contam para otimização.';

alter table public.ad_platform_connections enable row level security;
revoke all on public.ad_platform_connections from anon, authenticated;
grant select, insert, update, delete on public.ad_platform_connections to service_role;

drop trigger if exists trg_ad_platform_connections_updated_at on public.ad_platform_connections;
create trigger trg_ad_platform_connections_updated_at
  before update on public.ad_platform_connections
  for each row execute function public.fn_set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. O livro-razão dos envios
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Uma tabela, três trabalhos, e é de propósito:
--
--  (a) IDEMPOTÊNCIA. O `consumed_by` do `event_log` já garante entrega única por
--      handler, mas retry existe e um lead pode mudar de etapa de novo depois de
--      ganho. Contar a mesma venda duas vezes envenena o otimizador — é pior que
--      não contar, porque o erro é invisível e o algoritmo age sobre ele.
--
--  (b) SUPERFÍCIE DE FALHA (invariante 6 da doutrina de restrição de canal, e a
--      lição da #144). Um `return` mudo no worker quando falta configuração
--      deixaria a feature existindo só para quem lê o banco. A tela lê ESTA
--      tabela para dizer "3 vendas não reportadas: valor não preenchido".
--
--  (c) PROVA. O que foi mandado, quando, com qual veredito.
--
-- Uma linha por (organização, lead, evento): o handler faz upsert e nunca
-- rebaixa um `sent`. Assim a tela mostra o ESTADO ATUAL de cada venda, não um
-- histórico que cresce sem fim e que ninguém consegue ler.

create table if not exists public.ad_conversion_dispatches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  platform text not null,
  event_name text not null,
  -- `sent` | `skipped` | `error`. Espelha o vocabulário do HandlerResult do
  -- dispatcher (`lib/event-log/dispatcher.ts`) menos o `retry`, que é estado
  -- transitório do drain e não desfecho.
  status text not null,
  -- Razão legível e ESTÁVEL (`sem_atribuicao`, `sem_valor`, `sem_conexao`,
  -- `plataforma_sem_transporte`, …). A tela traduz; o banco guarda o slug, para
  -- a contagem não depender do idioma de quem salvou.
  reason text,
  -- Chave de deduplicação enviada à plataforma. Determinística
  -- (`<lead>:<evento>`): se o mesmo envio escapar duas vezes daqui, a plataforma
  -- ainda descarta a segunda cópia. Duas camadas, porque uma falha em silêncio.
  event_id text,
  value_cents bigint,
  currency text,
  detail text,
  attempted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ad_conversion_dispatches_lead_event_uk
  on public.ad_conversion_dispatches (organization_id, lead_id, event_name);

-- A tela abre em "o que precisa de mim": as pendências primeiro, por organização.
create index if not exists ad_conversion_dispatches_org_status_idx
  on public.ad_conversion_dispatches (organization_id, status, attempted_at desc);

comment on table public.ad_conversion_dispatches is
  'Livro-razão dos envios de conversão: idempotência (uma linha por lead+evento), superfície de falha para a tela, e prova do que foi mandado. Server-side only, como ad_platform_connections.';
comment on column public.ad_conversion_dispatches.reason is
  'Slug estável do motivo. Invariante 4 da doutrina de restrição de canal: envio que não se aplica é REGISTRADO, nunca omitido em silêncio.';

alter table public.ad_conversion_dispatches enable row level security;
revoke all on public.ad_conversion_dispatches from anon, authenticated;
grant select, insert, update, delete on public.ad_conversion_dispatches to service_role;

drop trigger if exists trg_ad_conversion_dispatches_updated_at on public.ad_conversion_dispatches;
create trigger trg_ad_conversion_dispatches_updated_at
  before update on public.ad_conversion_dispatches
  for each row execute function public.fn_set_updated_at();
