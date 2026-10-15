#!/usr/bin/env bash
# Prova de que o `update.sh` só cobra regra de isolamento de tabela que EXISTE
# no banco — e não de regra escrita dentro do corpo de uma função que ainda não
# rodou (issue #1897; mesma causa na #1893 e na #1899).
#
#   bash tests/shell/regras-isolamento-sem-modulo.test.sh
#
# O defeito medido: `hostgator-setup-kit/update.sh:396` monta a lista `esperadas`
# com TODO `create policy … on public.X` que exista no texto do
# `supabase/baseline.sql` — inclusive os que estão DENTRO do corpo de
# `public.fn_honorarios_provisionar()` (baseline.sql:36801, primeira policy em
# :36896), função que só executa quando alguém chama
# `fn_modulo_instalar('honorarios', …)`. Criar a função não cria tabela nenhuma.
# Sem o módulo instalado, `honorarios_contratos` e `honorarios_parcelas` não
# existem: a recriação responde `relation does not exist`, a segunda conferência
# acusa as MESMAS 8 regras e o script sai em `update.sh:493` com o CRM parado —
# era a atualização inteira de toda instalação SEM o módulo de honorários.
#
# O que está sob prova (uma instalação mentira por caso):
#   1. instalação SEM honorários: as regras escritas dentro do `$f$` da função
#      provisionadora NÃO entram em `esperadas` — a atualização termina em 0,
#      com o ✓ da conferência e sem "REGRAS DE ISOLAMENTO AUSENTES".
#   2. NÃO afrouxa: regra de tabela que EXISTE e não está no banco continua
#      sendo cobrada — sai em 1 e nomeia a regra faltante na tela.
#   3. módulo INSTALADO (tabelas e regras no banco): segue em verde — o conserto
#      não pune quem tem o módulo.
#   4. consulta de tabelas vazia (banco fora do ar): a conferência NÃO vira
#      muda — sem a lista de tabelas não se filtra nada e o aviso continua
#      saindo em 1. Sem esta guarda, filtrar sobre lista vazia derrubaria
#      `esperadas` inteira e o ✓ sairia com "0 declaradas".
#
# Nada aqui toca a máquina de quem roda: `docker`, `crontab`, `flock`, `curl` e
# `uname` são dublês, nenhum container sobe, nenhum crontab real é escrito, e o
# repositório git é descartável (mktemp).
set -uo pipefail
# Isolamento do git: um GIT_DIR herdado (suíte rodada de dentro de um hook ou de
# um `rebase --exec`) manda por cima de todo `cd`/`git -C` dos repositórios
# descartáveis abaixo, e init/commit/config caem no repositório de quem roda.
# Zera o ambiente local do git e dá a identidade por ambiente: nenhum teste
# aqui mede o autor.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# O namespace das imagens publicadas, lido da FONTE (hostgator-setup-kit/_common.sh)
# em vez de repetido aqui: o que está sob prova aqui independe de quem publica.
NS="$(sed -n 's/^IMG_NS=\"\(.*\)\"$/\1/p' "$REPO_ROOT/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
export NS

WORK="$(mktemp -d)"
# Guarda de raio de ação: com TMPDIR apontando para diretório inexistente o
# `mktemp` acima falha e WORK fica VAZIA — aí "$WORK/bin/docker" vira /bin/docker
# e os dublês abaixo sobrescrevem os binários da máquina de quem roda.
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK') — TMPDIR inválido?" >&2
  exit 1
fi
trap 'rm -rf "$WORK"' EXIT

REAL_UNAME="$(command -v uname)"

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
nao_contem() { ! grep -q -- "$1" "$2"; }  # nao_contem <texto> <arquivo>

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# O `docker` não sobe nada. As consultas da conferência de regras são respondidas
# por variáveis de ambiente do CASO: é assim que cada caso diz qual banco existe
# (TABELAS_EXISTENTES) e quais regras já estão no lugar (POLICIAS_EXISTENTES),
# sem precisar de um Postgres de verdade.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  # Consulta das regras existentes (pg_policy) da conferência do update.sh.
  *"select p.polname"*"pg_policy"*)
    [ -n "${POLICIAS_EXISTENTES:-}" ] && printf '%s\n' "$POLICIAS_EXISTENTES"
    ;;
  # Consulta das tabelas existentes (pg_class) — a régua que decide o que cobrar.
  *"select c.relname from pg_class"*)
    [ -n "${TABELAS_EXISTENTES:-}" ] && printf '%s\n' "$TABELAS_EXISTENTES"
    ;;
  # Healthcheck do update.sh: o app responde o que ele RESPONDE DE VERDADE
  # (status geral + corpo em JSON), capturado de uma instalação real.
  *" exec "*) printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":268}}}}\n' ;;
  # Imagem em execução, que o agent.sh guarda para poder voltar.
  *" images "*) printf 'sha256:deadbeef\n' ;;
  *" image inspect "*) printf 'x@sha256:aaa\n' ;;
  *" imagetools inspect --raw "*) printf '%s' '{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' ;;
  *" imagetools inspect --format "*) printf 'linux/amd64\n' ;;
  # Aplicação do baseline: sai limpa, como sai um psql que não achou erro nenhum.
  *" -f /b.sql "*) ;;
esac
exit 0
STUB
# `crontab` guarda a tabela num arquivo: o update.sh instala a linha do agente no
# fim, e escrever no crontab real da máquina de quem roda não é aceitável.
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# flock não existe no macOS e o kit depende dele; a exclusão mútua não está sob
# prova aqui, então este dublê só deixa passar.
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# curl: nenhuma saída deste arquivo deve tocar a rede (o heartbeat do agente não
# está sob prova aqui).
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '%s' '{"token":"teste"}' ;;
  *ghcr.io/v2/*) printf 200 ;;
  *) printf '{"data":{}}\n200' ;;
esac
STUB
# `uname -m` responde x86_64: o `_common.sh` recusa, antes de qualquer trabalho,
# todo update.sh que não roda em amd64 — e aqui quem está sob prova é a
# conferência de regras, não o processador de quem roda a suíte. A recusa de ARM
# tem prova própria em tests/shell/arquitetura-kit.test.sh.
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/uname"
export DOCKER_LOG="$WORK/docker.log" FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"
# O baseline do teste é aplicado por um dublê que não dorme entre tentativas.
export BASELINE_ESPERA_S=0

# ── O baseline sob prova ─────────────────────────────────────────────────────
# É uma rédução do `supabase/baseline.sql` REAL com as DUAS formas de declarar
# regra que ele usa: as de `leads` no texto solto (tabela que existe), e as de
# `honorários` DENTRO do corpo de `public.fn_honorarios_provisionar()` — que é
# como o baseline de verdade faz desde a migration 0480 / ADR-0002 (linha 36801).
BASELINE_FIXTURE="$WORK/baseline-fixture.sql"
cat > "$BASELINE_FIXTURE" <<'SQL'
-- Tabela que existe: a regra nasce aqui e é conferida.
drop policy if exists "leads_select" on public.leads;
create policy leads_select on public.leads
  for select using (true);

create policy leads_insert on public.leads
  for insert with check (true);

-- Módulo de honorários NÃO instalado: criar a função não cria tabela nenhuma.
create or replace function public.fn_honorarios_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create policy honorarios_contratos_select on public.honorarios_contratos for select using (true);
  create policy honorarios_contratos_insert on public.honorarios_contratos for insert with check (true);
  create policy honorarios_contratos_update on public.honorarios_contratos for update using (true);
  create policy honorarios_contratos_delete on public.honorarios_contratos for delete using (true);
  create policy honorarios_parcelas_select on public.honorarios_parcelas for select using (true);
  create policy honorarios_parcelas_insert on public.honorarios_parcelas for insert with check (true);
  create policy honorarios_parcelas_update on public.honorarios_parcelas for update using (true);
  create policy honorarios_parcelas_delete on public.honorarios_parcelas for delete using (true);
end;
$f$;
SQL

# As 10 regras do baseline: 2 de `leads` (tabela existente) e as 8 de honorários.
REGRAS_LEADS='leads_select|leads
leads_insert|leads'
REGRAS_LEADS_SELECT='leads_select|leads'
REGRAS_HONORARIOS='honorarios_contratos_select|honorarios_contratos
honorarios_contratos_insert|honorarios_contratos
honorarios_contratos_update|honorarios_contratos
honorarios_contratos_delete|honorarios_contratos
honorarios_parcelas_select|honorarios_parcelas
honorarios_parcelas_insert|honorarios_parcelas
honorarios_parcelas_update|honorarios_parcelas
honorarios_parcelas_delete|honorarios_parcelas'
TABELAS_HONORARIOS='honorarios_contratos
honorarios_parcelas'

# ── Instalação de mentira: kit + .env + repo git descartável ─────────────────
# Uma raiz por caso: fixture compartilhada entre casos é como um estado vazado
# vira verde falso — cada caso nasce limpo, como cada instalação de verdade.
montar_instalacao() {  # montar_instalacao <raiz>
  local raiz="$1" proj="$1/deskcommcrm"
  mkdir -p "$proj"
  cp -RL "$REPO_ROOT/hostgator-setup-kit" "$proj/"
  # backup.sh de mentira: deixa uma marca no disco. É o marco "o script já
  # começou a mexer", e ele não faz backup nenhum aqui — o que está sob prova é
  # a conferência de regras, não o backup (que tem prova própria).
  case "$proj/hostgator-setup-kit/backup.sh" in
    "$REPO_ROOT"/*) echo "recuso plantar o dublê dentro do repo"; exit 1 ;;
  esac
  cat > "$proj/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
touch "$raiz/marca-backup"
STUB
  chmod +x "$proj/hostgator-setup-kit/backup.sh"
  mkdir -p "$proj/supabase"
  cp "$BASELINE_FIXTURE" "$proj/supabase/baseline.sql"
  # shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
  printf 'services:\n  app:\n    image: \\${APP_IMAGE:-x}\n' > "$proj/docker-compose.prod.yml"
  # O overlay de build local existe no repo de verdade e o caminho de
  # recuperação do update.sh o referencia por nome.
  printf 'services:\n  app:\n    pull_policy: never\n    build:\n      context: .\n' > "$proj/docker-compose.build.yml"
  cat > "$proj/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
  chmod 600 "$proj/.env"
  (
    cd "$proj" || exit 1
    git init --quiet
    git add -A
    git commit --quiet -m "v0.9.0"
    git tag v0.9.0
    # Instalação que SEGUE A MAIN: HEAD à frente da última tag publicada — o
    # estado de quem acabou de instalar e recebeu um aviso de atualização.
    echo topo > topo.txt
    git add -A
    git commit --quiet -m "topo da main"
  ) >/dev/null 2>&1
}

# rodar <caso> <POLICIAS> <TABELAS> → saída em $OUTFILE, status em $RC
# Uma raiz por caso, e as duas variáveis dizem QUAL banco o dublê do docker tem.
rodar() {
  local raiz="$WORK/$1"
  shift
  POLICIAS_EXISTENTES="$1" TABELAS_EXISTENTES="$2" \
    bash -c 'cd "$1/deskcommcrm" && exec bash hostgator-setup-kit/update.sh --to v0.9.0 --force' \
    _ "$raiz" > "$OUTFILE" 2>&1 < /dev/null || RC=$?
}

# ── 1. Instalação SEM o módulo de honorários: o sintoma da issue ─────────────
echo "── 1. Sem honorários instalado: a atualização NÃO para na conferência"
montar_instalacao "$WORK/caso1"
OUTFILE="$WORK/saida1.txt"; RC=0
rodar caso1 "$REGRAS_LEADS" "leads"
check "a atualização termina com sucesso (status 0)" test "$RC" -eq 0
check "a conferência rodou e passou" \
  grep -q "✓ regras de isolamento conferidas (2 declaradas, todas no lugar)" "$OUTFILE"
check "sem o aviso vermelho que parava o CRM" \
  nao_contem "REGRAS DE ISOLAMENTO AUSENTES" "$OUTFILE"
check "nenhuma regra de honorários foi cobrada" nao_contem "honorarios" "$OUTFILE"
check "e a atualização chegou ao fim" grep -q "Atualização concluída" "$OUTFILE"

# ── 2. O conserto NÃO afrouxa: tabela existe, regra ausente, continua cobrada ─
echo "── 2. Tabela que EXISTE sem a regra continua sendo cobrada"
montar_instalacao "$WORK/caso2"
OUTFILE="$WORK/saida2.txt"; RC=0
# Só `leads_select` no banco: `leads_insert` falta, e a tabela existe.
rodar caso2 "$REGRAS_LEADS_SELECT" "leads"
rc2="$RC"
# O mesmo banco, agora com as duas regras de leads — controle do caso acima:
# o vermelho de baixo é da regra faltante, não do resto do harness.
montar_instalacao "$WORK/caso2b"
OUTFILE="$WORK/saida2b.txt"; RC=0
rodar caso2b "$REGRAS_LEADS
leads_insert|leads" "leads"
check "sem a regra faltante a mesma instalação passa (controle)" test "$RC" -eq 0
OUTFILE="$WORK/saida2.txt"; RC="$rc2"
check "sai em 1" test "$RC" -eq 1
check "o aviso vermelho aparece" grep -q "REGRAS DE ISOLAMENTO AUSENTES" "$OUTFILE"
check "e nomeia a regra que falta, na tabela que existe" \
  grep -q "leads_insert na tabela leads" "$OUTFILE"
check "nenhuma regra de honorários entra na lista" nao_contem "honorarios" "$OUTFILE"

# ── 3. Módulo INSTALADO: tabelas e regras no banco, segue em verde ───────────
echo "── 3. Com o módulo instalado, as regras dele continuam conferidas"
montar_instalacao "$WORK/caso3"
OUTFILE="$WORK/saida3.txt"; RC=0
rodar caso3 "$REGRAS_LEADS
$REGRAS_HONORARIOS" "leads
$TABELAS_HONORARIOS"
check "a atualização termina com sucesso (status 0)" test "$RC" -eq 0
check "todas as 10 regras entram na conferência" \
  grep -q "✓ regras de isolamento conferidas (10 declaradas, todas no lugar)" "$OUTFILE"
check "sem o aviso vermelho" nao_contem "REGRAS DE ISOLAMENTO AUSENTES" "$OUTFILE"

# ── 4. Consulta de tabelas vazia: a conferência não pode virar muda ──────────
echo "── 4. Banco fora do ar (nada de tabela respondida): o aviso continua saindo"
montar_instalacao "$WORK/caso4"
OUTFILE="$WORK/saida4.txt"; RC=0
rodar caso4 "" ""
check "sai em 1, como saía antes do conserto" test "$RC" -eq 1
check "o aviso vermelho aparece" grep -q "REGRAS DE ISOLAMENTO AUSENTES" "$OUTFILE"
check "e NÃO é um ✓ com zero regras conferidas" \
  nao_contem "✓ regras de isolamento conferidas (0 declaradas" "$OUTFILE"

printf '\n'
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
