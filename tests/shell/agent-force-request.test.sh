#!/usr/bin/env bash
# O pedido restrito de força chega ao argv do updater, inclusive na mesma tag.
# Executa o agent.sh inteiro em sandbox. Só o updater é substituído por um
# recibo de argumentos; Docker, rede, Git remoto e instalação não são usados.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "${AGENT_FORCE_SOURCE:-$RAIZ/hostgator-setup-kit/agent.sh}" "$WORK/agent-real.sh"
FALHAS=0

ok() { printf '  ✓ %s\n' "$1"; }
falha() { printf '  ✗ %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

# Contraprova de origem: representa o agente sem o anúncio novo, lendo um
# helper que alega suporte por conta própria. O que importa é o BODY emitido,
# não a presença da palavra "supports" num arquivo do disco.
node - "$WORK/agent-real.sh" "$WORK/agent-sem-anuncio.sh" <<'NODE'
const fs = require('node:fs');
const [origem, destino] = process.argv.slice(2);
const codigo = fs.readFileSync(origem, 'utf8');
fs.writeFileSync(destino, codigo.replace(/,\\"supports_forced_update\\":\s*true/g, ''));
NODE

rodar() { # nome, força JSON (vazio = ausente), atual, alvo, ancestral, pedido, variante, helper, runtime
  local nome="$1" forca="$2" atual="$3" alvo="$4" ancestral="$5"
  local pedido="$6" variante="${7:-real}" helper="${8:-false}" caso="$WORK/$1"
  local runtime="${9:-presente}"
  mkdir -p "$caso/hostgator-setup-kit"
  cp "$WORK/agent-${variante}.sh" "$caso/hostgator-setup-kit/agent.sh"
  : > "$caso/.senha-trocada"
  # Este .env é uma fixture criada aqui, sem credenciais nem leitura do .env real.
  printf 'WORKER_IMAGE=fixture/worker:1.89.0\nSCHEDULER_IMAGE=fixture/scheduler:1.89.0\n' > "$caso/.env"
  cat > "$caso/hostgator-setup-kit/_common.sh" <<'COMMON'
set -e -o pipefail
PROJECT_DIR="$FORCE_TEST_PROJECT"
MARCA_SEGREDO_DO_CRON_NOME=.senha-trocada
REFUSED_RC=42
enter_project() { cd "$PROJECT_DIR"; }
recusar_projeto_de_outra_arvore() { return 0; }
ultima_release_estavel() { printf 'v1.91.0'; }
is_already_in_head() { return "$FORCE_TEST_ANCESTRAL"; }
veredito_da_imagem_do_app() { printf presente; }
veredito_das_imagens_da_release() { printf completa; }
completar_pin_ausente() { :; }
pin_incompleto() { :; }
vigia_ler() { :; }
ler_rodada_do_banco() { :; }
flock() { return 0; }
dc() { printf 'imagem-sintetica\n'; }
git() {
  case "${1:-}" in
    fetch) return 0 ;;
    describe) printf '%s\n' "$FORCE_TEST_CURRENT" ;;
    rev-parse) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
    merge-base) return "$FORCE_TEST_ANCESTRAL" ;;
    show) printf '## [1.91.0]\n\nFixture\n' ;;
    *) printf 'Git inesperado no harness: %s\n' "$*" >&2; return 1 ;;
  esac
}
curl() {
  local corpo=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -d ]; then shift; corpo="$1"; break; fi
    shift
  done
  printf '%s\n' "$corpo" >> "$FORCE_TEST_POSTS"
  case "$corpo" in
    *'"kind":"heartbeat"'*) printf '%s\n200' "$FORCE_TEST_RESPONSE" ;;
    *) printf '{"data":{"ok":true}}\n200' ;;
  esac
}
COMMON
  # O helper controla apenas a observação sintética. Não anuncia capacidade
  # de topo e não participa da montagem do argv do agente em execução.
  if [ "$runtime" != ausente ]; then
    cat > "$caso/hostgator-setup-kit/_runtime.sh" <<'RUNTIME'
collect_runtime_confirmation() {
  RUNTIME_CONFIRMED=true
  RUNTIME_VERSION="${FORCE_TEST_CURRENT#v}"
  RUNTIME_REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  RUNTIME_BASE="$RUNTIME_REVISION"
  RUNTIME_CONFIRMATION="{\"schema\":1,\"supports_forced_update\":${FORCE_TEST_HELPER_SUPPORT}}"
}
runtime_can_install_release() { return 0; }
RUNTIME
  fi
  cat > "$caso/hostgator-setup-kit/update.sh" <<'UPDATER'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$FORCE_TEST_ARGV"
printf 'Updater dublê chamado; nenhuma atualização executada.\n'
UPDATER
  local resposta
  resposta="$(node - "$forca" "$alvo" "$pedido" <<'NODE'
const [force, target, requested] = process.argv.slice(2);
const data = {update_requested: requested === 'true', run_id: requested === 'true' ? '33333333-3333-4333-8333-333333333333' : null, to_version: target};
if (force !== '') data.force_requested = JSON.parse(force);
process.stdout.write(JSON.stringify({data}));
NODE
  )"
  local rc=0
  env -i PATH="$PATH" \
    INTERNAL_SECRET=segredo-sintetico NEXT_PUBLIC_APP_URL=https://fixture.invalid \
    FORCE_TEST_PROJECT="$caso" FORCE_TEST_CURRENT="$atual" \
    FORCE_TEST_ANCESTRAL="$ancestral" FORCE_TEST_RESPONSE="$resposta" \
    FORCE_TEST_POSTS="$caso/posts.jsonl" FORCE_TEST_ARGV="$caso/argv.nul" \
    FORCE_TEST_HELPER_SUPPORT="$helper" \
    bash "$caso/hostgator-setup-kit/agent.sh" > "$caso/saida.log" 2>&1 || rc=$?
  printf '%s\n' "$rc" > "$caso/exit.txt"
  if [ -n "${AGENT_FORCE_EVIDENCE_DIR:-}" ]; then
    mkdir -p "$AGENT_FORCE_EVIDENCE_DIR/$nome"
    cp "$caso/"*.jsonl "$caso/saida.log" "$caso/exit.txt" "$AGENT_FORCE_EVIDENCE_DIR/$nome/" 2>/dev/null || true
    [ ! -f "$caso/argv.nul" ] || cp "$caso/argv.nul" "$AGENT_FORCE_EVIDENCE_DIR/$nome/"
  fi
}

argv_igual() {
  node - "$WORK/$1" "$2" <<'NODE'
const fs = require('node:fs');
const [dir, esperado] = process.argv.slice(2);
if (fs.readFileSync(`${dir}/exit.txt`, 'utf8').trim() !== '0') {
  process.stderr.write(fs.readFileSync(`${dir}/saida.log`, 'utf8'));
  process.exit(1);
}
const path = `${dir}/argv.nul`;
const atual = fs.existsSync(path) ? fs.readFileSync(path, 'utf8').split('\0').slice(0, -1) : null;
if (JSON.stringify(atual) !== esperado) {
  process.stderr.write(`argv esperado ${esperado}; recebido ${JSON.stringify(atual)}\n`);
  process.exit(1);
}
NODE
}

recusou_alvo() {
  node - "$WORK/$1" <<'NODE'
const fs = require('node:fs');
const dir = process.argv[2];
const posts = fs.readFileSync(`${dir}/posts.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (fs.existsSync(`${dir}/argv.nul`) || !posts.some(p => p.kind === 'run_result' && p.status === 'failed')) {
  process.stderr.write('Alvo inválido chegou ao updater ou não teve desfecho de recusa.\n');
  process.exit(1);
}
NODE
}

sem_runtime() {
  node - "$WORK/$1" "$2" <<'NODE'
const fs = require('node:fs');
const [dir, recusa] = process.argv.slice(2);
if (fs.readFileSync(`${dir}/exit.txt`, 'utf8').trim() !== '0') {
  process.stderr.write(fs.readFileSync(`${dir}/saida.log`, 'utf8'));
  process.exit(1);
}
const posts = fs.readFileSync(`${dir}/posts.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const heartbeat = posts.find(p => p.kind === 'heartbeat');
if (!heartbeat || heartbeat.runtime_confirmation !== null) {
  process.stderr.write('O caso sem helper precisa emitir runtime_confirmation null.\n');
  process.exit(1);
}
if (recusa === 'true' && (fs.existsSync(`${dir}/argv.nul`) || !posts.some(p => p.kind === 'run_result' && p.status === 'failed'))) {
  process.stderr.write('Pedido forçado sem runtime confirmado chegou ao updater ou não teve desfecho de recusa.\n');
  process.exit(1);
}
NODE
}

capacidade() {
  node - "$WORK/$1" "$2" <<'NODE'
const fs = require('node:fs');
const [dir, esperado] = process.argv.slice(2);
if (fs.readFileSync(`${dir}/exit.txt`, 'utf8').trim() !== '0') {
  process.stderr.write(fs.readFileSync(`${dir}/saida.log`, 'utf8'));
  process.exit(1);
}
const posts = fs.readFileSync(`${dir}/posts.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const heartbeat = posts.find(p => p.kind === 'heartbeat');
const suporta = heartbeat?.supports_forced_update === true;
if (!heartbeat || suporta !== (esperado === 'true')) {
  process.stderr.write(`Capacidade de topo esperada ${esperado}; recebida ${String(heartbeat?.supports_forced_update)}\n`);
  process.exit(1);
}
NODE
}

printf '── Pedido de força do host: argv e anúncio emitidos pelo agente real\n'
rodar mesma-tag true v1.89.0 v1.89.0 0 true
if argv_igual mesma-tag '["--to","v1.89.0","--force"]'; then ok 'mesma tag recebe --force'; else falha 'mesma tag recebe --force'; fi

rodar ausente '' v1.89.0 v1.90.0 1 true
if argv_igual ausente '["--to","v1.90.0"]'; then ok 'intenção ausente preserva atualização normal'; else falha 'intenção ausente preserva atualização normal'; fi

rodar falso false v1.89.0 v1.90.0 1 true
if argv_igual falso '["--to","v1.90.0"]'; then ok 'false preserva atualização normal'; else falha 'false preserva atualização normal'; fi

rodar texto '"true"' v1.89.0 v1.90.0 1 true
if argv_igual texto '["--to","v1.90.0"]'; then ok 'string true não vira booleano de força'; else falha 'string true não vira booleano de força'; fi

rodar volta false v1.90.0 v1.89.0 0 true
if argv_igual volta '["--to","v1.89.0","--force"]'; then ok 'controle de volta mantém uma força'; else falha 'controle de volta mantém uma força'; fi

rodar volta-forcada true v1.90.0 v1.89.0 0 true
if argv_igual volta-forcada '["--to","v1.89.0","--force"]'; then ok 'pedido explícito e volta não duplicam --force'; else falha 'pedido explícito e volta não duplicam --force'; fi

rodar alvo-invalido true v1.89.0 'v1.89.0 --skip-backup' 0 true
if recusou_alvo alvo-invalido; then ok 'alvo fora de tag é recusado antes do updater'; else falha 'alvo fora de tag é recusado antes do updater'; fi

rodar anuncio false v1.89.0 v1.90.0 1 false real false
if capacidade anuncio true; then ok 'código em execução anuncia capacidade de topo'; else falha 'código em execução anuncia capacidade de topo'; fi

rodar helper-nao-anuncia false v1.89.0 v1.90.0 1 false sem-anuncio true
if capacidade helper-nao-anuncia false; then ok 'helper novo não anuncia por agente sem suporte'; else falha 'helper novo não anuncia por agente sem suporte'; fi

rodar forca-sem-runtime true v1.89.0 v1.90.0 1 true real false ausente
if sem_runtime forca-sem-runtime true; then ok 'pedido forçado enfileirado é recusado sem helper'; else falha 'pedido forçado enfileirado é recusado sem helper'; fi

rodar legado-sem-runtime false v1.89.0 v1.90.0 1 true real false ausente
if sem_runtime legado-sem-runtime false && argv_igual legado-sem-runtime '["--to","v1.90.0"]'; then ok 'pedido normal legado sem helper mantém atualização'; else falha 'pedido normal legado sem helper mantém atualização'; fi

if [ "$FALHAS" -ne 0 ]; then
  printf 'FALHOU: %s verificação(ões)\n' "$FALHAS"
  exit 1
fi
printf 'ok — argv restrito, controles e capacidade do agente aprovados\n'
