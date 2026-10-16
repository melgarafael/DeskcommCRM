#!/usr/bin/env bash
# Prova que o kit da HostGator (a entrada do `curl | bash`) e o runbook do WAHA
# também mandam o operador para a porta em que o SSH da VPS escuta de verdade.
#
#   bash tests/shell/kit-hostgator-porta-ssh-restante.test.sh
#
# O defeito que ele guarda é o mesmo do #2568 — a VPS da HostGator escuta SSH na
# 22022, não na 22 —, nos três arquivos que aquele PR não tocou: o `comecar.sh`
# (a primeira coisa que quem instala vê), o README do kit e o runbook do WAHA.
# Mandar `ssh root@IP` leva à 22 e recebe porta fechada; liberar `ufw allow 22/tcp`
# e ativar o ufw tranca a pessoa fora do servidor.
#
# Mede o texto, porque é o que a pessoa copia e cola. Nada aqui abre conexão de rede.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMECAR="$RAIZ/hostgator-setup-kit/comecar.sh"
README_KIT="$RAIZ/hostgator-setup-kit/README.md"
RUNBOOK="$RAIZ/docs/runbooks/waha-hostgator.md"

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

# Todo comando ssh que aponta para um host (`ssh user@host`) — em bloco ou entre
# crases, porque as duas formas são o que a pessoa copia. O `-p 22022` tem que estar
# na MESMA linha; a linha que só traz a chave (`.ssh/authorized_keys`) não casa `@`.
ssh_sem_porta() { grep -nE '(^|[[:space:]`])ssh[[:space:]]+[^[:space:]`]*@' "$1" | grep -vE '(^|[[:space:]])-p[[:space:]]*22022([[:space:]]|$)'; }
scp_sem_porta() { grep -nE '(^|[[:space:]`])scp[[:space:]]+[^[:space:]`]*@' "$1" | grep -vE '(^|[[:space:]])-P[[:space:]]*22022([[:space:]]|$)'; }

# Toda ocorrência de `ufw allow` que cita a porta de ssh (22) precisa citar a 22022.
# Segmento por linha para o `-` do grep não mascarar a ocorrência inteira.
ufw_ssh_sem_22022() {
  grep -oE 'ufw allow [^`|]*' "$1" \
    | grep -E '(^|[ ,])22([,/ ]|$)' \
    | grep -vE '(^|[ ,])22022([,/ ]|$)'
}

tem_ssh() { grep -qE '^[[:space:]]*ssh ' "$1"; }
tem_ufw() { grep -qE 'ufw allow ' "$1"; }

# ── comecar.sh: o script de ENTRADA do kit (curl | bash) ────────────────────
check "o comecar.sh tem ao menos um comando ssh (senão o resto passaria vazio)" tem_ssh "$COMECAR"
check "todo ssh do comecar.sh leva -p 22022" test -z "$(ssh_sem_porta "$COMECAR")"
# O texto do `ssh` mora num heredoc SEM aspas no delimitador: ali uma crase vira
# substituição de comando, e quem roda o `curl | bash` vê "-p: command not found"
# no lugar da frase. Executa o bloco como o bash executaria e exige stderr vazio.
mensagem_ssh_stderr() { awk '/cat <<SSH$/{p=1} p{print} p&&/^SSH$/{exit}' "$1" | bash 2>&1 >/dev/null; }
check "a mensagem de SSH do comecar.sh sai sem erro do bash (crase em heredoc vira comando)" test -z "$(mensagem_ssh_stderr "$COMECAR")"

# ── README do kit: o firewall que ele ensina ────────────────────────────────
check "o README do kit tem ao menos um ufw allow (senão o resto passaria vazio)" tem_ufw "$README_KIT"
check "nenhum ufw allow do README do kit deixa a porta de ssh sem a 22022" test -z "$(ufw_ssh_sem_22022 "$README_KIT")"

# ── runbook do WAHA: acesso ao VPS e firewall do mesmo passo ────────────────
check "o runbook tem ao menos um comando ssh (senão o resto passaria vazio)" tem_ssh "$RUNBOOK"
check "todo ssh do runbook leva -p 22022" test -z "$(ssh_sem_porta "$RUNBOOK")"
check "todo scp do runbook leva -P 22022 (maiúsculo: no scp, -p é outra coisa)" test -z "$(scp_sem_porta "$RUNBOOK")"
check "nenhum ufw allow do runbook deixa a porta de ssh sem a 22022" test -z "$(ufw_ssh_sem_22022 "$RUNBOOK")"

if [ "$FAILS" -gt 0 ]; then
  ssh_sem_porta "$COMECAR" | sed 's/^/    comecar.sh ssh sem porta: /'
  mensagem_ssh_stderr "$COMECAR" | sed 's/^/    comecar.sh mensagem de ssh: /'
  ssh_sem_porta "$RUNBOOK" | sed 's/^/    runbook ssh sem porta: /'
  scp_sem_porta "$RUNBOOK" | sed 's/^/    runbook scp sem porta: /'
  ufw_ssh_sem_22022 "$README_KIT" | sed 's/^/    README ufw sem a 22022: /'
  ufw_ssh_sem_22022 "$RUNBOOK" | sed 's/^/    runbook ufw sem a 22022: /'
  printf '\n%d falha(s)\n' "$FAILS"; exit 1
fi
printf '\ntudo verde\n'
