#!/usr/bin/env bash
# guard-hooks-atualizados.sh — o guard que roda não pode ser uma versão ATRASADA
# do guard.
#
# ## O caso, medido nesta máquina em 19/09/2026
#
#   core.hooksPath ............. /Users/…/DeskcommCRM/loop/hooks   (ABSOLUTO)
#   loop/hooks/pre-commit:6 .... top="$(git rev-parse --show-toplevel)"
#   checkout principal ......... branch 3026 commits atrás, árvore suja
#   freeze-invariants.sh ali ... 26 linhas (não trata merge)
#   em origin/main ............. 230 linhas (trata, desde 20796abf7)
#
# O `$top` faz cada worktree rodar os guards DELA — o que salva quem trabalha em
# branch atualizada e NÃO salva quem commita do checkout principal, porque lá o
# `$top` é o próprio checkout atrasado. O resultado é o pior tipo de falha: o
# commit passa, o guard "rodou", e a versão que rodou é mais fraca do que a que
# está na `main`. Ninguém vê.
#
# ## A régua: ATRASADO bloqueia, MODIFICADO só avisa
#
# São dois estados diferentes, e tratá-los igual quebraria todo PR que mexe em
# hook (inclusive este):
#
#   - **ATRASADO** — o arquivo aqui é IDÊNTICO ao da base comum com a
#     `origin/main`, e a `origin/main` mudou desde então. A branch não tocou no
#     guard; ele só envelheceu. Isso BLOQUEIA: guard velho é guard mais fraco, e
#     o conserto é uma linha (`git merge origin/main`).
#   - **MODIFICADO** — o arquivo difere da base comum: a branch mexeu nele de
#     propósito. Isso só AVISA; a mudança está sob revisão como qualquer código.
#
# ## O que este guard NÃO faz, declarado
#
# Sem `origin/main` no clone (fetch nunca feito, máquina offline), ele não tem
# com o que comparar e SEGUE, dizendo que não mediu. Bloquear commit por falta
# de rede seria trocar um risco raro por um travamento diário — e o aviso deixa
# o não-medido visível em vez de silencioso.
set -uo pipefail

[ "${DESKCOMM_GOV_HOOKS_ATRASADOS_OK:-0}" = "1" ] && exit 0

top="$(git rev-parse --show-toplevel)"
base_remota="origin/main"

if ! git rev-parse --verify -q "${base_remota}^{commit}" >/dev/null 2>&1; then
  echo "guard-hooks-atualizados: NÃO MEDIDO — '${base_remota}' não existe neste clone (rode 'git fetch origin main')." >&2
  exit 0
fi

fusao="$(git merge-base HEAD "$base_remota" 2>/dev/null || true)"
if [ -z "$fusao" ]; then
  echo "guard-hooks-atualizados: NÃO MEDIDO — não há base comum com '${base_remota}'." >&2
  exit 0
fi

atrasados=""
for guard in loop/hooks/*.sh loop/hooks/pre-commit loop/hooks/pre-push; do
  [ -f "$top/$guard" ] || continue
  aqui="$(git hash-object "$top/$guard")"
  na_base="$(git rev-parse -q --verify "${fusao}:${guard}" 2>/dev/null || true)"
  no_remoto="$(git rev-parse -q --verify "${base_remota}:${guard}" 2>/dev/null || true)"

  # Sem versão no remoto: guard novo, nascido nesta branch. Nada a comparar.
  [ -z "$no_remoto" ] && continue
  # Igual ao remoto: em dia.
  [ "$aqui" = "$no_remoto" ] && continue

  if [ "$aqui" = "$na_base" ]; then
    atrasados="${atrasados}  ${guard}\n"
  else
    echo "guard-hooks-atualizados: ${guard} foi MODIFICADO nesta branch — ele roda assim, e a mudança vai para revisão." >&2
  fi
done

if [ -n "$atrasados" ]; then
  echo "pre-commit BLOQUEADO: os guards deste checkout estão ATRASADOS em relação à ${base_remota}:" >&2
  printf '%b' "$atrasados" >&2
  echo "Esta branch não os tocou — eles só envelheceram, e guard velho é guard mais fraco:" >&2
  echo "o freeze-invariants de antes de 20796abf7, por exemplo, não trata merge e acusa resolução legítima." >&2
  echo "Conserto: git merge ${base_remota}   (ou 'git fetch origin main' antes, se a cópia local estiver velha)" >&2
  echo "Se você PRECISA commitar sem atualizar: DESKCOMM_GOV_HOOKS_ATRASADOS_OK=1, e diga no commit por quê." >&2
  exit 1
fi

exit 0
