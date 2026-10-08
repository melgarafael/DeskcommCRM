#!/usr/bin/env bash
# Extensões pela linha de comando — a parte chata, sem a parte perigosa.
#
# ─── POR QUE ESTE SCRIPT NÃO INSTALA ────────────────────────────────────────
#
# A decisão do dono (DEC-007, escolha 2) foi: um comando no kit, e ele tem de ser
# CLIENTE da mesma porta que a tela usa, nunca uma segunda porta por fora das
# proteções. Ao construir, medi o que essa porta exige (`lib/extensions/http.ts:41-93`):
#
#   - ser administrador da INSTALAÇÃO (`is_platform_admin`), com escopo `full`;
#   - não estar em sessão de acompanhamento de suporte;
#   - e uma SESSÃO com verificação em duas etapas (`sessionAal() === "aal2"`).
#
# As três se apoiam numa sessão de usuário. Um script no servidor não tem sessão, e
# dar a ele uma teria um custo específico: poder de plataforma atrás de um segredo
# em arquivo no disco, sem a verificação em duas etapas que a tela exige. Isso é
# exatamente a "segunda porta" que a decisão recusou — e quem lesse o registro de
# auditoria depois veria uma instalação atribuída a um administrador que não a fez.
#
# Então o comando faz o que é chato e seguro: descobrir, baixar e conferir o
# catálogo, deixando o arquivo pronto. A instalação continua sendo um clique de
# quem tem autoridade para isso. O trabalho manual que ele tira é o de achar o
# arquivo certo e conferir que ele não mudou no caminho.
#
# Uso:
#   ./extensao.sh listar                    # o que existe no catálogo oficial
#   ./extensao.sh baixar [destino]          # baixa e confere; imprime o caminho
#   ./extensao.sh --ajuda

source "$(dirname "$0")/_common.sh"

ORIGEM_PADRAO="https://extensoes.deskcomm.com.br"
ORIGEM="${EXTENSOES_ORIGEM:-$ORIGEM_PADRAO}"
CATALOGO_URL="${ORIGEM}/catalogo.json"

ajuda() {
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

exigir_jq() {
  command -v jq >/dev/null 2>&1 || {
    echo "Este comando precisa do 'jq'. Instale com: apt-get install -y jq" >&2
    exit 1
  }
}

baixar_para() {
  local destino="$1"
  # `--fail` para que 404 não vire arquivo com corpo de erro dentro; `--max-time`
  # para não pendurar o terminal de quem está numa rede ruim.
  curl -fsS --max-time 20 --proto '=https' --tlsv1.2 -o "$destino" "$CATALOGO_URL" || {
    echo "Não consegui baixar o catálogo de ${CATALOGO_URL}." >&2
    echo "Confira a conexão do servidor, ou baixe pelo navegador e use a tela." >&2
    return 1
  }
  catalogo_tem_forma "$destino" || {
    echo "O arquivo baixado não tem a forma de um catálogo. Nada foi usado." >&2
    rm -f "$destino"
    return 1
  }
}

# Função própria de propósito, e não um `jq` embutido no download: assim o teste consegue
# exercê-la sem rede. Enquanto ela vivia dentro de `baixar_para`, o caso do teste passava
# pelo motivo ERRADO — o `curl` recusava o protocolo do arquivo local antes de a validação
# rodar, e tirar a validação inteira não deixava o teste vermelho. Medido, não suposto.
catalogo_tem_forma() {
  [[ -f "$1" && -s "$1" ]] || return 1
  jq -e '.format_version == 1 and (.entries | type == "array") and (.origin | type == "string")' \
    "$1" >/dev/null 2>&1
}

comando_listar() {
  exigir_jq
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  baixar_para "$tmp" || return 1
  echo "Catálogo de ${ORIGEM} — revisão $(jq -r '.revision' "$tmp")"
  echo
  jq -r '.entries[] | "  \(.publisher)/\(.name)@\(.version)\n      \(.display.title["pt-BR"])\n      \(.display.summary["pt-BR"])\n      abre: \(.permissions | map(sub("navigation.";"")) | join(", "))\n"' "$tmp"
  echo "Para instalar: abra Extensões no CRM, envie o catálogo e escolha o pacote."
  echo "Baixe o arquivo com: $(basename "$0") baixar"
}

comando_baixar() {
  exigir_jq
  local destino="${1:-${PROJECT_DIR:-.}/catalogo-de-extensoes.json}"
  baixar_para "$destino" || return 1
  echo "Catálogo salvo em: ${destino}"
  echo "Revisão $(jq -r '.revision' "$destino") · $(jq -r '.entries | length' "$destino") extensão(ões)"
  echo
  echo "Agora, no CRM: Extensões › enviar este arquivo › escolher o pacote › instalar."
  echo "A instalação é pela tela de propósito: ela pede a verificação em duas etapas"
  echo "e registra quem instalou, o que um comando no servidor não teria como fazer."
}

case "${1:-}" in
  listar) comando_listar ;;
  baixar) shift; comando_baixar "${1:-}" ;;
  -h|--help|--ajuda|"") ajuda ;;
  *) echo "Comando desconhecido: $1" >&2; ajuda ;;
esac
