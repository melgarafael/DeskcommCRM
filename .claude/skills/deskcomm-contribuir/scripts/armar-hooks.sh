#!/usr/bin/env bash
# armar-hooks.sh — arma, neste clone, os hooks de git do contribuidor.
#
# Por que existem: os hooks do mantenedor (`loop/hooks`) são configuração LOCAL
# do clone dele (`core.hooksPath`), não viajam no repositório, e nenhum fork os
# roda. O defeito que eles evitam é o mais frequente da triagem — migration sem
# a tripla, ou com número já usado (renumerada 11 vezes desde agosto de 2026).
#
# O que arma (e só isso):
#   pre-commit  → tripla de migration + NNNN/timestamp únicos contra origin/main
#                 e branches locais; aviso (sem bloquear) de identidade root@/sem e-mail
#   pre-push    → recusa push na main/master; aviso de branch atrasada
#
# Uso: bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh [--desarmar]
set -euo pipefail

raiz="$(git rev-parse --show-toplevel)"
cd "$raiz"
alvo=".agents/skills/deskcomm-contribuir/scripts/hooks"
atual="$(git config --get core.hooksPath || true)"

if [ "${1:-}" = "--desarmar" ]; then
  if [ "$atual" = "$alvo" ]; then
    git config --unset core.hooksPath
    echo "ok: hooks do contribuidor desarmados (core.hooksPath removido)."
  else
    echo "nada a fazer: core.hooksPath=${atual:-<vazio>} não é o dos hooks do contribuidor."
  fi
  exit 0
fi

if [ -n "$atual" ] && [ "$atual" != "$alvo" ]; then
  echo "core.hooksPath já aponta para '$atual' — este clone tem hooks próprios (o mantenedor usa loop/hooks)." >&2
  echo "Não sobrescrevo. Se for mesmo trocar: git config core.hooksPath $alvo" >&2
  exit 2
fi

chmod +x "$alvo"/* 2>/dev/null || true
git config core.hooksPath "$alvo"
echo "ok: core.hooksPath=$alvo"
echo "  pre-commit: migration nova exige apêndice no baseline.sql + linha no MANIFEST.md no mesmo commit;"
echo "              NNNN e timestamp únicos contra origin/main e branches locais"
echo "  pre-push:   push na main/master é recusado; branch atrasada gera aviso"
echo "  identidade: commit como root@… ou sem e-mail gera aviso (o crédito some do seu perfil)"
echo "Desarmar: bash $alvo/../armar-hooks.sh --desarmar"
