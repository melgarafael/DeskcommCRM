#!/usr/bin/env bash
# Guarda a chave de TESTE da Stripe fora do repositório, sem que ela passe pelo
# chat, pela linha de comando ou pelo histórico do shell. Quem roda é o DONO,
# depois de COPIAR a chave no painel da Stripe. Nunca imprime a chave.
# Com a entrada num terminal (o dono), lê da área de transferência, fala e a
# limpa; com a entrada num pipe (o teste), lê do pipe, em silêncio.
set -eu
umask 077
DIR="${HOME}/.config/deskcomm"
ARQ="${DIR}/stripe-teste.key"
if [ -t 0 ]; then INTERATIVO=1; CHAVE="$(pbpaste | tr -d '[:space:]')"; else INTERATIVO=0; CHAVE="$(tr -d '[:space:]')"; fi
falar() { if [ "${INTERATIVO}" = 1 ]; then say -v Luciana "$1" || true; fi; }
limpar() { if [ "${INTERATIVO}" = 1 ]; then pbcopy </dev/null; fi; }
case "${CHAVE}" in
  sk_test_*|rk_test_*) ;;
  sk_live_*|rk_live_*)
    limpar
    falar "Essa chave é de produção. Não guardei. Copie a chave de teste."
    echo "RECUSADO: chave de produção. Nada foi guardado."
    exit 3 ;;
  *)
    falar "Não achei uma chave de teste da Stripe copiada."
    echo "RECUSADO: não recebi uma chave sk_test_ ou rk_test_."
    exit 2 ;;
esac
mkdir -p "${DIR}"
chmod 700 "${DIR}"
printf '%s' "${CHAVE}" > "${ARQ}"
chmod 600 "${ARQ}"
limpar
falar "Chave guardada"
echo "Chave de teste guardada."
