#!/usr/bin/env bash
# Prova de que o `update.sh` acha o `backup.sh` DO KIT quando é invocado de OUTRO
# diretório — é o defeito da issue 1437.
#
#   bash tests/shell/atualizacao-de-fora-nao-pula-o-backup.test.sh
#
# O defeito: o passo "Backup de segurança (antes de mexer no banco)" chamava
# `bash "$(dirname "$0")/backup.sh"`. O caminho é RELATIVO e o `enter_project`
# faz `cd` ANTES dele, então o `dirname "$0"` passava a ser lido a partir do
# diretório do PROJETO, não do kit. O `bash` respondia "No such file or
# directory", o script avisava e seguia atualizando SEM o backup que ele mesmo
# promete — em toda atualização, que é o impacto relatado na issue.
#
# O que está sob prova é ONDE o update.sh procura o backup: o dublê do
# `backup.sh` grava o `$0` que o update.sh usou, e a prova fica vermelha se esse
# caminho não for o do kit (ou se o arquivo nem for executado). O que o
# `backup.sh` FAZ tem prova própria em tests/shell/waha-backup-volume.test.sh.
#
# A invocação é RELATIVA de propósito (`bash update.sh`, `bash deskcommcrm/...`):
# com o caminho absoluto o `dirname "$0"` sobrevive ao `cd` mesmo com o defeito
# no lugar, e este arquivo ficaria verde medindo a si mesmo — foi o caminho
# absoluto no comando de quem abriu a issue que escondeu o problema dele.
#
# Nada aqui toca a máquina de quem roda: `docker`, `crontab`, `flock`, `curl` e
# `uname` são dublês, nenhum container sobe, nenhum crontab real é escrito, e o
# repositório git é descartável (mktemp).
set -uo pipefail
# Isolamento do git: um GIT_DIR herdado (suíte rodada de dentro de um hook ou de
# um `rebase --exec`) manda por cima de todo `cd`/`git init` dos repositórios
# descartáveis abaixo e escreve no repositório de quem roda. Zera o ambiente
# local do git e dá a identidade por ambiente: nenhum teste aqui mede o autor.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# O namespace das imagens publicado, lido da FONTE (_common.sh) em vez de
# repetido aqui: o que estes casos provam independe de quem publica as imagens.
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$REPO_ROOT/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
export NS

WORK="$(mktemp -d)"
# Guarda de raio de ação: com TMPDIR apontando para diretório inexistente o
# `mktemp` acima falha e WORK fica VAZIA — aí "$WORK/bin/docker" vira /bin/docker
# e os dublês abaixo sobrescrevem os binários da máquina de quem roda (aconteceu
# uma vez). Sem sandbox próprio não há prova honesta: para antes de plantar nada.
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
# `docker` não sobe nada: registra a chamada e responde o que o app responde de
# verdade no healthcheck (status geral `healthy` e o corpo em JSON). Sem o
# dublê, a suíte dependeria de um Docker de verdade na máquina de quem roda.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" exec "*) printf 'healthy\n{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":12}}}}\n' ;;
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
# curl: nenhuma saída deste arquivo deve tocar a rede (é o heartbeat do agente,
# que não está sob prova aqui).
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '{"data":{}}\n200'
STUB
# `uname -m` responde x86_64: o _common.sh recusa, antes de qualquer trabalho,
# todo update.sh que não roda em amd64 — e aqui quem está sob prova é o caminho
# do backup, não o processador de quem roda a suíte. A recusa de ARM tem prova
# própria (tests/shell/arquitetura-kit.test.sh); outro uso de uname vai ao real.
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/uname"
export DOCKER_LOG="$WORK/docker.log" FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"

# ── Fixture ──────────────────────────────────────────────────────────────────
# Uma raiz por caso: fixture compartilhada entre casos é como um estado vazado
# vira verde falso. Os dois layouts abaixo são instalações REAIS, e é a diferença
# entre eles que decide se o `dirname "$0"` sobrevive ao `cd` do enter_project.

# montar_projeto <proj> — o projeto em si: compose, .env, baseline e um repo git
# descartável que SEGUE A MAIN (HEAD à frente da última tag publicada, o estado
# de quem acabou de instalar e recebe um aviso de atualização).
montar_projeto() {
  local proj="$1"
  mkdir -p "$proj/supabase"
  printf 'select 1;\n' > "$proj/supabase/baseline.sql"
  printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$proj/docker-compose.prod.yml"
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
    echo topo > topo.txt
    git add -A
    git commit --quiet -m "topo da main"
  ) >/dev/null 2>&1
}

# plantar_backup_duble <backup.sh> <marca> — o `backup.sh` da instalação vira um
# dublê que grava no disco o `$0` com que o update.sh o chamou. O caminho da
# marca é absoluto (expandido aqui), então ela só aparece se o backup rodar de
# verdade — e diz ONDE ele foi procurado.
plantar_backup_duble() {
  local destino="$1" marca="$2"
  # A fixture nunca escreve DENTRO do repo. Se o caminho do dublê cair no
  # REPO_ROOT (kit copiado como symlink, por exemplo), este teste trocaria o
  # `backup.sh` de verdade por um dublê no checkout de quem roda — inclusive no
  # CI. Custa três linhas e mata a classe inteira.
  case "$destino" in
    "$REPO_ROOT"/*) echo "recuso plantar o dublê dentro do repo: $destino"; exit 1 ;;
  esac
  cat > "$destino" <<STUB
#!/usr/bin/env bash
printf 'zero=%s\npwd=%s\n' "\$0" "\$PWD" > "$marca"
STUB
  chmod +x "$destino"
}

# kit DENTRO do projeto: <raiz>/deskcommcrm/hostgator-setup-kit (o jeito que o
# cabeçalho do update.sh ensina, rodado de dentro do projeto).
montar_instalacao() {
  local raiz="$1" proj="$1/deskcommcrm"
  mkdir -p "$proj"
  cp -RL "$REPO_ROOT/hostgator-setup-kit" "$proj/"
  plantar_backup_duble "$proj/hostgator-setup-kit/backup.sh" "$raiz/marca-backup"
  montar_projeto "$proj"
}

# Kit NA RAIZ da instalação e projeto em <raiz>/deskcommcrm — o layout do relato
# da issue, que o próprio enter_project detecta (`elif [ -f deskcommcrm/$COMPOSE
# ]; then cd deskcommcrm`). Aqui o operador roda `bash update.sh` de dentro da
# raiz, então `$0` é só `update.sh` e o `dirname "$0"` vira "." — o que, DEPOIS
# do cd, significa "procure o backup.sh no PROJETO", que é o erro relatado.
montar_kit_na_raiz() {
  local raiz="$1" proj="$1/deskcommcrm"
  mkdir -p "$proj"
  cp -RL "$REPO_ROOT/hostgator-setup-kit/." "$raiz/"
  plantar_backup_duble "$raiz/backup.sh" "$raiz/marca-backup"
  montar_projeto "$proj"
}

# rodar_de <cwd> <caminho do update.sh> <saída> → status em RC
# O `< /dev/null` não é decoração: sem terminal no stdin, o caminho de backup que
# falhou chama `die` em vez de abrir o `read -p` de quem digita "sim" — é assim
# que a suíte roda no CI e no agente, e evita travar esperando resposta.
rodar_de() {
  local cwd="$1" caminho="$2" saida="$3"
  RC=0
  ( cd "$cwd" && bash "$caminho" --to v0.9.0 --force ) > "$saida" 2>&1 < /dev/null || RC=$?
}

echo '── 1. Kit na raiz, `bash update.sh` dali: o layout e a invocação do relato'
# É a invocação que produz a mensagem da issue, letra por letra: com `$0` sendo
# só `update.sh`, o `dirname "$0"` vira "." e, depois do cd, "./backup.sh" é
# procurado no diretório do PROJETO — onde o backup.sh do kit nunca está.
R1="$WORK/caso1"; mkdir -p "$R1"; montar_kit_na_raiz "$R1"
OUT1="$WORK/saida1.txt"
rodar_de "$R1" update.sh "$OUT1"; RC1="$RC"
check "o backup.sh do kit foi EXECUTADO (a marca é dele)" test -f "$R1/marca-backup"
check "e procurado NO KIT, não no diretório do projeto" \
  grep -q "^zero=$R1/backup\.sh$" "$R1/marca-backup"
check "o kit anunciou o backup feito" grep -q "✓ backup feito" "$OUT1"
check "a saída não tem o \"No such file or directory\" do relato" \
  nao_contem "No such file or directory" "$OUT1"
check "e nem o aviso de que a atualização seguiu sem backup" \
  nao_contem "backup preventivo falhou" "$OUT1"

echo '── 2. Do diretório de cima, `bash deskcommcrm/hostgator-setup-kit/update.sh`'
# A forma do cabeçalho do update.sh, executada do diretório de cima: depois do cd
# do enter_project o caminho relativo passa a apontar para dentro dele mesmo.
R2="$WORK/caso2"; mkdir -p "$R2"; montar_instalacao "$R2"
OUT2="$WORK/saida2.txt"
rodar_de "$R2" deskcommcrm/hostgator-setup-kit/update.sh "$OUT2"; RC2="$RC"
check "o backup.sh do kit foi EXECUTADO (a marca é dele)" test -f "$R2/marca-backup"
check "e procurado NO KIT, não no diretório do projeto" \
  grep -q "^zero=$R2/deskcommcrm/hostgator-setup-kit/backup\.sh$" "$R2/marca-backup"
check "o kit anunciou o backup feito" grep -q "✓ backup feito" "$OUT2"
check "a saída não tem o \"No such file or directory\" do relato" \
  nao_contem "No such file or directory" "$OUT2"
check "e nem o aviso de que a atualização seguiu sem backup" \
  nao_contem "backup preventivo falhou" "$OUT2"

echo '── 3. Do projeto, `bash hostgator-setup-kit/update.sh`: o jeito que sempre funcionou'
# Este é o jeito que a revisão usou, e é o motivo de o defeito ter passado
# batido: aqui o `cd` do enter_project NÃO muda o diretório corrente, então o
# caminho relativo continuava valendo. Fica sob prova que não regrediu — e que o
# caminho usado agora é ABSOLUTO: a marca guarda o `$0` inteiro, e com o defeito
# no lugar ela traria só `hostgator-setup-kit/backup.sh`.
R3="$WORK/caso3"; mkdir -p "$R3"; montar_instalacao "$R3"
OUT3="$WORK/saida3.txt"
rodar_de "$R3/deskcommcrm" hostgator-setup-kit/update.sh "$OUT3"; RC3="$RC"
check "o backup.sh do kit foi EXECUTADO (a marca é dele)" test -f "$R3/marca-backup"
check "e procurado NO KIT" \
  grep -q "^zero=$R3/deskcommcrm/hostgator-setup-kit/backup\.sh$" "$R3/marca-backup"
check "o kit anunciou o backup feito" grep -q "✓ backup feito" "$OUT3"

printf '\nstatus: caso1=%s caso2=%s caso3=%s\n' "$RC1" "$RC2" "$RC3"
if [ "$FAILS" -eq 0 ]; then echo "OK — todas as provas passaram."; else echo "FALHOU — $FAILS prova(s)."; fi
exit $((FAILS > 0))
