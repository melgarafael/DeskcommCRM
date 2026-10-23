#!/usr/bin/env bash
# app_esta_no_ar julga pelo CORPO da rota, não pelo código HTTP (#2757).
#
#   bash tests/shell/app-no-ar-pelo-corpo.test.sh
#
# ## O defeito que este arquivo guarda
#
# `/api/v1/health` responde **503** sempre que um dos serviços que ela vigia
# (WAHA, Redis, Supabase) está `down`. O `app_esta_no_ar` usava `curl -f`, então
# esse 503 contava como "o site caiu": uma queda do WhatsApp de ~10 minutos,
# dentro das 2 h depois de uma atualização que deu CERTO, fazia o agente voltar
# de versão — backup, migration e ~2 min fora do ar para consertar nada (o
# mantenedor mediu; ver o comentário do PR #2775).
#
# E o código HTTP sozinho não separa os dois casos que importam: o 503 do
# Traefik sem rota e o 503 da rota com o WhatsApp fora têm o MESMO número e
# significados opostos. Quem separa é o corpo — o JSON que só o sistema produz.
#
# ## Os seis casos (o que o mantenedor pediu, um a um)
#
#   1. 200 + JSON da rota (`healthy`)          → NO AR
#   2. 503 + JSON da rota (`unhealthy`)        → NO AR   ← é o caso do defeito
#   3. 503 SEM o JSON (página do proxy)        → FORA
#   4. 502 com HTML de proxy                   → FORA
#   5. porta fechada (conexão recusada)        → FORA
#   6. servidor que demora mais que --max-time → FORA
#
# ## Sabotagem (a prova de que o caso 2 guarda a linha certa)
#
# Devolver o `-f` ao `curl` do `app_esta_no_ar` (o código de antes) reprova o
# caso 2 e mais nenhum: com `-f`, 503 vira falha do curl e a função devolve
# "fora" mesmo com o JSON da rota no corpo.
#
# Nada aqui toca a máquina de quem roda: o servidor é local, em porta efêmera,
# e morre no `trap`.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMUM="$RAIZ/hostgator-setup-kit/_common.sh"
[ -r "$COMUM" ] || { echo "não achei $COMUM"; exit 1; }

falhas=0
ok()  { printf '  ✓ %s\n' "$1"; }
nao() { printf '  ✗ %s\n     esperava: %s\n     veio:     %s\n' "$1" "$2" "$3"; falhas=$((falhas + 1)); }

WORK="$(mktemp -d)"
[ -n "$WORK" ] && [ -d "$WORK" ] || { echo "abortado: mktemp -d não devolveu sandbox" >&2; exit 1; }
SERVIDOR_PID=""
limpar() {
  [ -n "$SERVIDOR_PID" ] && kill "$SERVIDOR_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap limpar EXIT

command -v python3 >/dev/null 2>&1 || { echo "abortado: python3 é o servidor local desta prova"; exit 1; }

# ── O servidor local: cada prefixo de caminho é um dos casos ────────────────
cat > "$WORK/servidor.py" <<'PY'
import sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JSON_OK = b'{"data":{"status":"healthy","version":"1.4.2","timestamp":"2026-10-20T12:00:00Z","checks":{}}}\n'
JSON_BAD = b'{"data":{"status":"unhealthy","version":"1.4.2","checks":{"waha":{"status":"down","latency_ms":0}}}}'
PROXY_503 = b'no available server\n'
PROXY_502 = b'<html><head><title>502 Bad Gateway</title></head><body>proxy</body></html>\n'

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        p = self.path
        if p.startswith("/ok"):
            self._reply(200, JSON_OK)
        elif p.startswith("/unhealthy"):
            self._reply(503, JSON_BAD)
        elif p.startswith("/proxy503"):
            self._reply(503, PROXY_503)
        elif p.startswith("/proxy502"):
            self._reply(502, PROXY_502)
        elif p.startswith("/lento"):
            time.sleep(40)
            self._reply(200, JSON_OK)
        else:
            self._reply(404, b"404 page not found\n")

    def _reply(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if body.startswith(b"{") else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
PY

python3 "$WORK/servidor.py" > "$WORK/porta.txt" 2>"$WORK/servidor.err" &
SERVIDOR_PID=$!
PORTA=""
for _ in $(seq 1 50); do
  PORTA="$(head -1 "$WORK/porta.txt" 2>/dev/null || true)"
  [ -n "$PORTA" ] && break
  sleep 0.1
done
if [ -z "$PORTA" ]; then
  echo "abortado: o servidor local não subiu" >&2
  cat "$WORK/servidor.err" >&2
  exit 1
fi
printf '  servidor local na porta %s\n' "$PORTA"

# Sonda a função REAL, num processo próprio: `_common.sh` liga `set -euo
# pipefail` e cada caso precisa do seu próprio shell limpo.
sondar() {  # sondar <caminho> → 0 = no ar, 1 = fora
  ( export NEXT_PUBLIC_APP_URL="http://127.0.0.1:${PORTA}${1}"
    # shellcheck source=/dev/null
    source "$COMUM" >/dev/null 2>&1
    app_esta_no_ar
  ) >/dev/null 2>&1
}

verificar() {  # verificar <descrição> <caminho|PORTA_FECHADA> <no_ar|fora>
  local desc="$1" caminho="$2" esperado="$3" rc
  if [ "$caminho" = "PORTA_FECHADA" ]; then
    ( export NEXT_PUBLIC_APP_URL="http://127.0.0.1:1"
      # shellcheck source=/dev/null
      source "$COMUM" >/dev/null 2>&1
      app_esta_no_ar
    ) >/dev/null 2>&1; rc=$?
  else
    sondar "$caminho"; rc=$?
  fi
  local veio="fora"
  [ "$rc" -eq 0 ] && veio="no ar"
  if [ "$veio" = "$esperado" ]; then
    ok "$desc → $esperado"
  else
    nao "$desc" "$esperado" "$veio"
  fi
}

echo "── 1. 200 com o JSON da rota (healthy)"
verificar "200 + JSON da rota" /ok "no ar"

echo "── 2. 503 com o JSON da rota (unhealthy) — o caso do defeito"
verificar "503 + JSON da rota" /unhealthy "no ar"

echo "── 3. 503 SEM o JSON da rota (página do proxy)"
verificar "503 do proxy, sem o JSON" /proxy503 fora

echo "── 4. 502 com HTML de proxy"
verificar "502 com HTML do proxy" /proxy502 fora

echo "── 5. porta fechada (conexão recusada)"
verificar "conexão recusada" PORTA_FECHADA fora

echo "── 6. servidor que demora mais que o --max-time"
verificar "tempo esgotado (--max-time 20)" /lento fora

echo
if [ "$falhas" -eq 0 ]; then
  echo "app-no-ar-pelo-corpo: 6 casos, todos de acordo com o corpo da rota."
  exit 0
fi
echo "app-no-ar-pelo-corpo: $falhas caso(s) em desacordo."
exit 1
