#!/usr/bin/env bash
#
# Porta de entrada para instalar o DeskcommCRM em produção numa VPS Ubuntu.
# A entrevista, a geração do .env e a orquestração da stack continuam no
# instalador self-host canônico para que haja uma única fonte de verdade.

set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly KIT_INSTALLER="$ROOT_DIR/hostgator-setup-kit/install-single-server.sh"

COLOR=0
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then COLOR=1; fi

paint() {
  local code="$1"
  shift
  if [[ "$COLOR" == 1 ]]; then
    printf '\033[%sm%s\033[0m\n' "$code" "$*"
  else
    printf '%s\n' "$*"
  fi
}

step() { printf '\n'; paint 32 "▶ $*"; }
warn() { paint 33 "⚠ $*"; }
die()  { paint 31 "✖ $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Uso: bash ubuntu-production-installer.sh [--domain DOMINIO]

Prepara uma VPS Ubuntu e inicia a instalação de produção do DeskcommCRM.

Modo interativo (recomendado):
  bash ubuntu-production-installer.sh

O instalador pergunta somente o domínio. Ele gera todos os segredos, instala o
Supabase self-hosted, cria o administrador inicial, configura HTTPS, sobe os
serviços Docker e valida DNS, banco e saúde. A IA inicia desativada.

Modo não interativo:
  bash ubuntu-production-installer.sh --domain crm.suaempresa.com.br

Serviços locais em Docker:
  app, worker, scheduler, WAHA, Redis, adaptador Redis HTTP, Caddy e Supabase
  self-hosted (Postgres, Auth, REST, Realtime e Storage).

Requisitos: VPS amd64 com no mínimo 4 GB de RAM (8 GB recomendados) e DNS do
domínio apontando para ela.
EOF
}

main() {
  local -a argumentos_kit=()

  case "${1:-}" in
    "") ;;
    --domain)
      [[ -n "${2:-}" ]] || { usage >&2; return 2; }
      argumentos_kit=(--domain "$2")
      [[ $# -eq 2 ]] || { usage >&2; return 2; }
      ;;
    -h|--help)
      usage
      return 0
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
  [[ $# -le 2 ]] || { usage >&2; return 2; }

  [[ -r /etc/os-release ]] || die "Não consegui identificar o sistema operacional. Este instalador requer Ubuntu."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *ubuntu* || "${ID_LIKE:-}" == *debian* ]] \
    || die "Distribuição não suportada (${PRETTY_NAME:-desconhecida}). Em outro Linux, use diretamente hostgator-setup-kit/install.sh."

  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) die "Arquitetura $(uname -m) não suportada pelas imagens de produção publicadas (linux/amd64)." ;;
  esac

  [[ -f "$KIT_INSTALLER" ]] || die "Instalador canônico não encontrado em $KIT_INSTALLER. Execute este arquivo dentro do repositório completo."
  [[ -f "$ROOT_DIR/docker-compose.prod.yml" ]] || die "docker-compose.prod.yml não encontrado na raiz do projeto."

  local -a privilegiado=()
  if [[ "${EUID}" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "Execute como root ou instale sudo para preparar o Ubuntu."
    sudo -v || die "Não consegui obter permissão administrativa com sudo."
    privilegiado=(sudo)
  fi

  step "Preparando dependências básicas do Ubuntu"
  if ! "${privilegiado[@]}" apt-get update; then
    warn "Um repositório APT externo falhou; tentarei usar os índices válidos já disponíveis."
  fi
  "${privilegiado[@]}" apt-get install -y ca-certificates curl git jq openssl

  local docker_instalado_agora=0
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker ainda não está instalado."
    step "Instalando Docker Engine e Docker Compose"
    local instalador_docker
    instalador_docker="$(mktemp)"
    trap 'rm -f "${instalador_docker:-}"' RETURN
    curl -fsSL https://get.docker.com -o "$instalador_docker"
    "${privilegiado[@]}" sh "$instalador_docker"
    rm -f "$instalador_docker"
    trap - RETURN
    docker_instalado_agora=1
  fi

  command -v docker >/dev/null 2>&1 || die "Docker foi instalado, mas não apareceu no PATH."

  # O daemon pode estar disponível só para root. Nesse caso toda a entrevista
  # roda com sudo, mantendo o .env e os crons sob o mesmo dono da instalação.
  local -a executor=(bash)
  if docker info >/dev/null 2>&1; then
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não está disponível."
  elif [[ "${EUID}" -ne 0 ]] && sudo docker info >/dev/null 2>&1; then
    sudo docker compose version >/dev/null 2>&1 || die "Docker Compose v2 não está disponível para root."
    executor=(sudo -E bash)
    if [[ "$docker_instalado_agora" == 1 ]]; then
      warn "O grupo docker só vale após novo login; esta primeira instalação continuará com sudo."
    else
      warn "Seu usuário não acessa o daemon Docker; a instalação continuará com sudo."
    fi
  else
    die "O daemon Docker não está rodando ou não pode ser acessado."
  fi

  step "Iniciando a instalação inteligente de produção"
  printf '%s\n' "  • somente o domínio será perguntado;"
  printf '%s\n' "  • Supabase, banco e todos os segredos serão gerados nesta VPS;"
  printf '%s\n' "  • app, worker, scheduler, WAHA e Redis usarão redes Docker privadas;"
  printf '%s\n' "  • Caddy emitirá HTTPS e publicará apenas o app e as APIs necessárias;"
  printf '%s\n' "  • administrador e senha aleatória serão exibidos e salvos com permissão 600."

  cd "$ROOT_DIR"
  exec "${executor[@]}" "$KIT_INSTALLER" "${argumentos_kit[@]}"
}

main "$@"
