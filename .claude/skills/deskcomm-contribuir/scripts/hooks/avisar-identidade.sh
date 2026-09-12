#!/usr/bin/env bash
# avisar-identidade.sh — o crédito do commit é da pessoa, não da máquina.
#
# Commits feitos direto numa VPS saem assinados como `root@vps-…`, e o GitHub não
# associa isso a conta nenhuma: o trabalho não aparece no perfil de quem fez, e o
# .mailmap do repo só corrige com prova. Aviso, não bloqueio — o commit é válido;
# só o crédito é que se perde. Sai sempre com 0.
set -uo pipefail

nome="$(git config user.name 2>/dev/null || true)"
email="$(git config user.email 2>/dev/null || true)"

if [ -z "$email" ]; then
  echo "aviso: git config user.email está vazio — o commit sai sem e-mail e não aparece no seu perfil do GitHub." >&2
  echo "       git config --global user.email \"<e-mail da sua conta do GitHub>\"" >&2
  exit 0
fi
case "$email" in
  root@* | *@localhost | *@vps* | *@srv* | *@*.local)
    echo "aviso: o commit vai sair como '${nome:-?} <$email>' — assinatura de máquina, não de pessoa." >&2
    echo "       Para o trabalho aparecer no seu perfil: git config --global user.email \"<e-mail da sua conta do GitHub>\"" >&2
    ;;
esac
exit 0
