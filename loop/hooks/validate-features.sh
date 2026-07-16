#!/usr/bin/env bash
# validate-features.sh — imutabilidade de plan/features.json (enforcement, não prosa).
# O loop só pode mudar os campos "passes" e "verification" de cada feature —
# e mesmo isso via `node loop/update-feature.ts`, nunca editor.
# Adicionar/remover/redefinir features é ato humano: DESKCOMM_GOV_PLAN_EDIT=1.
set -euo pipefail

# Sessão humana / lane de features declarada explicitamente
[ "${DESKCOMM_GOV_PLAN_EDIT:-0}" = "1" ] && exit 0

# features.json não está no commit → nada a validar
git diff --cached --name-only | grep -qx 'plan/features.json' || exit 0

command -v jq >/dev/null 2>&1 || {
  echo "pre-commit: jq é obrigatório para validar plan/features.json (brew install jq)." >&2
  exit 1
}

# Criação do arquivo (não existe em HEAD) só em sessão humana
if ! git cat-file -e HEAD:plan/features.json 2>/dev/null; then
  echo "pre-commit BLOQUEADO: criação de plan/features.json exige DESKCOMM_GOV_PLAN_EDIT=1 (sessão humana)." >&2
  exit 1
fi

old=$(git show HEAD:plan/features.json)
new=$(git show :plan/features.json)

# 1) Nada fora de .features pode mudar
if [ "$(jq -S 'del(.features)' <<<"$old")" != "$(jq -S 'del(.features)' <<<"$new")" ]; then
  echo "pre-commit BLOQUEADO: campos de topo de plan/features.json mudaram." >&2
  echo "O loop só escreve 'passes' e 'verification' (via node loop/update-feature.ts)." >&2
  echo "Mudar o plano é ato humano: DESKCOMM_GOV_PLAN_EDIT=1." >&2
  exit 1
fi

# 2) Ignorando passes/verification, o conjunto de features tem que ser IDÊNTICO
#    (pega edição de acceptance/depends_on/title/priority E adição/remoção de feature)
strip='[.features[] | del(.passes, .verification)] | sort_by(.id)'
if [ "$(jq -S "$strip" <<<"$old")" != "$(jq -S "$strip" <<<"$new")" ]; then
  echo "pre-commit BLOQUEADO: plan/features.json só pode mudar nos campos 'passes' e 'verification'." >&2
  echo "Editar acceptance/depends_on/title/priority ou adicionar/remover features é ato humano." >&2
  echo "Se a feature está mal-escrita, abra item na inbox (loop/INBOX.md) — não reescreva o teste." >&2
  echo "Sessão humana/lane de features: re-execute o commit com DESKCOMM_GOV_PLAN_EDIT=1." >&2
  exit 1
fi

exit 0
