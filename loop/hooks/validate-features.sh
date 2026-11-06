#!/usr/bin/env bash
# validate-features.sh — imutabilidade de plan/features.json (enforcement, não prosa).
# O loop só pode mudar os campos "passes" e "verification" de cada feature —
# e mesmo isso via `node loop/update-feature.ts`, nunca editor.
# Adicionar/remover/redefinir features é ato humano: DESKCOMM_GOV_PLAN_EDIT=1.
set -euo pipefail

# Sessão humana / lane de features declarada explicitamente
[ "${DESKCOMM_GOV_PLAN_EDIT:-0}" = "1" ] && exit 0

# features.json não está no commit → nada a validar.
#
# O pathspec NÃO é enfeite. Sem ele, `git diff --cached --name-only` despeja o
# índice inteiro e o `grep -q` casa e FECHA O PIPE no meio: o git morre de
# SIGPIPE, o `pipefail` propaga 141 e o `|| exit 0` engole. Medido em 18/09/2026:
# num merge com 4663 arquivos encenados o hook saía 0 sem validar NADA, em
# silêncio (exit 141 com pipefail; PIPESTATUS=(141 0) sem ele). Com o pathspec o
# git imprime um nome só e a sonda fica honesta no mesmo estado.
git diff --cached --name-only -- plan/features.json | grep -qx 'plan/features.json' || exit 0

# ── O que chega pelo OUTRO LADO de um merge já aceito não é edição desta branch ──
#
# Num merge, HEAD é a ponta da MINHA branch e o outro lado é MERGE_HEAD, que as
# três comparações abaixo ignoram. Então `old` = a versão velha da branch e
# `new` = a versão que a main trouxe: a diferença era lida como edição do autor.
# Medido: `git merge --no-commit --no-ff 1cd048310` (commit real da main que só
# toca plan/features.json) → `git commit` recusado, blob do índice IDÊNTICO ao de
# MERGE_HEAD, zero autoria minha. Mesma classe do guard de migration; irmão do
# caso 4/5 da issue #1161.
#
# Vem ANTES do teste de criação da linha seguinte de propósito: a main criar o
# arquivo depois do ponto da branch dispara o outro caminho falso — medido com o
# commit real que o criou.
#
# As três condições andam juntas, e é isso que impede o merge de virar lavanderia
# de edição: (a) estar num merge, (b) o outro lado já ser alcançável por
# `origin/main` — trabalho aceito, não branch de colega —, (c) o blob do índice
# ser IDÊNTICO ao do outro lado, isto é, zero autoria minha no arquivo. Falha
# qualquer uma → cai na verificação de sempre. Sem a ref `origin/main`, merge
# octopus ou blob ilegível, a condição é falsa e a guarda segue fechada.
#
# ── De ONDE sai o outro lado no caminho LIMPO (#374) ──────────────────────────
# O git chama o `pre-merge-commit` ANTES de gravar o `MERGE_HEAD` (medido pela
# sonda do M3-PREMISSA), então naquele instante a referência ainda não existe e
# esta guarda caía na verificação de sempre — punindo o merge inteiro como se a
# main tivesse escrito o plano. O mesmo git entrega a outra ponta, NAQUELE
# instante, em `GITHEAD_<sha>=<ref>`; é a MESMA fonte que o guard de invariantes
# (então `freeze-invariants.sh`) passou a usar na #374, com a mesma régua: uma ref
# só = um merge, duas ou mais
# (octopus) = sem sinal conclusivo, `outro_lado` fica vazio e nada é inocentado.
outro_lado=$(git rev-parse -q --verify MERGE_HEAD 2>/dev/null || true)
if [ -z "$outro_lado" ]; then
  githeads=$(env | sed -n 's/^\(GITHEAD_[0-9a-fA-F]\{40,\}\)=.*/\1/p' || true)
  n_githeads=$(printf '%s' "$githeads" | grep -c . || true)
  if [ "$n_githeads" = "1" ]; then
    outro_lado=$(git rev-parse -q --verify "${githeads#GITHEAD_}" 2>/dev/null || true)
  fi
fi

# ── (d) e (e): o sinal é FORJÁVEL, então o resultado tem de estar preso ────────
# `GITHEAD_*` é variável de ambiente: quem roda o commit a escreve. E `.git/MERGE_HEAD`
# também se escreve à mão. Com só (a)-(c), um commit COMUM com
# `GITHEAD_<um ancestral da main>=x` voltava o plano à versão daquele ancestral e
# apagava features com exit 0 (medido, nas duas rotas). As duas condições que faltavam
# são as 6 e 3 do guard de invariantes de então: (d) o índice é o que a main tem AGORA
# (`origin/main`), não qualquer ancestral; (e) esta branch nunca tocou o arquivo
# (`HEAD` == merge-base). Com as duas, o único conteúdo que o sinal libera é o da
# ponta da main sobre uma branch que não mexeu no plano — que é o merge legítimo.
# A sentinela de (e) é a MESMA dos dois lados: "ausente nos dois" (a main criou o
# arquivo depois do ponto da branch) é o caso legítimo, não um descasamento.
if [ -n "$outro_lado" ] \
  && git merge-base --is-ancestor "$outro_lado" origin/main 2>/dev/null \
  && [ "$(git rev-parse -q --verify ':plan/features.json' 2>/dev/null || echo ausente-no-indice)" \
     = "$(git rev-parse -q --verify "${outro_lado}:plan/features.json" 2>/dev/null || echo ausente-no-outro-lado)" ] \
  && [ "$(git rev-parse -q --verify ':plan/features.json' 2>/dev/null || echo ausente-no-indice)" \
     = "$(git rev-parse -q --verify 'origin/main:plan/features.json' 2>/dev/null || echo ausente-na-ponta)" ] \
  && base_vf=$(git merge-base HEAD "$outro_lado" 2>/dev/null) \
  && [ "$(git rev-parse -q --verify 'HEAD:plan/features.json' 2>/dev/null || echo ausente)" \
     = "$(git rev-parse -q --verify "${base_vf}:plan/features.json" 2>/dev/null || echo ausente)" ]; then
  exit 0
fi

command -v jq >/dev/null 2>&1 || {
  echo "pre-commit: jq é obrigatório para validar plan/features.json (brew install jq)." >&2
  exit 1
}

# Criação do arquivo (não existe em HEAD) só em sessão humana
if ! git cat-file -e HEAD:plan/features.json 2>/dev/null; then
  echo "pre-commit BLOQUEADO: criação de plan/features.json exige DESKCOMM_GOV_PLAN_EDIT=1 (sessão humana)." >&2
  exit 1
fi

old=$(git show HEAD:plan/features.json)
new=$(git show :plan/features.json)

# 1) Nada fora de .features pode mudar
if [ "$(jq -S 'del(.features)' <<<"$old")" != "$(jq -S 'del(.features)' <<<"$new")" ]; then
  echo "pre-commit BLOQUEADO: campos de topo de plan/features.json mudaram." >&2
  echo "O loop só escreve 'passes' e 'verification' (via node loop/update-feature.ts)." >&2
  echo "Mudar o plano é ato humano: DESKCOMM_GOV_PLAN_EDIT=1." >&2
  exit 1
fi

# 2) Ignorando passes/verification, o conjunto de features tem que ser IDÊNTICO
#    (pega edição de acceptance/depends_on/title/priority E adição/remoção de feature)
strip='[.features[] | del(.passes, .verification)] | sort_by(.id)'
if [ "$(jq -S "$strip" <<<"$old")" != "$(jq -S "$strip" <<<"$new")" ]; then
  echo "pre-commit BLOQUEADO: plan/features.json só pode mudar nos campos 'passes' e 'verification'." >&2
  echo "Editar acceptance/depends_on/title/priority ou adicionar/remover features é ato humano." >&2
  echo "Se a feature está mal-escrita, abra item na inbox (loop/INBOX.md) — não reescreva o teste." >&2
  echo "Sessão humana/lane de features: re-execute o commit com DESKCOMM_GOV_PLAN_EDIT=1." >&2
  exit 1
fi

exit 0
