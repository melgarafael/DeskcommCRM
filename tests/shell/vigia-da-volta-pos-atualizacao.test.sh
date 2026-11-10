#!/usr/bin/env bash
# A vigília da volta automática, medida de ponta a ponta (#2757, ajuste 2).
#
#   bash tests/shell/vigia-da-volta-pos-atualizacao.test.sh
#
# ## O que estava sem prova
#
# O mantenedor mediu: `git grep` por `vigia_armar`, `vigia_ler`, `vigia_falhou`,
# `app_esta_no_ar` e `.update-vigia` nos testes de `tests/shell/` dava ZERO. Os
# testes que já rodavam `update.sh` e `agent.sh` passavam pelo código novo sem
# conferir o que ele faz — a vigília podia estar armando a marca errada, contando
# duas vezes a mesma falha ou voltando de versão em laço, e a suíte ficava verde.
#
# ## Os seis pontos que este arquivo guarda
#
#   1. o `update.sh` ARMA a marca com a VERSÃO DE ORIGEM (de onde se saiu);
#   2. uma sonda que responde ZERA a contagem;
#   3. uma falha só REGISTRA (nada de voltar na primeira);
#   4. a segunda falha seguida chama `update.sh --to <anterior> --force` UMA vez
#      — e a marca já saiu ANTES da chamada (é a prova de "encerra a vigília
#      antes de voltar": sem isso a volta poderia se repetir a cada 5 minutos);
#   5. fora da janela de 2 h NADA acontece (marca velha é apagada, sem volta);
#   6. uma volta (`--to` mais antigo) NÃO re-arma a marca.
#   7. o aviso da volta leva o DESFECHO num CAMPO (`ok`): `true` quando o
#      `update.sh --to` da volta termina com código 0, `false` quando não. É o
#      campo — não o texto do motivo — que o painel lê para não tratar igual a
#      volta que terminou e a que falhou (#3271).
#
# ## Sabotagem (a prova de que cada caso guarda a linha certa)
#
#   * tirar o `vigia_encerrar` de antes da chamada → o caso 4 acusa a marca
#     ainda presente no instante da chamada;
#   * deixar a volta re-armar a marca (remover a exceção `is_already_in_head` do
#     update.sh) → o caso 6 acusa a marca criada por uma volta.
#
# Nada aqui toca a máquina de quem roda: `docker`, `crontab`, `flock`, `curl` e
# `uname` são dublês; nenhum contêiner sobe e o repositório git é descartável.
set -uo pipefail
unset $(git rev-parse --local-env-vars)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS="$(sed -n 's/^IMG_NS="\(.*\)"$/\1/p' "$RAIZ/hostgator-setup-kit/_common.sh" | head -1)"
[ -n "$NS" ] || { echo "não consegui ler IMG_NS de _common.sh"; exit 1; }
REAL_UNAME="$(command -v uname)"

falhas=0
ok()  { printf '  ✓ %s\n' "$1"; }
nao() { printf '  ✗ %s\n     esperava: %s\n     veio:     %s\n' "$1" "$2" "$3"; falhas=$((falhas + 1)); }

WORK="$(mktemp -d)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK')" >&2
  exit 1
fi
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/dub"
export DOCKER_LOG="$WORK/docker.log"
export DUB="$WORK/dub"
export FAKE_CRONTAB="$WORK/crontab.txt"
export CHAMADAS_LOG="$WORK/chamadas-update.log"
export POSTS_LOG="$WORK/posts-agent.log"

# ── Dublês ──────────────────────────────────────────────────────────────────
# O `docker` é o teatro do update.sh: registro alcançável, pull que publica a
# tag no "disco", `up` que só sobe imagem presente e `exec` que responde o
# healthcheck como a rota real responde.
cat > "$WORK/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "${1:-}" in
  info|image|inspect|images|run|network|start|rm|volume|logs|ps) exit 0 ;;
  buildx) exit 0 ;;
esac
if [ "${1:-}" = compose ]; then
  args="$*"
  case "$args" in
    *" exec "*)
      printf 'healthy\n{"data":{"status":"healthy","version":"0.9.0","checks":{}}}\n'
      exit 0 ;;
    *" pull "*)
      # `pull` bem-sucedido = as duas versões ficam "no disco" desta VPS.
      printf '0.9.0\n0.8.0\n' >> "$DUB/imagens-locais"
      exit 0 ;;
    *" up "*)
      tag="${APP_IMAGE##*:}"
      if [ -n "$tag" ] && grep -qx "$tag" "$DUB/imagens-locais" 2>/dev/null; then exit 0; fi
      echo "erro: imagem $tag não está no disco" >&2
      exit 1 ;;
    *" images -q "*) printf 'sha-%s\n' "${APP_IMAGE##*:}"; exit 0 ;;
    *" ps "*) printf 'app running\nworker running\nscheduler running\ncaddy running\n'; exit 0 ;;
  esac
fi
exit 0
DUBLE

cat > "$WORK/bin/crontab" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-l" ] && { [ -f "$FAKE_CRONTAB" ] && cat "$FAKE_CRONTAB"; exit 0; }
[ "${1:-}" = "-" ] && { cat > "$FAKE_CRONTAB"; exit 0; }
exit 0
STUB

cat > "$WORK/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

# `curl` responde três coisas, por endereço: a API de tags do GitHub, a ROTA de
# saúde (o interruptor é `$DUB/saude`) e o POST do agente (que fica registrado).
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *api.github.com*)
    printf '{"tag_name":"v0.9.0"}\n'; exit 0 ;;
  *api/v1/health*)
    modo="$(cat "$DUB/saude" 2>/dev/null || echo ok)"
    case "$modo" in
      ok)    printf '{"data":{"status":"healthy","version":"0.9.0","checks":{}}}\n'; exit 0 ;;
      down)  printf '{"data":{"status":"unhealthy","version":"0.9.0","checks":{"waha":{"status":"down"}}}\n'; exit 0 ;;
      proxy) printf 'no available server\n'; exit 0 ;;
    esac
    exit 0 ;;
  *api/v1/system/agent*)
    printf '%s\n' "$*" >> "$POSTS_LOG"
    printf '{"data":{"update_requested":false,"run_id":null,"to_version":""}}\n200'
    exit 0 ;;
esac
exit 0
STUB

cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf 'x86_64\n'; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB

chmod +x "$WORK/bin/docker" "$WORK/bin/crontab" "$WORK/bin/flock" "$WORK/bin/curl" "$WORK/bin/uname"
export PATH="$WORK/bin:$PATH"

preparar_vps() {
  : > "$DOCKER_LOG"
  printf '0.8.0\n0.9.0\n' > "$DUB/imagens-locais"
  : > "$DUB/saude" 2>/dev/null || true
  printf 'ok\n' > "$DUB/saude"
  : > "$CHAMADAS_LOG"
  : > "$POSTS_LOG"
}

# Uma instalação que JÁ está no ar na 0.8.0, com a 0.9.0 publicada no git.
montar_instalacao() {  # montar_instalacao <raiz>
  local raiz="$1" proj="$1/deskcommcrm"
  mkdir -p "$proj/supabase"
  cp -RL "$RAIZ/hostgator-setup-kit" "$proj/"
  case "$proj/hostgator-setup-kit/backup.sh" in
    "$RAIZ"/*) echo "recuso plantar o dublê dentro do repo"; exit 1 ;;
  esac
  printf '#!/usr/bin/env bash\nexit 0\n' > "$proj/hostgator-setup-kit/backup.sh"
  chmod +x "$proj/hostgator-setup-kit/backup.sh"
  printf 'select 1;\n' > "$proj/supabase/baseline.sql"
  printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$proj/docker-compose.prod.yml"
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
    printf 'instalada 0.8.0\n' > versao.txt
    git add -A && git commit --quiet -m "v0.8.0"
    git tag v0.8.0
    printf 'publicada 0.9.0\n' > versao.txt
    git add -A && git commit --quiet -m "v0.9.0"
    git tag v0.9.0
    # O que está INSTALADO é a 0.8.0: HEAD nela, como numa VPS que não atualizou.
    git checkout --quiet v0.8.0
  ) >/dev/null 2>&1
}

# ════════════════════════════════════════════════════════════════════════════
echo "── 1. o update.sh ARMA a marca com a versão de ORIGEM"
preparar_vps
R1="$WORK/inst1"; mkdir -p "$R1"; montar_instalacao "$R1"
PROJ1="$R1/deskcommcrm"
OUT1="$WORK/saida1.txt"
RC=0
( cd "$R1" && bash deskcommcrm/hostgator-setup-kit/update.sh --to v0.9.0 --force ) \
  > "$OUT1" 2>&1 < /dev/null || RC=$?
MARCA1="$PROJ1/.update-vigia"

if [ "$RC" -eq 0 ]; then ok "a atualização de 0.8.0 → 0.9.0 terminou bem (RC 0)"
else nao "update até o fim" "RC 0" "RC $RC ($(tail -2 "$OUT1" | tr '\n' ' '))"; fi

if [ -f "$MARCA1" ]; then
  ok "a marca .update-vigia nasceu"
else
  nao "marca armada" ".update-vigia existe" "arquivo ausente"
fi

EPOCH1="$(sed -n '1p' "$MARCA1" 2>/dev/null || true)"
DE1="$(sed -n '2p' "$MARCA1" 2>/dev/null || true)"
case "$EPOCH1" in
  ''|*[!0-9]*) nao "a marca guarda o instante (epoch UTC)" "número" "'$EPOCH1'" ;;
  *) ok "a marca guarda o instante (epoch UTC $EPOCH1)" ;;
esac
if [ "$DE1" = "v0.8.0" ] || [ "$DE1" = "0.8.0" ]; then
  ok "e guarda a versão de ORIGEM ($DE1) — para ela que a volta vai"
else
  nao "versão de origem na marca" "0.8.0 (a que estava no ar)" "'$DE1'"
fi

# ════════════════════════════════════════════════════════════════════════════
echo "── 2. uma volta (--to mais antigo) NÃO re-arma a marca"
# A instalação acima ficou na 0.9.0. Voltar para a 0.8.0 é "andar para trás", e
# andar para trás não arma vigília: quem está voltando não vigia.
rm -f "$MARCA1" "$PROJ1/.update-vigia-falhas"
preparar_vps
RC=0
( cd "$R1" && bash deskcommcrm/hostgator-setup-kit/update.sh --to v0.8.0 --force ) \
  > "$WORK/saida2.txt" 2>&1 < /dev/null || RC=$?
if [ -f "$MARCA1" ]; then
  nao "volta não arma a marca" ".update-vigia ausente" "marca criada por uma volta: $(sed -n '2p' "$MARCA1")"
else
  ok "a volta para a 0.8.0 não armou marca nenhuma"
fi

# ════════════════════════════════════════════════════════════════════════════
# O AGENTE: a vigília roda aqui, a cada 5 minutos.
mkdir -p "$WORK/agente"
AG="$WORK/agente/projeto"
mkdir -p "$AG"
cp -RL "$RAIZ/hostgator-setup-kit" "$AG/"
printf 'services:\n  app:\n    image: ${APP_IMAGE:-x}\n' > "$AG/docker-compose.prod.yml"
cat > "$AG/.env" <<ENV
APP_IMAGE=${NS}/deskcommcrm:0.9.0
WORKER_IMAGE=${NS}/deskcomm-worker:0.9.0
SCHEDULER_IMAGE=${NS}/deskcomm-scheduler:0.9.0
WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
ENV
chmod 600 "$AG/.env"
(
  cd "$AG" || exit 1
  git init --quiet
  printf 'instalada 0.9.0\n' > versao.txt
  git add -A && git commit --quiet -m "v0.9.0"
  git tag v0.9.0
) >/dev/null 2>&1

# O `update.sh` do agente vira um DUBLÊ: ele registra a chamada e, no instante
# dela, confere se a vigília já foi encerrada (é o caso 4).
cat > "$AG/hostgator-setup-kit/update.sh" <<'STUB'
#!/usr/bin/env bash
printf 'chamada: %s\n' "$*" >> "${CHAMADAS_LOG:?}"
for f in .update-vigia .update-vigia-falhas; do
  [ -e "$f" ] && printf 'AINDA-EXISTE %s\n' "$f" >> "${CHAMADAS_LOG:?}"
done
exit 0
STUB
chmod +x "$AG/hostgator-setup-kit/update.sh"

armar_marca() {  # armar_marca <segundos atrás> <versão de origem>
  printf '%s\n%s\n' "$(( $(date -u +%s) - ${1:-0} ))" "${2:-v0.8.0}" > "$AG/.update-vigia"
}
rodar_agente() {  # rodar_agente <modo de saúde: ok|down|proxy>
  printf '%s\n' "${1:-ok}" > "$DUB/saude"
  ( cd "$AG" && env -i PATH="$WORK/bin:$PATH" HOME="$WORK" \
      CHAMADAS_LOG="$CHAMADAS_LOG" POSTS_LOG="$POSTS_LOG" DUB="$DUB" \
      DOCKER_LOG="$DOCKER_LOG" FAKE_CRONTAB="$FAKE_CRONTAB" \
      bash hostgator-setup-kit/agent.sh ) > "$WORK/agente-saida.txt" 2>&1
  return 0
}
chamadas()  { grep -c '^chamada:' "$CHAMADAS_LOG" 2>/dev/null || true; }

echo "── 3. uma sonda que responde ZERA a contagem"
preparar_vps
armar_marca 60 v0.8.0
printf '1\n' > "$AG/.update-vigia-falhas"
rodar_agente ok
if [ -e "$AG/.update-vigia-falhas" ]; then
  nao "sonda boa zera a contagem" "arquivo de falhas removido" "contagem=$(cat "$AG/.update-vigia-falhas")"
else
  ok "a sonda boa zerou a contagem de falhas"
fi
if [ -e "$AG/.update-vigia" ]; then
  ok "e a marca SEGUE de pé (quem encerra é a janela, não uma sonda boa)"
else
  nao "marca preservada" ".update-vigia ainda existe" "a marca sumiu numa sonda boa"
fi
[ "$(chamadas)" = "0" ] && ok "nenhuma volta foi chamada" \
  || nao "nenhuma volta" "0 chamadas" "$(chamadas)"

echo "── 4. uma falha só REGISTRA (não volta na primeira)"
preparar_vps
armar_marca 60 v0.8.0
rm -f "$AG/.update-vigia-falhas"
rodar_agente proxy
CONTAGEM="$(cat "$AG/.update-vigia-falhas" 2>/dev/null || echo '')"
if [ "$CONTAGEM" = "1" ]; then ok "a primeira falha foi registrada (1)"
else nao "primeira falha registrada" "1" "'$CONTAGEM'"; fi
[ "$(chamadas)" = "0" ] && ok "e NENHUMA volta foi chamada" \
  || nao "nenhuma volta na primeira falha" "0 chamadas" "$(chamadas)"
[ -e "$AG/.update-vigia" ] && ok "a marca segue armada para o próximo ciclo" \
  || nao "marca armada" ".update-vigia existe" "marca sumiu na primeira falha"

echo "── 5. a segunda falha seguida volta UMA vez, e encerra a vigília ANTES"
preparar_vps
armar_marca 60 v0.8.0
printf '1\n' > "$AG/.update-vigia-falhas"
rodar_agente proxy

if [ "$(chamadas)" = "1" ]; then
  ok "o update.sh foi chamado UMA vez"
else
  nao "uma única chamada de volta" "1" "$(chamadas)"
fi
if grep -q '^chamada: --to v0\.8\.0 --force' "$CHAMADAS_LOG" 2>/dev/null; then
  ok "com o alvo da versão de origem e --force (--to v0.8.0 --force)"
else
  nao "alvo da volta" "--to v0.8.0 --force" "$(grep '^chamada:' "$CHAMADAS_LOG" | tr '\n' ';')"
fi
if grep -q 'AINDA-EXISTE' "$CHAMADAS_LOG" 2>/dev/null; then
  nao "vigília encerrada ANTES da chamada" "nenhuma marca no instante da chamada" \
      "$(grep 'AINDA-EXISTE' "$CHAMADAS_LOG" | tr '\n' ';')"
else
  ok "a vigília já estava encerrada no instante da chamada (nada de voltar em laço)"
fi
if [ ! -e "$AG/.update-vigia" ] && [ ! -e "$AG/.update-vigia-falhas" ]; then
  ok "marca e contagem saíram do disco ao fim"
else
  nao "fim da vigília" "sem .update-vigia nem -falhas" "sobraram marcas"
fi
if grep -q '"kind":"rollback"' "$POSTS_LOG" 2>/dev/null; then
  ok "e o agente contou a volta ao painel (kind rollback)"
else
  nao "aviso da volta no painel" 'POST com "kind":"rollback"' \
      "$(tail -2 "$POSTS_LOG" 2>/dev/null | tr '\n' ' ')"
fi
if grep -q '"returned_to":"v0.8.0"' "$POSTS_LOG" 2>/dev/null \
   || grep -q '"returned_to":"0.8.0"' "$POSTS_LOG" 2>/dev/null; then
  ok "o aviso diz para onde o sistema voltou (0.8.0)"
else
  nao "aviso com a versão de volta" 'returned_to 0.8.0' "$(tail -1 "$POSTS_LOG" 2>/dev/null | cut -c1-160)"
fi
# O DESFECHO desta volta (ela terminou: o dublê do update.sh sai com 0). Sem
# este campo o painel tinha de adivinhar pelo texto do motivo, e tratava igual
# a volta que voltou o sistema e a que o deixou fora do ar (#3271).
VOLTA_BOA="$(grep -F '"kind":"rollback"' "$POSTS_LOG" 2>/dev/null | tail -1)"
case "$VOLTA_BOA" in
  *'"ok":true'*)
    ok 'e o aviso leva o desfecho da volta: "ok":true (o update.sh da volta deu 0)' ;;
  *)
    nao "desfecho da volta que terminou" '"ok":true no corpo do aviso' \
        "${VOLTA_BOA:-<nenhum POST de rollback>}" ;;
esac

echo "── 6. fora da janela de 2 h NADA acontece"
preparar_vps
armar_marca $(( 3 * 60 * 60 )) v0.8.0
printf '1\n' > "$AG/.update-vigia-falhas"
rodar_agente proxy
[ "$(chamadas)" = "0" ] && ok "nenhuma volta fora da janela" \
  || nao "nenhuma volta fora da janela" "0 chamadas" "$(chamadas)"
if [ ! -e "$AG/.update-vigia" ]; then
  ok "a marca vencida foi APAGADA (não fica esperando a próxima queda)"
else
  nao "marca vencida apagada" ".update-vigia ausente" "marca de 3 h atrás continua no disco"
fi
if [ ! -e "$AG/.update-vigia-falhas" ]; then
  ok "e a contagem foi junto"
else
  nao "contagem apagada" "sem .update-vigia-falhas" "contagem órfã: $(cat "$AG/.update-vigia-falhas")"
fi

echo "── 7. o aviso da volta leva o DESFECHO — e a que não terminou não se disfarça"
# O caso 5 mediu a volta que TERMINOU. Aqui o update.sh da volta falha (código
# 7): o recado é o MESMO, e o que muda é o campo. É esta a diferença que o
# painel precisa para não afirmar "é a que está no ar agora" quando ninguém
# sabe em que versão o sistema ficou (#3271).
cat > "$AG/hostgator-setup-kit/update.sh" <<'STUB'
#!/usr/bin/env bash
printf 'chamada: %s\n' "$*" >> "${CHAMADAS_LOG:?}"
exit 7
STUB
chmod +x "$AG/hostgator-setup-kit/update.sh"
preparar_vps
armar_marca 60 v0.8.0
printf '1\n' > "$AG/.update-vigia-falhas"
rodar_agente proxy

VOLTA_RUIM="$(grep -F '"kind":"rollback"' "$POSTS_LOG" 2>/dev/null | tail -1)"
case "$VOLTA_RUIM" in
  *'"ok":false'*)
    ok 'a volta que falhou vai ao painel com "ok":false' ;;
  *)
    nao "desfecho da volta que não terminou" '"ok":false no corpo do aviso' \
        "${VOLTA_RUIM:-<nenhum POST de rollback>}" ;;
esac
case "$VOLTA_RUIM" in
  *'"returned_to":'*)
    # O recado continua o mesmo de antes (o formato não mudou: só ganhou o
    # campo), e é isso que faz o desfecho viajar junto do fato.
    ok 'e o resto do recado segue igual: para onde voltou continua no corpo' ;;
  *)
    nao "recado com a versão de volta" 'returned_to no corpo do aviso' \
        "${VOLTA_RUIM:-<nenhum POST de rollback>}" ;;
esac

echo
if [ "$falhas" -eq 0 ]; then
  echo "vigia-da-volta: os sete pontos da vigília estão de acordo."
  exit 0
fi
echo "vigia-da-volta: $falhas caso(s) em desacordo."
exit 1
