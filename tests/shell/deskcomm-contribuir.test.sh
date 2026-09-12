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
#   3. pre-push BLOQUEIA refs/heads/main e deixa passar uma feature branch.
#   4. armar-hooks.sh grava core.hooksPath, recusa sobrescrever hooks alheios,
#      e --desarmar limpa.
#   5. pre-voo.sh acusa CHANGELOG à mão, migration sem tripla e branch atrasada,
#      e sai com 0 (é medição, não veredito).
set -uo pipefail

SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.agents/skills/deskcomm-contribuir" && pwd)"
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

# ── um "repositório principal" mínimo, com uma migration já aplicada ─────────
principal="$TMP/principal"; mkdir -p "$principal"
git -C "$principal" init -q -b main
git -C "$principal" config user.email "mantenedor@exemplo.com"; git -C "$principal" config user.name "Mantenedor"
mkdir -p "$principal/supabase/migrations" "$principal/.agents/skills/deskcomm-contribuir/scripts/hooks"
cp -R "$SCRIPTS"/. "$principal/.agents/skills/deskcomm-contribuir/scripts/"
printf 'select 1;\n' > "$principal/supabase/migrations/20260101120000_0200_existente.sql"
printf -- '-- baseline\n' > "$principal/supabase/baseline.sql"
printf '| `20260101120000` | `0200_existente` |\n' > "$principal/supabase/migrations/MANIFEST.md"
printf '# Changelog\n' > "$principal/CHANGELOG.md"
printf 'Rafael Melgaço <rafael@maudibrasil.com.br> <119944436+melgarafael@users.noreply.github.com>\n' > "$principal/.mailmap"
printf 'X=1\n' > "$principal/.env.example"
git -C "$principal" add -A && git -C "$principal" commit -q -m "base"

clonar() { # $1 = destino, $2 = e-mail do contribuidor
  rm -rf "$1"; git clone -q "$principal" "$1"
  git -C "$1" config user.email "$2"; git -C "$1" config user.name "Pessoa"
  git -C "$1" config core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
  chmod +x "$1"/.agents/skills/deskcomm-contribuir/scripts/*.sh "$1"/.agents/skills/deskcomm-contribuir/scripts/hooks/*
}

echo "1. quem-sou.sh"
clone="$TMP/c1"; clonar "$clone" "alguem@fork.dev"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh)"
assert_contains "$saida" "^contribuidor" "e-mail desconhecido → contribuidor"
assert_contains "$saida" "alguem@fork.dev" "a saída explica o motivo (o e-mail)"
git -C "$clone" config user.email "rafael@maudibrasil.com.br"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh --curto)"
assert_contains "$saida" "^mantenedor$" "e-mail do .mailmap → mantenedor (--curto)"
git -C "$clone" config user.email "119944436+melgarafael@users.noreply.github.com"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/quem-sou.sh)"
assert_contains "$saida" "^mantenedor" "segundo e-mail do .mailmap → mantenedor"

echo "2. check-migration-triple.sh (pre-commit)"
clone="$TMP/c2"; clonar "$clone" "alguem@fork.dev"
cd "$clone" && git switch -q -c fix/algo
printf 'select 2;\n' > supabase/migrations/20260909100000_0201_nova.sql
git add supabase/migrations/20260909100000_0201_nova.sql
saida="$(git commit -q -m "migration sem tripla" 2>&1)"; code=$?
assert_exit "$code" 1 "migration sem baseline/MANIFEST é bloqueada"
assert_contains "$saida" "sem apêndice em supabase/baseline.sql" "a mensagem nomeia o baseline"
assert_contains "$saida" "sem linha em supabase/migrations/MANIFEST.md" "a mensagem nomeia o MANIFEST (acumula, não para no primeiro)"
printf -- '-- apêndice 0201\n' >> supabase/baseline.sql
printf '| `20260909100000` | `0201_nova` |\n' >> supabase/migrations/MANIFEST.md
git add -A
saida="$(git commit -q -m "migration com tripla" 2>&1)"; code=$?
assert_exit "$code" 0 "tripla completa com número livre passa"
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

echo "3. pre-push"
saida="$(printf 'refs/heads/fix/algo %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD)" | bash .agents/skills/deskcomm-contribuir/scripts/hooks/pre-push origin x 2>&1)"; code=$?
assert_exit "$code" 1 "push para refs/heads/main é bloqueado"
assert_contains "$saida" "a main é produção" "a mensagem explica"
saida="$(printf 'refs/heads/fix/algo %s refs/heads/fix/algo %s\n' "$(git rev-parse HEAD)" "0000000000000000000000000000000000000000" | bash .agents/skills/deskcomm-contribuir/scripts/hooks/pre-push origin x 2>&1)"; code=$?
assert_exit "$code" 0 "push de feature branch passa"

echo "4. armar-hooks.sh"
clone="$TMP/c4"; clonar "$clone" "alguem@fork.dev"; git -C "$clone" config --unset core.hooksPath
cd "$clone"
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh 2>&1)"; code=$?
assert_exit "$code" 0 "arma sem erro"
assert_contains "$(git config --get core.hooksPath)" "deskcomm-contribuir/scripts/hooks" "core.hooksPath aponta para os hooks do contribuidor"
git config core.hooksPath loop/hooks
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh 2>&1)"; code=$?
assert_exit "$code" 2 "recusa sobrescrever hooks alheios (loop/hooks do mantenedor)"
assert_contains "$(git config --get core.hooksPath)" "^loop/hooks$" "core.hooksPath intacto"
git config core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
saida="$(bash .agents/skills/deskcomm-contribuir/scripts/armar-hooks.sh --desarmar 2>&1)"
assert_exit "$?" 0 "--desarmar sai com 0"
if git config --get core.hooksPath >/dev/null; then falha "--desarmar limpa core.hooksPath"; else ok "--desarmar limpa core.hooksPath"; fi

echo "5. pre-voo.sh"
clone="$TMP/c5"; clonar "$clone" "root@vps-123.hostgator.com.br"
cd "$clone" && git switch -q -c feat/coisa
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

echo "6. sessao.sh (hook de início de sessão)"
clone="$TMP/c6"; clonar "$clone" "alguem@fork.dev"; git -C "$clone" config --unset core.hooksPath
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"; code=$?
assert_exit "$code" 0 "sai com 0"
assert_contains "$saida" "clone é de um contribuidor" "contribuidor recebe o lembrete"
assert_contains "$saida" "NÃO armados" "diz que os hooks não estão armados"
git -C "$clone" config core.hooksPath ".agents/skills/deskcomm-contribuir/scripts/hooks"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"
assert_contains "$saida" "contribuidor armados" "com hooks armados, diz que estão"
git -C "$clone" config user.email "rafael@maudibrasil.com.br"
saida="$(cd "$clone" && bash .agents/skills/deskcomm-contribuir/scripts/hooks/sessao.sh)"; code=$?
assert_exit "$code" 0 "mantenedor: sai com 0"
if [ -z "$saida" ]; then ok "mantenedor: silêncio total"; else falha "mantenedor: silêncio total" "saída: $saida"; fi

echo
if [ "$falhas" = 0 ]; then echo "deskcomm-contribuir: $casos casos, todos verdes"; exit 0
else echo "deskcomm-contribuir: $falhas de $casos casos vermelhos"; exit 1; fi
