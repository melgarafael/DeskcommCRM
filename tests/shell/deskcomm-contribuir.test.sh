#!/usr/bin/env bash
# Prova dos scripts da skill deskcomm-contribuir num repositório git DESCARTÁVEL.
# Nada aqui toca o clone de quem roda: cada caso cria um repo em diretório
# temporário, com um "origin" local fazendo o papel do repositório principal.
#
#   bash tests/shell/deskcomm-contribuir.test.sh
#
# O que está sob prova:
#   1. quem-sou.sh diz "contribuidor" para e-mail desconhecido e "mantenedor"
#      para um e-mail do .mailmap — sem rede (o gh é neutralizado no PATH).
#   2. check-migration-triple.sh BLOQUEIA migration nova sem baseline/MANIFEST,
#      BLOQUEIA NNNN e timestamp já usados na origin/main, e DEIXA PASSAR a
#      tripla completa com número livre. Bypass DESKCOMM_MIGRATION_EDIT=1.
#   2-bis. e, com a biblioteca da população AUSENTE (#1273), o NNNN já usado
#      CONTINUA bloqueado e a queda é declarada: o guard não pode afrouxar
#      porque a regra que ele consulta não estava à mão.
#   2-quater. o merge da main do PRODUTO passa mesmo com o NNNN dela noutra
#      branch do principal; um NNNN novo da branch continua bloqueado.
#   2-quinquies. o NNNN e o timestamp já COMMITADOS na própria branch contam:
#      a segunda 0201 e o carimbo repetido são bloqueados, e a dica não aponta
#      para o número que a branch já usa.
#   3. pre-push BLOQUEIA refs/heads/main e deixa passar uma feature branch.
#   4. armar-hooks.sh grava core.hooksPath, recusa sobrescrever hooks alheios,
#      e --desarmar limpa.
#   5. pre-voo.sh acusa CHANGELOG à mão, migration sem tripla e branch atrasada,
#      e sai com 0 (é medição, não veredito).
#   5-bis. a migration que a PRÓPRIA branch já commitou entra na população do
#      pré-voo: o "próximo NNNN" não aponta para o número que ela já usa.
#   5-ter. o complemento.sh acusa as DUAS migrations de mesmo NNNN dentro do
#      próprio PR, e não só as de fora.
#   5-quater. e acusa também sem checkout do PR (o modo do TRIAGEM.md, §4: o
#      HEAD é a main de quem tria); com UMA migration só, nenhuma acusa a si.
#   6. sessao.sh lembra o contribuidor e cala para o mantenedor.
#   7. O bloco do Passo 0 do SKILL.md — extraído do guia e EXECUTADO, em bash e zsh —
#      sempre dá uma resposta ou um erro que se explica: também numa subpasta do clone,
#      num clone sem o script e fora de qualquer clone, com e sem a instalação global.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="$RAIZ/.agents/skills/deskcomm-contribuir"
SCRIPTS="$SKILL/scripts"
falhas=0; casos=0
ok()   { casos=$((casos+1)); printf '  ✓ %s\n' "$1"; }
falha(){ casos=$((casos+1)); falhas=$((falhas+1)); printf '  ✗ %s\n     %s\n' "$1" "${2:-}"; }
assert_contains() { if grep -q -- "$2" <<<"$1"; then ok "$3"; else falha "$3" "esperava conter '$2'; saída: $(head -c 300 <<<"$1")"; fi; }
assert_not_contains() { if grep -q -- "$2" <<<"$1"; then falha "$3" "não esperava '$2'; saída: $(head -c 300 <<<"$1")"; else ok "$3"; fi; }
assert_exit() { if [ "$1" = "$2" ]; then ok "$3"; else falha "$3" "exit esperado $2, veio $1"; fi; }

# gh neutralizado: quem-sou.sh não pode depender de rede nem da conta de quem roda o teste
FAKEBIN="$(mktemp -d)"; printf '#!/usr/bin/env bash\nexit 1\n' > "$FAKEBIN/gh"; chmod +x "$FAKEBIN/gh"
export PATH="$FAKEBIN:$PATH"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP" "$FAKEBIN"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# ── isolamento do git: nada aqui escreve fora de "$TMP" ─────────────────────
# Um `cfg "$dir" user.*` grava onde o git RESOLVER o repositório, e não
# necessariamente em "$dir": um GIT_DIR herdado (rodar de dentro de um hook, de um
# `rebase --exec`) manda por cima do -C; "$dir" que não é repositório sobe até o
# pai. Foi assim que "Pessoa <alguem@fork.dev>" parou no .git/config do checkout
# compartilhado em 10/09/2026 e assinou 829 commits da main. Aqui o config É o dado
# sob teste (o quem-sou.sh lê `user.email`), então a identidade não pode ir para o
# ambiente. Em vez disso:
#   1. zera o ambiente local do git herdado — o idioma canônico do próprio git;
#   2. a descoberta de repositório nunca sobe para fora de "$TMP";
#   3. toda escrita de config é `--file <clone>/.git/config` (`cfg`), que não
#      resolve repositório nenhum: alvo errado é erro alto, nunca o repo de quem roda;
#   4. todo `cd` para um clone aborta se o clone não existir.
unset $(git rev-parse --local-env-vars)
export GIT_CEILING_DIRECTORIES="$TMP"
cfg() { local alvo="$1"; shift; git config --file "$alvo/.git/config" "$@"; }

# ── um "repositório principal" mínimo, com uma migration já aplicada ─────────
principal="$TMP/principal"; mkdir -p "$principal"
git -C "$principal" init -q -b main
cfg "$principal" user.email "mantenedor@exemplo.com"; cfg "$principal" user.name "Mantenedor"
mkdir -p "$principal/supabase/migrations" "$principal/.agents/skills/deskcomm-contribuir/scripts/hooks"
cp -R "$SCRIPTS"/. "$principal/.agents/skills/deskcomm-contribuir/scripts/"
# A biblioteca da POPULAÇÃO (#1273) mora em scripts/, fora da skill — e sem ela
# os hooks caem no caminho degradado e medem menos. O caso 2 mede o caminho
# COM a biblioteca; o 2-bis apaga o arquivo de propósito e mede o sem.
mkdir -p "$principal/scripts"
cp "$RAIZ/scripts/migration-populacao.sh" "$principal/scripts/"
printf 'select 1;\n' > "$principal/supabase/migrations/20260101120000_0200_existente.sql"
printf -- '-- baseline\n' > "$principal/supabase/baseline.sql"
printf '| `20260101120000` | `0200_existente` |\n' > "$principal/supabase/migrations/MANIFEST.md"
printf '# Changelog\n' > "$principal/CHANGELOG.md"
printf 'Rafael Melgaço <rafael@maudibrasil.com.br> <119944436+melgarafael@users.noreply.github.com>\n' > "$principal/.mailmap"
printf 'X=1\n' > "$principal/.env.example"
git -C "$principal" add -A && git -C "$principal" commit -q -m "base"

clonar() { # $1 = destino, $2 = e-mail do contribuidor
  rm -rf "$1"; git clone -q "$principal" "$1"
  cfg "$1" user.email "$2"; cfg "$1" user.name "Pessoa"
  cfg "$1" core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
  chmod +x "$1"/.agents/skills/deskcomm-contribuir/scripts/*.sh "$1"/.agents/skills/deskcomm-contribuir/scripts/hooks/*
}

echo "1. quem-sou.sh"
clone="$TMP/c1"; clonar "$clone" "alguem@fork.dev"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh)"
assert_contains "$saida" "^contribuidor" "e-mail desconhecido → contribuidor"
assert_contains "$saida" "alguem@fork.dev" "a saída explica o motivo (o e-mail)"
cfg "$clone" user.email "rafael@maudibrasil.com.br"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh --curto)"
assert_contains "$saida" "^mantenedor$" "e-mail do .mailmap → mantenedor (--curto)"
cfg "$clone" user.email "119944436+melgarafael@users.noreply.github.com"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh)"
assert_contains "$saida" "^mantenedor" "segundo e-mail do .mailmap → mantenedor"

echo "2. check-migration-triple.sh (pre-commit)"
clone="$TMP/c2"; clonar "$clone" "alguem@fork.dev"
cd "$clone" || exit 1; git switch -q -c fix/algo
printf 'select 2;\n' > supabase/migrations/20260909100000_0201_nova.sql
git add supabase/migrations/20260909100000_0201_nova.sql
saida="$(git commit -q -m "migration sem tripla" 2>&1)"; code=$?
assert_exit "$code" 1 "migration sem baseline/MANIFEST é bloqueada"
assert_contains "$saida" "sem apêndice em supabase/baseline.sql" "a mensagem nomeia o baseline"
assert_contains "$saida" "sem descrição" "a mensagem cobra a descrição (acumula, não para no primeiro)"
assert_contains "$saida" "-- manifest:" "a mensagem ensina a linha do cabeçalho"
printf -- '-- apêndice 0201\n' >> supabase/baseline.sql
printf -- '-- manifest:   \nselect 2;\n' > supabase/migrations/20260909100000_0201_nova.sql
git add -A
saida="$(git commit -q -m "manifest vazio" 2>&1)"; code=$?
assert_exit "$code" 1 "\`-- manifest:\` sem texto não conta como descrição"
printf -- '-- manifest: a nova coisa e por quê\nselect 2;\n' > supabase/migrations/20260909100000_0201_nova.sql
git add -A
saida="$(git commit -q -m "migration com tripla" 2>&1)"; code=$?
assert_exit "$code" 0 "tripla completa (descrição no cabeçalho, MANIFEST.md intocado) passa"
assert_exit "$(git diff --name-only HEAD~1 HEAD -- supabase/migrations/MANIFEST.md | wc -l | tr -d ' ')" 0 "o commit aceito não tocou o MANIFEST.md"
# colisão de NNNN e de timestamp com a origin/main
printf 'select 3;\n' > supabase/migrations/20260101120000_0200_colide.sql
printf -- '-- x\n' >> supabase/baseline.sql; printf '| x | `0200_colide` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "colisao" 2>&1)"; code=$?
assert_exit "$code" 1 "NNNN/timestamp já usados na origin/main são bloqueados"
assert_contains "$saida" "NNNN=0200" "acusa o NNNN"
assert_contains "$saida" "timestamp 20260101120000" "acusa o timestamp (os dois de uma vez)"
saida="$(DESKCOMM_MIGRATION_EDIT=1 git commit -q -m "bypass" 2>&1)"; code=$?
assert_exit "$code" 0 "DESKCOMM_MIGRATION_EDIT=1 é o bypass explícito"
git reset -q --hard HEAD~1 2>/dev/null

# ── 2-bis. A AUSÊNCIA da biblioteca NÃO afrouxa o guard (#1273) ─────────────────
# O caso que a issue descreve: a regra da população vive num lugar só
# (scripts/migration-populacao.sh), e um clone antigo, ou uma cópia da skill de
# uma versão anterior, NÃO tem esse arquivo. Se a queda da biblioteca esvaziasse
# a população, o `grep` não acharia colisão nenhuma e o pre-commit LIBERARIA o
# commit — um guard que encolhe o universo em silêncio é exatamente o defeito
# que a #1273 corrige. Aqui a biblioteca é apagada DE VERDADE do clone e o NNNN
# já usado na origin/main tem de continuar bloqueado, com o aviso da degradação.
echo "2-bis. check-migration-triple.sh sem a biblioteca (a guarda NÃO afrouxa)"
sem_lib="$TMP/c2-sem-lib"
rm -rf "$sem_lib"; git clone -q "$principal" "$sem_lib"
cfg "$sem_lib" user.email "alguem@fork.dev"; cfg "$sem_lib" user.name "Pessoa"
cfg "$sem_lib" core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
chmod +x "$sem_lib"/.agents/skills/deskcomm-contribuir/scripts/*.sh \
          "$sem_lib"/.agents/skills/deskcomm-contribuir/scripts/hooks/*
cd "$sem_lib" || exit 1; git switch -q -c fix/sem-lib
rm -f scripts/migration-populacao.sh   # a queda real da biblioteca
[ -r scripts/migration-populacao.sh ] && falha "2-bis" "a biblioteca não saiu do clone: o caso não mede a queda"
printf 'select 3;\n' > supabase/migrations/20260101120000_0200_colide.sql
printf -- '-- x\n' >> supabase/baseline.sql
printf '| x | `0200_colide` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "colisao sem biblioteca" 2>&1)"; code=$?
assert_exit "$code" 1 "sem a biblioteca, o NNNN já usado AINDA é bloqueado (o guard não afrouxa)"
assert_contains "$saida" "NNNN=0200" "sem a biblioteca, o NNNN continua sendo acusado"
assert_contains "$saida" "migration-populacao.sh AUSENTE" "a queda da biblioteca é DECLARADA, não silenciosa"
assert_contains "$saida" "checar:colisao-de-migration" "o aviso aponta quem mede a população inteira"
assert_not_contains "$saida" "command not found" "sem a biblioteca, o bloqueio não tropeça em função ausente"
# O NNNN em colisão que NÃO é o 1º arquivo da ref: o caminho sem biblioteca
# prefixava só a 1ª linha de cada ref, e o `grep "<ref> <nome>"` perdia o resto.
git reset -q --hard HEAD 2>/dev/null
git switch -q -c colega
printf 'select 5;\n' > supabase/migrations/20260301120000_0300_do_colega.sql
printf 'select 6;\n' > supabase/migrations/20260301130000_0301_do_colega.sql
git add -A; DESKCOMM_MIGRATION_EDIT=1 git commit -q -m "colega"
git switch -q fix/sem-lib
rm -f scripts/migration-populacao.sh
printf 'select 7;\n' > supabase/migrations/20260909120000_0301_colide.sql
printf -- '-- y\n' >> supabase/baseline.sql
printf '| y | `0301_colide` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "colisao com arquivo que nao e o primeiro da ref" 2>&1)"; code=$?
assert_exit "$code" 1 "sem a biblioteca, colisão com o 3º arquivo de outra branch AINDA é bloqueada"
assert_contains "$saida" "NNNN=0301" "e o NNNN acusado é o do 3º arquivo"
git reset -q --hard HEAD 2>/dev/null

# ── 2-ter. Clone que só tem o FORK (item 1 da #1273) ─────────────────────────
# A `origin` aponta para um fork no GitHub (o insteadOf a resolve para o
# principal local, sem rede) e nenhum remoto é melgarafael/DeskcommCRM: a base
# vira a origin/main DO FORK, que pode estar atrás do principal. O hook não
# bloqueia por isso, mas DIZ; e o pré-voo não dá ✓ de "livre" sobre essa régua.
echo "2-ter. clone só com o fork: NÃO MEDIDO declarado"
fork="$TMP/c2-fork"; clonar "$fork" "alguem@fork.dev"
cfg "$fork" remote.origin.url "https://github.com/alguem/DeskcommCRM.git"
cfg "$fork" "url.$principal.insteadOf" "https://github.com/alguem/DeskcommCRM.git"
cd "$fork" || exit 1; git switch -q -c fix/no-fork
printf 'select 8;\n' > supabase/migrations/20260909130000_0201_no_fork.sql
printf -- '-- z\n' >> supabase/baseline.sql
printf '| z | `0201_no_fork` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "migration num fork" 2>&1)"; code=$?
assert_exit "$code" 0 "número livre no fork não bloqueia (não há colisão medida)"
assert_contains "$saida" "NÃO MEDIDOS contra a main do PRODUTO" "o hook declara que não mediu a main do produto"
assert_contains "$saida" "git remote add upstream" "e diz como corrigir"
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh 2>&1)"
assert_not_contains "$saida" "✓ NNNN" "o pré-voo não dá ✓ de NNNN livre sobre a main do fork"
assert_not_contains "$saida" "✓ próximo NNNN" "nem ✓ de próximo NNNN"
assert_contains "$saida" "NÃO MEDIDO contra a main do PRODUTO" "o pré-voo declara a régua"

# ── 2-quater. Trazer a main do PRODUTO não é "migration nova" ─────────────────
# Com a população alargada para refs/remotes/*, uma branch do principal com OUTRO
# arquivo de mesmo NNNN (o 0412 de `resgate/1651-…` contra o 0412 da main, medido
# em 27/09/2026) fazia o merge da upstream/main ser BLOQUEADO, mandando renumerar
# migration que já está na main. O que a main do produto já tem sai da conta.
echo "2-quater. merge da main do produto não é bloqueado por branch velha do principal"
produto="$TMP/produto"; rm -rf "$produto"; git clone -q "$principal" "$produto"
cfg "$produto" user.email "mantenedor@exemplo.com"; cfg "$produto" user.name "Mantenedor"
git -C "$produto" switch -q -c velha
printf 'select 9;\n' > "$produto/supabase/migrations/20260102000000_0412_versao_antiga.sql"
git -C "$produto" add -A; git -C "$produto" commit -q -m "velha"
git -C "$produto" switch -q main
printf 'select 10;\n' > "$produto/supabase/migrations/20260103000000_0412_versao_da_main.sql"
printf -- '-- apêndice 0412\n' >> "$produto/supabase/baseline.sql"
printf '| `20260103000000` | `0412_versao_da_main` |\n' >> "$produto/supabase/migrations/MANIFEST.md"
git -C "$produto" add -A; git -C "$produto" commit -q -m "0412 na main"
merge="$TMP/c2-merge"; clonar "$merge" "alguem@fork.dev"
cfg "$merge" remote.upstream.url "https://github.com/melgarafael/DeskcommCRM.git"
cfg "$merge" remote.upstream.fetch "+refs/heads/*:refs/remotes/upstream/*"
cfg "$merge" "url.$produto.insteadOf" "https://github.com/melgarafael/DeskcommCRM.git"
cd "$merge" || exit 1; git fetch -q upstream; git switch -q -c fix/traz-a-main
git rev-parse -q --verify refs/remotes/upstream/velha >/dev/null || falha "2-quater" "a branch velha do principal não chegou: o caso não mede a colisão"
git merge -q --no-ff --no-commit upstream/main >/dev/null 2>&1
saida="$(git commit -q -m "traz a main do produto" 2>&1)"; code=$?
assert_exit "$code" 0 "o merge da main do produto passa, mesmo com 0412 noutra branch do principal"
assert_not_contains "$saida" "BLOQUEADO" "e não manda renumerar migration que já está na main"
# A guarda real segue inteira: um 0412 NOVO desta branch ainda colide.
printf 'select 11;\n' > supabase/migrations/20260909140000_0412_minha.sql
printf -- '-- w\n' >> supabase/baseline.sql; printf '| w | `0412_minha` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "0412 meu" 2>&1)"; code=$?
assert_exit "$code" 1 "um 0412 NOVO desta branch continua bloqueado"
assert_contains "$saida" "upstream/main" "e o dono nomeado é a main do produto"
git reset -q --hard HEAD 2>/dev/null

# ── 2-quinquies. O que a PRÓPRIA branch já commitou está na população ────────
# `pop_refs_de_outrem` tira da conta a ref cujo SHA é o do HEAD (a #1155: não
# acusar o autor de colidir consigo), e o hook não devolvia o HEAD — então a
# 0201 que a branch JÁ commitou sumia da população: a segunda 0201 (e o mesmo
# carimbo) passava calada, e a dica mandava renumerar para a 0201 da branch.
echo "2-quinquies. a migration já commitada na própria branch conta"
propria="$TMP/c2-propria"; clonar "$propria" "alguem@fork.dev"
cd "$propria" || exit 1; git switch -q -c fix/duas
tripla() { # $1 = nome em supabase/migrations/
  printf 'select 1;\n' > "supabase/migrations/$1"
  printf -- '-- apêndice %s\n' "$1" >> supabase/baseline.sql
  printf '| `%s` |\n' "$1" >> supabase/migrations/MANIFEST.md
  git add -A
}
tripla 20260910000000_0201_primeira.sql
saida="$(git commit -q -m "0201 primeira" 2>&1)"; code=$?
assert_exit "$code" 0 "a primeira 0201 da branch passa (número livre)"
tripla 20260910010000_0201_segunda.sql
saida="$(git commit -q -m "0201 segunda" 2>&1)"; code=$?
assert_exit "$code" 1 "0201_primeira commitada + 0201_segunda encenada: BLOQUEIA"
assert_contains "$saida" "já existe em: HEAD(20260910000000_0201_primeira.sql)" "e o dono nomeado é a própria branch"
git reset -q --hard HEAD 2>/dev/null
tripla 20260910000000_0202_mesmo_carimbo.sql
saida="$(git commit -q -m "carimbo repetido" 2>&1)"; code=$?
assert_exit "$code" 1 "carimbo da migration já commitada, repetido: BLOQUEIA"
assert_contains "$saida" "timestamp 20260910000000 de '20260910000000_0202_mesmo_carimbo.sql' já existe em: HEAD" "e acusa o timestamp contra a própria branch"
git reset -q --hard HEAD 2>/dev/null
tripla 20260910020000_0200_da_main.sql
saida="$(git commit -q -m "0200 da main de novo" 2>&1)"; code=$?
assert_exit "$code" 1 "0200 da main encenada de novo segue bloqueada (controle positivo)"
assert_contains "$saida" "próximo livre 0202" "a dica não manda para a 0201 que a branch já usa"
git reset -q --hard HEAD 2>/dev/null
tripla 20260910030000_0202_livre.sql
saida="$(git commit -q -m "0202 livre" 2>&1)"; code=$?
assert_exit "$code" 0 "e um número de fato livre passa (o HEAD não acusa o próprio arquivo)"
cd "$merge" || exit 1

echo "3. pre-push"
saida="$(printf 'refs/heads/fix/algo %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD)" | bash .agents/skills/deskcomm-contribuir/scripts/hooks/pre-push origin x 2>&1)"; code=$?
assert_exit "$code" 1 "push para refs/heads/main é bloqueado"
assert_contains "$saida" "a main é produção" "a mensagem explica"
saida="$(printf 'refs/heads/fix/algo %s refs/heads/fix/algo %s\n' "$(git rev-parse HEAD)" "0000000000000000000000000000000000000000" | bash .agents/skills/deskcomm-contribuir/scripts/hooks/pre-push origin x 2>&1)"; code=$?
assert_exit "$code" 0 "push de feature branch passa"

echo "4. armar-hooks.sh"
clone="$TMP/c4"; clonar "$clone" "alguem@fork.dev"; cfg "$clone" --unset core.hooksPath
cd "$clone" || exit 1
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh 2>&1)"; code=$?
assert_exit "$code" 0 "arma sem erro"
assert_contains "$(git config --get core.hooksPath)" "deskcomm-contribuir/scripts/hooks" "core.hooksPath aponta para os hooks do contribuidor"
cfg "$clone" core.hooksPath loop/hooks
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh 2>&1)"; code=$?
assert_exit "$code" 2 "recusa sobrescrever hooks alheios (loop/hooks do mantenedor)"
assert_contains "$(git config --get core.hooksPath)" "^loop/hooks$" "core.hooksPath intacto"
cfg "$clone" core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh --desarmar 2>&1)"
assert_exit "$?" 0 "--desarmar sai com 0"
if git config --get core.hooksPath >/dev/null; then falha "--desarmar limpa core.hooksPath"; else ok "--desarmar limpa core.hooksPath"; fi

echo "5. pre-voo.sh"
clone="$TMP/c5"; clonar "$clone" "root@vps-123.hostgator.com.br"
cd "$clone" || exit 1; git switch -q -c feat/coisa
# a main anda (branch atrasada) — commit direto no principal
printf 'select 9;\n' > "$principal/outro.txt"; git -C "$principal" add -A; git -C "$principal" commit -q -m "main anda"
printf '## [9.9.9] - à mão\n' >> CHANGELOG.md
printf 'select 4;\n' > supabase/migrations/20260909110000_0202_sem_tripla.sql
git add -A; DESKCOMM_MIGRATION_EDIT=1 git commit -q -m "pr com problemas"
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh 2>&1)"; code=$?
assert_exit "$code" 0 "pre-voo sai com 0 mesmo com problemas (é medição)"
assert_contains "$saida" "commit(s) atrás de origin/main" "acusa branch atrasada"
assert_contains "$saida" "seção de versão à mão no CHANGELOG.md" "acusa CHANGELOG à mão"
assert_contains "$saida" "SEM apêndice em supabase/baseline.sql" "acusa migration sem baseline"
assert_contains "$saida" "assinados como máquina" "acusa autoria root@vps"
assert_contains "$saida" "checks obrigatórios NÃO MEDIDOS" "sem gh, declara o não medido em vez de copiar a lista"
git switch -q main 2>/dev/null
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh 2>&1)"
assert_contains "$saida" "você está na 'main'" "na main, manda abrir branch"

# ── 5-bis. A migration que a PRÓPRIA branch já commitou entra na população ────
# `pop_refs_de_outrem` tira da conta a ref cujo SHA é o do HEAD (armadilha já
# paga), e sem devolvê-lo a migration que a branch JÁ commitou sumia: o "próximo
# NNNN" apontava para o número que ela já usava. O pré-voo mede a main do PRODUTO, então
# o clone precisa de um remoto com a URL do principal — o mesmo preparo do 2-quater.
echo "5-bis. o 'próximo NNNN' do pré-voo não aponta para o número que a branch já commitou"
clone="$TMP/c5-bis"; clonar "$clone" "alguem@fork.dev"
cfg "$clone" remote.produto.url "https://github.com/melgarafael/DeskcommCRM.git"
cfg "$clone" remote.produto.fetch "+refs/heads/*:refs/remotes/produto/*"
cfg "$clone" "url.$principal.insteadOf" "https://github.com/melgarafael/DeskcommCRM.git"
git -C "$clone" fetch -q produto
git -C "$clone" switch -q -c fix/minha
printf 'select 2;\n' > "$clone/supabase/migrations/20260920120000_0201_minha.sql"
printf -- '-- apêndice 0201\n' >> "$clone/supabase/baseline.sql"
printf '| `20260920120000` | `0201_minha` |\n' >> "$clone/supabase/migrations/MANIFEST.md"
git -C "$clone" add -A; git -C "$clone" commit -q -m "migration 0201 da própria branch"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh 2>&1)"; code=$?
assert_exit "$code" 0 "o pré-voo mede e sai com 0"
assert_contains "$saida" "próximo NNNN medido em produto/main ∪ outras refs do clone: 0202 (teto 0201)" "o próximo livre passa por cima do 0201 que a branch commitou"
assert_not_contains "$saida" "próximo NNNN medido em produto/main ∪ outras refs do clone: 0201 (teto 0200)" "e não devolve o número que a própria branch usa"

# ── 5-ter. As duas migrations de mesmo NNNN do PR se acusam ──────────────────
# No `complemento.sh` a conta é a mesma: sem a cabeça do PR, a população só tinha
# a base, e nenhum dos dois arquivos do PR acusava o outro. Aqui quem tria está
# com o checkout NO PR (a cabeça é o HEAD); o modo do §4 é o 5-quater.
echo "5-ter. o complemento.sh acusa as duas migrations de mesmo NNNN dentro do próprio PR"
clone="$TMP/c5-ter"; clonar "$clone" "alguem@fork.dev"
cfg "$clone" remote.produto.url "https://github.com/melgarafael/DeskcommCRM.git"
cfg "$clone" remote.produto.fetch "+refs/heads/*:refs/remotes/produto/*"
cfg "$clone" "url.$principal.insteadOf" "https://github.com/melgarafael/DeskcommCRM.git"
git -C "$clone" fetch -q produto
git -C "$clone" switch -q -c tri/1780
printf 'select 3;\n' > "$clone/supabase/migrations/20260928000000_0201_a.sql"
printf 'select 4;\n' > "$clone/supabase/migrations/20260928010000_0201_b.sql"
printf -- '-- apêndice 0201\n' >> "$clone/supabase/baseline.sql"
printf '| `a` |\n| `b` |\n' >> "$clone/supabase/migrations/MANIFEST.md"
git -C "$clone" add -A; git -C "$clone" commit -q -m "PR com duas 0201"
mkdir -p "$clone/triagem/scripts"
cp "$RAIZ/triagem/scripts/complemento.sh" "$clone/triagem/scripts/"
# O `gh` é dublado por FUNÇÃO exportada, e não por um diretório no PATH: assim o
# dublê não depende de como o PATH chega ao `bash` filho (num "$TMP" com ':' — o
# do Windows — um diretório no PATH se parte em dois e o dublê não é achado).
gh() {
  # a cabeça do PR É o HEAD deste clone (checkout do PR).
  local base; base="$(git merge-base origin/main HEAD)"
  case "$1 $2" in
    'pr diff') git diff "$base"...HEAD ;;
    'pr view')
      for a in "$@"; do
        case "$a" in
          files) git diff --name-only "$base"...HEAD ;;
          headRefOid) git rev-parse HEAD ;;
        esac
      done ;;
  esac
}
export -f gh
saida="$(cd "$clone" && bash triagem/scripts/complemento.sh 1780 2>&1)"; code=$?
unset -f gh
assert_exit "$code" 0 "o complemento roda"
cabeca="$(git -C "$clone" rev-parse HEAD)"
assert_contains "$saida" "20260928000000_0201_a.sql colide_em=$cabeca" "a primeira 0201 acusa a irmã do próprio PR"
assert_contains "$saida" "20260928010000_0201_b.sql colide_em=$cabeca" "e a segunda acusa a primeira"

# ── 5-quater. Sem checkout do PR, a cabeça vem do gh, não do HEAD ─────────────
# O TRIAGEM.md, §4, roda o complemento do clone de QUEM TRIA, depois de
# `git fetch origin pull/<n>/head`: o HEAD é a main, e a cabeça do PR só existe
# numa ref que `pop_refs_de_outrem` descarta (`refs/remotes/pr/N`). Contar o HEAD
# ali media a main contra ela mesma, e a duplicata interna passava calada.
echo "5-quater. o complemento acusa a duplicata interna com o HEAD na main de quem tria"
# $1 = número do PR, $2... = arquivos de migration da cabeça dele
pr_sem_checkout() {
  local n="$1"; shift
  git -C "$clone" switch -q -c "tmp/$n" main
  local i=0 m; for m in "$@"; do
    i=$((i + 1)); printf 'select %s;\n' "$i" > "$clone/supabase/migrations/$m"
    printf -- '-- apêndice %s\n' "$m" >> "$clone/supabase/baseline.sql"
    printf '| `%s` |\n' "$m" >> "$clone/supabase/migrations/MANIFEST.md"
  done
  git -C "$clone" add -A; git -C "$clone" commit -q -m "PR $n"
  git -C "$clone" update-ref "refs/remotes/pr/$n" HEAD
  git -C "$clone" switch -q main; git -C "$clone" branch -q -D "tmp/$n"
}
clone="$TMP/c5-quater"; clonar "$clone" "alguem@fork.dev"
cfg "$clone" remote.produto.url "https://github.com/melgarafael/DeskcommCRM.git"
cfg "$clone" remote.produto.fetch "+refs/heads/*:refs/remotes/produto/*"
cfg "$clone" "url.$principal.insteadOf" "https://github.com/melgarafael/DeskcommCRM.git"
git -C "$clone" fetch -q produto
pr_sem_checkout 1781 20260928000000_0201_a.sql 20260928010000_0201_b.sql
pr_sem_checkout 1782 20260928000000_0201_so.sql
mkdir -p "$clone/triagem/scripts"
cp "$RAIZ/triagem/scripts/complemento.sh" "$clone/triagem/scripts/"
gh() {
  # a cabeça do PR é a refs/remotes/pr/N; o HEAD fica na main de quem tria.
  local n cab base; n="$3"; cab="$(git rev-parse "refs/remotes/pr/$n")"; base="$(git merge-base origin/main "$cab")"
  case "$1 $2" in
    'pr diff') git diff "$base...$cab" ;;
    'pr view')
      for a in "$@"; do
        case "$a" in
          files) git diff --name-only "$base...$cab" ;;
          headRefOid) printf '%s\n' "$cab" ;;
        esac
      done ;;
  esac
}
export -f gh
saida="$(cd "$clone" && bash triagem/scripts/complemento.sh 1781 2>&1)"; code=$?
controle="$(cd "$clone" && bash triagem/scripts/complemento.sh 1782 2>&1)"
unset -f gh
cabeca="$(git -C "$clone" rev-parse refs/remotes/pr/1781)"
assert_exit "$code" 0 "o complemento roda com o HEAD na main"
assert_contains "$(git -C "$clone" branch --show-current)" "^main$" "quem tria segue na main"
assert_contains "$saida" "20260928000000_0201_a.sql colide_em=$cabeca" "a primeira 0201 acusa a irmã pela cabeça do gh"
assert_contains "$saida" "20260928010000_0201_b.sql colide_em=$cabeca" "e a segunda acusa a primeira"
assert_contains "$controle" "20260928000000_0201_so.sql colide_em=0" "controle: a migration única não acusa a si mesma"

echo "6. sessao.sh (hook de início de sessão)"
clone="$TMP/c6"; clonar "$clone" "alguem@fork.dev"; cfg "$clone" --unset core.hooksPath
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"; code=$?
assert_exit "$code" 0 "sai com 0"
assert_contains "$saida" "clone é de um contribuidor" "contribuidor recebe o lembrete"
assert_contains "$saida" "NÃO armados" "diz que os hooks não estão armados"
cfg "$clone" core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"
assert_contains "$saida" "contribuidor armados" "com hooks armados, diz que estão"
cfg "$clone" user.email "rafael@maudibrasil.com.br"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"; code=$?
assert_exit "$code" 0 "mantenedor: sai com 0"
if [ -z "$saida" ]; then ok "mantenedor: silêncio total"; else falha "mantenedor: silêncio total" "saída: $saida"; fi

echo "7. Passo 0 do SKILL.md (o bloco que o guia manda colar)"
# O bloco é LIDO do guia, não copiado para cá: o que está sob prova é o que a pessoa cola. Ele
# já foi um laço que, sem o script ao alcance, não imprimia nada — e o gate do guia ("se a
# resposta começar com...") ficava sem resposta para ler.
bloco="$TMP/passo0.sh"
awk '/^## Passo 0/ { p = 1 } p && /^```bash$/ { dentro = 1; next } dentro && /^```$/ { exit } dentro { print }' "$SKILL/SKILL.md" > "$bloco"
if grep -q 'quem-sou.sh' "$bloco"; then ok "o bloco foi extraído do SKILL.md (guarda de vacuidade)"; else falha "o bloco foi extraído do SKILL.md (guarda de vacuidade)" "nada casou entre '## Passo 0' e o primeiro bloco bash"; fi
sem_guias="$TMP/home-sem-guias"; mkdir -p "$sem_guias"
com_guias="$TMP/home-com-guias"; mkdir -p "$com_guias/.claude/skills"; cp -R "$SKILL" "$com_guias/.claude/skills/"
clone7="$TMP/c7"; clonar "$clone7" "alguem@fork.dev"; mkdir -p "$clone7/app/api"
antigo="$TMP/c7-antigo"; git init -q "$antigo"; mkdir -p "$antigo/app"   # fork de antes do script
fora="$TMP/fora-de-clone"; mkdir -p "$fora"
passo0() {  # passo0 <shell> <home> <pasta> → $out, $err, $code
  out="$(cd "$3" && HOME="$2" "$1" "$bloco" 2>"$TMP/passo0.err")"; code=$?
  err="$(cat "$TMP/passo0.err")"
}
# zsh é o shell padrão do macOS, onde a pessoa cola; -f para não ler o .zshrc de quem roda o teste.
printf '#!/bin/sh\nexec zsh -f "$@"\n' > "$TMP/zsh-sem-rc"; chmod +x "$TMP/zsh-sem-rc"
for sh in bash zsh; do
  if ! command -v "$sh" >/dev/null 2>&1; then echo "  ($sh ausente nesta máquina: o bloco NÃO foi medido nele)"; continue; fi
  cmd="$sh"; [ "$sh" = bash ] || cmd="$TMP/zsh-sem-rc"
  passo0 "$cmd" "$sem_guias" "$clone7"
  assert_contains "$out" "^contribuidor — e-mail do git: alguem@fork.dev" "($sh) raiz do clone, sem instalação global: responde pelo script do clone"
  passo0 "$cmd" "$sem_guias" "$clone7/app/api"
  assert_contains "$out" "^contribuidor — e-mail do git: alguem@fork.dev" "($sh) subpasta do clone, sem instalação global: responde igual à raiz"
  cfg "$clone7" user.email "rafael@maudibrasil.com.br"
  passo0 "$cmd" "$sem_guias" "$clone7/app/api"
  assert_contains "$out" "^mantenedor" "($sh) subpasta do clone do mantenedor: responde mantenedor (o guia não o trata como contribuidor)"
  cfg "$clone7" user.email "alguem@fork.dev"
  passo0 "$cmd" "$sem_guias" "$antigo/app"
  if [ "$code" != 0 ] && [ -z "$out" ]; then ok "($sh) clone sem o script, sem instalação global: sai com erro e sem resposta inventada"; else falha "($sh) clone sem o script, sem instalação global: sai com erro e sem resposta inventada" "code=$code out=$out"; fi
  assert_contains "$err" "^NÃO MEDIDO — não achei o quem-sou.sh no clone .*c7-antigo" "($sh) e o erro diz o que não achou e onde procurou"
  assert_contains "$err" "comando de uma linha do README (https://github.com/melgarafael/DeskcommCRM#readme) e rode de novo" "($sh) e diz como sair dali"
  passo0 "$cmd" "$sem_guias" "$fora"
  if [ "$code" != 0 ] && [ -z "$out" ]; then ok "($sh) fora de clone, sem instalação global: sai com erro e sem resposta inventada"; else falha "($sh) fora de clone, sem instalação global: sai com erro e sem resposta inventada" "code=$code out=$out"; fi
  assert_contains "$err" "^NÃO MEDIDO — não achei o quem-sou.sh nem nas pastas globais" "($sh) e o erro não finge que havia clone"
  passo0 "$cmd" "$com_guias" "$fora"
  if [ "$code" = 0 ] && [ "$out" = "contribuidor — fora de um clone git" ]; then ok "($sh) fora de clone, com instalação global: a resposta que o guia promete"; else falha "($sh) fora de clone, com instalação global: a resposta que o guia promete" "code=$code out=$out err=$err"; fi
  passo0 "$cmd" "$com_guias" "$antigo/app"
  assert_contains "$out" "^contribuidor — e-mail do git: " "($sh) clone sem o script, com instalação global: mede o clone pelo script global"
done

echo
if [ "$falhas" = 0 ]; then echo "deskcomm-contribuir: $casos casos, todos verdes"; exit 0
else echo "deskcomm-contribuir: $falhas de $casos casos vermelhos"; exit 1; fi
