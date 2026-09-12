#!/usr/bin/env bash
# check-migration-triple.sh (contribuidor) — a tripla de migration é indivisível.
#
# Commit que ADICIONA supabase/migrations/*.sql precisa, no MESMO commit:
#   1. mudança em supabase/baseline.sql (apêndice idempotente — é o que o kit
#      self-host aplica; migration que não chega lá não chega em quem instalou)
#   2. linha em supabase/migrations/MANIFEST.md
# E o NNNN e o TIMESTAMP do nome novo não podem existir em origin/main nem em
# branch local: colisão é o defeito nº 1 da triagem (renumerada 11 vezes desde
# agosto de 2026), e quem cria migration copiando outra copia os dois.
#
# Diferença para o hook do mantenedor (loop/hooks): compara contra origin/main
# (um fork raramente tem outras branches locais) e não conhece a dívida de
# timestamp da main, que é assunto do mantenedor.
# Bypass explícito (correção orientada pelo mantenedor): DESKCOMM_MIGRATION_EDIT=1
set -euo pipefail

[ "${DESKCOMM_MIGRATION_EDIT:-0}" = "1" ] && exit 0

novas="$(git diff --cached --name-status | awk '$1 == "A" && $2 ~ /^supabase\/migrations\/.*\.sql$/ { print $2 }')"
[ -z "$novas" ] && exit 0

staged="$(git diff --cached --name-only)"
falhou=0

if ! grep -qx 'supabase/baseline.sql' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem apêndice em supabase/baseline.sql no MESMO commit." >&2
  echo "  O kit self-host aplica SÓ o baseline: sem o apêndice, a mudança não chega em quem instalou numa VPS." >&2
  falhou=1
fi
if ! grep -qx 'supabase/migrations/MANIFEST.md' <<<"$staged"; then
  echo "pre-commit BLOQUEADO: migration nova sem linha em supabase/migrations/MANIFEST.md no MESMO commit." >&2
  falhou=1
fi

# Refs contra as quais a unicidade é medida: origin/main (se existe) + branches locais.
refs="$(git branch --format='%(refname:short)' 2>/dev/null || true)"
if git rev-parse -q --verify origin/main >/dev/null 2>&1; then refs="origin/main
$refs"; fi

while IFS= read -r caminho; do
  nome="$(basename "$caminho")"
  ts="$(sed -nE 's/^([0-9]{14})_[0-9]{4}_.+\.sql$/\1/p' <<<"$nome")"
  nnnn="$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$nome")"
  if [ -z "$nnnn" ] || [ -z "$ts" ]; then
    echo "pre-commit BLOQUEADO: '$nome' não segue <timestamp de 14 dígitos>_<NNNN>_<slug>.sql." >&2
    falhou=1
    continue
  fi
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    existentes="$(git ls-tree -r --name-only "$ref" -- supabase/migrations 2>/dev/null | sed 's#^supabase/migrations/##' || true)"
    colisao_n="$(grep -E "^[0-9]{14}_${nnnn}_.+\.sql$" <<<"$existentes" | grep -vx "$nome" || true)"
    colisao_t="$(grep -E "^${ts}_[0-9]{4}_.+\.sql$" <<<"$existentes" | grep -vx "$nome" || true)"
    if [ -n "$colisao_n" ]; then
      echo "pre-commit BLOQUEADO: NNNN=$nnnn de '$nome' já existe em '$ref': $colisao_n" >&2
      echo "  Próximo livre: git ls-tree -r --name-only origin/main -- supabase/migrations | sed -E 's/.*_([0-9]{4})_.*/\\1/' | sort -n | tail -1" >&2
      echo "  Troque o TIMESTAMP junto (date -u +%Y%m%d%H%M%S) — renumerar só o NNNN é o que fabrica colisão de timestamp." >&2
      falhou=1
    fi
    if [ -n "$colisao_t" ]; then
      echo "pre-commit BLOQUEADO: timestamp $ts de '$nome' já existe em '$ref': $colisao_t" >&2
      echo "  O Supabase usa o timestamp como identidade da migration; dois iguais quebram db push/reset." >&2
      falhou=1
    fi
  done <<<"$refs"
done <<<"$novas"

if [ "$falhou" = 1 ]; then
  echo "Correção orientada pelo mantenedor: DESKCOMM_MIGRATION_EDIT=1 git commit …" >&2
  exit 1
fi
exit 0
