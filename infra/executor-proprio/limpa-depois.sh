#!/usr/bin/env bash
# Gancho de SAÍDA dos runners persistentes (ACTIONS_RUNNER_HOOK_JOB_COMPLETED).
# Roda depois de todo job, inclusive cancelado ou cortado por relógio, quando o
# trap dos scripts pode não ter rodado. Num runner persistente o que sobra fica
# no disco e na RAM para o próximo job.
#
# Só os contêineres DESTE job: os scripts de banco os rotulam com
# `deskcomm.worktree=<checkout>`, e o checkout é deste runner (um job por vez
# por runner). O rótulo por run/job não serviria: as duas pernas de uma matriz
# têm o mesmo GITHUB_RUN_ID e o mesmo GITHUB_JOB e rodam ao mesmo tempo nos dois
# runners — a primeira a terminar apagaria o Postgres da outra.
set -u
if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  for c in $(docker ps -aq --filter "label=deskcomm.worktree=${GITHUB_WORKSPACE}" 2>/dev/null); do
    docker rm -f -v "$c" >/dev/null 2>&1 || true
  done
fi
# Rede de segurança para o que escapou: contêiner PARADO há mais de 6 h e volume
# sem contêiner. Nenhum dos dois alcança o que o outro runner está usando.
docker container prune -f --filter "until=6h" >/dev/null 2>&1 || true
docker volume prune -f >/dev/null 2>&1 || true
rm -rf "${RUNNER_TEMP:-/nonexistent}"/* 2>/dev/null || true
exit 0
