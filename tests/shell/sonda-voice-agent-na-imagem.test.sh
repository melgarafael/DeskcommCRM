#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/sonda-voice-agent-na-imagem.sh"

ok_log='[voice-agent] worker iniciado, conectando ao ARI...
[audiosocket] servidor TCP escutando na porta 9092
Error: connect ECONNREFUSED 127.0.0.1:8088'
if sonda_voice_classificar "$ok_log" running; then echo '✓ listener vivo, ARI ausente'; else exit 1; fi
if sonda_voice_classificar 'Error: Cannot find module tsx' exited; then
  echo '✗ import quebrado foi aceito'; exit 1
else echo '✓ módulo ausente recusado'; fi
if sonda_voice_classificar "$ok_log" exited; then
  echo '✗ saída inesperada foi aceita'; exit 1
else echo '✓ saída inesperada recusada'; fi
if sonda_voice_classificar '[voice-agent] worker iniciado' running; then
  echo '✗ sem listener foi aceito'; exit 1
else echo '✓ sem listener recusado'; fi
