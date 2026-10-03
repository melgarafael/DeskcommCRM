#!/usr/bin/env bash
# Smoke nativo do boot da imagem, SEM ARI, banco ou chave reais. Não prova ligação.
set -euo pipefail

sonda_voice_classificar() { # <logs> <running|exited>
  local logs="${1:-}" estado="${2:-}"
  if printf '%s' "$logs" | grep -Eq 'Cannot find module|ERR_MODULE_NOT_FOUND|Cannot use import statement|SyntaxError|env faltando|MODULE_NOT_FOUND'; then
    printf 'Agente de voz falhou no import ou configuração de boot\n' >&2
    return 1
  fi
  if [ "$estado" != running ]; then
    printf 'Agente de voz encerrou antes de servir AudioSocket\n' >&2
    return 1
  fi
  if ! printf '%s' "$logs" | grep -q 'servidor TCP escutando na porta'; then
    printf 'Agente de voz não anunciou o listener AudioSocket\n' >&2
    return 1
  fi
}

sonda_voice_imagem() { # <imagem local já construída no runner nativo>
  local imagem="${1:-}" nome="voice-smoke-$$" logs estado
  [ -n "$imagem" ] || { printf 'Informe a imagem de voz\n' >&2; return 1; }
  trap 'docker rm -f "$nome" >/dev/null 2>&1 || true' RETURN
  docker run -d --network none --name "$nome" \
    -e NEXT_PUBLIC_SUPABASE_URL=https://exemplo.invalid \
    -e NEXT_PUBLIC_SUPABASE_ANON_KEY=chave-anon-de-mentira \
    -e SUPABASE_SERVICE_ROLE_KEY=chave-de-mentira \
    -e ARI_URL=http://127.0.0.1:8088/ari \
    -e ARI_WS_URL=ws://127.0.0.1:8088/ari/events \
    -e ARI_USERNAME=usuario-de-mentira \
    -e ARI_PASSWORD=senha-de-mentira \
    -e OPENAI_API_KEY=sk-chave-de-mentira \
    "$imagem" >/dev/null
  for _ in $(seq 1 30); do
    logs="$(docker logs "$nome" 2>&1 || true)"
    if docker ps --filter "name=$nome" --filter status=running -q | grep -q .; then
      estado=running
    else
      estado=exited
    fi
    if [ "$estado" != running ] || printf '%s' "$logs" | grep -q 'servidor TCP escutando na porta'; then
      sonda_voice_classificar "$logs" "$estado" || { printf '%s\n' "$logs" | tail -30 >&2; return 1; }
      printf 'Boot nativo do voice-agent OK; ARI, banco e chamada real não medidos.\n'
      return 0
    fi
    sleep 2
  done
  printf 'Timeout: listener AudioSocket não abriu em 60s\n' >&2
  docker logs "$nome" 2>&1 | tail -30 >&2 || true
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  sonda_voice_imagem "${1:-}"
fi
