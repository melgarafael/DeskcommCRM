#!/usr/bin/env bash
# Guarda a chave de API do SANDBOX do Asaas fora do repositório, sem que ela
# passe pelo chat, pela linha de comando ou pelo histórico do shell. Quem roda é
# o DONO, depois de COPIAR a chave no painel do sandbox. Nunca imprime a chave.
# Com a entrada num terminal (o dono), lê da área de transferência, fala e a
# limpa; com a entrada num pipe (o teste), lê do pipe, em silêncio.
# Molde: scripts/guardar-chave-stripe-teste.sh.
set -eu
umask 077
DIR="${HOME}/.config/deskcomm"
ARQ="${DIR}/asaas-sandbox.key"
if [ -t 0 ]; then INTERATIVO=1; CHAVE="$(pbpaste | tr -d '[:space:]')"; else INTERATIVO=0; CHAVE="$(tr -d '[:space:]')"; fi
falar() { if [ "${INTERATIVO}" = 1 ]; then say -v Luciana "$1" || true; fi; }
limpar() { if [ "${INTERATIVO}" = 1 ]; then pbcopy </dev/null; fi; }
case "${CHAVE}" in
  '$aact_hmlg_'*) ;;
  '$aact_prod_'*)
    limpar
    falar "Essa chave é de produção. Não guardei. Copie a chave do sandbox."
    echo "RECUSADO: chave de produção do Asaas. Nada foi guardado."
    exit 3 ;;
  *)
    # A chave antiga, sem marca de ambiente, PODE ser de produção: não fica na área de transferência.
    case "${CHAVE}" in '$aact_'*) limpar ;; esac
    falar "Não achei uma chave do sandbox do Asaas copiada."
    echo 'RECUSADO: não recebi uma chave do sandbox ($aact_hmlg_). Chave antiga, sem a marca do ambiente, também é recusada: gere uma nova no sandbox.'
    exit 2 ;;
esac
mkdir -p "${DIR}"
chmod 700 "${DIR}"
printf '%s' "${CHAVE}" > "${ARQ}"
chmod 600 "${ARQ}"
limpar
falar "Chave guardada"
echo "Chave do sandbox guardada."
