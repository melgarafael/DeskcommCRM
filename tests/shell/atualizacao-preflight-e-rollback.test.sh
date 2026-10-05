#!/usr/bin/env bash
# Prova dos critérios da issue #1955: o `update.sh` não pode deixar a
# instalação offline quando o registro de imagens não responde.
#
#   bash tests/shell/atualizacao-preflight-e-rollback.test.sh
#
# ## O defeito (instalação real HostGator, reproduzido 2x)
#
# Ao atualizar pela tela, o resolver do Docker saturou (`[resolver] more than
# 1024 concurrent queries`, `dial udp 8.8.4.4:53: i/o timeout`), o `pull` e o
# `up -d` morreram, o script caiu no fallback de CONSTRUÇÃO LOCAL (OOM no
# `next-build`) e o app saiu sem voltar: serviços em `Created`/`Exited`, 502
# para todo mundo, até um restart manual do Docker.
#
# ## Os três casos sob prova
#
#   1. PREFLIGHT FALHO NÃO PARA NADA — sem resposta do registro/DNS lá na
#      frente, o update recusa (RC 3) antes do backup, do checkout e de
#      qualquer `docker stop`: a versão atual segue no ar intocada;
#   2. SEM REGISTRO NO MEIO DO UPDATE — o build local NÃO é disparado por
#      padrão, o run termina com diagnóstico persistido, e NENHUM serviço
#      encerra em `Created`/`Exited` (o rollback devolve a versão anterior);
#   3. CONTROLE — com `DESKCOMM_BUILD_LOCAL=1` (quem quer de propósito) o
#      build acontece e a atualização fecha no ar. Sem este controle, um
#      código que nunca construísse passaria no caso 2 por acidente.
#
# Nada aqui toca a máquina de quem roda: `docker`, `crontab`, `flock`, `curl`
# e `uname` são dublês, nenhum contêiner sobe, nenhum crontab real é escrito, e
# o repositório git é descartável (mktemp).
set -uo pipefail
# Isolamento do git: um GIT_DIR herdado (suíte rodada de dentro de um hook ou
# de um `rebase --exec`) manda por cima de todo `cd`/`git init` dos
# repositórios descartáveis abaixo. Zera o ambiente local do git e dá a
# identidade por ambiente: nenhum teste aqui mede o autor.
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# O namespace das imagens, lido da FONTE (_common.sh) em vez de repetido aqui.
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$RAIZ/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
export NS

falhas=0
ok()  { printf '  ✓ %s\n' "$1"; }
nao() { printf '  ✗ %s\n     esperava: %s\n     veio:     %s\n' "$1" "$2" "$3"; falhas=$((falhas + 1)); }
nao_contem() { ! grep -q -- "$1" "$2"; }

WORK="$(mktemp -d)"
# Guarda de raio de ação: com TMPDIR apontando para diretório inexistente o
# `mktemp` falha e WORK fica VAZIA — aí "$WORK/bin/docker" vira /bin/docker e os
# dublês sobrescrevem os binários da máquina de quem roda.
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK')" >&2
  exit 1
fi
trap 'rm -rf "$WORK"' EXIT
REAL_UNAME="$(command -v uname)"

# ── Dublês ──────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
export DOCKER_LOG="$WORK/docker.log"
export FAKE_CRONTAB="$WORK/crontab.txt"
export DUB="$WORK/dub"
mkdir -p "$DUB"

# O `docker` é o teatro inteiro desta prova. Ele mantém um MODELO da
# instalação em `$DUB`:
#   registro        — o registro de imagens está alcançável (soma do apagão)
#   imagens-locais  — tags que existem no disco desta "VPS"
#   estado.txt      — "serviço estado" de cada contêiner (running/created/exited)
#
# E ele é fiel ao que aconteceu na VPS real: o `pull` morre E o registro some
# na mesma passada (é assim que um apagão de DNS se manifesta), o `up -d` com
# imagem que não está no disco deixa o serviço em `created` e sai 1, e o build
# do overlay publica a tag no disco.
cat > "$WORK/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
ESTADO="$DUB/estado.txt"
# Caso 6: o daemon travado pelo resolver saturado — todo comando fica preso.
[ -f "$DUB/trava" ] && exec sleep 20

reg() {  # reg <serviço> <estado>
  local s="$1" e="$2" tmp="$ESTADO.tmp.$$"
  grep -v "^$s " "$ESTADO" 2>/dev/null > "$tmp" || true
  printf '%s %s\n' "$s" "$e" >> "$tmp"
  mv "$tmp" "$ESTADO"
}

# Caso 5: a versão NOVA sobe o app, mas o worker cai (`exited`) ou nem chega
# a existir no `ps` (`some`) — o critério 6 da issue. Vale para todo `up` da
# 0.9.0 (o do build e o do proxy); o da volta, na 0.8.0, sobe inteiro.
queda_da_versao_nova() {
  [ "${APP_IMAGE##*:}" = 0.9.0 ] || return 0
  if [ -f "$DUB/worker-exited" ]; then reg worker exited; fi
  if [ -f "$DUB/worker-some" ]; then
    grep -v '^worker ' "$ESTADO" > "$ESTADO.tmp.$$"; mv "$ESTADO.tmp.$$" "$ESTADO"
  fi
  return 0
}

case "${1:-}" in
  info|ps|image|inspect|images|run|network|start|rm|volume|logs) exit 0 ;;
  buildx)
    # `docker buildx version`: o plugin existe, salvo no caso 7.
    if [ "${2:-}" = version ]; then [ -f "$DUB/sem-buildx" ] && exit 1; exit 0; fi
    # `docker buildx imagetools inspect` é a SONDA do registro: só responde
    # enquanto `$DUB/registro` existir — e, com ele de pé, só para as imagens
    # cuja publicação TERMINOU (`$DUB/voz-pronta` é o interruptor do caso 4).
    [ -f "$DUB/registro" ] || exit 1
    case "$*" in
      *deskcomm-voice-agent*) [ -f "$DUB/voz-pronta" ] || exit 1 ;;
    esac
    exit 0 ;;
esac

if [ "${1:-}" = compose ]; then
  args="$*"
  case "$args" in
    *"docker-compose.build.yml"*)
      # O overlay de build local: o `build` publica a tag no disco e o `up`
      # sobe tudo, como numa VPS de verdade depois da construção.
      case "$args" in *" build"*) printf '0.9.0\n' >> "$DUB/imagens-locais" ;; esac
      for s in app worker scheduler caddy; do reg "$s" running; done
      queda_da_versao_nova
      exit 0 ;;
    *" exec "*)
      printf 'healthy\n{"data":{"status":"healthy","version":"0.9.0","checks":{"supabase":{"status":"ok","latency_ms":12}}}}\n'
      exit 0 ;;
    *" pull"*)
      # O pull falha E o registro cai junto: o apagão que a issue descreve.
      rm -f "$DUB/registro"
      exit 1 ;;
    *" stop "*)
      for s in app worker scheduler; do reg "$s" exited; done
      exit 0 ;;
    *" up "*)
      # A imagem pedida está no disco? O `.env` exportado diz qual é — e é
      # por isso que o rollback só funciona se voltar TAMBÉM as variáveis do
      # ambiente: o compose (e este dublê) preferem o ambiente ao `.env`.
      tag="${APP_IMAGE##*:}"
      if [ -n "$tag" ] && grep -qx "$tag" "$DUB/imagens-locais" 2>/dev/null; then
        for s in app worker scheduler caddy; do reg "$s" running; done
        queda_da_versao_nova
        exit 0
      fi
      for s in app worker scheduler; do reg "$s" created; done
      exit 1 ;;
    *" ps "*)
      cat "$ESTADO" 2>/dev/null
      exit 0 ;;
  esac
fi
exit 0
DUBLE

# `crontab` guarda a tabela num arquivo: o update.sh instala a linha do agente.
cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB
# flock não existe no macOS e o kit depende dele; não está sob prova aqui.
cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# curl: nenhuma saída deste arquivo toca a rede.
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '{"tag_name":"v0.9.0"}\n'
STUB
# `uname -m` responde x86_64: o _common.sh recusa update.sh fora de amd64/arm64,
# e o processador de quem roda a suíte não é o alvo de nenhuma destas provas.
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/uname"
export PATH="$WORK/bin:$PATH"

# ── Fixture ─────────────────────────────────────────────────────────────────
# Uma VPS que JÁ ESTÁ no ar, na 0.8.0, com as quatro imagens pinadas no .env —
# é o estado de quem clica em "Atualizar" na tela.
montar_instalacao() {  # montar_instalacao <raiz>
  local raiz="$1" proj="$1/deskcommcrm"
  mkdir -p "$proj/supabase"
  cp -RL "$RAIZ/hostgator-setup-kit" "$proj/"
  # O dublê do backup grava a marca SÓ se for executado — é como o caso 1 prova
  # que o preflight abortou antes do backup.
  case "$proj/hostgator-setup-kit/backup.sh" in
    "$RAIZ"/*) echo "recuso plantar o dublê dentro do repo"; exit 1 ;;
  esac
  cat > "$proj/hostgator-setup-kit/backup.sh" <<STUB
#!/usr/bin/env bash
printf 'zero=%s\n' "\$0" > "$raiz/marca-backup"
STUB
  chmod +x "$proj/hostgator-setup-kit/backup.sh"
  printf 'select 1;\n' > "$proj/supabase/baseline.sql"
  printf 'services:\n  app:\n    image: \${APP_IMAGE:-x}\n' > "$proj/docker-compose.prod.yml"
  # O overlay de build precisa EXISTIR no projeto: sem ele o `-f` morre antes
  # de qualquer construção e o caso 3 (controle) mediria outra coisa.
  cp "$RAIZ/docker-compose.build.yml" "$proj/"
  cat > "$proj/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:0.8.0
APP_PULL_POLICY=missing
WORKER_IMAGE=${NS}/deskcomm-worker:0.8.0
WORKER_PULL_POLICY=missing
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:0.8.0
SCHEDULER_PULL_POLICY=missing
VOICE_AGENT_IMAGE=${NS}/deskcomm-voice-agent:0.8.0
VOICE_AGENT_PULL_POLICY=missing
WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=chave
ENV
  chmod 600 "$proj/.env"
  (
    cd "$proj" || exit 1
    git init --quiet
    git add -A
    git commit --quiet -m "v0.9.0"
    git tag v0.9.0
    echo topo > topo.txt
    git add -A
    git commit --quiet -m "topo da main"
  ) >/dev/null 2>&1
}

# O estado da "VPS" entre casos: registro alcançável, 0.8.0 no disco, tudo no ar.
preparar_vps() {
  : > "$DOCKER_LOG"
  : > "$DUB/estado.txt"
  local s
  for s in app worker scheduler caddy; do printf '%s running\n' "$s" >> "$DUB/estado.txt"; done
  printf '0.8.0\n' > "$DUB/imagens-locais"
  : > "$DUB/registro"                          # o registro está alcançável
  : > "$DUB/voz-pronta"                        # e as QUATRO imagens publicadas
  rm -f "$DUB/worker-exited" "$DUB/worker-some" "$DUB/trava" "$DUB/sem-buildx"
}

# rodar_update <raiz> <saída> [VAR=valor ...] → status em RC
# Invocação RELATIVA de propósito, e `< /dev/null` para não travar num `read -p`.
rodar_update() {
  local raiz="$1" saida="$2"; shift 2
  RC=0
  ( cd "$raiz" && env "$@" bash deskcommcrm/hostgator-setup-kit/update.sh \
      --to v0.9.0 --force ) > "$saida" 2>&1 < /dev/null || RC=$?
}

fora_do_ar() { grep -cE ' (created|exited)$' "$DUB/estado.txt" 2>/dev/null || true; }

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 1 — preflight falho: recusa ANTES de parar qualquer coisa"
preparar_vps
rm -f "$DUB/registro"                      # registro/DNS inacessível
R1="$WORK/caso1"; mkdir -p "$R1"; montar_instalacao "$R1"
OUT1="$WORK/saida1.txt"
rodar_update "$R1" "$OUT1"; RC1="$RC"
DIAG1="$R1/deskcommcrm/.deskcomm-update-diagnostico.log"

if [ "$RC1" -eq 3 ]; then
  ok "o update RECUSOU sem começar (RC 3 — o agente não tenta desfazer)"
else
  nao "recusa antes de tudo" "RC 3" "RC $RC1"
fi
if grep -qiE 'registro de imagens|DNS|preflight' "$OUT1"; then
  ok "e diz o MOTIVO (registro/DNS), não uma falha muda"
else
  nao "motivo da recusa" "frase citando registro/DNS" "$(tail -3 "$OUT1" | tr '\n' ' ')"
fi
if [ ! -f "$R1/marca-backup" ]; then
  ok "o backup NUNCA rodou (a recusa veio antes dele)"
else
  nao "backup não iniciado" "marca-backup ausente" "marca-backup foi criada"
fi
if grep -qE ' stop | up -d| rm -f' "$DOCKER_LOG"; then
  nao "nenhum serviço foi parado/recriado" "sem stop/up/rm no log do docker" \
      "$(grep -E ' stop | up -d| rm -f' "$DOCKER_LOG" | head -2 | tr '\n' ';')"
else
  ok "nenhum serviço foi parado, recriado ou removido"
fi
if grep -q "^APP_IMAGE=$NS/deskcommcrm:0.8.0$" "$R1/deskcommcrm/.env"; then
  ok "o .env segue apontando para a versão de antes (0.8.0)"
else
  nao ".env intocado" "APP_IMAGE=:0.8.0" "$(grep '^APP_IMAGE=' "$R1/deskcommcrm/.env")"
fi
if [ -f "$DIAG1" ]; then
  ok "o run terminou com diagnóstico PERSISTIDO"
else
  nao "diagnóstico persistido" ".deskcomm-update-diagnostico.log existe" "arquivo ausente"
fi
if [ -f "$DIAG1" ] && grep -qiE 'registro|falha' "$DIAG1"; then
  ok "e o diagnóstico é legível (cita a causa e o status)"
else
  nao "diagnóstico legível" "cita registro/falha" "$(tail -3 "$DIAG1" 2>/dev/null | tr '\n' ' ')"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 2 — registro cai NO MEIO do update: sem build local e sem serviço morto"
preparar_vps
R2="$WORK/caso2"; mkdir -p "$R2"; montar_instalacao "$R2"
OUT2="$WORK/saida2.txt"
rodar_update "$R2" "$OUT2"; RC2="$RC"
DIAG2="$R2/deskcommcrm/.deskcomm-update-diagnostico.log"

if [ "$RC2" -ne 0 ]; then
  ok "o update terminou como FALHA (RC $RC2), não como sucesso"
else
  nao "run com falha" "RC diferente de 0" "RC 0"
fi
if grep -q 'docker-compose.build.yml' "$DOCKER_LOG"; then
  nao "NÃO dispara build local quando o registro não responde" \
      "sem '-f docker-compose.build.yml'" \
      "$(grep 'docker-compose.build.yml' "$DOCKER_LOG" | head -1)"
else
  ok "o build local NÃO foi disparado (o registro não respondia)"
fi
if grep -qE ' (created|exited)$' "$DUB/estado.txt"; then
  nao "nenhum serviço em Created/Exited" "tudo running" \
      "$(grep -E ' (created|exited)$' "$DUB/estado.txt" | tr '\n' ' ')"
else
  ok "NENHUM serviço saiu em Created/Exited — o rollback religou o que estava no ar"
fi
for chave in APP WORKER SCHEDULER VOICE_AGENT; do
  if grep -q "^${chave}_IMAGE=$NS/.*:0.8.0$" "$R2/deskcommcrm/.env"; then
    ok "o pin ${chave}_IMAGE voltou para a versão anterior (0.8.0)"
  else
    nao "rollback do pin ${chave}_IMAGE" "…:0.8.0" \
        "$(grep "^${chave}_IMAGE=" "$R2/deskcommcrm/.env" 2>/dev/null)"
  fi
done
if [ -f "$DIAG2" ] && grep -qiE 'falha|RC 1|saída: 1' "$DIAG2"; then
  ok "diagnóstico persistido e legível, com o desfecho da falha"
else
  nao "diagnóstico da falha" "arquivo com status de falha" \
      "$(tail -4 "$DIAG2" 2>/dev/null | tr '\n' ' ')"
fi
if grep -qiE 'registro|DESKCOMM_BUILD_LOCAL' "$OUT2"; then
  ok "a saída explica POR QUE não construiu e como construir de propósito"
else
  nao "explicação na saída" "menção ao registro ou a DESKCOMM_BUILD_LOCAL" \
      "$(tail -3 "$OUT2" | tr '\n' ' ')"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 3 — CONTROLE: com DESKCOMM_BUILD_LOCAL=1 o build ACONTECE"
# Sem este controle, um código que nunca construísse passaria no caso 2 por
# acidente (o log do docker estaria vazio de build por qualquer outro motivo).
preparar_vps
R3="$WORK/caso3"; mkdir -p "$R3"; montar_instalacao "$R3"
OUT3="$WORK/saida3.txt"
rodar_update "$R3" "$OUT3" DESKCOMM_BUILD_LOCAL=1; RC3="$RC"
DIAG3="$R3/deskcommcrm/.deskcomm-update-diagnostico.log"

if grep -q -- '-f docker-compose.build.yml build' "$DOCKER_LOG"; then
  ok "o build local foi EXECUTADO (prova que o que trava o caso 2 é o portão)"
else
  nao "build local executado" "docker compose … -f docker-compose.build.yml build" \
      "$(grep -c 'docker-compose.build.yml' "$DOCKER_LOG") ocorrência(s)"
fi
if [ "$RC3" -eq 0 ] && grep -q 'Atualização concluída' "$OUT3"; then
  ok "a atualização fechou no ar (RC 0, 'Atualização concluída')"
else
  nao "atualização concluída" "RC 0 com a frase final" "RC $RC3"
fi
if grep -qE ' (created|exited)$' "$DUB/estado.txt"; then
  nao "todos os serviços de pé" "sem created/exited" \
      "$(grep -E ' (created|exited)$' "$DUB/estado.txt" | tr '\n' ' ')"
else
  ok "app, worker, scheduler e proxy saíram SAUDÁVEIS"
fi
if grep -q "^APP_IMAGE=$NS/deskcommcrm:0.9.0$" "$R3/deskcommcrm/.env"; then
  ok "sem rollback: o .env ficou na versão nova (0.9.0)"
else
  nao ".env na versão nova" "APP_IMAGE=:0.9.0" "$(grep '^APP_IMAGE=' "$R3/deskcommcrm/.env")"
fi
if [ -f "$DIAG3" ] && grep -qiE 'concluído|sucesso' "$DIAG3"; then
  ok "o run de sucesso TAMBÉM deixa diagnóstico (status legível)"
else
  nao "diagnóstico do sucesso" "status de concluído" \
      "$(tail -4 "$DIAG3" 2>/dev/null | tr '\n' ' ')"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 3b — a saída de escape vale com o registro FORA desde o início"
# A recusa do portão ensina `DESKCOMM_BUILD_LOCAL=1 … --force`. Com o registro
# ainda fora, o preflight não pode recusar justamente esse pedido.
preparar_vps
rm -f "$DUB/registro"
R3B="$WORK/caso3b"; mkdir -p "$R3B"; montar_instalacao "$R3B"
OUT3B="$WORK/saida3b.txt"
rodar_update "$R3B" "$OUT3B" DESKCOMM_BUILD_LOCAL=1; RC3B="$RC"
if [ "$RC3B" -eq 0 ] && grep -q -- '-f docker-compose.build.yml build' "$DOCKER_LOG"; then
  ok "com DESKCOMM_BUILD_LOCAL=1 o preflight não recusa: construiu e concluiu (RC 0)"
else
  nao "saída de escape aceita" "RC 0 com build local" "RC $RC3B; $(grep -m1 'Motivo' "$OUT3B")"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 5 — critério 6: app saudável com outro serviço fora do ar VOLTA a versão"
# O app responde, mas o worker da versão nova caiu (`exited`) ou nem apareceu
# no `ps`. A atualização não pode fechar como sucesso: tem de sair com falha e
# devolver os pins. O controle com tudo `running` é o caso 3, que conclui.
for jeito in exited some; do
  preparar_vps
  : > "$DUB/worker-$jeito"
  R5="$WORK/caso5-$jeito"; mkdir -p "$R5"; montar_instalacao "$R5"
  OUT5="$WORK/saida5-$jeito.txt"
  rodar_update "$R5" "$OUT5" DESKCOMM_BUILD_LOCAL=1; RC5="$RC"
  if [ "$RC5" -ne 0 ] && grep -q 'NÃO subiram: worker' "$OUT5"; then
    ok "worker $jeito: a atualização FALHOU e nomeou o worker (RC $RC5)"
  else
    nao "worker $jeito acusado" "RC≠0 e 'NÃO subiram: worker'" "RC $RC5; $(tail -2 "$OUT5" | tr '\n' ' ')"
  fi
  if grep -q "^APP_IMAGE=$NS/deskcommcrm:0.8.0$" "$R5/deskcommcrm/.env" \
     && grep -q "^WORKER_IMAGE=$NS/deskcomm-worker:0.8.0$" "$R5/deskcommcrm/.env"; then
    ok "worker $jeito: os pins voltaram para a versão anterior (0.8.0)"
  else
    nao "worker $jeito: pins de volta" "…:0.8.0" "$(grep -E '^(APP|WORKER)_IMAGE=' "$R5/deskcommcrm/.env" | tr '\n' ' ')"
  fi
done

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 4 — critério 1: release com imagem faltando NÃO é oferecida"
# shellcheck disable=SC1091
. "$RAIZ/hostgator-setup-kit/_common.sh"
set +e
preparar_vps
v="$(veredito_das_imagens_da_release 0.9.0)"
if [ "$v" = "prontas" ]; then ok "as quatro prontas: a release pode ser anunciada"
else nao "as quatro prontas" "prontas" "$v"; fi

rm -f "$DUB/voz-pronta"
v="$(veredito_das_imagens_da_release 0.9.0)"
if [ "$v" = "incompleta" ]; then ok "voz sem publicar: a release está INCOMPLETA e não se oferece"
else nao "release incompleta" "incompleta" "$v"; fi
v="$(veredito_das_imagens_da_release v0.9.0)"
if [ "$v" = "incompleta" ]; then ok "e o 'v' da tag não confunde a sonda"
else nao "sonda com o v da tag" "incompleta" "$v"; fi

rm -f "$DUB/registro"
v="$(veredito_das_imagens_da_release 0.9.0)"
if [ "$v" = "indisponivel" ]; then
  ok "CONTROLE: registro fora → indisponível, que é o estado que NÃO cala o agente"
else nao "registro fora" "indisponivel" "$v"; fi

AGENTE="$(cat "$RAIZ/hostgator-setup-kit/agent.sh")"
case "$AGENTE" in
  *veredito_das_imagens_da_release*) ok "o agent.sh consulta as QUATRO imagens antes de anunciar" ;;
  *) nao "agent.sh consulta as quatro" "chamada a veredito_das_imagens_da_release" "ausente" ;;
esac
case "$AGENTE" in
  *'= "incompleta"'*) ok "e só cala quando há imagem FALTANDO (incompleta)" ;;
  *) nao "silencia em incompleta" 'teste contra "incompleta"' "ausente" ;;
esac

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 6 — Docker travado: a conferência e o diagnóstico têm PRAZO"
# O diagnóstico roda no gatilho de saída, inclusive quando o preflight recusou
# porque o Docker não respondeu: sem prazo no `ps`, a atualização nunca
# terminaria. O `timeout` daqui encurta qualquer prazo para 2s (e existe no
# macOS, que não tem um), para a prova não custar 30s por chamada.
mkdir -p "$WORK/bin-prazo"
cat > "$WORK/bin-prazo/timeout" <<'STUB'
#!/usr/bin/env bash
shift
"$@" & p=$!
( sleep 2; kill -TERM "$p" ) >/dev/null 2>&1 & k=$!
wait "$p"; rc=$?
kill "$k" 2>/dev/null
exit "$rc"
STUB
chmod +x "$WORK/bin-prazo/timeout"
PATH_ANTES="$PATH"; PATH="$WORK/bin-prazo:$PATH"
preparar_vps
: > "$DUB/trava"
inicio=$SECONDS; fora6="$(servicos_fora_do_ar)"; dur=$((SECONDS - inicio))
if [ "$dur" -lt 10 ] && [ -z "$fora6" ]; then
  ok "servicos_fora_do_ar volta em ${dur}s com o Docker travado, e 'não sei' não acusa ninguém"
else
  nao "conferência com prazo" "menos de 10s e lista vazia" "${dur}s, lista '$fora6'"
fi
DIAGNOSTICO_ARQUIVO="$WORK/diag6.log"
inicio=$SECONDS; diagnostico_de_atualizacao 3; dur=$((SECONDS - inicio))
if [ "$dur" -lt 10 ] && grep -q 'não respondeu' "$DIAGNOSTICO_ARQUIVO" 2>/dev/null; then
  ok "o diagnóstico volta em ${dur}s e escreve que o Docker não respondeu"
else
  nao "diagnóstico com prazo" "menos de 10s e 'não respondeu' no arquivo" "${dur}s; $(tail -2 "$DIAGNOSTICO_ARQUIVO" 2>/dev/null | tr '\n' ' ')"
fi
rm -f "$DUB/trava"
PATH="$PATH_ANTES"

# ════════════════════════════════════════════════════════════════════════════
echo "── caso 7 — sem o plugin buildx, o motivo diz buildx, não DNS"
preparar_vps
: > "$DUB/sem-buildx"
motivo7="$(preflight_atualizacao 0.9.0)"; rc7=$?
if [ "$rc7" -ne 0 ] && printf '%s' "$motivo7" | grep -q 'buildx' \
   && ! printf '%s' "$motivo7" | grep -q 'DNS'; then
  ok "recusa nomeando o plugin buildx ausente"
else
  nao "motivo do buildx ausente" "rc≠0 citando buildx e não DNS" "rc $rc7: $motivo7"
fi

printf '\n'
if [ "$falhas" -eq 0 ]; then echo "TUDO VERDE"; exit 0; fi
echo "$falhas caso(s) vermelho(s)"
exit 1
