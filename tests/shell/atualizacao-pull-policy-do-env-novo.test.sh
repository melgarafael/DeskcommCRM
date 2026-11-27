#!/usr/bin/env bash
# A cerca da regra de download da issue #5116 no lugar em que o CI a roda.
#
# O trabalho é de `scripts/test-update-pull-policy.sh` (sandbox com `docker`
# dublê, git descartável, os casos A1/A2 e a sabotagem A4). Este arquivo só
# existe porque o CI roda teste de shell por `pnpm test:shell`, e um
# `scripts/test-*.sh` chamado por ninguém não roda em lugar nenhum — a regra
# está em tests/unit/test-shell-roda-os-validadores-do-kit.test.ts.
#
#   bash tests/shell/atualizacao-pull-policy-do-env-novo.test.sh
#
# `set -euo pipefail` + `exec` para o rc ser exatamente o do script provado:
# sem isso o `if` do wrapper transformaria um vermelho em verde.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$RAIZ/scripts/test-update-pull-policy.sh"
