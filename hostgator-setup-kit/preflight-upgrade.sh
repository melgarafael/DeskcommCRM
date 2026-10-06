#!/usr/bin/env bash
# Pré-voo somente-leitura para uma instalação cuja cópia do update.sh é antiga.
# Execute a partir de um clone NOVO do mesmo fork, antes do updater antigo.
set -euo pipefail
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$KIT_DIR/_common.sh"

INSTALLATION=""; TARGET_TAG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --installation|--to)
      option="$1"; shift
      [ "$#" -gt 0 ] || { printf 'Falta valor para %s\n' "$option" >&2; exit 2; }
      if [ "$option" = --installation ]; then INSTALLATION="$1"; else TARGET_TAG="$1"; fi ;;
    *) printf 'Opção desconhecida: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "$INSTALLATION" ] && [ -n "$TARGET_TAG" ] || {
  printf 'Uso: bash hostgator-setup-kit/preflight-upgrade.sh --installation <pasta> --to vX.Y.Z\n' >&2
  exit 2
}
INSTALLATION="$(readlink -f -- "$INSTALLATION")" || exit 2
[ -d "$INSTALLATION" ] && [ -f "$INSTALLATION/docker-compose.prod.yml" ] && [ -f "$INSTALLATION/.env" ] || {
  printf 'Instalação não encontrada (compose e .env necessários): %s\n' "$INSTALLATION" >&2
  exit 2
}

# load_env interpreta os valores como DADOS, não executa o .env. Fica num
# processo isolado e não imprime nem registra nenhuma credencial.
load_env "$INSTALLATION/.env"
PLATAFORMA="$(plataforma_oci_do_host "$(uname -m 2>/dev/null || true)")" || {
  printf 'Sem imagem nativa para este host; o pré-voo não pode aprovar a atualização.\n' >&2
  exit 1
}
preflight_plataforma_atualizacao "$TARGET_TAG" "$PLATAFORMA" || {
  printf 'Atualização recusada antes de qualquer escrita. Não rode o updater antigo para este alvo.\n' >&2
  exit 1
}
printf 'Pré-voo OK: %s oferece %s nas quatro imagens do CRM e na WAHA efetiva.\n' "$TARGET_TAG" "$PLATAFORMA"
printf 'Nenhum arquivo, contêiner ou banco foi alterado. Rode o updater existente com --to %s.\n' "$TARGET_TAG"
