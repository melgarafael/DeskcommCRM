#!/usr/bin/env bash
# ── #1778 — a guarda de arquitetura sem suporte só considera instalação REAL ───────────────────────
#
# O DEFEITO, e por que o teste do #1775 não podia pegá-lo:
#
#   O #1775 separou instalação NOVA (recusa em não-x86_64) de instalação
#   EXISTENTE (aviso, e o script segue até o build local). O critério de
#   "existente" lia o estado do DIRETÓRIO — compose E um `.env` — e um
#   `install.sh --yes` numa VPS com arquitetura sem suporte e `.env` já preenchido (copiado de
#   outra máquina, gerado por automação, ou deixado por uma rodada anterior que
#   parou no meio) passava como existente e ia construir as imagens na própria
#   VPS. O caminho alcançado é o mesmo build local que o install.sh já tem
#   (por volta da linha 2209), então não é risco de segurança: é a instalação
#   NOVA em arquitetura sem suporte deixar de ser recusada, que é o que a guarda do #1042 existe
#   para impedir.
#
#   O teste do #1775 não podia ver isso porque a fixture dele (`montar_instalacao`)
#   representa uma instalação que JÁ PASSOU pelo install.sh: para aquela prova,
#   "tem compose e tem `.env`" e "é instalação real" são a MESMA coisa. Foi por
#   isso que este arquivo nasce: separar os dois, e dar ao par `.env`-sem-mais um
#   nome que a guarda trata como instalação NOVA.
#
# O QUE ESTE ARQUIVO PROVA, e o que NÃO prova:
#
#   Prova que a guarda decide pelo que a instalação DEIXOU (marcador, contêiner
#   do projeto, contêiner do Supabase single-server) e não pelo que chegou
#   pronto na pasta: com `.env` e nada instalado, riscv64 é recusada com a
#   recusa do #1042. Prova que os três sinais de instalação real continuam
#   passando, que o filtro de contêiner é por PROJETO (o de outra instalação na
#   mesma VPS não vale), que `docker` indisponível não vira instalação inventada,
#   e que em x86_64 o `docker` nem é chamado — a guarda não perguntou nada.
#
#   NÃO prova nada numa VPS com arquitetura sem suporte de verdade: `uname` e `docker` são dublês, o
#   diretório é descartável (mktemp) e nenhum contêiner sobe. O que se prova é
#   a DECISÃO da guarda, que é onde o critério mora.
#
#   bash tests/shell/guarda-arm-so-considera-instalacao-real.test.sh
set -uo pipefail
# Isolamento do git: um GIT_DIR herdado (suíte rodada de dentro de um hook ou
# de um `rebase --exec`) manda por cima de todo `cd`/`git init` dos diretórios
# descartáveis abaixo. Nenhum teste aqui mede o autor do git.
unset $(git rev-parse --local-env-vars 2>/dev/null) 2>/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
COMMON="$REPO_ROOT/hostgator-setup-kit/_common.sh"

WORK="$(mktemp -d)"
# Guarda de raio de ação: com TMPDIR apontando para diretório inexistente o
# `mktemp` acima falha e WORK fica VAZIA — aí "$WORK/bin/docker" vira /bin/docker
# e o dublê abaixo sobrescreve o binário da máquina de quem roda a suíte.
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ]; then
  echo "abortado: mktemp -d não devolveu um sandbox (WORK='$WORK') — TMPDIR inválido?" >&2
  exit 1
fi
trap '[ "${DK_KEEP:-0}" = 1 ] || rm -rf "$WORK"' EXIT

REAL_UNAME="$(command -v uname)"
FAILS=0
TOTAL=0
check() {  # check <descrição> <comando de verificação...>
  TOTAL=$((TOTAL + 1))
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}
nao_contem() { ! grep -q -- "$1" "$2"; }   # nao_contem <texto> <arquivo>

# ── Dublês ───────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin"
# `uname -m` é a arquitetura que o caso escolhe; o resto de `uname` vai para o
# binário de verdade.
cat > "$WORK/bin/uname" <<STUB
#!/usr/bin/env bash
[ "\$*" = "-m" ] && { printf '%s\n' "\${FAKE_ARCH:-riscv64}"; exit 0; }
exec "$REAL_UNAME" "\$@"
STUB
# `docker` responde ao ÚNICO comando que a guarda faz: `ps -a -q --filter
# label=com.docker.compose.project=<nome>`. O dublê devolve um id quando o nome
# pedido estiver na lista de PROJETOS COM CONTÊINER, e vazio quando não estiver
# — inclusive quando o nome pedido for o do projeto de outra instalação, que é
# o caso 7. Toda chamada vai para o log, para o teste provar que em x86_64 a
# guarda NÃO PERGUNTOU nada (caso 8).
cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
n="$*"
projeto="${n##*com.docker.compose.project=}"
projeto="${projeto%% *}"
for p in ${PROJETOS_COM_CONTAINER:-}; do
  [ "$p" = "$projeto" ] && { printf 'c0ffee1234\n'; exit 0; }
done
exit 0
STUB
# A asserção do caso 8 precisa provar que a guarda NÃO falou com o Docker, e
# não apenas que o log ficou vazio: o stub registra uma linha por chamada, então
# "nenhuma linha" e "nenhuma consulta ao projeto" são a mesma coisa aqui. O
# `label=com.docker.compose.project` é o que distingue a consulta da guarda de
# qualquer outra linha que um stub pudesse escrever.
docker_falou_com_o_docker() { grep -q 'com.docker.compose.project' "$DOCKER_LOG" 2>/dev/null; }
# `check` roda o comando com "${@:2}", e um `!` solto ali vira nome de comando
# em vez de negação — daí a inversão morar numa função própria.
docker_nao_falou() { ! docker_falou_com_o_docker; }
chmod +x "$WORK/bin/uname" "$WORK/bin/docker"
export DOCKER_LOG="$WORK/docker.log"
export PATH="$WORK/bin:$PATH"

# ── Fixture ──────────────────────────────────────────────────────────────────
# Uma pasta que parece uma instalação: compose + `.env`. O que muda entre os
# casos é o resto — o marcador, os contêineres, e se o `.env` existe. O nome do
# projeto que o Compose derivaria da pasta é `deskcommcrm` (basename), e é por
# ele que o dublê do `docker` responde.
montar_pasta() {  # montar_pasta <diretório> [1=com .env]
  local d="$1" sem_env="${2:-0}"
  mkdir -p "$d"
  printf 'services:\n  app:\n    image: x\n' > "$d/docker-compose.prod.yml"
  [ "$sem_env" = 1 ] && return 0
  cat > "$d/.env" <<ENV
APP_IMAGE=x
SUPABASE_DB_URL=postgresql://x/y
NEXT_PUBLIC_APP_URL=https://crm.exemplo.com.br
INTERNAL_SECRET=segredo
ENV
  chmod 600 "$d/.env"
}

# roda_guarda <diretório de trabalho> <arch> <projetos com contêiner...> → rc
# Carrega o `_common.sh` com o NOME de quem sourceou, porque é o nome que a
# guarda confere (`BASH_SOURCE[1]`): sem ele a guarda nem roda. A decisão é lida
# de `instalacao_real_do_kit_aqui`, que é onde o critério mora, e a RECUSA é
# provada pelo rc e pelo texto do #1042 — a mesma prova do
# `tests/shell/arquitetura-kit.test.sh`, com a instalação NOVA carregada de `.env`.
guarda() {  # guarda <diretório> <arch> [projetos com contêiner...]
  local d="$1" arch="$2"; shift 2
  # O log é ZERADO entre as duas passadas do helper: a primeira mede o
  # `instalacao_real_do_kit_aqui` (que chama o docker) e a segunda mede a
  # `verificar_arquitetura_do_kit` (que, em amd64, não pode chamar). Sem o
  # `: >` no meio, a consulta da primeira passada ainda estaria no log quando a
  # asserção do caso 8 lesse, e o caso diria que a guarda falou com o Docker em
  # x86_64 — o que é o defeito, e não o que acontece.
  : > "$DOCKER_LOG"
  ( cd "$d" && \
    env FAKE_ARCH="$arch" PROJETOS_COM_CONTAINER="$*" \
      bash -c '. "$0"
               if instalacao_real_do_kit_aqui; then echo REAL; else echo NOVA; fi' "$COMMON" \
  ) > "$WORK/veredito.txt" 2>"$WORK/guarda.err"
  # O rc é o da VERIFICAÇÃO DA GUARDA completa (que sai 1 na recusa), e não o do
  # `bash -c` acima: a guarda é quem responde se a instalação existe.
  : > "$DOCKER_LOG"
  ( cd "$d" && env FAKE_ARCH="$arch" PROJETOS_COM_CONTAINER="$*" \
      bash -c 'set -- "$0"; . "$1"
               verificar_arquitetura_do_kit' "$COMMON" install.sh \
  ) > "$WORK/guarda.out" 2>&1
  RC=$?
  VEREDITO="$(cat "$WORK/veredito.txt")"
  SAIDA="$(cat "$WORK/guarda.out")"
}
# O nome que o Compose derivaria da pasta. Lido do próprio `docker` dublê em vez
# de repetido aqui: se um dia a fórmula mudar, o teste continua medindo a
#_installação_ e não uma constante desatualizada.
nome_derivado() { basename "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-'; }

# ─────────────────────────────────────────────────────────────────────────────
echo '── 1. A DEFÉITO DA #1778: .env preenchido + NADA instalado é instalação'
echo '      NOVA, e riscv64 é recusada com a recusa do #1042'
# A receita do relato: `install.sh --yes` numa VPS com arquitetura sem suporte e instalação NOVA cujo `.env` veio
# pronto (copiado de outra máquina, gerado por automação, ou deixado por uma
# rodada que parou no meio). Compose e `.env` estão lá — que era o que bastava.
# O resultado tem de ser a RECUSA, com o texto do #1042, e sem a palavra do
# aviso de instalação existente.
R1="$WORK/caso1"; mkdir -p "$R1"; montar_pasta "$R1/deskcommcrm" 0
guarda "$R1" riscv64
check ".env + compose e NADA instalado → a instalação NÃO é real" \
  test "$VEREDITO" = NOVA
check "e riscv64 é recusada (rc=$RC, e != 0)" test "$RC" -ne 0
check "a recusa é a do #1042 (orienta a VPS suportada)" \
  grep -q 'Use uma VPS x86_64/amd64 ou ARM64/aarch64' "$WORK/guarda.out"
check "a recusa diz qual arquitetura foi encontrada" \
  grep -q 'riscv64' "$WORK/guarda.out"
check "e NÃO diz que a instalação já existe (o aviso do #1775)" \
  nao_contem 'JÁ EXISTE' "$WORK/guarda.out"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 2. OS TRÊS SINAIS DE INSTALAÇÃO REAL CONTINUAM PASSANDO (#1775 intacto)'
# O contrapeso obrigatório: o que o #1775 consertou não pode ser desfeito. Sem
# esta seção, um conserto que recusasse TUDO em arquitetura sem suporte também ficaria verde.
R2="$WORK/caso2"; mkdir -p "$R2"; montar_pasta "$R2/deskcommcrm" 0
marcar_instalacao() {  # marcar_instalacao <diretório> [versão]
  printf 'instalado_em=2026-09-27T00:00:00Z\nversao=%s\n' "${2:-0.9.0}" \
    > "$1/.deskcomm-instalado"
  chmod 600 "$1/.deskcomm-instalado"
}
# 2a. O marcador, que o install.sh grava com a stack no ar. É o sinal mais
# forte: a instalação em si escreveu que terminou.
marcar_instalacao "$R2/deskcommcrm"
guarda "$R2" riscv64
check "o marcador .deskcomm-instalado → a instalação é real" test "$VEREDITO" = REAL
check "e riscv64 passa pela guarda (rc=$RC, e == 0)" test "$RC" -eq 0
check "com o aviso de que a instalação já existe, e não com a recusa" \
  grep -q 'JÁ EXISTE' "$WORK/guarda.out"
check "e a recusa do #1042 NÃO aparece" \
  nao_contem 'Use uma VPS x86_64/amd64 ou ARM64/aarch64' "$WORK/guarda.out"

# 2b. O contêiner do projeto, que é o caso de quem instalou numa versão
# anterior e por isso não tem marcador. Precisa ser o contêiner do projeto
# DESTA instalação — daí o nome derivado da pasta, e não um nome qualquer.
R2B="$WORK/caso2b"; mkdir -p "$R2B"; montar_pasta "$R2B/deskcommcrm" 0
guarda "$R2B" riscv64 "$(nome_derivado "$R2B/deskcommcrm")"
check "contêiner do projeto DESTA instalação → é real" test "$VEREDITO" = REAL
check "e riscv64 passa pela guarda (rc=$RC, e == 0)" test "$RC" -eq 0
check "com o aviso de instalação existente" grep -q 'JÁ EXISTE' "$WORK/guarda.out"

# 2c. O contêiner do Supabase single-server, que o modo single-server cria com
# o sufixo `-supabase` no nome do projeto. Sem este sinal, quem instalou em
# single-server passaria a ser recusado numa VPS com arquitetura sem suporte — uma regressão nova.
R2C="$WORK/caso2c"; mkdir -p "$R2C"; montar_pasta "$R2C/deskcommcrm" 0
guarda "$R2C" riscv64 "$(nome_derivado "$R2C/deskcommcrm")-supabase"
check "contêiner do Supabase single-server → é real" test "$VEREDITO" = REAL
check "e riscv64 passa pela guarda (rc=$RC, e == 0)" test "$RC" -eq 0

# 2d. O COMPOSE_PROJECT_NAME do `.env` manda sobre o nome derivado da pasta, e
# o guard tem de procurar pelo que os contêineres carregam de verdade. Uma
# segunda instalação na mesma VPS (a receita do próprio kit para quem quer duas)
# nomeia o projeto no `.env` justamente para não disputar o parque com a outra.
R2D="$WORK/caso2d"; mkdir -p "$R2D"; montar_pasta "$R2D/deskcommcrm" 0
printf 'COMPOSE_PROJECT_NAME=deskcommcrm-2\n' >> "$R2D/deskcommcrm/.env"
guarda "$R2D" riscv64 "deskcommcrm-2"
check "COMPOSE_PROJECT_NAME do .env manda sobre o nome da pasta → é real" \
  test "$VEREDITO" = REAL
check "e riscv64 passa pela guarda (rc=$RC, e == 0)" test "$RC" -eq 0

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 3. O QUE NÃO É PROVA DE INSTALAÇÃO: os contêineres errados e o Docker'
echo '      que não respondeu'
# Aqui está a outra metade do defeito. Um `docker ps` que responde com o
# contêiner de OUTRO programa não prova que ESTE projeto foi instalado — e a
# VPS de quem já tem um WordPress é a regra, não a exceção. Sem o filtro por
# projeto, qualquer VPS com Docker vira "instalação existente" e a recusa do
# #1042 deixa de existir em cima de um `docker ps` qualquer.
R3="$WORK/caso3"; mkdir -p "$R3"; montar_pasta "$R3/deskcommcrm" 0
guarda "$R3" riscv64 "wordpress_app_pljr imobplus-server-app-1 traefik"
check "contêiner de OUTRO programa na mesma VPS → a instalação NÃO é real" \
  test "$VEREDITO" = NOVA
check "e riscv64 é recusada (rc=$RC, e != 0)" test "$RC" -ne 0
check "a recusa é a do #1042" grep -q 'Use uma VPS x86_64/amd64 ou ARM64/aarch64' "$WORK/guarda.out"

# Um `docker` que não responde (fora do PATH, daemon parado, sem permissão no
# socket) devolve vazio, e vazio é "não achei" — a resposta que manda RECUSAR.
# O contrário seria adivinhar instalação a partir de um Docker que não falou.
R3B="$WORK/caso3b"; mkdir -p "$R3B"; montar_pasta "$R3B/deskcommcrm" 0
guarda "$R3B" riscv64
: > "$DOCKER_LOG"
( cd "$R3B" && env -i PATH="/usr/bin:/bin" HOME="${HOME:-/root}" FAKE_ARCH=riscv64 \
    bash -c '. "$0"
             if instalacao_real_do_kit_aqui; then echo REAL; else echo NOVA; fi' "$COMMON" \
) > "$WORK/sem-docker.txt" 2>&1
check "sem docker no PATH, a instalação NÃO é inventada" \
  grep -q '^NOVA$' "$WORK/sem-docker.txt"

# Sem `.env` não há nem nome de projeto para procurar — e a pasta nem é uma
# instalação. O guard nem deve chamar o docker aqui.
R3C="$WORK/caso3c"; mkdir -p "$R3C"; montar_pasta "$R3C/deskcommcrm" 1
guarda "$R3C" riscv64 "$(nome_derivado "$R3C/deskcommcrm")"
check "sem .env (e com contêiner do projeto lá) → a instalação NÃO é real" \
  test "$VEREDITO" = NOVA
check "e riscv64 é recusada (rc=$RC, e != 0)" test "$RC" -ne 0
check "e o docker nem é chamado sem .env" docker_nao_falou

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 4. x86_64: A GUARDA CONTINUA NÃO PERGUNTANDO NADA'
# Em amd64 o veredito é `amd64` antes de olhar o disco, e a guarda não deve
# tocar no Docker para descobrir isso. O `test:shell` roda num Mac Apple
# Silicon, então este caso é o que impede a suíte de depender do processador de
# quem a roda.
R4="$WORK/caso4"; mkdir -p "$R4"; montar_pasta "$R4/deskcommcrm" 0
guarda "$R4" x86_64
check "em x86_64 a guarda atravessa (rc=$RC, e == 0)" test "$RC" -eq 0
check "em x86_64 a guarda NÃO chama o docker (nem disco, nem contêiner)" \
  docker_nao_falou
check "em x86_64 não sai nem recusa nem aviso sobre arquitetura" \
  nao_contem 'arquitetura' "$WORK/guarda.out"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 5. A FÓRMULA DO NOME: a cópia do guard bate com nome_do_projeto_compose'
# O guard repete a fórmula do nome do projeto em vez de chamar a função, porque
# roda no TOPO do `_common.sh`, antes dela existir. Essa repetição é uma dívida:
# se as duas divergirem, a guarda para de achar o contêiner de quem JÁ TEM
# instalação e volta a recusar a recuperação do #1775. Este caso mede as duas
# lado a lado, com as pastas que o próprio kit já usa de exemplo.
(
  . "$COMMON" 2>/dev/null
  for pasta in deskcommcrm _deskcomm -deskcomm _-_crm _123 CRM-production meu_crm-2; do
    dir="$WORK/nome/$pasta"; mkdir -p "$dir"
    printf 'x\n' > "$dir/docker-compose.prod.yml"; : > "$dir/.env"
    printf '%s %s %s\n' "$pasta" "$(nome_do_projeto_compose "$dir")" \
      "$(nomes_do_projeto_da_instalacao "$dir" | tr '\n' ',')"
  done
) > "$WORK/nomes.txt" 2>&1
while read -r pasta esperado derivados; do
  check "«${pasta}»: o guard deriva «${esperado}» como nome_do_projeto_compose" \
    test "$derivados" = "$esperado,"
done < "$WORK/nomes.txt"

# Um COMPOSE_PROJECT_NAME fora do que o Compose aceita é ignorado, e o derivado
# da pasta segue na lista: um nome inválido não pode fazer a guarda procurar
# por algo que o Docker nunca chamará.
R5="$WORK/caso5"; mkdir -p "$R5"; montar_pasta "$R5/deskcommcrm" 0
printf 'COMPOSE_PROJECT_NAME=CRM Inválido/Não\n' >> "$R5/deskcommcrm/.env"
N5="$(
  . "$COMMON" 2>/dev/null
  nomes_do_projeto_da_instalacao "$R5/deskcommcrm" | tr '\n' ','
)"
check "um COMPOSE_PROJECT_NAME inválido é ignorado (resta o nome derivado: $N5)" \
  test "$N5" = "$(nome_derivado "$R5/deskcommcrm"),"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 6. O MARCADOR: o install.sh grava, e a guarda lê o que ele diz'
# O marcador é o sinal que o install.sh passa a escrever. As duas metades
# importam: que ele SAI com a stack no ar (e não antes, nem quando o app não
# respondeu), e que a guarda reconhece o arquivo.
# A escrita é medida pela FUNÇÃO, isolada do resto do instalador (que exige
# root, Docker e um banco): o que muda de um lado para o outro é o diretório.
R6="$WORK/caso6"; mkdir -p "$R6"; montar_pasta "$R6/deskcommcrm" 0
(
  PROJECT_DIR="$R6/deskcommcrm" bash -c '. "$0"; marcar_instalacao_feita 0.9.0' "$COMMON"
) >/dev/null 2>&1
check "marcar_instalacao_feita grava o arquivo na raiz da instalação" \
  test -f "$R6/deskcommcrm/.deskcomm-instalado"
check "e o arquivo registra a versão que subiu" \
  grep -q '^versao=0.9.0$' "$R6/deskcommcrm/.deskcomm-instalado"
check "e registra quando (ISO-8601 em UTC, para o log do dono)" \
  grep -qE '^instalado_em=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' \
    "$R6/deskcommcrm/.deskcomm-instalado"
check "e nasce com o mesmo rigor do .env (600), que é onde ele mora" \
  test "$(stat -c '%a' "$R6/deskcommcrm/.deskcomm-instalado" 2>/dev/null || stat -f '%Lp' "$R6/deskcommcrm/.deskcomm-instalado" 2>/dev/null)" = 600
# E a guarda o reconhece pelo arquivo, sem perguntar nada ao Docker.
: > "$DOCKER_LOG"
(
  cd "$R6" && bash -c '. "$0"
                  if instalacao_real_do_kit_aqui; then echo REAL; else echo NOVA; fi' "$COMMON"
) > "$WORK/caso6.txt" 2>&1
check "a guarda reconhece o marcador sem chamar o docker" \
  grep -q '^REAL$' "$WORK/caso6.txt"
check "e de fato não chamou o docker" docker_nao_falou

# O install.sh grava o marcador SÓ com o app saudável, e as duas receitas de
# "recomeçar" o apagam junto com o `.env`. Um marcador que sobrasse depois de
# derrubar tudo faria a guarda mentir sobre uma instalação que não existe mais
# — a mesma classe de defeito que este conserto veio tirar.
check "o install.sh só grava o marcador quando o app está saudável" \
  grep -qE 'if \[ "\$\{APP_SAUDAVEL:-0\}" = 1 \]; then' "$REPO_ROOT/hostgator-setup-kit/install.sh"
check "e a receita de 'recomeçar' apaga o marcador junto com o .env" \
  grep -q 'rm -f .env ${MARCA_INSTALACAO_NOME' "$REPO_ROOT/hostgator-setup-kit/install.sh"
check "e o painel de recuperação do install.sh também o apaga" \
  grep -q 'rm -f \${MARCA_INSTALACAO_NOME' "$REPO_ROOT/hostgator-setup-kit/install.sh"
check "e o marcador está no .gitignore (estado da VPS, não do repositório)" \
  grep -qx '.deskcomm-instalado' "$REPO_ROOT/.gitignore"
# O update.sh também grava, com o app saudável. Depois deste conserto, uma
# instalação NOVA numa arquitetura sem suporte é recusada — então toda instalação nessa arquitetura que existe veio
# de antes e NÃO tem marcador; o único sinal dela seria o contêiner, e um
# `down` sem `-v` (ou um `prune`) a faria ser recusada como nova, o mesmo
# defeito do #1775. Gravar no update fecha isso a partir da atualização
# seguinte. A prova é a ORDEM: a gravação mora dentro do bloco do app saudável.
check "o update.sh grava o marcador só depois de o app voltar saudável" \
  awk '/^if \[ -n "\$ok" \]; then$/{d=1; next} d && /^(else|elif|fi)/{exit} d && /marcar_instalacao_feita/{achou=1; exit} END{exit !achou}' \
    "$REPO_ROOT/hostgator-setup-kit/update.sh"

# ─────────────────────────────────────────────────────────────────────────────
echo
echo '── 7. O NOME ANTIGO FOI REMOVIDO: nada chama mais o critério do .env'
# `instalacao_do_kit_ja_existe` era a função do critério de `main` (compose +
# `.env`). Se ela tivesse sobrado no arquivo, o próximo conserto da guarda
# voltaria a usá-la por engano — e o defeito voltaria sem nenhuma mudança
# visível no diff.
check "a função do critério antigo (compose + .env) não existe mais" \
  bash -c '! grep -q "^instalacao_do_kit_ja_existe()" "$0"' "$COMMON"
check "e ninguém no kit a chama" \
  bash -c '! grep -rq "instalacao_do_kit_ja_existe" hostgator-setup-kit/' "$REPO_ROOT"

printf '\nprovas: %d vermelho(s) de %d\n' "$FAILS" "$TOTAL"
if [ "$FAILS" -eq 0 ]; then
  echo "OK — a guarda só considera instalação real (#1778) e o caminho de recuperação do #1775 continua aberto."
else
  echo "FALHOU — $FAILS prova(s)."
fi
exit $((FAILS > 0))
