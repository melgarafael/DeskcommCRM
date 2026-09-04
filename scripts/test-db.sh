#!/usr/bin/env bash
# gov-loop G1-02 — baseline install+update gate + RLS isolation invariants.
#
# Sobe um Postgres efêmero (pgvector/pgvector:pg17), aplica supabase/baseline.sql
# em modo install e depois em modo update — as DUAS passadas com ON_ERROR_STOP=1,
# que é o que torna a segunda uma prova de idempotência e não só um "terminou"
# (issue #184) — e roda a suíte vitest de invariantes (tests/invariants/**)
# conectada ao container via `docker exec psql`, com a ordem dos arquivos
# EMBARALHADA e cada arquivo num banco próprio (issue #207).
# O container é SEMPRE derrubado no EXIT (sucesso ou falha).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
# A PORTA: quem PEDE escolhe; quem não pede deixa o Docker escolher.
#
# Antes era 54329 fixo, e duas sessões rodando `test:db` ao mesmo tempo colidiam:
# a segunda morria com `Bind for 127.0.0.1:54329 failed: port is already
# allocated` e exit 125, ANTES de aplicar o baseline — um vermelho que não fala
# de schema nenhum. O contorno era combinar `TEST_DB_PORT` a mão entre as
# sessões, o que é disciplina onde devia ser mecanismo.
#
# Procurar uma porta livre e depois pedi-la teria uma corrida entre o "está
# livre" e o "me dá": duas sessões podem ver a mesma porta livre no mesmo
# instante. Publicar em `127.0.0.1::5432` faz o DAEMON alocar e devolver — não
# há janela. A porta efetiva é lida depois com `docker port`.
PORT_PEDIDA="${TEST_DB_PORT:-}"
PUBLICACAO="127.0.0.1::5432"
[ -n "$PORT_PEDIDA" ] && PUBLICACAO="127.0.0.1:${PORT_PEDIDA}:5432"

# O NOME não diz de quem é o container. Quando duas sessões precisam limpar "só
# os seus", a única saída hoje é inferir por porta publicada ou por prefixo de
# nome — e foi assim que uma limpeza de containers de uma sessão passou por cima
# dos de outra. Os labels fazem "só os meus" ser uma query:
#   docker ps --filter label=deskcomm.worktree=$PWD
DONO_WORKTREE="$ROOT"
DONO_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || echo desconhecida)"
CONTAINER="deskcomm-test-db-$$"
# pg15 e não pg17: o piso real do baseline é pg15 (`security_invoker` em view,
# baseline.sql:1215). O 17 vinha de 9 `GRANT … MAINTAIN` que o `pg_dump` de um
# projeto Supabase pg17 emitiu sozinho ao serializar o ACL das tabelas
# append-only — ninguém os escreveu, e nenhum código do projeto usa o
# privilégio. Testar no piso é o que faz este gate cobrir a instalação mais
# pobre que dizemos suportar, em vez da mais rica que temos à mão.
# Quem guarda o piso é tests/unit/baseline-no-piso-do-postgres.test.ts.
IMAGE="pgvector/pgvector:pg15"
# O baseline é aplicado UMA vez, num banco-MOLDE. Cada ARQUIVO de tests/invariants
# recebe uma cópia nova dele — `create database postgres template $TEMPLATE`, ~0,2s
# medidos — feita pelo setupFile declarado em vitest.db.config.ts.
#
# Sem isso os 100 arquivos dividem um único banco global e o veredito do job
# obrigatório `invariants` passa a depender da ORDEM em que o vitest resolveu
# rodá-los (issue #207): medido em a8b09280, 3 de 4 seeds de
# `--sequence.shuffle.files` ficavam vermelhas — por colisão de fixture entre
# arquivos, não por defeito do produto. Gate que sorteia não prova o isolamento
# multi-tenant que ele carrega.
TEMPLATE="inv_baseline"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

# O DETECTOR DE ÁRVORE VIVA — o script desconfiando de si mesmo.
#
# Esta suíte lê o `baseline.sql` no começo e roda por até ~15 minutos. Se alguém
# (ou você, noutra janela) editar o baseline ou um invariante NO MEIO da corrida,
# o veredito do fim não descreve nenhuma árvore que exista: metade dele mediu o
# arquivo antigo. Já aconteceu — 44 minutos de suíte sobre um baseline que estava
# sendo reescrito, e a divergência só apareceu depois, comparando mtime a mão.
#
# `find -newer` em vez de `stat`: `stat -f %m` (BSD/macOS) e `stat -c %Y` (GNU/CI)
# têm sintaxes incompatíveis, e um detector que falhe no CI é pior que nenhum.
# ⚠️ SEM `-t`, e com os X explícitos. O `mktemp -t <prefixo>` do BSD (macOS)
# aceita template sem `XXXXXX`; o GNU (Linux, que é o runner do CI) recusa com
# "too few X's in template" e derruba o job em 22 segundos, antes de subir banco
# nenhum. Verde no meu laptop, vermelho no CI — e a branch nunca tinha passado
# por CI para a divergência aparecer.
#
# Esta forma é idêntica nos dois: caminho completo, seis X, sem depender de como
# cada `mktemp` interpreta `-t`.
CARIMBO="$(mktemp "${TMPDIR:-/tmp}/deskcomm-test-db-carimbo.XXXXXX")"
MEDIDOS=("$BASELINE" "$ROOT/tests/invariants" "$ROOT/scripts/test-db.sh" "$ROOT/vitest.db.config.ts")

arvore_mexeu() {
  find "${MEDIDOS[@]}" -type f -newer "$CARIMBO" 2>/dev/null | head -20
}

cleanup() {
  echo "==> teardown: removendo container $CONTAINER"
  # `-v` REMOVE OS VOLUMES ANÔNIMOS, e sem ele cada rodada vazava ~68 MB.
  #
  # `pgvector/pgvector:pg17` declara `VOLUME /var/lib/postgresql/data` no
  # Dockerfile (`docker image inspect … .Config.Volumes`), então todo container
  # criado sem `-v` explícito ganha um volume ANÔNIMO. O `--rm` do `docker run`
  # cuidaria disso ao término normal, mas quem chega primeiro é este trap, e
  # `docker rm -f` sem `-v` remove o container e DEIXA o volume.
  #
  # Medido, com contagem antes/depois: `docker rm -f` → +1 volume órfão;
  # `docker rm -fv` → nenhum. Numa máquina de desenvolvimento onde esta suíte
  # roda dezenas de vezes por dia, isso somou **355 volumes órfãos e 24 GB** —
  # o suficiente para encher o disco e derrubar o daemon do Docker, que é como
  # o defeito apareceu (2026-08-25: `No space left on device` em toda escrita,
  # inclusive a do próprio harness).
  #
  # O sintoma não aponta para cá: o disco enche horas depois, e quem paga é a
  # próxima sessão a rodar qualquer coisa.
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  rm -f "$CARIMBO"
}
trap cleanup EXIT

echo "==> subindo $IMAGE como $CONTAINER (worktree $DONO_WORKTREE, branch $DONO_BRANCH)"
docker run -d --rm --name "$CONTAINER" \
  -p "$PUBLICACAO" \
  --label "deskcomm.harness=test-db" \
  --label "deskcomm.worktree=$DONO_WORKTREE" \
  --label "deskcomm.branch=$DONO_BRANCH" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  "$IMAGE" >/dev/null

# A porta EFETIVA só se sabe depois de o daemon alocar.
#
# ⚠️ E ela tem de ser EXPORTADA para o vitest: 49 arquivos de tests/invariants
# abrem conexão TCP em `process.env.TEST_DB_PORT ?? 54329`. Hoje isso funciona
# por acidente — a env do shell de quem chamou é herdada. Com a porta escolhida
# aqui dentro, sem o export os 49 iriam bater na 54329, que é de outra pessoa ou
# de ninguém.
PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || { echo "FATAL: não consegui ler a porta publicada do container" >&2; exit 1; }
export TEST_DB_PORT="$PORT"
echo "    ✓ publicado em 127.0.0.1:$PORT"

# Espera o servidor DEFINITIVO (o initdb sobe um temporário só em socket;
# testar via TCP 127.0.0.1 evita o falso-ready da fase de init).
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -c "select 1" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "FATAL: postgres não ficou pronto em 60s" >&2; exit 1; }

docker exec "$CONTAINER" psql -U postgres -d postgres -q -c "create database $TEMPLATE" >/dev/null

psql_install() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$TEMPLATE" -v ON_ERROR_STOP=1 -q -f - "$@"
}

echo "==> prelude: stubs mínimos do Supabase (roles, auth.uid(), extensions)"
# Um Postgres cru não tem os roles/schemas do Supabase que o baseline (pg_dump) supõe.
# Criamos os stubs mínimos AQUI — nunca editar o baseline.sql pra isso.
psql_install <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- O DEFAULT ACL QUE TODO PROJETO SUPABASE JÁ TEM ANTES DE QUALQUER SQL NOSSO.
--
-- Sem estas 4 linhas o Postgres efêmero NÃO é o banco do produto, e a diferença
-- não é cosmética: ela apaga uma classe inteira de defeito do campo de visão do
-- job `invariants`.
--
-- O `pg_dump` do baseline emite, na linha ~3960, o `ALTER DEFAULT PRIVILEGES ...
-- GRANT ALL ON FUNCTIONS TO anon` — mas ele só o emite PORQUE a entrada já
-- existia no projeto de origem. Num Supabase de verdade (nuvem, que é o que o
-- `hostgator-setup-kit/install.sh` manda o cliente usar, ou a CLI local) essa
-- entrada em `pg_default_acl` é gravada pelo bootstrap do Supabase, ANTES de
-- `install.sh`/`update.sh` rodarem. Consequência: toda função que o baseline cria
-- — inclusive as ~27 do CORPO do dump — nasce com EXECUTE para anon.
--
-- Num Postgres cru, ao contrário, a entrada só passa a existir NA linha 3960 — e
-- as funções do corpo, criadas antes dela, nascem limpas. Medido em 2026-08-08,
-- pg17 descartável, baseline @9249e6f2 aplicado com e sem este bloco:
--
--     sem  -> 0 de 27 SECURITY DEFINER de public executáveis por anon
--     com  -> 6 de 27  (activate_kb_version, fn_decrypt_oauth, fn_encrypt_oauth,
--                       fn_lgpd_cascade_redact_contact, fn_update_budget_consumption,
--                       retrieve_top_k_chunks)
--
-- As mesmas 6, exatamente, que `select ... has_function_privilege('anon', ...)`
-- devolve no `supabase_db_deskcomm-crm` desta máquina hoje. Ou seja: o gate estava
-- verde medindo um universo onde o defeito não pode existir.
--
-- `revoke execute ... from public` no default também é fiel ao produto: no
-- Supabase real o `proacl` das definer de public NÃO tem `=X` (grant a PUBLIC),
-- então lá a exposição vem do grant DIRETO a anon — o caminho que
-- `revoke from public` sozinho não fecha.
alter default privileges for role postgres in schema public grant all on functions to anon;
alter default privileges for role postgres in schema public grant all on functions to authenticated;
alter default privileges for role postgres in schema public grant all on functions to service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;

create schema if not exists auth;
create schema if not exists extensions;

-- O baseline referencia extensions.uuid_generate_v4/gen_random_bytes e os tipos
-- public.vector/public.citext + gin_trgm_ops, mas não cria as extensões (pg_dump).
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;

-- Stubs de storage (o apêndice do baseline cria buckets + policies em storage.objects).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.users (FKs do baseline apontam pra cá).
--
-- `raw_user_meta_data` entrou com a migration 0202 (fn_conversation_assign
-- passou a ler `raw_user_meta_data->>'full_name'` dentro da definer) — é o
-- nome real da coluna no GoTrue, não um apelido do stub.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.uid() lendo o claim `sub` de request.jwt.claims (mesmo contrato
-- do Supabase; os testes simulam o JWT via set_config).
--
-- O CORPO ABAIXO É CÓPIA FIEL do `auth.uid()` do Supabase — conferido em
-- 2026-08-11 com `pg_get_functiondef` no `supabase_db_deskcomm-crm` (imagem
-- supabase/postgres:17.6.1.106). A cópia importa por causa de UM detalhe que a
-- versão anterior deste stub errava:
--
--     antes:  nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
--     real:   nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
--
-- O `nullif` do original protege o CAST; o do stub protegia o resultado. Um GUC
-- customizado que já foi tocado numa transação anterior passa a existir com
-- string VAZIA em vez de NULL — e aí o stub estourava
-- `invalid input syntax for type json` onde o Supabase devolve NULL sossegado.
-- Consequência: qualquer função que chame `auth.uid()` incondicionalmente (o
-- guard `if auth.uid() is not null and not fn_role_at_least(...)`, que é o
-- padrão deste schema) quebrava no gate e passava em produção. Instrumento que
-- diverge do produto não mede o produto.
create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $fn$;

grant usage on schema auth, extensions, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
SQL

echo "==> conferindo que o banco efêmero é o do PRODUTO (antes do baseline)"
# A guarda tem de rodar AQUI e não na suíte de invariantes, e isto foi medido:
# o próprio baseline traz o `ALTER DEFAULT PRIVILEGES … TO anon` na linha ~3960,
# então DEPOIS de aplicá-lo a entrada em pg_default_acl existe de qualquer jeito e
# uma asserção lá dentro passa sempre — verde por não medir nada. A diferença entre
# o banco fiel e o fictício só é observável NESTE instante: antes do baseline.
#
# A sonda cria uma definer de mentira e mede o ACL dela. Se as 4 linhas de `alter
# default privileges` acima desaparecerem — perda silenciosa, que nenhum grep de
# símbolo acha e que qualquer convergência no prelude sobrescreve sem conflito —,
# este passo derruba o run com a razão escrita, em vez de a suíte inteira ficar
# verde medindo o universo errado.
#
# O QUE ELA MEDE, e por que não é `has_function_privilege`: a primeira versão
# perguntava se `anon` PODE executar, e aprovava os dois mundos. Num Postgres cru
# a função nasce com o grant a PUBLIC (`=X/postgres`), do qual `anon` herda — o
# privilégio EFETIVO é `true` sem nenhum default ACL. É a mesma armadilha das duas
# origens de EXECUTE que a doutrina descreve (CLAUDE.md, migrations item 9), aqui
# do lado do instrumento. O que distingue os mundos é o grant DIRETO a `anon` no
# `proacl`, que só existe se `pg_default_acl` tiver a entrada.
#
# `-q` é obrigatório: sem ele o stdout leva "CREATE FUNCTION"/"DROP FUNCTION"
# junto do resultado e a comparação com "t" falha sempre — sonda que reprova o
# banco certo é tão inútil quanto sonda que aprova o errado.
fidelidade="$(docker exec -i "$CONTAINER" psql -U postgres -d "$TEMPLATE" -v ON_ERROR_STOP=1 -q -tA -f - <<'SQL'
create function public.fn_sonda_fidelidade_do_harness() returns int
  language sql security definer as $fn$ select 1 $fn$;
select exists (
  select 1 from pg_proc p, unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where p.proname = 'fn_sonda_fidelidade_do_harness'
     and split_part(a::text, '=', 1) = 'anon'
);
drop function public.fn_sonda_fidelidade_do_harness();
SQL
)"
if [ "$fidelidade" != "t" ]; then
  echo "FATAL: neste banco uma SECURITY DEFINER nova em public NÃO nasce com grant DIRETO a anon." >&2
  echo "       Num projeto Supabase de verdade — o que install.sh manda o cliente criar — ela nasce," >&2
  echo "       porque o bootstrap do Supabase grava um ALTER DEFAULT PRIVILEGES … TO anon em" >&2
  echo "       pg_default_acl ANTES de qualquer SQL nosso. Sem reproduzir isso aqui, o gate" >&2
  echo "       hardening-definer-varredura fica VERDE com 6 funções expostas à anon key em" >&2
  echo "       produção (medido 2026-08-08, baseline 9249e6f2). Restaure as 4 linhas de" >&2
  echo "       'alter default privileges … on functions' no prelude acima." >&2
  exit 1
fi
echo "    ✓ definer nova nasce com grant direto a anon (armadilha do produto reproduzida)"

echo "==> modo INSTALL: aplicando baseline.sql com ON_ERROR_STOP=1"
psql_install < "$BASELINE"
echo "    ✓ install ok"

# COM `ON_ERROR_STOP=1`, e é isto que torna o passo uma prova (issue #184).
#
# Antes ele re-aplicava SEM a flag e chamava o resultado de "idempotência". Não
# era: sem a flag o psql segue após cada erro, então o passo saía verde com 301
# erros dentro — inclusive os 4 `policy already exists` que faziam uma mudança de
# RLS do apêndice NÃO chegar ao clone. O `update.sh` também roda sem a flag e
# filtra esses erros como benignos, então nem ele nem este gate viam o defeito, e
# o README dizia "provando idempotência" apontando para cá.
#
# A flag é a diferença entre "re-aplicar terminou" e "re-aplicar não errou".
echo "==> modo UPDATE: re-aplicando baseline.sql COM ON_ERROR_STOP=1 (idempotência de verdade)"
psql_install < "$BASELINE"
echo "    ✓ update ok (zero erro na re-aplicação)"

echo "==> banco \`postgres\` a partir do molde (o setupFile o recria a cada arquivo)"
# Criar aqui, ALÉM do reset por arquivo, tem dois motivos medidos:
#  - `docker exec … psql -d postgres` (o que se digita para depurar o container)
#    continua funcionando;
#  - se alguém remover o `setupFiles` de vitest.db.config.ts, a suíte volta ao
#    regime ANTIGO — banco global compartilhado — em vez de explodir com
#    "database postgres does not exist" em 99 arquivos. Aí o invariante
#    tests/invariants/harness-isola-por-arquivo.test.ts aponta a regressão certa,
#    com duas asserções, em vez de o run virar um muro de ruído.
docker exec -i "$CONTAINER" psql -U postgres -d template1 -q -v ON_ERROR_STOP=1 -f - <<SQL
drop database if exists postgres with (force);
create database postgres template $TEMPLATE;
SQL

echo "==> invariantes: vitest (tests/invariants) — banco novo por ARQUIVO, ordem sorteada"
# `--sequence.shuffle.files`: com o isolamento por arquivo a ordem deixa de ser
# variável escondida, e sortear é o que impede a próxima colisão de fixture de
# ficar dormente até alguém renomear um arquivo.
TEST_DB_CONTAINER="$CONTAINER" TEST_DB_TEMPLATE="$TEMPLATE" TEST_DB_PORT="$PORT" \
  vitest run --config vitest.db.config.ts --sequence.shuffle.files=true "$@"

# A RECUSA. Vem depois do vitest e ANTES da palavra "verde", porque o que se
# recusa aqui é o próprio resultado — inclusive um resultado que passou.
mexidos="$(arvore_mexeu)"
if [ -n "$mexidos" ]; then
  echo "" >&2
  echo "FATAL: a árvore mudou DURANTE a corrida — este resultado não vale, tenha ele passado ou não." >&2
  echo "       Arquivos tocados depois do início:" >&2
  echo "$mexidos" | sed 's/^/         /' >&2
  echo "       O veredito acima mediu uma mistura: parte do run viu o arquivo antigo," >&2
  echo "       parte viu o novo, e nenhuma árvore que existe hoje foi medida inteira." >&2
  echo "       Rode de novo com a árvore parada." >&2
  exit 1
fi

echo "==> test:db verde"
