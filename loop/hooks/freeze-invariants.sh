#!/usr/bin/env bash
# freeze-invariants.sh — tests/invariants/** é o eval do épico (congelado).
# ADICIONAR arquivo novo é permitido (G1-03 cria a suíte; fases seguintes podem
# acrescentar invariantes). MODIFICAR ou DELETAR arquivo pré-existente é bloqueado
# sem DESKCOMM_GOV_INVARIANTS_EDIT=1.
# Exceção legítima: o flip test.fails → teste normal nas fases G2+ (o catraca da
# G1-03) — a sessão exporta a env E o commit message cita o flip.
set -euo pipefail

[ "${DESKCOMM_GOV_INVARIANTS_EDIT:-0}" = "1" ] && exit 0

# Status M/D/R (rename = delete disfarçado) em tests/invariants/ bloqueia; A passa.
#
# ⚠️ `-c core.quotepath=false` e o `"?` do regex NÃO são enfeite: eram um FURO
# ABERTO, medido em 18/09/2026 nesta versão e nas duas anteriores. Com
# `core.quotepath` no PADRÃO do git (true), um caminho com qualquer byte
# não-ASCII sai citado e com escapes em octal —
#   M	"tests/invariants/inv-acentua\303\247\303\243o.test.ts"
# — e o campo passa a COMEÇAR com `"`, então a âncora `^tests/invariants/` não
# casa e a linha nunca entra na lista. Medido pelo caminho de produção, FORA de
# merge nenhum: `git rm` desse invariante saía exit 0 e o arquivo DESAPARECIA do
# HEAD; editá-lo saía exit 0 com o enfraquecimento commitado. Silêncio total —
# a pior classe para uma guarda, e invisível justo onde o projeto é em português.
#
# `-F'\t'` põe o path INTEIRO em `$2`/`$3` (o `--name-status` separa por TAB; com
# o FS padrão um caminho com espaço era quebrado em vários campos), e o `"?`
# mantém na lista o que o git cita mesmo com `quotepath=false` (aspas, barra
# invertida ou newline no nome). Nesse resto o `rev-parse` de cada ref falha, os
# quatro OIDs vêm vazios, a condição 5 recusa a exclusão e a guarda falha
# FECHADA — que é o lado certo para um caminho que ela não sabe ler.
violations=$(git -c core.quotepath=false diff --cached --name-status \
  | awk -F'\t' '$1 ~ /^(M|D|R)/ && ($2 ~ /^"?tests\/invariants\// || $3 ~ /^"?tests\/invariants\//) { print $0 }')

# ── O que o OUTRO LADO DO MERGE mudou não é edição desta branch ────────────
#
# Um `git merge origin/main` que dá CONFLITO passa por `git commit`, e aí o
# pre-commit roda sobre o índice INTEIRO do merge — inclusive os invariantes
# que vieram da main. O guard lia isso como "o autor mexeu no eval".
#
# Medido em 18/09/2026 (caso 4/5 da issue #1161, medido por outra sessão da
# triagem): o merge de 38 commits da main numa branch de trabalho foi
# BLOQUEADO acusando `tests/invariants/rls-completude-varredura.test.ts`.
# A procedência, nos dois sentidos — o segundo é o controle que fecha:
#   git log --oneline origin/main..HEAD -- <o invariante>   → VAZIO
#   git log --oneline HEAD..origin/main -- <o invariante>   → ebeb83807
# Nenhum commit da branch tocou o arquivo; foi a main chegando.
#
# E era IMPOSSÍVEL de satisfazer: a única exceção que o guard oferece é o flip
# de test.fails, e num merge não há flip nenhum. Dentro do que ele oferecia
# sobravam descartar trabalho alheio ou não mesclar a main — as duas piores
# que abrir a válvula por rotina, que é como uma guarda deixa de proteger.
#
# ── O EIXO: PROCEDÊNCIA, não conteúdo nem existência de caminho ────────────
#
# Duas formas mais simples foram MEDIDAS e as duas furam:
#
#   (a) existência de caminho (`git cat-file -e origin/main:$p`, a forma do
#       guard de migration): o invariante existe na main tanto quando a main o
#       trouxe quanto quando a branch o reescreveu. Edição própria escondida
#       dentro do merge passa com exit 0.
#   (b) identidade de CONTEÚDO contra `origin/main` (`:$p` == `origin/main:$p`):
#       também é verdade quando a sessão REVERTE o invariante para a versão da
#       main — que é autoria, e é o exato enfraquecimento que o freeze existe
#       para impedir. Medido pelo caminho de produção (`git commit` real, pelo
#       dispatcher), no mesmo estado: hook (b) → exit 0, o invariante commitado
#       com a asserção que a branch tinha acrescentado APAGADA; hook anterior →
#       exit 1. E a rota não precisa de válvula em passo nenhum: basta mesclar
#       LIMPO a branch de um colega que fortaleceu o invariante (merge limpo não
#       chama hook) e reverter no commit seguinte. Alcançabilidade medida nos
#       últimos 300 commits sem-merge da main: 15 modificações de invariante —
#       "HEAD tem o invariante diferente do da main" é rotina.
#
# O eixo certo é o que o outro lado do merge EFETIVAMENTE MUDOU **sem que esta
# branch tenha tocado o arquivo**, e isso exige CINCO referências:
#
#   ENCENADO    o índice                          (`:<path>`)
#   NA_BRANCH   HEAD, a ponta desta branch        (`HEAD:<path>`)
#   OUTRO_LADO  MERGE_HEAD (só existe DURANTE um merge)
#   BASE        git merge-base HEAD MERGE_HEAD
#   NA_PONTA    o que a main tem AGORA             (`origin/main:<path>`)
#
# Um caminho sai da lista se, e só se, TODAS as seis condições valem:
#
#   1. MERGE_HEAD existe (há merge em curso) e tem EXATAMENTE UM lado;
#   2. `git merge-base --is-ancestor MERGE_HEAD origin/main` — o outro lado já
#      está na main: não é branch de colega nem commit fabricado. ⚠️ Isto NÃO
#      quer dizer que ele é o que a main tem HOJE — `--is-ancestor` aceita
#      QUALQUER ancestral, e quem foi absorvido e depois SUPERADO continua
#      ancestral (#1227). A ponta é medida pela 6, não por aqui;
#   3. NA_BRANCH == BASE — esta branch NUNCA tocou este invariante;
#   4. ENCENADO == OUTRO_LADO — inclusive "ausente nos dois", que é a deleção
#      que o merge trouxe; E
#   5. OUTRO_LADO != BASE, isto é, o outro lado realmente mexeu ali; E
#   6. ENCENADO == NA_PONTA — o conteúdo que entra é o que a main tem AGORA.
#      Sem a 6, mesclar um commit que a main absorveu e depois SUPEROU grava a
#      versão superada e o conserto da main desaparece da branch, em silêncio
#      (caso ANCESTRAL-SUPERADO, no teste irmão).
#
# ── por que a 3 e a 5 (a raiz comum das duas refutações: não se olhava HEAD) ──
#
# As duas versões anteriores decidiam sem NENHUMA leitura de `HEAD:<path>`, e o
# furo que sobrou tem essa raiz única: as condições 4 e 5 são **também**
# verdadeiras quando a própria branch tinha uma versão do invariante e a sessão a
# DESCARTA pegando a do outro lado. Medido pelo caminho de produção: num merge
# CONFLITADO com a main, o 3-way do git já resolve o invariante sozinho com as
# duas asserções no índice; a sessão então roda, DENTRO do merge,
# `git checkout origin/main -- <inv> && git add` e commita — exit 0, e o
# MARCADOR-COLEGA desaparece do HEAD. (`git checkout MERGE_HEAD -- <inv>` faz o
# mesmo.) E a rota não pede válvula em passo nenhum: o fortalecimento do colega
# chega por merge LIMPO, que não chama hook.
#
# `HEAD:<p>` == `BASE:<p>` é exatamente a referência que distingue o caso
# legítimo, e é a que o relato do #1161 já media na mão:
#   git log --oneline origin/main..HEAD -- <inv>   → VAZIO
# Nenhum commit desta branch tocou o arquivo → a perda não é autoria dela.
#
# ⚠️ A condição 5 NÃO é redundante com a 3+4, e a razão é que estas comparações
# são de BLOB — cegas para MODO. Num `chmod +x` de invariante dentro do merge os
# quatro OIDs são idênticos (3 e 4 valem), e só a 5 recusa a exclusão.
#
# ── por que a 2 (e ela já existia no irmão) ──
#
# `MERGE_HEAD` é uma ref que a PRÓPRIA SESSÃO fabrica, e `git stash` cria commit
# sem passar pelo pre-commit:
#   git stash push -m enfraquecimento
#   git merge --no-commit --no-ff "$(git rev-parse stash@{0})"
#   git add -A && git commit
# Medido: o hook anterior saía 0 e o MARCADOR-BRANCH era apagado do HEAD —
# REGRESSÃO contra os dois antecessores, que saíam 1. A forma mundana é a mesma
# sem stash: merge CONFLITADO da branch de um colega que apagou o invariante.
#
# `validate-features.sh` já carregava essa condição, com o motivo escrito: "o
# outro lado já ser alcançável por `origin/main` — trabalho aceito, não branch de
# colega — … é isso que impede o merge de virar lavanderia de edição".
#
# O que ela compra é a PRIMEIRA metade da frase: alcançável, isto é, não é branch
# de colega. "Trabalho aceito" — o que a main tem AGORA — é a 6: quem a main
# absorveu e depois SUPEROU permanece alcançável, e era por aí que o merge
# reescrevia o invariante com a versão superada, em silêncio (#1227). O guard
# irmão carrega a mesma ancestralidade (`loop/hooks/validate-features.sh`) e
# também não tem a 6; se o furo é o mesmo lá, é outro PR — não medido aqui.
#
# A condição 3 NÃO cobre esse caso (no stash a BASE é o próprio HEAD, então
# NA_BRANCH == BASE é trivialmente verdade), e a 2 não cobre o da 3 (lá o outro
# lado É a main). São dois furos com uma raiz e duas condições distintas.
#
# ⚠️ A 6 NÃO é o "hook (b)" refutado duas seções acima: lá a identidade de
# conteúdo contra `origin/main` era a condição ÚNICA, e por isso liberava o caso
# em que a SESSÃO reverte, DENTRO do merge, um invariante que a própria branch
# fortaleceu. Aqui a 6 é CONJUNTA com a 3+4+5: naquele estado a 3 é falsa
# (NA_BRANCH != BASE) e o caminho SEGUE ACUSADO (caso CONTEUDO-REVERTIDO).
#
# A condição 4 vale para TODOS os caminhos da linha. Numa linha `R` (rename) o
# path VELHO é uma DELEÇÃO, e julgar só o novo (`$3`) deixava o invariante
# antigo ser apagado em silêncio — medido com arquivos reais: `R058` de um
# invariante para outro passava com exit 0 pelo dispatcher. O par `R` o git
# forma sozinho quando a adição que chega é ≥50% similar ao arquivo apagado.
#
# ⚠️ Falhar FECHADO é o lado seguro aqui (bloquear pede uma válvula declarada;
# liberar perde o eval em silêncio). Por isso: sem MERGE_HEAD, merge de mais de
# um lado (octopus), `merge-base` sem ancestral comum, `is-ancestor` saindo
# não-zero ou a ref `origin/main` ausente → nenhuma exclusão.
#
# ⚠️ E isto é MUDANÇA DE COMPORTAMENTO declarada contra a versão anterior: sem
# `origin/main` (fork, clone raso) o falso positivo do #1161 volta a ser
# ACUSADO — a versão anterior o resolvia de graça ali, e a condição 2 cobra a
# ref de volta. É o lado seguro: quem não tem a ref não tem como provar que o
# outro lado é trabalho aceito, e a saída é a válvula declarada (medido: caso
# SEM-REF, exit 0 na versão anterior → exit 1 aqui, como na `main`).
#
# (E o `[ -f ... ] && lados=...` que pedia uma linha só aqui NÃO serve: sob
# `set -e`, o compound inteiro sai 1 quando o arquivo não existe e mata o hook —
# fecha, mas fecha SEMPRE, inclusive no commit comum sem invariante nenhum.)
arquivo_merge_head="$(git rev-parse --git-path MERGE_HEAD)"
lados=0
if [ -f "$arquivo_merge_head" ]; then
  lados=$(grep -c . "$arquivo_merge_head" || true)
fi

if [ -n "$violations" ] && [ "$lados" = "1" ]; then
  outro_lado=$(git rev-parse --quiet --verify MERGE_HEAD^0 2>/dev/null || true)
  base=$(git merge-base HEAD "$outro_lado" 2>/dev/null || true)
  # condição 2, na forma do irmão `validate-features.sh`: dentro de `if`, um
  # `is-ancestor` não-zero (inclusive `origin/main` inexistente) não mata o hook
  # sob `set -e` — só deixa `aceito=0`, e nada é excluído.
  aceito=0
  if [ -n "$outro_lado" ] && git merge-base --is-ancestor "$outro_lado" origin/main 2>/dev/null; then
    aceito=1
  fi
  if [ -n "$outro_lado" ] && [ -n "$base" ] && [ "$aceito" = "1" ]; then
    violations=$(while IFS= read -r linha; do
      [ -z "$linha" ] && continue
      veio_do_merge=1
      while IFS= read -r caminho; do
        [ -z "$caminho" ] && continue
        encenado=$(git rev-parse --quiet --verify ":$caminho" 2>/dev/null || true)
        na_branch=$(git rev-parse --quiet --verify "HEAD:$caminho" 2>/dev/null || true)
        no_outro=$(git rev-parse --quiet --verify "$outro_lado:$caminho" 2>/dev/null || true)
        na_base=$(git rev-parse --quiet --verify "$base:$caminho" 2>/dev/null || true)
        # 6: a PONTA da main, não qualquer ancestral dela. Sem esta linha a exclusão
        # acima aceita o commit que a main absorveu e depois superou, e o conserto da
        # main volta a ser revertido em silêncio pelo merge (#1227). "Ausente" nos dois
        # (deleção que a ponta já tem) também vale: a perda não é autoria da branch.
        na_ponta=$(git rev-parse --quiet --verify "origin/main:$caminho" 2>/dev/null || true)
        if [ "$na_branch" = "$na_base" ] \
          && [ "$encenado" = "$no_outro" ] \
          && [ "$no_outro" != "$na_base" ] \
          && [ "$encenado" = "$na_ponta" ]; then continue; fi
        veio_do_merge=0
        break
      done <<EOF
$(printf '%s' "$linha" | awk -F'\t' '{ for (i = 2; i <= NF; i++) if ($i != "") print $i }')
EOF
      [ "$veio_do_merge" = "1" ] && continue
      printf '%s\n' "$linha"
    done <<<"$violations")
  fi
fi

if [ -n "$violations" ]; then
  echo "pre-commit BLOQUEADO: tests/invariants/** é congelado — modificar/deletar invariante existente:" >&2
  echo "$violations" >&2
  echo "Invariante incômodo = ou o código está errado, ou o invariante está mal-escrito —" >&2
  echo "o segundo caso vai pra inbox (loop/INBOX.md), não pro Edit." >&2
  echo "Exceção legítima (o catraca): flip de test.fails → teste normal quando a fase G2+ corrige o gap." >&2
  echo "Nesse caso: exporte DESKCOMM_GOV_INVARIANTS_EDIT=1 e cite o flip no commit message." >&2
  echo "" >&2
  echo "RESOLVENDO CONFLITO DE MERGE e caiu aqui? Então a sua resolução ficou DIFERENTE dos dois" >&2
  echo "lados — isso é edição própria dentro do merge, e é o que este guard existe para pegar." >&2
  echo "Caminho sem improviso: resolva ESCOLHENDO um dos lados, feche o merge, e faça a mudança" >&2
  echo "que você queria num commit PRÓPRIO, com a razão escrita. A válvula acima é para o flip," >&2
  echo "não para resolução — válvula usada fora do caso previsto vira válvula de rotina." >&2
  exit 1
fi

exit 0
