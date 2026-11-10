#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/sonda-voice-agent-na-imagem.sh"

ok_log='[voice-agent] worker iniciado, conectando ao ARI...
[audiosocket] servidor TCP escutando na porta 9092
Error: connect ECONNREFUSED 127.0.0.1:8088'
if sonda_voice_classificar "$ok_log" running healthy; then echo '✓ listener saudável, ARI ausente'; else exit 1; fi
if sonda_voice_classificar 'Error: Cannot find module tsx' exited unhealthy; then
  echo '✗ import quebrado foi aceito'; exit 1
else echo '✓ módulo ausente recusado'; fi
if sonda_voice_classificar "$ok_log" exited unhealthy; then
  echo '✗ saída inesperada foi aceita'; exit 1
else echo '✓ saída inesperada recusada'; fi
if sonda_voice_classificar '[voice-agent] worker iniciado' running healthy; then
  echo '✗ sem listener foi aceito'; exit 1
else echo '✓ sem listener recusado'; fi

if sonda_voice_classificar "$ok_log" running starting; then
  echo '✗ saúde ainda em avaliação foi aceita'; exit 1
else
  codigo=$?
  [ "$codigo" -eq 2 ] || exit 1
  echo '✓ starting continua em espera'
fi
for saude in '' unhealthy desconhecida; do
  if sonda_voice_classificar "$ok_log" running "$saude"; then
    echo '✗ log e processo sem saúde confirmada foram aceitos'; exit 1
  else echo '✓ saúde ausente ou negativa recusada'; fi
done

# Exercita o arquivo que a imagem entrega, sem importar o worker, ARI ou banco.
# Todos os listeners são locais a este processo e fechados no finally.
node --input-type=module - "$ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const probe = join(process.argv[2], 'scripts/voice-agent-healthcheck.mjs');

async function executar(porta, preload) {
  const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' };
  if (porta !== undefined) env.AUDIOSOCKET_PORT = porta;
  const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, probe] : [probe];
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const limite = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('O probe não encerrou em 5 segundos'));
    }, 5000);
    child.stdout.on('data', (s) => { stdout += s; });
    child.stderr.on('data', (s) => { stderr += s; });
    child.once('error', (err) => { clearTimeout(limite); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(limite);
      resolve({ code, signal, stdout, stderr, duracao: Date.now() - inicio });
    });
  });
}

async function comListener(porta, usarDefault) {
  const sockets = new Set();
  let conexoes = 0, bytes = 0;
  const server = createServer((socket) => {
    conexoes += 1;
    sockets.add(socket);
    socket.on('data', (s) => { bytes += s.length; });
    socket.on('close', () => { sockets.delete(socket); });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(porta, '127.0.0.1', resolve);
    });
    const endereco = server.address();
    assert.ok(endereco && typeof endereco !== 'string');
    const result = await executar(usarDefault ? undefined : String(endereco.port));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(conexoes, 1, 'O probe precisa conectar no listener real');
    assert.equal(bytes, 0, 'A sonda não pode enviar frame de chamada');
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error('O probe deixou um socket aberto')), 1000);
      server.close(() => { clearTimeout(limite); resolve(); });
    });
    assert.equal(sockets.size, 0, 'O probe precisa fechar a conexão');
    return endereco.port;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

await comListener(9092, true);
console.log('✓ probe conecta em 9092 por padrão, não envia dados e fecha socket');
const portaFechada = await comListener(0, false);
console.log('✓ probe respeita AUDIOSOCKET_PORT');
const recusado = await executar(String(portaFechada));
assert.equal(recusado.code, 1, 'Porta fechada não pode ser saudável');
console.log('✓ conexão recusada falha fechada');

for (const porta of ['', '0', '65536', '-1', '9092junk', '9092.5', '1e3']) {
  const result = await executar(porta);
  assert.equal(result.code, 1, `Porta inválida foi aceita: ${JSON.stringify(porta)}`);
}
console.log('✓ portas inválidas falham fechadas');

// Controla apenas o transporte: o prazo e o encerramento são do script real.
const semResposta = `
  import net from 'node:net';
  import { EventEmitter } from 'node:events';
  import { syncBuiltinESMExports } from 'node:module';
  net.createConnection = () => {
    const socket = new EventEmitter();
    socket.destroy = () => { process.stdout.write('socket-fechado'); };
    return socket;
  };
  syncBuiltinESMExports();
`;
const pendente = await executar('9092', semResposta);
assert.equal(pendente.code, 1, 'Transporte sem resposta precisa expirar');
assert.ok(pendente.duracao >= 2500, 'O prazo real do probe não foi exercitado');
assert.equal(pendente.stdout, 'socket-fechado', 'A conexão pendente precisa ser destruída');
console.log('✓ transporte sem resposta expira sem processo pendente');
NODE

# O laço da sonda também é exercitado: Docker e sleep são dublês locais.
# Um log de boot pronto não pode encerrar a prova antes de healthy.
TMP_SONDA="$(mktemp -d)"
trap 'rm -rf "$TMP_SONDA"' EXIT
docker() {
  case "${1:-}" in
    image)
      [ "$CENARIO_SONDA" = sem_probe ] || printf '%s\n' '["CMD","node","scripts/voice-agent-healthcheck.mjs"]'
      ;;
    run) : > "$TMP_SONDA/criou"; printf 'container-da-fixture\n' ;;
    logs) printf '%s\n' "$ok_log" ;;
    inspect)
      case "${3:-}" in
        *State.Status*) printf 'running\n' ;;
        *State.Health*)
          local rodada=0
          [ ! -f "$TMP_SONDA/rodada" ] || read -r rodada < "$TMP_SONDA/rodada"
          rodada=$((rodada + 1))
          printf '%s\n' "$rodada" > "$TMP_SONDA/rodada"
          case "$CENARIO_SONDA" in
            progresso) if [ "$rodada" -eq 1 ]; then printf 'starting\n'; else printf 'healthy\n'; fi ;;
            sem_saude) ;;
            unhealthy) printf 'unhealthy\n' ;;
            starting) printf 'starting\n' ;;
            *) return 1 ;;
          esac
          ;;
        *) return 1 ;;
      esac
      ;;
    rm) : > "$TMP_SONDA/removeu" ;;
    *) printf 'Docker inesperado na fixture: %s\n' "$*" >&2; return 1 ;;
  esac
}
sleep() { printf '%s\n' "$1" >> "$TMP_SONDA/esperas"; }
limpar_cenario_sonda() { rm -f "$TMP_SONDA/criou" "$TMP_SONDA/removeu" "$TMP_SONDA/rodada" "$TMP_SONDA/esperas"; }

CENARIO_SONDA=progresso
if sonda_voice_imagem imagem-da-fixture; then :; else exit 1; fi
[ "$(cat "$TMP_SONDA/rodada")" = 2 ] || { echo '✗ log de boot antecipou o fim da sonda'; exit 1; }
[ "$(cat "$TMP_SONDA/esperas")" = 2 ] || exit 1
[ -f "$TMP_SONDA/removeu" ] || { echo '✗ contêiner da sonda não foi limpo'; exit 1; }
echo '✓ sonda espera starting e só termina após healthy'

limpar_cenario_sonda
CENARIO_SONDA=sem_probe
if sonda_voice_imagem imagem-da-fixture; then
  echo '✗ imagem sem probe foi aceita'; exit 1
else echo '✓ ausência do probe recusa antes do boot'; fi
[ ! -f "$TMP_SONDA/criou" ] || exit 1

for CENARIO_SONDA in sem_saude unhealthy; do
  limpar_cenario_sonda
  if sonda_voice_imagem imagem-da-fixture; then
    echo '✗ log e processo passaram sem saúde do contêiner'; exit 1
  else echo '✓ sonda recusa contêiner sem saúde confirmada'; fi
  [ -f "$TMP_SONDA/removeu" ] || exit 1
done

limpar_cenario_sonda
CENARIO_SONDA=starting
if sonda_voice_imagem imagem-da-fixture; then
  echo '✗ starting permanente foi aceito'; exit 1
else echo '✓ starting permanente esgota o orçamento existente'; fi
[ "$(awk '{ total += $1 } END { print total + 0 }' "$TMP_SONDA/esperas")" = 60 ] || exit 1
[ -f "$TMP_SONDA/removeu" ] || exit 1
