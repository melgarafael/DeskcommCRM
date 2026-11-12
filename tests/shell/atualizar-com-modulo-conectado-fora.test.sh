#!/usr/bin/env bash
# Prova de que ATUALIZAR O CRM não depende do serviço de um módulo conectado (Spec 33, F6;
# ADR-0005 escolha 2): com um módulo "instalado" e o serviço dele fora do ar, o `update.sh` termina
# com sucesso, sem esperar o serviço e sem tocar em rota ou tabela do módulo.
#
#   bash tests/shell/atualizar-com-modulo-conectado-fora.test.sh
#
# O QUE O HARNESS ALCANÇA, E O QUE NÃO (dito aqui para ninguém ler esta prova como mais do que ela é)
#
#   • "Módulo instalado" mora no BANCO (extension_installations, organization_extensions) e o
#     `update.sh` não o lê: o dublê de `docker` não tem banco, e nenhuma etapa do kit pergunta ao
#     Postgres quais módulos existem. Por isso este arquivo NÃO consegue plantar um módulo instalado
#     de verdade, e não finge: nenhuma linha daqui cria uma "instalação" que o script pudesse ler.
#   • O que ele prova é o lado que o `update.sh` tem como falhar por causa do módulo: ALCANÇAR o
#     serviço dele. O serviço de mentira é uma ORIGEM MORTA (`MODULO_ORIGEM`) que o dublê de `curl`
#     faz pendurar por 30 s, como um serviço que não responde; qualquer chamada que o `update.sh`
#     fizesse a ela, ou a uma rota `/api/v1/extensions/*` do CRM, ou a uma tabela do módulo (nos
#     argumentos do `psql`/`docker`), fica anotada e reprova a prova. Terminar com sucesso
#     SEM nenhuma dessas anotações é o que significa "sem esperar o serviço e sem tocar nele".
#   • O que fica FORA: o conteúdo real do `baseline.sql` (a fixture usa `select 1;`) e o app em si.
#     O complemento, que varre o TEXTO de todo script do kit à procura de qualquer ponto de contato
#     com módulo, é `tests/unit/atualizar-nao-depende-de-modulo-conectado.test.ts`. Os dois juntos
#     cobrem o que este harness não representa; nenhum dos dois, sozinho, cobre o que o outro cobre.
#
# SABOTAGEM PREVISTA: acrescentar ao `update.sh` um `curl` a `$MODULO_ORIGEM` (ou a
# `/api/v1/extensions/...`), ou um `psql ... extension_installations`, deixa o caso 1 vermelho
# (anotação no log do módulo / do docker). Os controles do caso 2 provam que as sondas enxergam.
#
# Nada aqui toca a máquina de quem roda: `docker`, `crontab`, `flock`, `curl` e `uname` são dublês,
# nenhum container sobe, nenhum crontab real é escrito e o repositório git é descartável (mktemp).
set -uo pipefail
# Isolamento do git (ver update-guard.test.sh): um GIT_DIR herdado mandaria por cima de todo
# `cd`/`git init` dos repositórios descartáveis abaixo.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$REPO_ROOT/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
export NS

WORK="$(mktemp -d)"
# Guarda de raio de ação: sem sandbox próprio (TMPDIR inválido) os dublês abaixo escreveriam em /bin.
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK') — TMPDIR inválido?" >&2
  exit 1
fi
trap 'rm -rf "$WORK"' EXIT

REAL_GIT="$(command -v git)"
REAL_UNAME="$(command -v uname)"

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
nao_contem() { ! grep -qE -- "$1" "$2"; }  # nao_contem <regex> <arquivo>

# O "serviço do módulo": uma origem em loopback que NINGUÉM atende. A porta é a do discard (9): nada
# escuta nela na máquina de quem roda, e mesmo que algo escutasse o dublê de `curl` nunca sai de casa.
export MODULO_ORIGEM="http://127.0.0.1:9"
# O que identifica contato com módulo, nos argumentos de qualquer comando que o update.sh executou.
PADRAO_DE_ROTA='127\.0\.0\.1:9|api/v1/extensions|x-module-'
PADRAO_DE_TABELA='extension_installations|organization_extensions|extension_module_|extension_installation_secrets|service_origin'

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# `docker` não sobe nada: registra TODOS os argumentos (é aí que o `psql` efêmero do kit aparece, com
# o SQL do `-c`) e responde o que o app responde de verdade no healthcheck.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" imagetools inspect --raw "*) printf '%s' '{"schemaVersion":2,"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}'; exit 0 ;;
  *" imagetools inspect --format "*) printf 'linux/amd64\n'; exit 0 ;;
  *" exec "*) printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":12}}}}\n' ;;
  *" images "*) printf 'sha256:deadbeef\n' ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# `curl`: anota CADA chamada inteira (para a prova ler as rotas) e nunca toca a rede. Contra a origem
# morta do módulo (ou uma rota de extensões) ele faz o que um serviço fora do ar faz: não responde
# (pendura `MODULO_ESPERA_S` segundos), e a chamada fica numa lista à parte. As demais respostas são as
# do app que pede a atualização, como em update-guard.test.sh.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"$MODULO_ORIGEM"*|*api/v1/extensions*|*x-module-*)
    printf '%s\n' "$*" >> "$MODULO_LOG"
    sleep "${MODULO_ESPERA_S:-30}"
    exit 28 ;;
esac
payload=""
while [ $# -gt 0 ]; do
  [ "$1" = "-d" ] && { shift; payload="$1"; }
  shift
done
case "$payload" in
  *heartbeat*) printf '{"data":{"update_requested":true,"run_id":"11111111-1111-4111-8111-111111111111"}}\n200' ;;
  *)           printf '{"data":{}}\n200' ;;
esac
STUB
cat > "$WORK/bin/git" <<STUB
#!/usr/bin/env bash
exec "$REAL_GIT" "\$@"
STUB
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/git" "$WORK/bin/uname"
export DOCKER_LOG="$WORK/docker.log" CURL_LOG="$WORK/curl.log" MODULO_LOG="$WORK/modulo.log"
export FAKE_CRONTAB="$WORK/crontab.txt"
: > "$DOCKER_LOG"; : > "$CURL_LOG"; : > "$MODULO_LOG"
export PATH="$WORK/bin:$PATH"

# ── Instalação de mentira: repo git + kit + .env (a mesma de update-guard.test.sh) ──────────────────
PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$REPO_ROOT/hostgator-setup-kit/_common.sh" "$REPO_ROOT/hostgator-setup-kit/_manifestos.sh" \
   "$REPO_ROOT/hostgator-setup-kit/_i18n.sh" "$REPO_ROOT/hostgator-setup-kit/update.sh" \
   "$REPO_ROOT/hostgator-setup-kit/agent.sh" "$REPO_ROOT/hostgator-setup-kit/manutencao.sh" \
   "$PROJ/hostgator-setup-kit/"
cp -R "$REPO_ROOT/hostgator-setup-kit/manutencao" "$PROJ/hostgator-setup-kit/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$PROJ/hostgator-setup-kit/backup.sh"
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
printf '.env*\n' > .gitignore
git init --quiet
git add -A
git commit --quiet -m "v0.9.0"
git tag v0.9.0
echo topo > topo.txt; git add -A; git commit --quiet -m "topo da main"
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
git checkout --quiet v0.9.0

OUTFILE="$WORK/saida.txt"

echo "── 1. Atualizar com um módulo conectado e o serviço dele fora do ar"
INICIO=$SECONDS
RC=0
bash hostgator-setup-kit/update.sh --to v1.1.0 > "$OUTFILE" 2>&1 < /dev/null || RC=$?
DURACAO=$((SECONDS - INICIO))
printf '  (a atualização levou %ss; o serviço de mentira penduraria 30s se alguém o chamasse)\n' "$DURACAO"
check "a atualização termina com sucesso" test "$RC" -eq 0
check "  e o fim diz Atualização concluída" grep -q "✓ Atualização concluída" "$OUTFILE"
check "o update.sh não chamou o serviço do módulo (nenhuma anotação no log do módulo)" test ! -s "$MODULO_LOG"
check "nenhum curl do update.sh tocou a origem do módulo nem rota de extensões" \
  nao_contem "$PADRAO_DE_ROTA" "$CURL_LOG"
check "nenhum comando do update.sh (docker/psql) tocou tabela do módulo" \
  nao_contem "$PADRAO_DE_TABELA" "$DOCKER_LOG"
check "nem a saída da atualização cita módulo, serviço de módulo ou rota de extensões" \
  nao_contem 'service_origin|api/v1/extensions|módulo conectado' "$OUTFILE"
check "a imagem da versão nova foi gravada no .env (a atualização fez o trabalho dela)" \
  grep -q "^APP_IMAGE=${NS}/deskcommcrm:1.1.0$" .env

echo "── 2. Controles: as sondas do caso 1 enxergam quando o contato existe"
# Sem isto o caso 1 poderia estar verde porque as sondas são cegas (o log vazio lê igual a "ninguém
# chamou"). Cada controle faz o contato de propósito, fora do update.sh, e exige a anotação.
: > "$MODULO_LOG"; : > "$CURL_LOG"; : > "$DOCKER_LOG"
MODULO_ESPERA_S=0 curl -s "$MODULO_ORIGEM/embed" > /dev/null 2>&1
check "o dublê de curl anota a chamada à origem do módulo" test -s "$MODULO_LOG"
check "e a sonda de rota a reconhece no log do curl" grep -qE -- "$PADRAO_DE_ROTA" "$CURL_LOG"
: > "$MODULO_LOG"
MODULO_ESPERA_S=0 curl -s -X POST "https://crm.exemplo.com.br/api/v1/extensions/token" > /dev/null 2>&1
check "e a rota de token do módulo também cai na anotação" test -s "$MODULO_LOG"
docker compose exec db psql -c "select * from public.extension_installations" > /dev/null 2>&1
check "a sonda de tabela reconhece uma consulta a extension_installations no log do docker" \
  grep -qE -- "$PADRAO_DE_TABELA" "$DOCKER_LOG"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
