#!/usr/bin/env bash
# Guarda de entrada do executor próprio: roda ANTES de todo job, e job que ela
# recusa não executa nenhum passo (exit != 0 → "the job will not run and will be
# marked as failed", docs do GitHub sobre ACTIONS_RUNNER_HOOK_JOB_STARTED).
#
# Por que a guarda mora AQUI e não no `runs-on` dos workflows: o repositório é
# público, e num `pull_request` de fork o GitHub roda o workflow da BRANCH DO
# FORK. Quem abre o PR pode reescrever `runs-on:` para mirar esta máquina — a
# expressão dos nossos YAML só decide para quem não a edita. Este arquivo é
# gravado na imagem do executor, fora do alcance de qualquer PR, e é lido pelo
# processo do runner antes do checkout.
#
# Aceita só o que já exige permissão de escrita no repositório, e nunca de bot:
#   - push, workflow_dispatch, schedule, merge_group;
#   - pull_request cuja branch mora NESTE repositório (não num fork).
# Recusa todo o resto — inclusive pull_request_target e qualquer evento novo que
# o GitHub venha a criar. Na dúvida (payload ilegível, campo ausente), recusa.
set -uo pipefail

REPO_ESPERADO="${DESKCOMM_REPO_ESPERADO:-melgarafael/DeskcommCRM}"

recusa() {
  echo "::error::executor próprio recusou este job: $1. Ele só roda trabalho de branch deste repositório; PR de fork roda nas máquinas do GitHub." >&2
  exit 1
}

[ "${GITHUB_REPOSITORY:-}" = "$REPO_ESPERADO" ] \
  || recusa "repositório '${GITHUB_REPOSITORY:-<vazio>}' não é ${REPO_ESPERADO}"

# Bot nunca: o dependabot abre PR com branch DESTE repositório, então passaria
# na regra de origem abaixo e rodaria atualização de dependência com o Docker do
# host. O roteamento dos workflows já o manda ao GitHub; isto vale para quem não
# segue o roteamento.
case "${GITHUB_ACTOR:-}" in
  *"[bot]") recusa "ator '${GITHUB_ACTOR}' é bot (bots rodam nas máquinas do GitHub)" ;;
esac

case "${GITHUB_EVENT_NAME:-}" in
  push | workflow_dispatch | schedule | merge_group)
    echo "executor próprio: evento ${GITHUB_EVENT_NAME} aceito"
    exit 0
    ;;
  pull_request)
    [ -r "${GITHUB_EVENT_PATH:-}" ] || recusa "payload do evento ilegível"
    origem=$(jq -r '.pull_request.head.repo.full_name // ""' "$GITHUB_EVENT_PATH" 2>/dev/null) \
      || recusa "payload do evento não é JSON"
    [ "$origem" = "$REPO_ESPERADO" ] || recusa "a branch do PR mora em '${origem:-<desconhecido>}'"
    echo "executor próprio: PR de branch deste repositório aceito"
    exit 0
    ;;
  *)
    recusa "evento '${GITHUB_EVENT_NAME:-<vazio>}' fora da lista"
    ;;
esac
