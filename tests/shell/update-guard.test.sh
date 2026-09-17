#!/usr/bin/env bash
# Prova do `hostgator-setup-kit/update.sh` num repositório git descartável, com
# `docker` e `crontab` substituídos por dublês — nada aqui toca a máquina de
# quem roda (nenhum container sobe, nenhum crontab real é escrito).
#
#   bash tests/shell/update-guard.test.sh
#
# O que está sob prova (defeitos reais achados na revisão final da branch):
#   1. Alvo ANTERIOR ao que está instalado é recusado ANTES do backup — numa
#      instalação que segue a `main`, `git describe --exact-match` é vazio e a
#      comparação de tags passa batido: sem a guarda de ancestralidade, o
#      script rebobinava a instalação para a última tag publicada.
#   2. `--force` continua sendo a saída explícita de quem quer mesmo voltar.
#   3. A imagem escolhida é GRAVADA no .env (não só exportada), sem duplicar a
#      chave a cada execução — senão o próximo `docker compose up -d` do dono
#      volta pro ":latest" e desfaz a atualização.
#   4. A linha de cron do agente entra na pasta do projeto (o agent.sh resolve
#      o projeto pelo diretório corrente, e no cron o CWD é o home).
#   5. Mesmo quando o update é recusado, o agente da tela fica instalado — é o
#      que faz o bootstrap pelo terminal ter fim.
#   6. `compare_failed` no heartbeat tem DUAS linhas independentes em
#      agent.sh que podem acendê-lo (CONTIDA=2 vindo do `is_already_in_head`,
#      e o fallback de "nenhuma tag conhecida + fetch falhou") — casos 8 e 9
#      isolam cada uma, provado por sabotagem cirúrgica de cada linha.
set -uo pipefail

# O namespace das imagens publicadas, lido da FONTE (hostgator-setup-kit/_common.sh)
# em vez de repetido aqui. Este arquivo tinha o literal em 29 lugares — fixtures e
# asserções —, o que amarrava a suíte a UM publicador: um fork que publica as
# próprias imagens fica vermelho sem ter quebrado nada. O que estes casos provam é
# que as três imagens andam na MESMA versão, e isso independe de quem publica.
#
# O CUSTO DE DERIVAR, e onde ele é pago. Enquanto o literal estava aqui, este
# arquivo era a única canária do repo contra um IMG_NS errado: um valor trocado
# reprovava 4 casos (medido). Derivando, ele deixa de reprovar — os testes
# passam a concordar entre si sobre o valor errado, que é a família do teste que
# mede a si mesmo. A proteção não sumiu: mudou de lugar, para
# `tests/unit/namespace-das-imagens.test.ts`, que assere o literal UMA vez e
# confere que o compose, o `.env` de exemplo e o workflow de publicação dizem o
# mesmo. Se você veio parar aqui procurando a guarda do namespace, é lá.
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
# Exportado porque o dublê de `docker` (escrito mais abaixo num heredoc quoted)
# resolve $NS em tempo de execução, já dentro de outro processo.
export NS


# Capturado ANTES de qualquer `cd`: o script muda de diretório várias vezes, e
# `${BASH_SOURCE[0]}` é relativo ao cwd de quem invocou. Resolvê-lo lá embaixo
# devolvia string vazia, e o `.` virava `/_common.sh`.
KIT_DIR_TESTE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# git de verdade, resolvido ANTES de $WORK/bin entrar no PATH (senão o shim
# abaixo se acharia a si mesmo e recursaria pra sempre).
REAL_GIT="$(command -v git)"

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês de `docker` e `crontab` ───────────────────────────────────────────
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  # Healthcheck do update.sh: "docker compose ... exec -T app node -e ...".
  # O dublê responde o que o app RESPONDE DE VERDADE — capturado da instalação
  # em produção. Antes aqui vinha {"status":"ok"}, um formato que /api/v1/health
  # nunca emitiu: `ok` é o vocabulário dos CHECKS individuais, e o status geral
  # usa healthy|degraded|unhealthy. Um dublê que fala um dialeto inventado
  # aprova código que o app real reprovaria — foi exatamente por casar
  # '"status":"ok"' no JSON cru que o kit dava por saudável um app com o BANCO
  # FORA, desde que qualquer outro check estivesse de pé.
  # São duas linhas porque o probe imprime o status geral e depois o corpo.
  *" exec "*)   printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":268},"redis":{"status":"ok","latency_ms":4},"waha":{"status":"ok","latency_ms":6}}}}\n' ;;
  # Imagem em execução, que o agent.sh guarda para poder voltar. Precisa
  # devolver algo: com PREV_IMAGE vazio o rollback nem seria tentado, e o teste
  # do agente passaria mesmo com o defeito de volta.
  *" images "*) printf 'sha256:deadbeef\n' ;;
  # Aplicação do baseline. Só com BASELINE_ROTEIRO no ambiente (caso 4c): cada
  # chamada imprime a próxima passada do roteiro. Fora dele, sai limpa como antes.
  *" -f /b.sql "*)
    if [ -n "${BASELINE_ROTEIRO:-}" ]; then
      n=$(( $(cat "$BASELINE_ROTEIRO/n" 2>/dev/null || echo 0) + 1 ))
      printf '%s' "$n" > "$BASELINE_ROTEIRO/n"
      [ -f "$BASELINE_ROTEIRO/passada.$n" ] && cat "$BASELINE_ROTEIRO/passada.$n"
    fi ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# flock não existe no macOS e o agent.sh depende dele; aqui a exclusão mútua
# não está sob prova, então o dublê só deixa passar.
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# O "app": responde ao heartbeat que ALGUÉM PEDIU uma atualização (é o que faz
# o agente sair do heartbeat e ir executar) e guarda cada corpo enviado, que é
# como a prova lê o desfecho reportado.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
payload=""
while [ $# -gt 0 ]; do
  [ "$1" = "-d" ] && { shift; payload="$1"; }
  shift
done
printf '%s\n' "$payload" >> "$CURL_LOG"
case "$payload" in
  *heartbeat*) printf '{"data":{"update_requested":true,"run_id":"11111111-1111-4111-8111-111111111111"}}\n200' ;;
  *)           printf '{"data":{}}\n200' ;;
esac
STUB
# `git` de verdade para tudo, EXCETO `fetch --unshallow` quando
# FORCE_UNSHALLOW_FAIL=1 estiver no ambiente — é o que isola o caso 8 (a
# comparação genuinamente NÃO SABE porque o unshallow falhou) de um fetch
# --tags comum, que continua funcionando contra a origin de verdade. Fora
# desse gate (a maioria das chamadas do arquivo inteiro, casos 1-7 incluídos)
# o dublê é 100% transparente.
cat > "$WORK/bin/git" <<STUB
#!/usr/bin/env bash
if [ "\${FORCE_UNSHALLOW_FAIL:-0}" = "1" ]; then
  for a in "\$@"; do
    if [ "\$a" = "--unshallow" ]; then
      echo "fatal: simulated unshallow failure" >&2
      exit 1
    fi
  done
fi
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/git"
export DOCKER_LOG="$WORK/docker.log" CURL_LOG="$WORK/curl.log"
export FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"

# ── Instalação de mentira: repo git + kit + .env ─────────────────────────────
PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$REPO_ROOT/hostgator-setup-kit/_common.sh" "$REPO_ROOT/hostgator-setup-kit/update.sh" \
   "$REPO_ROOT/hostgator-setup-kit/agent.sh" "$PROJ/hostgator-setup-kit/"
# backup.sh de mentira: deixa um rastro. É o marco "o script já começou a
# mexer" — a guarda de retrocesso só vale se abortar ANTES dele.
BACKUP_MARK="$WORK/backup-rodou"
cat > "$PROJ/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
touch "$BACKUP_MARK"
STUB
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$PROJ/docker-compose.prod.yml"
printf 'select 1;\n' > "$PROJ/supabase/baseline.sql"
cat > "$PROJ/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
chmod 600 "$PROJ/.env"

cd "$PROJ" || exit 1
git init --quiet
git config user.email t@t.t; git config user.name t
git add -A
git commit --quiet -m "v0.9.0"
git tag v0.9.0
# Instalação que SEGUE A MAIN: HEAD à frente da última tag publicada.
echo topo > topo.txt; git add -A; git commit --quiet -m "topo da main"

OUTFILE="$WORK/saida.txt"
run_update() {  # run_update <args...> → saída em $OUTFILE, status em $RC
  rm -f "$BACKUP_MARK"
  bash hostgator-setup-kit/update.sh "$@" > "$OUTFILE" 2>&1
  RC=$?
}

echo "── 1. Alvo anterior ao instalado é recusado antes do backup"
run_update --to v0.9.0
check "aborta com status != 0" test "$RC" -ne 0
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"

echo "── 2. Sem --to, a última tag publicada também é recusada se já está no HEAD"
# É o caso do defeito: o dono copia da tela o comando sem argumento nenhum.
run_update
check "aborta com status != 0" test "$RC" -ne 0
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "mesmo recusando, deixou o agente da tela instalado (com cd no diretório do projeto)" \
  grep -q "cd ${PROJ} && bash hostgator-setup-kit/agent.sh" "$FAKE_CRONTAB"

echo "── 3. --force é a saída explícita de quem quer mesmo voltar"
run_update --to v0.9.0 --force
check "passou da guarda e rodou o backup" test -f "$BACKUP_MARK"

echo "── 4. Atualização de verdade grava a imagem no .env, sem duplicar a chave"
# Estado de quem sofreu um rollback antes: o agente deixou a imagem apontando
# para um ID local e a política em "missing" (ID não se puxa do registro).
set_env_missing() { grep -v '^APP_PULL_POLICY=' .env > .env.t; echo 'APP_PULL_POLICY=missing' >> .env.t; mv .env.t .env; }
set_env_missing
git checkout --quiet main 2>/dev/null || git checkout --quiet master
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
git checkout --quiet v0.9.0
run_update --to v1.1.0
check "a atualização termina com sucesso" test "$RC" -eq 0
check ".env aponta para a imagem da versão instalada" grep -q "^APP_IMAGE=${NS}/deskcommcrm:1.1.0$" .env
check "a chave APP_IMAGE não duplicou" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
run_update --to v1.1.0 --force
check "segunda execução também não duplica" test "$(grep -c '^APP_IMAGE=' .env)" -eq 1
check "as outras chaves do .env sobreviveram" grep -q '^INTERNAL_SECRET=segredo$' .env
check "a política de pull vira 'missing' — a tag é imutável, e 'always' derrubaria o CRM se o GHCR caísse" \
  grep -q '^APP_PULL_POLICY=missing$' .env
check "e sem duplicar a chave" test "$(grep -c '^APP_PULL_POLICY=' .env)" -eq 1
check ".env continua 600 (só o dono lê)" test -n "$(find .env -perm 600)"

# Esta prova exigia 'always' até 2026-08-13, e o motivo escrito era real: um
# rollback deixava 'missing' no .env com um ID de imagem LOCAL, e ninguém
# desfazia — o `up -d` manual do dono parava de puxar imagem para sempre.
#
# O que mudou não foi a preocupação, foi a régua. Medido: com 'always' e o
# registro sem responder para aquela referência, o `up -d` FALHA e o contêiner
# NÃO SOBE, mesmo com a imagem já no disco. Como a instalação agora nasce e
# permanece pinada numa tag imutável, 'always' deixou de proteger de qualquer
# coisa e passou a amarrar a subida do CRM de um cliente pago à disponibilidade
# do GHCR. O medo original continua coberto por outro caminho: o update.sh faz
# `dc pull` EXPLÍCITO, que independe do pull_policy, e regrava a tag por cima do
# ID local do rollback — que é o que a prova logo acima verifica.
# Ver docs/doctrine/packaging.md, invariante 5.

echo "── 4b. As três imagens sobem juntas, na mesma versão"
# O worker e o scheduler eram `build:`-only no compose: `dc pull` os pulava e o
# `up -d` sem --build recriava o contêiner sobre a imagem velha. O worker — o
# runtime do agente de IA — ficava congelado no código do dia da instalação.
# Se estas três linhas voltarem a divergir, o defeito voltou.
check "o worker é pinado na MESMA versão do app" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:1.1.0$" .env
check "o scheduler é pinado na MESMA versão do app" \
  grep -q "^SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.1.0$" .env
check "o worker herda a política da tag imutável" \
  grep -q '^WORKER_PULL_POLICY=missing$' .env
check "o scheduler herda a política da tag imutável" \
  grep -q '^SCHEDULER_PULL_POLICY=missing$' .env
check "nenhuma das chaves novas duplicou" \
  test "$(grep -cE '^(WORKER|SCHEDULER)_(IMAGE|PULL_POLICY)=' .env)" -eq 4

echo "── 4c. Deadlock com o app no ar: o banco é aplicado de novo antes do ✓"
# Medido numa VPS real na v1.27.3: com o app atendendo, o `create policy` logo
# depois de um `drop policy` perdeu um deadlock, o script avisou e seguiu, e a
# tabela ficou sem a policy de leitura. A função tem a própria suíte
# (baseline-reaplica-apos-disputa.test.sh); este caso prova que o update.sh
# passa por ela e que a tela diz a verdade nos dois desfechos.
ROTEIRO_UG="$WORK/roteiro-baseline"
DEADLOCK_UG='psql:/b.sql:16766: ERROR:  deadlock detected'
mkdir -p "$ROTEIRO_UG"
printf '%s\n' "$DEADLOCK_UG" > "$ROTEIRO_UG/passada.1"
: > "$DOCKER_LOG"
BASELINE_ROTEIRO="$ROTEIRO_UG" BASELINE_ESPERA_S=0 run_update --to v1.1.0 --force
check "a atualização termina com sucesso" test "$RC" -eq 0
check "o update.sh aplicou o baseline duas vezes" test "$(grep -c -- '-f /b.sql' "$DOCKER_LOG")" -eq 2
check "e diz ✓ banco atualizado" grep -q "✓ banco atualizado" "$OUTFILE"
check "  contando que foi na 2ª passada (o ✓ depois de disputa não é mudo)" grep -q "✓ banco atualizado na passada 2" "$OUTFILE"
# linha_de <texto fixo>: número da primeira linha da saída que contém o texto (0 se nenhuma).
linha_de() { grep -nF -- "$1" "$OUTFILE" | head -1 | cut -d: -f1 | grep . || echo 0; }
check "  e a linha que perdeu a disputa foi listada ANTES do ✓" \
  test "$(linha_de 'psql:/b.sql:16766: ERROR:  deadlock detected')" -gt 0 -a \
       "$(linha_de 'psql:/b.sql:16766: ERROR:  deadlock detected')" -lt "$(linha_de '✓ banco atualizado na passada 2')"
check "  sem o aviso de banco" test -z "$(grep 'NÃO são os esperados' "$OUTFILE" || true)"
check "  e o fim diz Atualização concluída" grep -q "✓ Atualização concluída" "$OUTFILE"
# Com --force na mesma tag ninguém conferiu a imagem: a frase antiga ("o app está
# rodando uma imagem antiga") mentia justo para quem seguiu a dica de repetir.
check "--force na mesma tag diz que está refazendo, sem inventar imagem antiga" grep -q "Refazendo a versão v1.1.0" "$OUTFILE"
check "  (a frase da imagem antiga não aparece)" test -z "$(grep 'imagem antiga' "$OUTFILE" || true)"

rm -rf "$ROTEIRO_UG"; mkdir -p "$ROTEIRO_UG"
for n in 1 2 3; do printf '%s\n' "$DEADLOCK_UG" > "$ROTEIRO_UG/passada.$n"; done
: > "$DOCKER_LOG"
BASELINE_ROTEIRO="$ROTEIRO_UG" BASELINE_ESPERA_S=0 run_update --to v1.1.0 --force
check "deadlock que não passa aplica 3 vezes e desiste" test "$(grep -c -- '-f /b.sql' "$DOCKER_LOG")" -eq 3
check "  NÃO vira ✓ banco atualizado" test -z "$(grep '✓ banco atualizado' "$OUTFILE" || true)"
check "  a tela mostra o deadlock" grep -q "deadlock detected" "$OUTFILE"
# Sem --force, repetir o update.sh responderia "já está na versão mais recente"
# e não tocaria no banco.
check "  e ensina a repetir de um jeito que re-aplica" grep -qF "update.sh --to v1.1.0 --force" "$OUTFILE"
# Na v1.27.3 de uma VPS real o aviso do passo 4 ficou soterrado pelo docker pull,
# e a última frase da tela era "Atualização concluída".
# O cabeçalho do bloco FINAL, e não a frase do passo 6: as duas diziam "banco NÃO
# terminou limpo", e o check passava com o bloco final apagado (medido em sabotagem).
check "  o FIM da tela repete que o banco NÃO terminou limpo" \
  grep -q "Atenção: o banco NÃO terminou limpo nesta atualização" "$OUTFILE"
check "  e não diz Atualização concluída" test -z "$(grep 'Atualização concluída' "$OUTFILE" || true)"
check "  a dica aparece no passo do banco E no fim" test "$(grep -cF 'update.sh --to v1.1.0 --force' "$OUTFILE")" -eq 2
# Restaurar o backup desfaz também o que o CRM gravou desde ele: é o último recurso.
check "  no passo do banco, repetir vem ANTES de restaurar" \
  test "$(linha_de 'update.sh --to v1.1.0 --force')" -lt "$(linha_de 'Só em último caso, volte ao backup')"
check "  e a orientação é a ÚLTIMA coisa da saída, depois do passo 7" \
  test -n "$(tail -n 8 "$OUTFILE" | grep -F 'update.sh --to v1.1.0 --force' || true)"

# Lista grande (role sem dono: milhares de "must be owner") com a disputa no topo.
# `printf | head -20` sob pipefail levava SIGPIPE e o set -e matava o update.sh
# com 141 — antes do aviso de PERMISSÃO, que existe para este caso, e antes do pull.
rm -rf "$ROTEIRO_UG"; mkdir -p "$ROTEIRO_UG"
{ printf '%s\n' "$DEADLOCK_UG"; for i in $(seq 1 4000); do printf 'psql:/b.sql:%s: ERROR:  must be owner of table tabela_%s\n' "$i" "$i"; done; } > "$ROTEIRO_UG/passada.1"
cp "$ROTEIRO_UG/passada.1" "$ROTEIRO_UG/passada.2"; cp "$ROTEIRO_UG/passada.1" "$ROTEIRO_UG/passada.3"
: > "$DOCKER_LOG"
BASELINE_ROTEIRO="$ROTEIRO_UG" BASELINE_ESPERA_S=0 run_update --to v1.1.0 --force
check "lista de erros maior que o buffer do pipe não mata o update.sh" test "$RC" -eq 0
check "  a disputa no topo foi reconhecida (3 passadas)" test "$(grep -c -- '-f /b.sql' "$DOCKER_LOG")" -eq 3
check "  o aviso de PERMISSÃO chegou à tela" grep -q "erros de PERMISSÃO" "$OUTFILE"
check "  e o fim diz que o banco NÃO terminou limpo" grep -q "banco NÃO terminou limpo" "$OUTFILE"
# Lista misturada: repetir cura a parte da disputa e NÃO cura a de permissão. As
# duas metades são ditas — escolher uma escondia a ação possível da outra.
check "  a metade que repetir cura é dita" grep -q "Parte não aplicou porque o banco seguiu ocupado" "$OUTFILE"
check "  e a metade que repetir NÃO cura também" grep -q "esses repetir não cura" "$OUTFILE"
check "  e o fim orienta a conexão do dono" test -n "$(tail -n 8 "$OUTFILE" | grep -F 'SUPABASE_DB_ADMIN_URL' || true)"

# Só permissão, sem disputa nenhuma: uma passada, e o fim diz o que fazer.
rm -rf "$ROTEIRO_UG"; mkdir -p "$ROTEIRO_UG"
for i in $(seq 1 200); do printf 'psql:/b.sql:%s: ERROR:  must be owner of table tabela_%s\n' "$i" "$i"; done > "$ROTEIRO_UG/passada.1"
: > "$DOCKER_LOG"
BASELINE_ROTEIRO="$ROTEIRO_UG" BASELINE_ESPERA_S=0 run_update --to v1.1.0 --force
check "só permissão: uma passada (repetir não cura)" test "$(grep -c -- '-f /b.sql' "$DOCKER_LOG")" -eq 1
check "  sem a metade de banco ocupado (não houve disputa)" test -z "$(grep 'Parte não aplicou' "$OUTFILE" || true)"
check "  e o FIM orienta a conexão do dono" test -n "$(tail -n 8 "$OUTFILE" | grep -F 'SUPABASE_DB_ADMIN_URL' || true)"

# ── Clone RASO: a topologia que o install.sh realmente entrega ───────────────
# `install.sh` instala com `git clone --depth 1`. Num repositório raso o
# `merge-base --is-ancestor` responde "não é ancestral" para QUALQUER coisa
# fora do único commit baixado — inclusive para uma tag velha. Era o furo que
# mantinha o retrocesso vivo mesmo com a guarda: o fixture acima (git init
# completo) não tinha como pegar.
SRC="$WORK/src"
mkdir -p "$SRC"
cp -R "$PROJ/hostgator-setup-kit" "$SRC/"
mkdir -p "$SRC/supabase"; printf 'select 1;\n' > "$SRC/supabase/baseline.sql"
# shellcheck disable=SC2016  # o ${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$SRC/docker-compose.prod.yml"
printf '.env\n' > "$SRC/.gitignore"
cd "$SRC" || exit 1
git init --quiet; git config user.email t@t.t; git config user.name t
git add -A; git commit --quiet -m "release antiga"; git tag v0.9.0
echo topo > topo.txt; git add -A; git commit --quiet -m "main, depois da release"

clona_raso() {  # clona_raso <destino> — igual ao install.sh: --depth 1
  git clone --depth 1 --quiet "file://$SRC" "$1"
  cat > "$1/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:latest
APP_PULL_POLICY=always
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
  chmod 600 "$1/.env"
}

echo "── 5. Clone raso (o do install.sh): a tag velha continua sendo recusada"
RASO="$WORK/raso"
clona_raso "$RASO"
cd "$RASO" || exit 1
check "o fixture é mesmo um clone raso (senão esta prova não vale nada)" \
  test "$(git rev-parse --is-shallow-repository)" = "true"
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3), não com falha genérica" test "$RC" -eq 3
check "explica em português que é retrocesso" grep -q "ANTERIOR à que já está instalada" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"
check "a imagem do .env continua intacta" grep -q "^APP_IMAGE=${NS}/deskcommcrm:latest$" .env
check "completou a história para poder decidir (deixou de ser raso)" \
  test "$(git rev-parse --is-shallow-repository)" = "false"

echo "── 6. Clone raso que NÃO consegue completar a história: recusa em vez de chutar"
CEGO="$WORK/cego"
clona_raso "$CEGO"
cd "$CEGO" || exit 1
git fetch --tags --quiet origin            # conhece a tag…
git remote set-url origin "$WORK/nao-existe"  # …mas perdeu o caminho de volta
HEAD_ANTES="$(git rev-parse HEAD)"
run_update
check "aborta com o código de recusa (3)" test "$RC" -eq 3
check "diz que não teve CERTEZA, em vez de agir" grep -q "consegui ter CERTEZA" "$OUTFILE"
check "não chegou a rodar o backup" test ! -f "$BACKUP_MARK"
check "NÃO rebobinou: o HEAD é o mesmo de antes" test "$(git rev-parse HEAD)" = "$HEAD_ANTES"

echo "── 7. Recusa não é falha no meio: o agente não desfaz o que nunca foi feito"
# O update.sh recusa (RC=3) e o agent.sh, antes, tratava qualquer RC!=0 como
# "quebrou": reiniciava o container, reescrevia o .env e reportava
# "failed_rolled_back" — estrago inventado, para um run que não tocou em nada.
AGENTE="$WORK/agente"
clona_raso "$AGENTE"
cd "$AGENTE" || exit 1
: > "$DOCKER_LOG"; : > "$CURL_LOG"; rm -f "$BACKUP_MARK"
bash hostgator-setup-kit/agent.sh > "$WORK/agente.out" 2>&1
check "o agente chegou a executar o update (o app de mentira pediu)" \
  grep -q '"kind":"run_progress"\|"kind":"run_result"' "$CURL_LOG"
check "NÃO reiniciou o container" test -z "$(grep -F 'up -d app' "$DOCKER_LOG" || true)"
check "NÃO reescreveu a imagem do .env" grep -q "^APP_IMAGE=${NS}/deskcommcrm:latest$" .env
check "reportou 'failed', não 'failed_rolled_back'" \
  test -n "$(grep -F '"status":"failed"' "$CURL_LOG" || true)"
check "não reportou rollback nenhum" test -z "$(grep -F 'failed_rolled_back' "$CURL_LOG" || true)"
check "o motivo em português chegou no log que a tela mostra" \
  grep -qi 'anterior' "$CURL_LOG"

echo "── 8. CONTIDA=2 (unshallow falhou) SOZINHO já acende compare_failed, mesmo com fetch --tags OK"
# Isola a linha `[ "$CONTIDA" = 2 ] && COMPARE_FAILED=true`. O modo de falha
# mais provável numa VPS fraca é exatamente este: um `fetch --tags` é barato e
# passa (FETCH_OK=1), mas o `--unshallow` (que baixa a história inteira) é caro
# e falha — origin continua alcançável o tempo todo, ao contrário do caso 9.
echo mid > "$SRC/mid.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "depois da 0.9.0"
echo nova > "$SRC/nova.txt"; git -C "$SRC" add -A; git -C "$SRC" commit --quiet -m "release nova"
git -C "$SRC" tag v1.1.0
CONTIDA2="$WORK/contida2"
git -c advice.detachedHead=false clone --depth 1 --branch v0.9.0 --quiet "file://$SRC" "$CONTIDA2"
cp "$RASO/.env" "$CONTIDA2/.env"; chmod 600 "$CONTIDA2/.env"
cd "$CONTIDA2" || exit 1
check "fixture: ainda é raso, e a origin CONTINUA alcançável (nada quebrado)" \
  test "$(git rev-parse --is-shallow-repository)" = "true"
: > "$CURL_LOG"
FORCE_UNSHALLOW_FAIL=1 bash hostgator-setup-kit/agent.sh > "$WORK/agente-contida2.out" 2>&1
check "o heartbeat diz explicitamente que não conseguiu comparar (CONTIDA=2 isolado)" \
  grep -q '"compare_failed":true' "$CURL_LOG"
check "e não anuncia a tag que não conseguiu confirmar" \
  grep -q '"latest_version":""' "$CURL_LOG"

echo "── 9. Sem NENHUMA tag conhecida + fetch --tags falhou: fallback isolado"
# Isola a linha `[ -z "$LATEST_TAG" ] && [ "$FETCH_OK" = 0 ]`. Diferente do
# caso 8: aqui a origin fica INALCANÇÁVEL desde o primeiro fetch (FETCH_OK=0),
# e o CONTIDA nunca chega a ser calculado porque não há tag nenhuma conhecida
# localmente (`--no-tags` no clone) — só este fallback pode acender
# compare_failed neste cenário.
SEM_TAG="$WORK/sem-tag"
git clone --depth 1 --no-tags --quiet "file://$SRC" "$SEM_TAG"
cp "$RASO/.env" "$SEM_TAG/.env"; chmod 600 "$SEM_TAG/.env"
cd "$SEM_TAG" || exit 1
check "fixture: nenhuma tag v* conhecida localmente" test -z "$(git tag -l 'v*')"
git remote set-url origin "$WORK/nao-existe"   # fetch --tags vai falhar (FETCH_OK=0)
: > "$CURL_LOG"
bash hostgator-setup-kit/agent.sh > "$WORK/agente-sem-tag.out" 2>&1
check "sem tag nenhuma conhecida e sem conseguir buscar, o heartbeat diz que não sabe (fallback isolado)" \
  grep -q '"compare_failed":true' "$CURL_LOG"
check "e não anuncia versão nenhuma" \
  grep -q '"latest_version":""' "$CURL_LOG"

echo

echo "── 10. Pin pela metade: o estado que a 1ª atualização deixa, e ninguém via"
# Medido em ensaio e depois na produção: quem executa a primeira atualização de
# uma instalação legada é o `update.sh` que já estava no disco — o antigo —, e
# ele só grava APP_IMAGE. O worker cai no default do compose (`:stable`, canal
# MÓVEL) e o script termina com "Atualização concluída — app no ar e saudável".
# Nada na tela dizia que o worker ficou solto; na release seguinte o canal se
# move e um `up -d` levaria o worker sozinho, com o app na versão antiga.
# A função vive no _common.sh do kit e precisa ser carregada AQUI. Sem isto os
# casos cujo esperado é vazio passavam por VACUIDADE — "comando não encontrado"
# devolve string vazia, que casa com o esperado. Três de cinco verdes eram
# falsos até esta linha existir.
# shellcheck source=/dev/null
. "$KIT_DIR_TESTE/_common.sh"
command -v pin_incompleto >/dev/null || { echo "  ✗ pin_incompleto não carregou — teste inconclusivo"; FAILS=$((FAILS+1)); }

pin_caso() {  # pin_caso <descrição> <conteúdo do .env> <esperado>
  local d="$1" env="$2" esperado="$3" r
  printf '%s\n' "$env" > "$PROJ/.env.pin"
  r="$(cd "$PROJ" && pin_incompleto .env.pin || true)"
  check "$d" test "$r" = "$esperado"
}
pin_caso "app pinado + worker/scheduler AUSENTES → acusa os dois" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0" "worker scheduler"
pin_caso "app pinado + worker em canal móvel → acusa" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:stable
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0" "worker"
pin_caso "as três na mesma versão → silêncio" \
  "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0" ""
pin_caso "app num canal deliberado (:latest) → não é 'metade', silêncio" \
  "APP_IMAGE=${NS}/deskcommcrm:latest" ""
# As aspas SIMPLES são o objeto deste caso — o `install.sh` grava assim. Elas
# ficam literais porque estão DENTRO da string de aspas duplas; trocá-las por
# duplas FECHA a string, e o conteúdo sai sem aspa nenhuma. Medido: nessa forma
# o caso vira byte-a-byte igual ao "as três na mesma versão" logo acima, e o
# rótulo passa a mentir sobre o que está sendo exercitado.
pin_caso "valores entre aspas, como o install grava → silêncio" \
  "APP_IMAGE='${NS}/deskcommcrm:1.3.0'
WORKER_IMAGE='${NS}/deskcomm-worker:1.3.0'
SCHEDULER_IMAGE='${NS}/deskcomm-scheduler:1.3.0'" ""
rm -f "$PROJ/.env.pin"



echo "── 11. Autocorreção do pin: preenche lacuna, nunca sobrescreve decisão"
# O `agent.sh` (cron de 5 min) completa o pin AUSENTE com a versão que a imagem
# em execução declara. A regra que torna isso seguro: chave ausente é omissão do
# `update.sh` antigo; chave presente é decisão de quem opera — inclusive a de
# seguir um canal móvel. Um cron que corrigisse escolha alheia seria pior que o
# defeito que ele conserta.
#
# Aqui o docker é dublado: o que se testa é a REGRA, não o daemon. O caminho com
# imagem real foi exercitado na VPS, com cron de verdade.
PIN_DIR="$WORK/autopin"; mkdir -p "$PIN_DIR/bin"
cat > "$PIN_DIR/bin/docker" <<'STUBDOCKER'
#!/usr/bin/env bash
# inspect de contêiner → devolve o nome da imagem; de imagem → devolve a versão
case "$*" in
  # O heredoc é quoted ('STUBDOCKER') para proteger $* e $DUBLE_VERSION, então
  # $NS NÃO é expandido na escrita: ele chega literal aqui e é resolvido quando o
  # dublê RODA, lendo do ambiente (por isso o `export NS` lá em cima). Sem essa
  # resolução o dublê devolvia a string `${NS}/deskcomm-worker:stable` — uma
  # fixture que não representa instalação nenhuma. O `:?` faz o dublê morrer alto
  # se a variável não vier, em vez de devolver um nome começando em "/".
  *"Config.Image"*)  printf '%s/deskcomm-worker:stable\n' "${NS:?dublê de docker sem NS no ambiente}" ;;
  *"image.version"*) printf '%s
' "${DUBLE_VERSION:-1.3.0}" ;;
  *) exit 1 ;;
esac
STUBDOCKER
chmod +x "$PIN_DIR/bin/docker"

autopin() {  # autopin <conteúdo do .env> → ecoa o que a função corrigiu
  printf '%s
' "$1" > "$PIN_DIR/.env"
  ( cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" bash -c \
      ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null ) || true
}

R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0")"
check "chave AUSENTE → preenche os dois" test "$R" = "worker scheduler"
check "  e grava a versão da imagem em execução, não um canal" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0$" "$PIN_DIR/.env"
check "  com pull_policy de tag imutável" \
  grep -q "^WORKER_PULL_POLICY=missing$" "$PIN_DIR/.env"

# Rodar de novo sobre o resultado: nada a fazer, e o arquivo não muda.
ANTES_MD5="$(md5sum "$PIN_DIR/.env" | cut -d' ' -f1)"
R="$( ( cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" bash -c ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null ) || true )"
check "idempotente: 2ª passada não corrige nada" test -z "$R"
check "  e não altera um byte do .env" test "$ANTES_MD5" = "$(md5sum "$PIN_DIR/.env" | cut -d' ' -f1)"

# A REGRA QUE PROTEGE O OPERADOR. Se esta cair, o cron passa a sobrescrever
# escolha explícita — e a decisão de implementar a autocorreção deixa de valer.
R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:stable
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:stable")"
check "canal móvel EXPLÍCITO → não toca (é decisão de quem opera)" test -z "$R"
check "  o :stable escolhido continua lá, intacto" \
  grep -q "^WORKER_IMAGE=${NS}/deskcomm-worker:stable$" "$PIN_DIR/.env"

R="$(autopin "APP_IMAGE=${NS}/deskcommcrm:1.3.0
WORKER_IMAGE=${NS}/deskcomm-worker:1.3.0
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:1.3.0")"
check "já pinada → silêncio" test -z "$R"

# Imagem sem o label (build local): não há versão para gravar, e inventar uma
# seria pior que não fazer nada.
R="$( printf "APP_IMAGE=${NS}/deskcommcrm:1.3.0\n" > "$PIN_DIR/.env"
      cd "$PIN_DIR" && PATH="$PIN_DIR/bin:$PATH" DUBLE_VERSION="<no value>" bash -c \
        ". '$KIT_DIR_TESTE/_common.sh'; completar_pin_ausente .env" 2>/dev/null || true )"
check "imagem sem label de versão → não inventa pin" test -z "$R"

if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
