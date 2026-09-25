#!/usr/bin/env bash
# Prova do `loop/hooks/guard-hooks-atualizados.sh` em repositórios git
# DESCARTÁVEIS: cada caso monta o estado (em dia, atrasado, modificado, sem
# remoto) e roda o guard. Nada aqui toca o clone de quem roda.
#
#   bash tests/shell/guard-hooks-atualizados.test.sh
#
# A distinção que este arquivo existe para prender é ATRASADO × MODIFICADO:
# tratá-los igual ou bloquearia todo PR que mexe em hook (inclusive o que criou
# este guard), ou deixaria passar o checkout velho — que é o caso real medido
# em 19/09/2026: o checkout principal desta máquina, 3026 commits atrás, rodava
# um freeze-invariants de 26 linhas contra 230 na `main`.
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$RAIZ/loop/hooks/guard-hooks-atualizados.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
casos=0
falhas=0

# ── isolamento do git: nada aqui escreve fora de "$TMP" ───────────────────────
# Um `git -C "$dir" config user.*` grava onde o git RESOLVER o repositório, e não
# necessariamente em "$dir": um GIT_DIR herdado (rodar de dentro de um hook, de um
# `rebase --exec`) manda por cima do -C; "$dir" que não é repositório sobe até o pai.
# Foi assim que "Pessoa <alguem@fork.dev>" parou no .git/config do checkout de quem
# rodava a suíte e assinou 829 commits da main a partir de 10/09/2026. Três travas:
#   1. zera o ambiente local do git herdado — o idioma canônico do próprio git;
#   2. a descoberta de repositório nunca sobe para fora de "$TMP";
#   3. identidade por ambiente, não por `git config` (NENHUM caso aqui mede o autor).
unset $(git rev-parse --local-env-vars)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_CEILING_DIRECTORIES="$TMP"
export GIT_AUTHOR_NAME="Teste" GIT_AUTHOR_EMAIL="teste@exemplo.invalid"
export GIT_COMMITTER_NAME="Teste" GIT_COMMITTER_EMAIL="teste@exemplo.invalid"

checa() { # nome, esperado, obtido
  casos=$((casos + 1))
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FALHA $1 — esperado exit $2, obtido $3" >&2
    falhas=$((falhas + 1))
  fi
}

# Um "remoto" local faz o papel da origin; nada de rede.
cenario() { # devolve o caminho de um clone com origin/main configurada
  local remoto clone
  remoto="$(mktemp -d "$TMP/remoto.XXXXXX")"
  clone="$(mktemp -d "$TMP/clone.XXXXXX")"
  (
    cd "$remoto" || exit 1
    git init -q --bare
  )
  (
    cd "$clone" || exit 1
    git init -q
    mkdir -p loop/hooks
    printf '#!/usr/bin/env bash\nexit 0\n' > loop/hooks/freeze-invariants.sh
    cp "$GUARD" loop/hooks/guard-hooks-atualizados.sh
    git add -A
    git commit -qm base
    git remote add origin "$remoto"
    git push -q origin HEAD:main
    git fetch -q origin main
  )
  printf '%s' "$clone"
}

# ── 1. em dia: passa ──────────────────────────────────────────────────────────
c="$(cenario)"
( cd "$c" && bash loop/hooks/guard-hooks-atualizados.sh >/dev/null 2>&1 )
checa "checkout em dia PASSA" 0 $?
rm -rf "$c"

# ── 2. ATRASADO: a main mudou o guard, esta branch não tocou → BLOQUEIA ───────
c="$(cenario)"
(
  cd "$c" || exit 1
  # a `main` ganha uma versão nova do freeze…
  git checkout -qb tmp-main
  printf '#!/usr/bin/env bash\n# versão nova, mais forte\nexit 0\n' > loop/hooks/freeze-invariants.sh
  git commit -qam "freeze mais forte"
  git push -q origin HEAD:main
  git fetch -q origin main
  # …e a branch de trabalho continua na versão velha
  git checkout -q -
)
( cd "$c" && bash loop/hooks/guard-hooks-atualizados.sh >/dev/null 2>&1 )
checa "guard ATRASADO em relação à origin/main BLOQUEIA" 1 $?
rm -rf "$c"

# ── 3. MODIFICADO de propósito: avisa, mas PASSA ──────────────────────────────
# Sem isto, o PR que conserta um hook seria bloqueado pelo próprio hook.
c="$(cenario)"
(
  cd "$c" || exit 1
  printf '#!/usr/bin/env bash\n# mudança DESTA branch, sob revisão\nexit 0\n' > loop/hooks/freeze-invariants.sh
  git commit -qam "mexe no guard de propósito"
)
saida="$( cd "$c" && bash loop/hooks/guard-hooks-atualizados.sh 2>&1 )"
codigo=$?
checa "guard MODIFICADO pela branch PASSA" 0 $codigo
casos=$((casos + 1))
if printf '%s' "$saida" | grep -q "MODIFICADO"; then
  echo "  ok   e o aviso diz que foi modificado"
else
  echo "  FALHA o aviso de MODIFICADO não apareceu — saída: $saida" >&2
  falhas=$((falhas + 1))
fi
rm -rf "$c"

# ── 4. sem origin/main: NÃO MEDIDO, e segue ───────────────────────────────────
# Bloquear commit por falta de rede troca um risco raro por travamento diário.
c="$(mktemp -d "$TMP/sem-origin.XXXXXX")"
(
  cd "$c" || exit 1
  git init -q
  mkdir -p loop/hooks
  cp "$GUARD" loop/hooks/guard-hooks-atualizados.sh
  git add -A
  git commit -qm base
)
saida="$( cd "$c" && bash loop/hooks/guard-hooks-atualizados.sh 2>&1 )"
codigo=$?
checa "sem origin/main SEGUE (não medido)" 0 $codigo
casos=$((casos + 1))
if printf '%s' "$saida" | grep -q "NÃO MEDIDO"; then
  echo "  ok   e declara o não medido em vez de calar"
else
  echo "  FALHA não declarou o NÃO MEDIDO — saída: $saida" >&2
  falhas=$((falhas + 1))
fi
rm -rf "$c"

# ── 5. a válvula existe e funciona ────────────────────────────────────────────
c="$(cenario)"
(
  cd "$c" || exit 1
  git checkout -qb tmp-main
  printf '#!/usr/bin/env bash\n# versão nova\nexit 0\n' > loop/hooks/freeze-invariants.sh
  git commit -qam "nova"
  git push -q origin HEAD:main
  git fetch -q origin main
  git checkout -q -
)
( cd "$c" && DESKCOMM_GOV_HOOKS_ATRASADOS_OK=1 bash loop/hooks/guard-hooks-atualizados.sh >/dev/null 2>&1 )
checa "a válvula libera o atrasado quando declarada" 0 $?
rm -rf "$c"

if [ "$falhas" -gt 0 ]; then
  echo "guard-hooks-atualizados: $falhas de $casos caso(s) falharam" >&2
  exit 1
fi
echo "guard-hooks-atualizados: ${casos} casos ok"
