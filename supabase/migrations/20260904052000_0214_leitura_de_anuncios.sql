-- 0214 · Quem paga a mídia não via a mídia.
--
-- ─── O buraco que isto fecha ────────────────────────────────────────────────
-- A 0213 fechou o caminho de VOLTA: a venda fechada no CRM vira conversão na
-- plataforma. O caminho de IDA continuou fora do produto — para saber quanto
-- custou o lead que ele acabou de atender, o dono do tráfego abria o
-- Gerenciador de Anúncios numa aba separada e comparava a olho com o funil daqui.
--
-- Esta migration guarda a credencial que deixa o CRM LER as métricas da conta de
-- anúncios (campanhas, gasto, resultado, custo por resultado) e mostrá-las na
-- tela `/app/ads/meta`, ao lado do resto da análise.
--
-- ─── Por que uma TABELA NOVA, e não uma coluna em `ad_platform_connections` ──
-- A pergunta é legítima: as duas guardam "um token da Meta por organização", e
-- duplicar estrutura é o anti-pattern 2 desta casa. São quatro razões, e a
-- primeira sozinha já decide:
--
--  1. O índice único da 0213 é `(organization_id, platform)` — UMA linha por
--     plataforma por organização. Os dois tokens têm ESCOPOS DIFERENTES na Meta
--     (a 0213 quer permissão de escrita no dataset de conversões; esta quer
--     `ads_read`) e não são o mesmo segredo. Não cabem na mesma linha sem uma
--     coluna nova, e a coluna nova traz as três razões seguintes junto.
--
--  2. `enabled` é UM interruptor. Ele existe na 0213 para PAUSAR o envio de
--     conversões preservando a credencial. Se as duas features dividissem a
--     linha, pausar o envio apagaria o dashboard, e ligar o dashboard religaria
--     o envio — dois ciclos de vida atrás de um botão só.
--
--  3. `dataset_id` e `test_event_code` são vocabulário de CONVERSÃO. Uma linha
--     de leitura os deixaria nulos para sempre, e a tabela passaria a ter
--     colunas cujo significado depende de qual feature escreveu a linha.
--
--  4. Raio de explosão. `lerCredencial()` (`lib/plataformas-de-anuncio/credenciais.ts`)
--     é lido pelo worker que despacha `lead.won`. Um upsert desta feature na
--     linha compartilhada — um `enabled` distraído, um token trocado — derruba
--     o reporte de vendas de quem nunca abriu esta tela.
--
-- O que É reaproveitado, e integralmente: a CIFRA (`fn_encrypt_oauth`, a mesma
-- de `calendar_connections`, `channel_sessions` e da 0213 — sem terceiro caminho
-- de cifra no repo) e a POSTURA (RLS ligada, zero policies, grants revogados).
-- O que não se duplica é o segredo e o interruptor; o mecanismo é um só.
--
-- ─── Por que NÃO existe `enabled` aqui ──────────────────────────────────────
-- Copiá-lo seria cargo cult. Em 0213 ele pausa um worker que roda sozinho e
-- gasta cota de plataforma sem ninguém pedir. Aqui não há nada rodando: a
-- leitura só acontece quando alguém abre a tela e clica em "Atualizar". Um
-- switch "desligado" nesta tabela significaria apenas "a tela não funciona
-- hoje", que é indistinguível de não estar conectada — dois estados com a mesma
-- consequência é um estado a mais para o operador entender à toa.
--
-- Desconectar, portanto, é APAGAR a linha. Ausência = não conectado, e o
-- caminho de volta é colar o token de novo, que é o mesmo trabalho de religar.
--
-- ─── Por que RLS LIGADA com ZERO policies ───────────────────────────────────
-- Mesmo desenho de `platform_google_oauth` (0201) e da 0213, pelo mesmo motivo:
-- a anon key VAI PARA O BROWSER, e tabela com RLS ligada sem policy nenhuma e
-- com grants de anon/authenticated revogados não é servida pelo PostgREST de
-- jeito nenhum — só o `service_role`, que vive no servidor.
--
-- Um token `ads_read` é MENOS perigoso que o da 0213 (lê, não escreve), e ainda
-- assim expõe o orçamento, o criativo e a performance de quem anuncia — dado
-- comercial que um concorrente pagaria para ver. Não há motivo para afrouxar.
--
-- Nenhuma função nova em `public` ⇒ nenhuma superfície `security definer` nova
-- ⇒ o item 9 da doutrina de migrations não é acionado por este arquivo.

-- ─────────────────────────────────────────────────────────────────────────────
-- A conexão de LEITURA com a plataforma de anúncios
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ad_insights_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Mesmo vocabulário agnóstico da 0213 (`PlataformaDeAnuncio`): a plataforma
  -- que hospeda o anúncio, não o nome do endpoint que a lê.
  platform text not null,
  access_token_encrypted bytea not null,
  -- A conta que a tela abre por padrão, quando o token alcança várias.
  -- Nullable: na primeira conexão ainda não houve escolha, e a tela seleciona a
  -- primeira conta ativa até alguém decidir outra. NÃO é FK — o identificador é
  -- da Meta, não nosso, e a conta pode sair do alcance do token sem aviso.
  default_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint ad_insights_connections_platform_conhecida
    check (platform in ('meta_ads', 'google_ads'))
);

-- Uma conexão de leitura por plataforma por organização. Mesma lição da 0213 e
-- da #236: sem isto, dois saves distraídos deixariam duas linhas e o handler
-- leria a errada em silêncio.
create unique index if not exists ad_insights_connections_org_platform_uk
  on public.ad_insights_connections (organization_id, platform);

comment on table public.ad_insights_connections is
  'Credencial de LEITURA da conta de anúncios da organização, para o painel /app/ads/meta. Separada de ad_platform_connections de propósito: escopo de token diferente (ads_read), ciclo de vida diferente e nenhum risco de derrubar o envio de conversões. Server-side only: RLS ligada sem policies e grants revogados de anon/authenticated. O token nunca volta ao browser.';
comment on column public.ad_insights_connections.access_token_encrypted is
  'Cifrado por fn_encrypt_oauth (pgp_sym/aes256), a mesma cifra de calendar_connections, channel_sessions e ad_platform_connections. NOT NULL: uma linha sem token não descreve conexão nenhuma, e aqui não existe estado "conectado mas pausado" para justificá-la.';
comment on column public.ad_insights_connections.default_account_id is
  'act_<id> que a tela abre por padrão. Sem FK: o identificador é da Meta e a conta pode sair do alcance do token sem aviso.';

alter table public.ad_insights_connections enable row level security;
revoke all on public.ad_insights_connections from anon, authenticated;
grant select, insert, update, delete on public.ad_insights_connections to service_role;

drop trigger if exists trg_ad_insights_connections_updated_at on public.ad_insights_connections;
create trigger trg_ad_insights_connections_updated_at
  before update on public.ad_insights_connections
  for each row execute function public.fn_set_updated_at();
