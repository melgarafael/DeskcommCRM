-- 0341 — A configuração da INSTALAÇÃO sai do `.env` e passa a caber na tela.
--
-- ── O problema ───────────────────────────────────────────────────────────────
--
-- Trocar a chave de IA, o token do WAHA ou o remetente de e-mail exige SSH na
-- VPS, editar o `.env` e recriar os contêineres. Para o público do kit — quem
-- compra hospedagem e instala sozinho — isso é o mesmo que não ser configurável.
-- A marca (0155) e a credencial do Google (0201) já fizeram essa travessia; esta
-- migration generaliza o caminho para o resto da configuração.
--
-- ── Por que LINHAS e não COLUNAS ─────────────────────────────────────────────
--
-- `platform_branding` e `platform_settings` são singletons com uma coluna por
-- campo, e para 3 ou 4 campos isso é o certo. Aqui não serve, por duas razões
-- medidas:
--
--   1. ESCALA. São 42 chaves candidatas (27 migráveis + 15 knobs). Cifrada, cada
--      credencial ocupa quatro campos (ciphertext, iv, tag, last4) — a tabela
--      passaria de 150 colunas, e cada chave nova seria um ALTER.
--
--   2. O TUDO-OU-NADA. O cabeçalho de `lib/branding/instalacao.ts` documenta que
--      coluna nova em singleton é tudo-ou-nada por construção: código novo sobre
--      schema velho faz o PostgREST devolver `42703` para a LINHA INTEIRA, e a
--      marca toda cai no `.env`. Numa tabela de linhas esse modo de falha não
--      existe: chave que o banco ainda não tem é simplesmente linha ausente, e
--      linha ausente JÁ significa "usa o `.env`" — que é o mesmo desfecho, sem
--      derrubar as outras 41 no caminho.
--
-- ── Por que a cifra é da APLICAÇÃO e não do banco ────────────────────────────
--
-- O repositório tem DOIS padrões de cifra convivendo, e a escolha entre eles não
-- é estética:
--
--   • `fn_encrypt_oauth` (0201/0257) cifra no banco com `pgp_sym_encrypt`, e a
--     chave mora em `private.app_secrets`, semeada pelo kit.
--   • `lib/crypto/aes_gcm.ts` cifra na aplicação (AES-256-GCM), e a chave mora
--     só no `.env` (`AI_CRED_AES_KEY`). É o que já protege
--     `ai_provider_credentials`, com nove consumidores.
--
-- O `backup.sh` do kit roda `pg_dump` SEM filtrar schema, pela mesma conexão
-- privilegiada que semeia a chave — se a semeadura alcança `private.app_secrets`,
-- o dump também alcança. E o backup NÃO leva o `.env` (só banco + sessões do
-- WhatsApp). Com a cifra do banco, portanto, um arquivo de backup vazado entrega
-- a chave e o cofre juntos. Isso é tolerável para um segredo do Google; deixa de
-- ser quando o cofre guarda TODAS as credenciais da instalação.
--
-- Por isso esta tabela guarda o envelope AES-GCM cru (`ciphertext`/`iv`/`tag`) e
-- nenhuma função do banco sabe abri-lo. Backup vazado sem o `.env` é ruído.
--
-- ── `semeado_do_env` não é enfeite de proveniência ───────────────────────────
--
-- É o que impede o `.env` de desfazer uma escolha humana, e a regra vem inteira
-- de `precisaSemear` em `lib/branding/instalacao.ts`: a escrita pela tela zera o
-- campo, e linha com `semeado_do_env = false` NUNCA é semeada de novo. Sem isso,
-- o valor antigo do `.env` reescreveria no próximo boot o que a pessoa acabou de
-- digitar, e o campo pareceria não funcionar.
--
-- Apagar a linha é o "voltar ao padrão": sem linha, o resolvedor lê o `.env` de
-- novo e pode semear outra vez. Por isso `delete` entra no grant.
--
-- Sem dado tocado, sem backfill: tabela nova, vazia, e o resolvedor degrada para
-- o `.env` enquanto ela estiver assim.

create table if not exists public.platform_config (
  chave           text        primary key,
  valor           text,
  ciphertext      bytea,
  iv              bytea,
  tag             bytea,
  last4           text,
  eh_segredo      boolean     not null default false,
  semeado_do_env  boolean     not null default false,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  -- A chave É o nome da variável de ambiente, para que a correspondência
  -- banco ↔ `.env` seja literal e conferível por quem opera a VPS.
  constraint platform_config_chave_formato
    check (chave ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- Segredo e knob são formas mutuamente exclusivas da mesma linha. Sem este
  -- XOR, uma linha poderia ter `valor` em claro E envelope cifrado — e o
  -- resolvedor teria de escolher, o que é como um segredo vaza em claro.
  constraint platform_config_forma_do_valor check (
    (eh_segredo
       and ciphertext is not null and iv is not null and tag is not null
       and valor is null)
    or
    (not eh_segredo
       and valor is not null
       and ciphertext is null and iv is null and tag is null)
  )
);

comment on table public.platform_config is
  'Configuração da INSTALAÇÃO editável pela tela (não do tenant): uma linha por variável, nomeada como a própria variável de ambiente. Linha ausente = usa o .env. Segredo guarda envelope AES-256-GCM cru (lib/crypto/aes_gcm.ts, chave em AI_CRED_AES_KEY, fora do banco de propósito — ver o cabeçalho da migration 0341); knob guarda texto. Lida/escrita só server-side por service_role. Ver lib/instalacao/config.ts.';

comment on column public.platform_config.semeado_do_env is
  'true = o valor veio do .env por semeadura automática e pode ser re-semeado. false = uma pessoa escreveu pela tela, e o .env NUNCA sobrescreve. Mesma regra de platform_branding.seeded_from_env (0155).';

comment on column public.platform_config.last4 is
  'Últimos 4 caracteres do segredo, para a tela identificar QUAL chave está lá sem nunca devolver o valor. Null para knob.';

-- ZERO POLICIES, DE PROPÓSITO — mesma decisão de `platform_branding` (0155) e
-- `platform_settings` (0253): esta linha não pertence a organização nenhuma,
-- então não há predicado de tenant que a isole. RLS ligada sem policy = ninguém
-- alcança pela REST; quem lê é o service_role, que a bypassa, e só do servidor.
alter table public.platform_config enable row level security;

-- As DUAS origens de grant, e tratar só uma deixa a tabela exposta com o gate
-- verde: (A) o `alter default privileges ... on tables to anon` do baseline
-- alcança TODA tabela criada depois dele — isto é, todo apêndice novo; (B) o
-- grant que o Postgres dá ao dono. O repositório já registra alguém que
-- conhecia a doutrina e errou exatamente aqui.
revoke all on public.platform_config from anon, authenticated;
grant select, insert, update, delete on public.platform_config to service_role;

drop trigger if exists trg_platform_config_touch on public.platform_config;
create trigger trg_platform_config_touch
  before update on public.platform_config
  for each row execute function public.fn_touch_updated_at();

notify pgrst, 'reload schema';
