#!/usr/bin/env bash
# Prova que o `update.sh` TOMA o `.update.lock` — o mesmo cadeado que o botão
# "Atualizar agora" (agent.sh) usa — e que o caminho do botão continua passando.
#
#   bash tests/shell/update-toma-a-trava.test.sh
#
# O defeito (#5052): o cadeado existia e só o `agent.sh` o tomava. O `update.sh`
# rodado pelo terminal entrava sem cadeado nenhum, então duas atualizações
# podiam aplicar o `supabase/baseline.sql` no MESMO banco ao mesmo tempo — foi o
# par de erros do incidente 1.118 → 1.119 (`cannot change name of input
# parameter`), em duas aplicações defasadas em 2,75–3,5 s.
#
# Os três casos:
#   (a) trava OCUPADA por outro processo → sai SEM backup e SEM banco, com rc 0
#       e uma mensagem que diz POR QUE (o operador precisa saber que o painel
#       está atualizando), e sem deixar diagnóstico pela metade;
#   (b) trava HERDADA (o que o `agent.sh` faz: fd 9 aberto + o fd exportado) →
#       segue normalmente, não morre no cadeado do próprio pai;
#   (c) trava LIVRE → toma o cadeado, segue, e o cadeado está livre de novo na
#       saída — inclusive quando a execução sai pelo caminho de erro/trap.
#
# Nada aqui toca a máquina de quem roda: `docker` e `crontab` são dublês, o
# repositório é descartável e o `flock` é o de verdade (é ele que está sob
# prova). O update é cortado no backup de propósito: o que se mede é a ordem
# cadeado → backup → código → banco, não o banco em si.
set -uo pipefail
# Isolamento do git: um GIT_DIR herdado manda por cima de todo `cd`/`git -C` dos
# repositórios descartáveis abaixo (ver o mesmo bloco em update-guard.test.sh).
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$REPO_ROOT/hostgator-setup-kit"
WORK="$(mktemp -d)"
HOLDER=""
trap '[ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null; rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando de verificação...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# `docker`: responde o que o update.sh pergunta ANTES do banco (info, buildx,
# imagens do registro) e registra cada chamada. O que interessa aqui é o que
# NÃO aparece no log quando a trava está ocupada.
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" buildx version "*)     printf 'github.com/docker/buildx v0.0.0\n' ;;
  *" imagetools inspect "*) printf 'Digest: sha256:aaa\n' ;;
  *" image inspect "*)      printf 'x@sha256:aaa\n' ;;
esac
exit 0
STUB
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# `uname -m` responde x86_64: o `_common.sh` recusa todo `update.sh` que não roda
# em amd64 antes de qualquer trabalho, e aqui quem está sob prova é o cadeado.
REAL_UNAME="$(command -v uname)"
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/uname"
export DOCKER_LOG="$WORK/docker.log" FAKE_CRONTAB="$WORK/crontab.txt"
export PATH="$WORK/bin:$PATH"

# ── Instalação de mentira: repo git + kit + .env ─────────────────────────────
PROJ="$WORK/deskcommcrm"
mkdir -p "$PROJ/hostgator-setup-kit" "$PROJ/supabase"
cp "$KIT/_common.sh" "$KIT/_manifestos.sh" "$KIT/_i18n.sh" "$KIT/update.sh" \
   "$KIT/agent.sh" "$KIT/manutencao.sh" "$PROJ/hostgator-setup-kit/"
cp -R "$KIT/manutencao" "$PROJ/hostgator-setup-kit/"
# backup.sh de mentira: o rastro "o script já começou a mexer". Ele FALHA de
# propósito — é o corte do teste, depois do cadeado e antes do código/banco, e
# o `update.sh` sai por `die` (caminho de erro, com o trap no lugar).
cat > "$PROJ/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
echo backup >> "\$BACKUP_LOG"
exit 1
STUB
export BACKUP_LOG="$WORK/backup.log"
# shellcheck disable=SC2016  # o \${APP_IMAGE} é literal DENTRO do compose
printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$PROJ/docker-compose.prod.yml"
printf 'services:\n  app:\n    pull_policy: never\n    build:\n      context: .\n' > "$PROJ/docker-compose.build.yml"
printf 'select 1;\n' > "$PROJ/supabase/baseline.sql"
cat > "$PROJ/.env" <<ENV
APP_IMAGE=ghcr.io/exemplo/deskcommcrm:0.9.0
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
chmod 600 "$PROJ/.env"
printf '.env*\n' > "$PROJ/.gitignore"

cd "$PROJ" || exit 1
git init --quiet
git add -A
git commit --quiet -m "v0.9.0"
git tag v0.9.0
echo nova > nova.txt; git add -A; git commit --quiet -m "v1.1.0"; git tag v1.1.0
git checkout --quiet v0.9.0

LOCK="$PROJ/.update.lock"
DIAG="$PROJ/.deskcomm-update-diagnostico.log"
OUT="$WORK/saida.txt"

executar() {  # executar <comando...> → saída em $OUT, status em $RC
  RC=0
  "$@" > "$OUT" 2>&1 || RC=$?
}
recomecar() {  # zera os rastros entre os casos
  rm -f "$BACKUP_LOG" "$DOCKER_LOG" "$DIAG"
}
msg_trava() { grep -qi "atualização em andamento pelo painel" "$OUT"; }
msg_backup() { grep -q "backup preventivo falhou" "$OUT"; }

# Segura o cadeado num processo de VERDADE (não no mesmo shell do teste: o
# cadeado é por descritor de arquivo, e o teste também precisa de um fd livre).
cat > "$WORK/segura.sh" <<'STUB'
#!/usr/bin/env bash
exec 9>"$1" || exit 9
flock -n 9 || exit 9
: > "$2"
# `exec` de propósito: o processo que fica de pé É o `sleep`, dono do fd 9 —
# matá-lo fecha o descritor e liberta o cadeado na hora. Com o `sleep` como
# filho, o kill no shell deixava o filho vivo segurando o cadeado por 120 s, e
# o caso seguinte (b) encontrava a trava ocupada sem ninguém a estar usando
# (medido: foi assim que a primeira versão deste teste nasceu vermelha à toa).
exec sleep 120
STUB
segurar_trava() {
  bash "$WORK/segura.sh" "$LOCK" "$WORK/segurando" &
  HOLDER=$!
  local i
  for i in $(seq 100); do [ -f "$WORK/segurando" ] && return 0; sleep 0.05; done
  echo "não consegui segurar o cadeado com outro processo"; exit 1
}
soltar_trava() {
  [ -n "$HOLDER" ] && { kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; }
  HOLDER=""; rm -f "$WORK/segurando"
}
# O caminho do BOTÃO, imitado fielmente: fd 9 aberto e travado ANTES, e o fd
# exportado — é o que o `agent.sh` faz antes de chamar o update.sh.
cat > "$WORK/pelo-botao.sh" <<'STUB'
#!/usr/bin/env bash
exec 9>"$1" || exit 9
flock -n 9 || { echo "cadeado ocupado — não deveria acontecer aqui" >&2; exit 9; }
export DESKCOMM_UPDATE_LOCK_FD=9
cd "$2" || exit 1
shift 2
bash hostgator-setup-kit/update.sh "$@"
STUB

# ── (a) Trava ocupada: sai sem backup e sem banco, e diz por quê ─────────────
echo "── (a) trava ocupada por outro processo (o painel atualizando)"
recomecar
segurar_trava
executar bash hostgator-setup-kit/update.sh --to v1.1.0
soltar_trava
check "sai com rc 0 (não é erro: outra atualização está fazendo o trabalho)" test "$RC" -eq 0
check "diz que já há uma atualização em andamento pelo painel" msg_trava
check "não rodou o backup" test ! -f "$BACKUP_LOG"
check "não chamou o docker nenhuma vez (nada de banco, nada de contêiner)" test ! -s "$DOCKER_LOG"
check "não deixou diagnóstico pela metade" test ! -e "$DIAG"

# ── (b) Trava herdada (agent.sh): segue e não trava contra o pai ─────────────
echo "── (b) trava herdada do agent.sh (fd 9 aberto + DESKCOMM_UPDATE_LOCK_FD)"
recomecar
executar bash "$WORK/pelo-botao.sh" "$LOCK" "$PROJ" --to v1.1.0
check "NÃO recusa por causa do cadeado do próprio pai" bash -c "! grep -qi 'atualização em andamento pelo painel' '$OUT'"
check "seguiu e chegou ao backup (a trava herdada não barrou nada)" test -f "$BACKUP_LOG"
check "saiu pelo erro deste teste (backup quebrado de propósito), não pelo cadeado" msg_backup

# ── (c) Trava livre: toma o cadeado, segue e libera na saída ─────────────────
echo "── (c) trava livre: toma o cadeado, segue e libera"
recomecar
rm -f "$LOCK"
executar bash hostgator-setup-kit/update.sh --to v1.1.0
check "criou o cadeado no caminho de sempre (\$PROJECT_DIR/.update.lock)" test -f "$LOCK"
check "seguiu e chegou ao backup" test -f "$BACKUP_LOG"
check "não confundiu trava livre com trava ocupada" bash -c "! grep -qi 'atualização em andamento pelo painel' '$OUT'"
check "saiu pelo erro deste teste, com o trap no lugar" msg_backup
check "liberou o cadeado na saída do caminho de erro" \
  bash -c "exec 9>'$LOCK' && flock -n 9"

# Depois de liberado, a recusa volta a funcionar: o cadeado não ficou preso.
echo "── (c2) o cadeado liberado barra uma segunda execução concorrente"
recomecar
segurar_trava
executar bash hostgator-setup-kit/update.sh --to v1.1.0
soltar_trava
check "recusa de novo (o cadeado não vazou entre as execuções)" msg_trava
check "sem backup nesta segunda recusa" test ! -f "$BACKUP_LOG"

if [ "$FAILS" -ne 0 ]; then
  printf '\n%d prova(s) falharam\n' "$FAILS"
  exit 1
fi
printf '\n✓ todas as provas passaram\n'
