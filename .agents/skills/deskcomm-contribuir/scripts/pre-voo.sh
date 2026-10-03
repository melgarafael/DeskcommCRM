#!/usr/bin/env bash
# pre-voo.sh — mede, ANTES do PR, o que a triagem do mantenedor mede DEPOIS.
#
# Só lê. Nunca edita, nunca bloqueia: imprime uma linha por item, com a medida
# e o comando que a produziu, para a pessoa (ou o assistente) decidir. Sai com
# 0 mesmo cheio de ✗ — o veredito é de quem lê, e um script que "reprova" o
# próprio autor vira script que ninguém roda.
#
#   ✓ medido e limpo   ⚠ olhe isto   ✗ vai travar na triagem   · não se aplica
#
# Uso: bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh
set -uo pipefail

raiz="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "✗ fora de um clone git"; exit 0; }
cd "$raiz"

# A POPULAÇÃO da unicidade de NNNN é a mesma dos hooks (#1273) e vive num lugar
# só, `scripts/migration-populacao.sh`. Sem a biblioteca (clone antigo, ou a
# cópia da skill de uma versão anterior), o pré-voo segue medindo o que media —
# e a linha de migration DIZ que não achou a população nova.
BIBLIOTECA="$raiz/scripts/migration-populacao.sh"
[ -r "$BIBLIOTECA" ] && { . "$BIBLIOTECA" || true; }

ok()   { printf '✓ %s\n' "$*"; }
olhe() { printf '⚠ %s\n' "$*"; }
trava(){ printf '✗ %s\n' "$*"; }
nao()  { printf '· %s\n' "$*"; }

echo "── pré-voo do contribuidor · $(date -u +%Y-%m-%dT%H:%MZ) ──"

# ── 0. Âncora ────────────────────────────────────────────────────────────────
if git fetch origin -q 2>/dev/null; then :; else olhe "sem rede: origin/main pode estar velha (git fetch origin)"; fi
if ! git rev-parse -q --verify origin/main >/dev/null 2>&1; then
  trava "origin/main não existe neste clone — adicione o remoto do repositório principal: git remote add upstream https://github.com/melgarafael/DeskcommCRM.git && git fetch upstream && git branch --track main-upstream upstream/main"
  exit 0
fi
MAIN="$(git rev-parse --short origin/main)"
B="$(git merge-base origin/main HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
ok "âncora: origin/main=$MAIN · branch=$branch (git rev-parse --short origin/main)"

case "$branch" in
  main|master) trava "você está na '$branch' — abra uma branch nomeada a partir de origin/main: git switch -c fix/o-que-conserta origin/main" ;;
esac

# ── 1. Atraso e sobreposição ─────────────────────────────────────────────────
atraso="$(git rev-list --count "$B..origin/main")"
proprios="$(git rev-list --count "$B..HEAD")"
if [ "$atraso" -gt 0 ]; then
  cmd="git merge origin/main"; [ "$proprios" = 0 ] && cmd="git merge --ff-only origin/main"
  olhe "branch $atraso commit(s) atrás de origin/main ($proprios próprios) — traga a main para dentro: $cmd (nunca reset --hard)"
else
  ok "branch em dia com origin/main ($proprios commit(s) próprios)"
fi
sobre="$(comm -12 <(git diff --name-only "$B" origin/main | sort) <(git diff --name-only "$B" HEAD | sort))"
if [ -n "$sobre" ]; then
  olhe "arquivos que a main TAMBÉM mudou desde a base (conflito nasce aqui): $(echo "$sobre" | tr '\n' ' ')"
else
  ok "nenhum arquivo em sobreposição com a main (comm -12 dos dois diffs contra o merge-base)"
fi

sujo="$(git status --porcelain | wc -l | tr -d ' ')"
[ "$sujo" = 0 ] && ok "árvore limpa" || olhe "$sujo arquivo(s) não commitados (git status --porcelain) — o que não está no commit não vai no PR"

[ "$proprios" = 0 ] && { nao "sem commits próprios ainda — o resto do pré-voo mede o diff, que está vazio"; exit 0; }

# ── 2. Higiene do diff ───────────────────────────────────────────────────────
diff_nomes="$(git diff --name-only "$B" HEAD)"

fora="$(git diff --diff-filter=A --name-only "$B" HEAD | grep -vE '^(app|components|lib|hooks|workers|tests|docs|supabase|scripts|evidence|public|types|hostgator-setup-kit|\.changes|\.github|\.agents|\.claude|\.cursor|\.opencode|loop|triagem)/' | grep -vE '^(package\.json|pnpm-lock\.yaml|proxy\.ts|next\.config\.(ts|mjs)|README(\.[a-z]+)?\.md|CHANGELOG\.md|CLAUDE\.md|AGENTS\.md|CONTRIBUTING\.md|\.gitignore|\.dockerignore|\.gitattributes|docker-compose[^ ]*\.yml|Dockerfile[^ ]*|Caddyfile)$' || true)"
[ -z "$fora" ] && ok "nenhum arquivo NOVO fora das pastas do produto" || olhe "arquivo(s) novo(s) fora das pastas do produto — é do produto ou da SUA instalação? $(echo "$fora" | tr '\n' ' ')"

segredos="$(git diff "$B" HEAD | grep -nE '^\+.*(postgres(ql)?://[^[:space:]]*:[^[:space:]@]+@|sk-ant-[A-Za-z0-9]|sk-or-[A-Za-z0-9]|sbp_[A-Za-z0-9]|eyJhbGciOi|PRIVATE KEY|\$2[ab]\$[0-9]{2}\$)' | head -3 || true)"
[ -z "$segredos" ] && ok "nenhum segredo reconhecível no diff (connection string, chave de IA, token, JWT, hash de senha)" || trava "parece haver SEGREDO no diff — remova e rotacione a chave: $(echo "$segredos" | cut -c1-120 | tr '\n' ' ')"

marca="$(git diff "$B" HEAD | grep -nE '^\+.*(DEFAULT_APP_NAME|APP_NAME=|APP_ACCENT_HEX=|NEXT_PUBLIC_APP_URL=)' | head -3 || true)"
envs="$(echo "$diff_nomes" | grep -E '(^|/)\.env(\.|$)' | grep -v '\.example$' || true)"
if [ -n "$marca" ] || [ -n "$envs" ]; then
  olhe "marca/config de instalação no diff (a marca vive no banco e na tela Configurações › Marca, não no código): ${envs:+$envs }$(echo "$marca" | cut -c1-100 | tr '\n' ' ')"
else
  ok "sem marca nem .env de instalação no diff"
fi

logs="$(git diff "$B" HEAD -- '*.ts' '*.tsx' | grep -nE '^\+[^+].*console\.log\(' | grep -vE '^\+.*(//|\*)' | head -3 || true)"
[ -z "$logs" ] && ok "nenhum console.log novo (o lint só AVISA; a triagem reprova)" || olhe "console.log novo em .ts/.tsx — use lib/logger.ts: $(echo "$logs" | cut -c1-100 | tr '\n' ' ')"

# ── 3. Migration: a tripla e a unicidade ─────────────────────────────────────
migs="$(git diff --diff-filter=A --name-only "$B" HEAD | grep -E '^supabase/migrations/.*\.sql$' || true)"
if [ -z "$migs" ]; then
  nao "nenhuma migration nova"
else
  tem_base="$(echo "$diff_nomes" | grep -cx 'supabase/baseline.sql' || true)"
  tem_mani="$(echo "$diff_nomes" | grep -cx 'supabase/migrations/MANIFEST.md' || true)"
  [ "$tem_base" = 1 ] && ok "migration nova COM apêndice no baseline.sql" || trava "migration nova SEM apêndice em supabase/baseline.sql — o kit self-host aplica só o baseline; sem ele a mudança não chega em quem instalou"
  sem_desc=""
  for m in $migs; do
    git show "HEAD:$m" 2>/dev/null | grep -E '^-- manifest:[[:space:]]*[^[:space:]]' >/dev/null || sem_desc="$sem_desc $m"
  done
  if [ -z "$sem_desc" ]; then ok "migration nova COM descrição (\`-- manifest:\` no .sql)"
  elif [ "$tem_mani" = 1 ]; then ok "migration nova COM linha no MANIFEST.md (jeito antigo; prefira \`-- manifest:\` no .sql)"
  else trava "migration nova SEM descrição:$sem_desc — ponha uma linha \`-- manifest: <o quê e por quê>\` no cabeçalho do .sql (não no MANIFEST.md)"
  fi
  # A POPULAÇÃO da unicidade: a main do PRODUTO (o remoto que aponta para
  # melgarafael/DeskcommCRM, com qualquer nome) mais `refs/heads` E
  # `refs/remotes` (#1273). O `origin/main` de antes, num clone de fork, é a main
  # DO FORK — que pode estar atrás da do principal, e aí o pré-voo dizia "NNNN
  # livre" com exit 0 sobre um número que o principal já tinha (caso medido:
  # fork parado em 0323, principal em 0324).
  pop_base=""
  if declare -F pop_main_do_produto >/dev/null 2>&1; then
    pop_base="$(pop_main_do_produto || true)"
    if [ -n "$pop_base" ] && ! git rev-parse -q --verify "${pop_base}^{commit}" >/dev/null 2>&1; then
      pop_base=""
    fi
  fi
  # pop_sem_produto=1: há remoto de GitHub (um fork) e nenhum é o principal. Aí
  # nenhum "livre" sai com ✓: o fork pode estar atrás do principal, e o ✓ sobre
  # ele é o "livre" falso da #1273. (Fixture sem remoto de GitHub só tem o que
  # tem; biblioteca ausente já sai declarada acima.)
  pop_sem_produto=0
  if [ -z "$pop_base" ]; then
    if declare -F pop_tem_remoto_de_github >/dev/null 2>&1 && pop_tem_remoto_de_github; then
      pop_sem_produto=1
    fi
    pop_base="origin/main"
    git rev-parse -q --verify "${pop_base}^{commit}" >/dev/null 2>&1 || pop_base=""
  fi
  pop_refs=""
  if declare -F pop_refs_de_outrem >/dev/null 2>&1; then
    pop_refs="$(pop_refs_de_outrem "$pop_base" 2>/dev/null || true)"
  else
    pop_refs="origin/main $(git for-each-ref --format='%(refname)' refs/heads refs/remotes 2>/dev/null || true)"
    olhe "NÃO MEDIDO no formato novo: scripts/migration-populacao.sh AUSENTE — a unicidade abaixo sai sobre origin/main + refs/heads + refs/remotes (#1273)"
  fi
  [ -n "${pop_refs// /}" ] || pop_refs="HEAD"
  pop_migs=""
  if declare -F pop_migrations >/dev/null 2>&1; then
    # O HEAD entra SEMPRE: `pop_refs_de_outrem` tira a ref cujo SHA é o do HEAD,
    # e sem devolvê-lo aqui a migration que a PRÓPRIA branch já commitou sumia da
    # conta — o próximo NNNN apontava para o número que a branch já usava. O
    # próprio arquivo não é acusado: o `grep -vE` abaixo o tira.
    pop_migs="$(pop_migrations $pop_refs HEAD 2>/dev/null || true)"
  else
    # Sem a biblioteca, a lista é a de sempre: "<ref> <nome>", montada na mão,
    # para o `grep` de baixo achar a mesma coisa que achava antes.
    for ref in $pop_refs HEAD; do
      [ -n "$ref" ] || continue
      arquivos="$(git ls-tree -r --name-only "$ref" -- supabase/migrations 2>/dev/null \
        | sed 's#^supabase/migrations/##' || true)"
      [ -n "$arquivos" ] && pop_migs="${pop_migs}$(awk -v r="$ref" '{ print r, $0 }' <<<"$arquivos")"$'\n'
    done
  fi
  if [ "$pop_sem_produto" = 1 ]; then
    olhe "NÃO MEDIDO contra a main do PRODUTO: nenhum remoto aponta para melgarafael/DeskcommCRM — a unicidade abaixo sai sobre '${pop_base:-nenhuma base}' e a cópia local. Corrija com: git remote add upstream https://github.com/melgarafael/DeskcommCRM.git && git fetch upstream"
  fi
  # "livre" sobre a base errada não é ✓: é ⚠ com o nome da régua.
  livre() { if [ "$pop_sem_produto" = 1 ]; then olhe "$* (NÃO MEDIDO contra a main do produto)"; else ok "$*"; fi; }
  for m in $migs; do
    nome="$(basename "$m")"
    nnnn="$(sed -nE 's/^[0-9]{14}_([0-9]{4})_.+\.sql$/\1/p' <<<"$nome")"
    ts="$(sed -nE 's/^([0-9]{14})_[0-9]{4}_.+\.sql$/\1/p' <<<"$nome")"
    if [ -z "$nnnn" ]; then trava "'$nome' não segue <timestamp14>_<NNNN>_<slug>.sql"; continue; fi
    # A âncora é a POSIÇÃO do nome canônico (`^[0-9]{14}_NNNN_`), e o `grep` roda
    # sobre a LINHA INTEIRA ("<ref> <nome>") para o dono poder ser nomeado. O
    # `^[0-9]{14}_${nnnn}_` sem o campo da ref casaria a linha errada em silêncio.
    cn="$(grep -E "^[A-Za-z0-9_./-]+ [0-9]{14}_${nnnn}_.+\.sql$" <<<"$pop_migs" | grep -vE " ${nome}\$" || true)"
    ct="$(grep -E "^[A-Za-z0-9_./-]+ ${ts}_[0-9]{4}_.+\.sql$" <<<"$pop_migs" | grep -vE " ${nome}\$" || true)"
    dono="$(awk '{printf "%s(%s) ", $1, $2}' <<<"$cn" | sed 's/ $//')"
    # "livre" sem dizer sobre QUAL população é a afirmação sem régua que a
    # #1155 registrou — e o número que se renumera errado sai daqui.
    pop_desc="$pop_base ∪ outras refs do clone"
    [ -z "$cn" ] && livre "NNNN $nnnn livre em $pop_desc" \
      || trava "NNNN $nnnn já existe em $pop_desc: $dono — renumere E troque o timestamp (date -u +%Y%m%d%H%M%S)"
    [ -z "$ct" ] && livre "timestamp $ts livre em $pop_desc" \
      || trava "timestamp $ts já existe em $pop_desc: $(awk '{printf "%s(%s) ", $1, $2}' <<<"$ct" | sed 's/ $//')"
    if grep -qiE 'create table' "$m" && ! grep -qiE 'enable row level security' "$m"; then
      olhe "'$nome' cria tabela sem 'enable row level security' — tabela tenant-aware exige RLS + policy tenant_isolation_<tabela>_all + entrada em tests/invariants/rls-isolation.test.ts"
    fi
    if grep -qiE 'create (or replace )?function' "$m" && ! grep -qiE 'revoke execute' "$m"; then
      olhe "'$nome' cria função sem 'revoke execute … from public, anon' — função nova em public nasce exposta como RPC"
    fi
  done
  # O resto da população — os PRs ABERTOS, inclusive de fork — NÃO é medido aqui:
  # o pré-voo não vai à rede. Declarar é o contrato; com o `gh` logado, o mesmo
  # `gh pr list` do #1269 fecha a conta (issue #1273).
  pop_teto="$(cut -d' ' -f2- <<<"$pop_migs" | sed -nE 's/^[0-9]{14}_([0-9]{4})_.*$/\1/p' | sort -n | tail -1)"
  if [ -n "$pop_teto" ]; then
    pop_prox="$(printf '%04d' $((10#$pop_teto + 1)))"
    livre "próximo NNNN medido em $pop_desc: ${pop_prox} (teto ${pop_teto})"
  else
    nao "nenhum NNNN entrou na população medida (base '${pop_base:-nenhuma}'; PRs abertos fora daqui — use pnpm checar:colisao-de-migration)"
  fi
  # A fila de PRs abertos é do repositório do PRODUTO, com qualquer nome de
  # remoto — é o mesmo cuidado do #1269: listar o fork devolve zero, e esse zero
  # sairia como medição.
  pop_repo="$(pop_repo_do_produto 2>/dev/null || true)"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if [ -n "$pop_repo" ]; then
      pop_abertos="$(gh pr list --repo "$pop_repo" --state open --limit 1000 \
        --json number --jq '.[].number' 2>/dev/null | grep -c . || true)"
      ok "PRs abertos em $pop_repo: ${pop_abertos:-0} visível(is) — a prévia do número é 'pnpm checar:colisao-de-migration' (mede também as cabeças, inclusive de fork)"
    else
      olhe "PRs ABERTOS NÃO MEDIDOS: este clone não tem remoto do repositório principal. Quem mede: pnpm checar:colisao-de-migration"
    fi
  else
    olhe "PRs ABERTOS (inclusive de fork) NÃO MEDIDOS: o gh não está logado aqui. Quem mede é o script: pnpm checar:colisao-de-migration"
  fi
fi

# ── 4. Release: fragmento sim, CHANGELOG à mão não ──────────────────────────
secao="$(git diff "$B" HEAD -- CHANGELOG.md | grep -E '^\+## \[' || true)"
[ -z "$secao" ] && ok "CHANGELOG.md sem seção de versão escrita à mão" || trava "seção de versão à mão no CHANGELOG.md ($secao) — o corte é automático; remova e escreva um fragmento em .changes/"
frag="$(git diff --diff-filter=A --name-only "$B" HEAD | grep -E '^\.changes/.*\.md$' || true)"
toca_produto="$(echo "$diff_nomes" | grep -cE '^(app|lib|components|workers|hooks|supabase|hostgator-setup-kit)/|^(docker-compose|Dockerfile)' || true)"
if [ -n "$frag" ]; then
  ok "fragmento de release presente: $(echo "$frag" | tr '\n' ' ') (valide: pnpm release:conferir)"
elif [ "$toca_produto" -gt 0 ]; then
  olhe "diff toca o produto e não há fragmento em .changes/ — se o operador da VPS percebe a mudança, escreva um (impacto: nada_mudou | capacidade_nova | exige_acao)"
else
  nao "sem fragmento, e o diff não toca o produto"
fi

# ── 5. Env var nova ──────────────────────────────────────────────────────────
env_novas="$(git diff "$B" HEAD -- lib/env.ts | grep -oE '^\+\s+([A-Z][A-Z0-9_]+):' | sed -E 's/^\+\s+//; s/:$//' || true)"
if [ -n "$env_novas" ]; then
  for v in $env_novas; do
    grep -q "^$v=" .env.example 2>/dev/null && ok "env $v está no .env.example" || trava "env $v nova em lib/env.ts e ausente do .env.example (DoD 9) — e precisa de default que não quebre instalação existente"
  done
fi

# ── 6. Documento de autoridade tocado ────────────────────────────────────────
autoridade="$(echo "$diff_nomes" | grep -E '^(CLAUDE|AGENTS|CONTRIBUTING|ARCHITECTURE|README|SECURITY)\.md$|^docs/(doctrine|runbooks|adr|index\.md|current-state|harness-audit|threat-model|DEPLOY-CHECKLIST|SETUP)|^triagem/|^\.agents/skills/' || true)"
[ -z "$autoridade" ] && nao "nenhum documento de autoridade tocado" || olhe "documento(s) de autoridade tocado(s): releia as afirmações de estado do trecho ('é obrigatório', 'ainda não', 'N de M') e troque número por comando — $(echo "$autoridade" | tr '\n' ' ')"

# ── 7. Teste que falta ───────────────────────────────────────────────────────
codigo="$(echo "$diff_nomes" | grep -E '^(app|lib|components|workers|hooks)/.*\.(ts|tsx)$' | grep -vE '\.(test|spec)\.tsx?$' || true)"
testes="$(echo "$diff_nomes" | grep -E '\.(test|spec)\.tsx?$' || true)"
if [ -n "$codigo" ] && [ -z "$testes" ]; then
  olhe "código mudou e nenhum teste entrou no diff — mudou comportamento? então existe um teste que fica vermelho sem a sua mudança (passe 6 da triagem)"
elif [ -n "$testes" ]; then
  ok "teste(s) no diff: $(echo "$testes" | wc -l | tr -d ' ') — sabote o conserto e confira que ficam vermelhos"
fi
specs="$(git diff --diff-filter=A --name-only "$B" HEAD | grep -E '^tests/e2e/.*\.spec\.ts$' || true)"
for s in $specs; do
  nome="$(basename "$s")"
  grep -q "$nome" .github/workflows/e2e.yml && ok "spec $nome está no e2e.yml" || trava "spec nova $nome fora do .github/workflows/e2e.yml — entre em SPECS_PARTE_N ou FORA_DO_CI com motivo (tests/unit/e2e-cobertura-completa.test.ts reprova)"
done

# ── 8. Identidade dos commits ────────────────────────────────────────────────
autores="$(git log --format='%an <%ae>' "$B..HEAD" | sort -u)"
if echo "$autores" | grep -qiE '<root@|<[^@]*@(localhost|vps|srv)|<>$|@[^>]*\.local>'; then
  olhe "commit(s) assinados como máquina, não pessoa — o trabalho não aparece no seu perfil: $(echo "$autores" | tr '\n' ' ') → git config --global user.email <e-mail da sua conta> e refaça a autoria dos seus commits"
else
  ok "autoria dos commits: $(echo "$autores" | tr '\n' ' ')"
fi

# ── 9. A régua real, se o gh estiver logado ──────────────────────────────────
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  checks="$(gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")' 2>/dev/null || true)"
  [ -n "$checks" ] && ok "checks obrigatórios na main hoje: $checks" || nao "não consegui ler a branch protection (sem permissão?) — a lista em CLAUDE.md pode estar velha"
else
  nao "gh não logado: checks obrigatórios NÃO MEDIDOS (a lista em CLAUDE.md/CONTRIBUTING.md pode estar velha)"
fi

echo "── fim · o que não aparece aqui não foi medido ──"
exit 0
