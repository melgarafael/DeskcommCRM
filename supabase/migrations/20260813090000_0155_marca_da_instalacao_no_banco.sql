-- ============================================================================
-- 0155 — A MARCA DA INSTALAÇÃO SAI DO `.env` E VAI PARA O BANCO.
--
-- Hoje nome, logo e cor da instalação vivem só em `APP_NAME` / `APP_LOGO_URL` /
-- `APP_ACCENT_HEX`. Trocar qualquer um exige SSH na VPS, editar o `.env` e
-- reiniciar a stack — para o público-alvo do kit (quem compra hospedagem e
-- instala sozinho) isso é o mesmo que não ser configurável. A configuração passa
-- a viver aqui, e o `.env` continua sendo DUAS coisas: a SEMENTE da primeira
-- leitura e a REDE DE SEGURANÇA de rollback.
--
-- ─── Por que o `.env` continua sendo escrito (isto não é redundância) ────────
--
-- O `agent.sh` do kit, em falha de update, reverte só a IMAGEM (`APP_IMAGE`) —
-- não o schema, não o `git checkout`. O clone fica com CÓDIGO ANTIGO sobre BANCO
-- NOVO, por construção: o `update.sh` aplica o baseline ANTES de puxar a imagem.
-- Código antigo não conhece esta tabela; se a marca só existisse aqui, ele
-- leria o `.env` vazio e a marca do revendedor SUMIRIA no meio de um rollback —
-- exatamente o momento em que ninguém quer descobrir mais um problema. Com o
-- `.env` intacto, a marca degrada para o valor da instalação e a tela continua
-- sendo a do cliente.
--
-- ⚠️ CORREÇÃO DE 2026-08-14 — a rede cobre NOME E LOGO, não a cor.
--
-- O parágrafo acima foi escrito como se valesse para as três colunas. Vale para
-- duas. `install.sh` grava `APP_NAME` e `APP_LOGO_URL` no `.env` e NÃO grava
-- `APP_ACCENT_HEX` (medido: `grep -c APP_ACCENT_HEX hostgator-setup-kit/install.sh`
-- → 0, contra 7 de `APP_NAME`) — a chave só existe em `.env.example`, e o `.env`
-- é escrito com truncamento, então quem a puser à mão a perde no install
-- seguinte.
--
-- E, mais fundo que isso: para COR a rede é vazia POR CONSTRUÇÃO, não por
-- descuido. `APP_ACCENT_HEX` nasceu neste mesmo épico, junto com esta tabela.
-- Não existe versão do app velha o bastante para desconhecer `platform_branding`
-- e ainda assim pintar accent a partir do `.env` — quem não conhece a tabela
-- também não conhece a variável. Gravar a cor no `.env` seria semente e proteção
-- contra o truncamento do install, não rollback.
--
-- O `comment on table` do `supabase/baseline.sql` já carrega a redação
-- corrigida. Aqui embaixo ele fica como foi aplicado: migration já aplicada não
-- se reescreve, corrige-se por forward-fix — e nesta linha a diferença é de
-- redação, não de comportamento.
--
-- ─── Singleton, e por que ele é uma linha e não uma coluna em `organizations` ─
--
-- DIRC responde **D — Duplicar? Não; vive aqui mesmo**. Esta é a marca da
-- INSTALAÇÃO (o que pinta o login, o e-mail de recuperação, o 500) — telas onde
-- ainda não há organização resolvida: 6 dos 8 call sites de `lib/branding` estão
-- nessa situação. Pendurá-la numa organização obrigaria a escolher uma
-- arbitrariamente antes de o usuário existir. A marca POR organização é outra
-- coisa, mora em `organizations.settings.branding`, e é a fase seguinte.
--
-- `id smallint primary key default 1` + CHECK `id = 1`: a chave existe para que
-- `on conflict (id)` seja expressável e para que a segunda linha seja recusada
-- pelo banco, não pela disciplina de quem escreve a query.
--
-- ─── `fallback_at` / `fallback_reason` são ESTADO, não configuração ──────────
--
-- Invariante 6 da doutrina Sistema Vivo: informação com propósito. Quando a
-- serialização recusa a cor configurada (valor fora da allowlist de forma,
-- envelope malformado, saída suspeita), o produto degrada para a cor dele — e
-- SEM estas duas colunas esse degrade é indistinguível de "a feature nunca foi
-- instalada". O operador veria a cor do produto e concluiria que o campo não
-- funciona. Com elas, a recusa fica gravada com QUANDO e POR QUÊ.
--
-- `fallback_reason` guarda FORMA, nunca IDENTIDADE — nenhum hex de marca entra
-- aí (mesma disciplina de `lib/branding/resolve.ts`). Quem escreve é
-- `lib/branding/instalacao.ts`, no caminho de render, e quem LIMPA é o mesmo
-- código quando a resolução volta a passar: alarme que não apaga sozinho ensina
-- a ignorar alarme.
--
-- ─── `accent_hex`: CHECK de REGEX, não de conjunto ──────────────────────────
--
-- ⚠️ Esta coluna NÃO entra na lista `PARES` de
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts`. Aquele invariante
-- extrai o vocabulário de um CHECK `= ANY (ARRAY[...])`; sobre um `~ '^#...'`
-- ele não teria conjunto nenhum para comparar e estouraria. A doutrina "coluna
-- nova com CHECK → uma linha ali" vale para CHECK de CONJUNTO; está escrito no
-- cabeçalho daquele arquivo e repetido aqui porque a leitura apressada é a que
-- "completa" o schema e quebra o gate.
--
-- Regex de 6 dígitos e minúsculo de propósito: é a forma que `normalizarHex`
-- (`lib/branding/rampa.ts`) emite. Aceitar `#FFF` aqui criaria duas grafias da
-- mesma cor no banco e a comparação "mudou?" passaria a mentir.
--
-- ─── RLS LIGADA COM ZERO POLICIES + REVOKE EXPLÍCITO ────────────────────────
--
-- As duas coisas juntas, e nenhuma substitui a outra:
--
--   (1) `enable row level security` sem NENHUMA policy é a forma explícita de
--       dizer "o PostgREST nunca serve isto". A tabela é lida e escrita
--       exclusivamente server-side, com o admin client (que é `service_role`,
--       `bypassrls`).
--
--   (2) `revoke all ... from anon, authenticated` — ESTE É O ANÁLOGO, PARA
--       TABELA, DA REGRA DE `security definer` DO ITEM 9 DO CLAUDE.md, e não
--       está documentado em lugar nenhum hoje. O `supabase/baseline.sql` traz
--       `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` (linha 3972) e
--       `... TO authenticated` (3973), e eles valem para TODA tabela criada
--       DEPOIS deles — isto é, para todo apêndice novo, e para toda migration
--       aplicada num projeto Supabase de verdade, onde a entrada em
--       `pg_default_acl` é gravada pelo bootstrap antes de qualquer SQL nosso.
--       Tabela nova NASCE CONCEDIDA. Foi exatamente isso que produziu a
--       vulnerabilidade que a 0143 consertou (`org_guardrail_layers`, medido: um
--       `viewer` desligava a camada anti-jailbreak pelo PostgREST — UPDATE 1 +
--       INSERT 1). A 0142 dizia "nenhuma função nova, então não há grant a
--       revogar": leitura de uma doutrina que fala de FUNÇÃO, aplicada a uma
--       TABELA.
--
--       Aqui o revoke vai além do precedente da 0143 (que revogou só de `anon`),
--       e por um motivo medido: RLS sem policy devolve ZERO LINHA para
--       `authenticated`, mas o privilégio continua no catálogo, e é a camada que
--       sobra no dia em que alguém acrescentar "só uma policy de leitura".
--       Nenhuma tela lê esta tabela pelo client de sessão — quem lê é o
--       `app/layout.tsx`, no servidor. Então não há nada a perder revogando.
--
-- ─── Sem `event_log` ────────────────────────────────────────────────────────
--
-- Deliberado, e confirmado lendo `lib/event-log/register-handlers.ts`: os 12
-- handlers registrados cobrem IA, RAG, LGPD, automações, follow-up e mídia —
-- nenhum cobreria um tipo `platform_branding.*`. O drain deixa evento sem
-- handler INTOCADO, então a linha nasceria `pending` para sempre em todo clone.
-- Evento sem consumer é o anti-pattern nº 3 do CLAUDE.md. O registro desta
-- mutação é `audit()`, que tem consumidor real (a tela de auditoria).
--
-- ─── `updated_by` sem FK ────────────────────────────────────────────────────
--
-- É carimbo de PROVENIÊNCIA, não vínculo. Um `references auth.users on delete
-- set null` apagaria o autor quando a conta dele fosse removida — e a pergunta
-- "quem trocou a marca desta instalação?" é feita justamente depois de a pessoa
-- sair. Mesma razão pela qual a linha não é apagada quando o autor some.
--
-- Idempotente e re-aplicável: `create table if not exists`, `drop trigger if
-- exists` antes do `create trigger`, e os grants/revokes são declarativos.
-- ============================================================================

create table if not exists public.platform_branding (
  id                  smallint primary key default 1,
  app_name            text,
  logo_url            text,
  accent_hex          text,
  show_powered_by     boolean     not null default true,
  seeded_from_env     boolean     not null default false,
  -- Estado, não configuração: é o que torna a falha OBSERVÁVEL (invariante 6).
  fallback_at         timestamptz,
  fallback_reason     text,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint platform_branding_singleton  check (id = 1),
  constraint platform_branding_accent_hex check (accent_hex is null or accent_hex ~ '^#[0-9a-f]{6}$')
);

comment on table public.platform_branding is
  'Marca da INSTALAÇÃO (login, e-mail, 500) — linha única id=1. Semeada do .env na primeira leitura; o .env continua sendo a rede de segurança de rollback. Lida/escrita só server-side (service_role). Ver lib/branding/instalacao.ts.';

comment on column public.platform_branding.seeded_from_env is
  'true = os valores vieram do .env e ninguém os editou pela tela. A escrita humana zera isto, e é o que impede a semeadura de reescrever o que uma pessoa apagou de propósito.';

comment on column public.platform_branding.fallback_at is
  'Quando a cor configurada foi RECUSADA e o produto caiu na cor dele. NULL = nenhuma recusa em vigor. Sem esta coluna o degrade é indistinguível de "a feature nunca foi instalada".';

comment on column public.platform_branding.fallback_reason is
  'Códigos de recusa (FORMA, nunca o hex da marca). Escrito e limpo por lib/branding/instalacao.ts.';

alter table public.platform_branding enable row level security;

-- ZERO POLICIES, DE PROPÓSITO. Ver o bloco "RLS LIGADA COM ZERO POLICIES" acima:
-- é a forma explícita de dizer que o PostgREST não serve esta tabela.

revoke all on public.platform_branding from anon, authenticated;
grant select, insert, update on public.platform_branding to service_role;

drop trigger if exists trg_platform_branding_touch on public.platform_branding;
create trigger trg_platform_branding_touch
  before update on public.platform_branding
  for each row execute function public.fn_touch_updated_at();
