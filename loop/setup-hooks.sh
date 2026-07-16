#!/usr/bin/env bash
# setup-hooks.sh — arma os hooks determinísticos do gov-loop (uma vez por checkout).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath loop/hooks
chmod +x loop/hooks/*
echo "ok: core.hooksPath=loop/hooks (pre-commit: features + migration-triple + freeze-invariants; pre-push: gate de fase)"

missing=0
if ! command -v jq >/dev/null 2>&1; then
  echo "FALTA jq — os hooks de pre-commit e o guard PreToolUse dependem dele. Instale: brew install jq" >&2
  missing=1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "FALTA node — loop/update-feature.ts e loop/setup-claude-guard.mjs dependem dele. Instale Node >= 22.18 (nvm install 22)" >&2
  missing=1
else
  major=$(node --version | sed -E 's/^v([0-9]+).*/\1/')
  if [ "$major" -lt 22 ]; then
    echo "AVISO: node $(node --version) < 22.18 — 'node loop/update-feature.ts' exige type-stripping (Node >= 22.18, ou rode com --experimental-strip-types em 22.6+)." >&2
  fi
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "AVISO: docker não encontrado — 'pnpm test:db' e a suíte tests/invariants (Postgres descartável, G1-02/03) precisam dele." >&2
fi

exit $missing
