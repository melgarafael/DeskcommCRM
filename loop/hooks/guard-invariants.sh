#!/usr/bin/env bash
# guard-invariants.sh — guarda de `tests/invariants/**`. MODIFICAR é livre; DELETAR
# continua pedindo justificativa.
#
# ── o congelamento foi APOSENTADO, e por quê ───────────────────────────────────
#
# `tests/invariants/**` nasceu como o eval do épico (G1-03): editar um invariante
# era editar a régua que media o próprio épico, então o diretório era congelado —
# ADICIONAR passava, MODIFICAR/DELETAR exigiam `DESKCOMM_GOV_INVARIANTS_EDIT=1`.
#
# O épico terminou. O diretório virou a suíte geral de invariantes do projeto
# (526 `*.test.ts`), atrás do check obrigatório `invariants` (`pnpm test:db`), e
# editar um invariante passou a ser manutenção normal de teste. O congelamento
# cobrava uma taxa que já não comprava nada: quem ajustava uma asserção legítima
# gastava a válvula, e válvula gasta por rotina é como uma guarda morre.
#
# Este hook era `freeze-invariants.sh` e tinha 503 linhas para julgar
# PROCEDÊNCIA de `M`/`T` dentro de merge (cinco referências, seis condições). Com
# `M` livre, nada disso tem objeto — o que sobrou não depende de merge nenhum.
#
# ── o que sobrou, e por que só a DELEÇÃO ──────────────────────────────────────
#
# Apagar um invariante não é manutenção: é a única forma de um teste incômodo
# SAIR do gate sem ninguém decidir nada — o `it()` que reprova vira arquivo
# ausente e o verde volta. Quem acha o invariante errado escreve no inbox
# (`loop/INBOX.md`) ou conserta o código; o que não pode é o arquivo sumir em
# silêncio. `R` entra junto: renomear é deleção disfarçada — o caminho antigo
# some do HEAD e o invariante que vigiava aquilo deixa de rodar.
#
# A régua é a da MAIN, não a do índice: apagar o que a `origin/main` JÁ NÃO TEM
# não perde guarda nenhuma — o invariante que esta branch criou (nunca esteve na
# main) e a deleção que a main fez e o merge trouxe passam livres. É o que impede
# o falso positivo do #1161 de voltar por esta porta: mesclar a main que apagou um
# invariante produz uma linha `D` no índice que NÃO é autoria de quem merja.
#
# Apagar o que a main TEM bloqueia, com a válvula declarada e a razão no commit.
#
# ⚠️ Falha FECHADA onde não dá para saber: sem `origin/main` (fork sem o remote,
# clone raso) não há como provar que a main já não tinha o arquivo → bloqueia,
# e a mensagem diz o que fazer. Caminho que o git CITA (aspas, newline no nome)
# também entra fechado, pelo mesmo motivo de sempre: nome que não se lê não se
# julga — e com `-c core.quotepath=false` a acentuação comum (o padrão deste
# projeto) já sai crua e é lida.
#
# Cadeia de guarda, medida (não presumida):
#   loop/hooks/pre-commit:14        chama este hook (último dos quatro)
#   loop/hooks/pre-merge-commit:31  `exec bash .../pre-commit` — o merge que
#                                   auto-commita passa pelos mesmos guards (#1225)
#   loop/setup-hooks.sh:7           `git config core.hooksPath loop/hooks` (arma)
#   loop/hooks/guard-protected-paths.sh:8  (PreToolUse, Claude Code) NÃO barra
#                                   mais Edit/Write; barra `rm` de teste, e é o
#                                   irmão que fecha o caminho do agente.
set -euo pipefail

[ "${DESKCOMM_GOV_INVARIANTS_EDIT:-0}" = "1" ] && exit 0

# `D` (delete) e `R` (rename = delete disfarçado) em tests/invariants/ pedem ordem.
# `-c core.quotepath=false`: sem isso um nome acentuado sai citado em octal e o
# regex da âncora não casa — era um furo ABERTO, medido em 18/09/2026.
# `-F'\t'`: com o FS padrão do awk um caminho com espaço era quebrado em campos.
# O `"?` mantém na lista o que o git cita mesmo com quotepath=false.
apagados=$(git -c core.quotepath=false diff --cached --name-status \
  | awk -F'\t' '$1 ~ /^(D|R)/ && $2 ~ /^"?tests\/invariants\// { print $0 }')

# A esmagadora maioria dos commits não apaga invariante nenhum: sai antes de
# qualquer consulta a ref, para o hook não custar nada no caminho comum.
[ -n "$apagados" ] || exit 0

# Sem a ponta da main não há régua. Bloquear é o lado seguro (bloquear pede uma
# válvula declarada; liberar perde um invariante em silêncio).
if ! git rev-parse --quiet --verify "origin/main^{commit}" >/dev/null 2>&1; then
  echo "pre-commit BLOQUEADO: este commit apaga invariante e não há 'origin/main' para dizer se ele já saiu da main." >&2
  echo "$apagados" >&2
  echo "Conserto: git fetch origin main  (a ponta da main é a régua da deleção)." >&2
  echo "Se você PRECISA commitar sem a ref: DESKCOMM_GOV_INVARIANTS_EDIT=1, e diga no commit por quê." >&2
  exit 1
fi

# 0 = a main TEM o caminho (apagar é perda) · 1 = a main não tem (passa).
main_tem() {
  case "$1" in
    '"'*) return 0 ;;
  esac
  git rev-parse --quiet --verify "origin/main:$1" >/dev/null 2>&1
}

violacoes=''
while IFS= read -r linha; do
  [ -n "$linha" ] || continue
  caminho=${linha#*$'\t'}
  caminho=${caminho%%$'\t'*}
  if main_tem "$caminho"; then
    violacoes="${violacoes}${linha}"$'\n'
  fi
done <<<"$apagados"

if [ -n "$violacoes" ]; then
  echo "pre-commit BLOQUEADO: invariante que a main tem não se apaga:" >&2
  printf '%s' "$violacoes" >&2
  echo "" >&2
  echo "MODIFICAR invariante é livre (o congelamento foi aposentado) — o que este hook barra é a" >&2
  echo "DELEÇÃO: apagar tira o teste do gate sem ninguém decidir nada. Renomear conta como apagar." >&2
  echo "Invariante incômodo = ou o código está errado, ou o invariante está mal-escrito — o segundo" >&2
  echo "caso vai pra inbox (loop/INBOX.md) ou se conserta no lugar, não no rm." >&2
  echo "Deleção deliberada (duplicata, invariante substituído): DESKCOMM_GOV_INVARIANTS_EDIT=1 e a" >&2
  echo "razão escrita no commit. Válvula usada fora de caso declarado vira válvula de rotina." >&2
  echo "RESOLVENDO CONFLITO DE MERGE e caiu aqui? A resolução escolheu APAGAR o lado que a main" >&2
  echo "mantém — resolva mantendo o arquivo e faça a remoção que você queria num commit próprio." >&2
  exit 1
fi

exit 0
