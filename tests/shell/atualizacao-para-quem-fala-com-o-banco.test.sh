#!/usr/bin/env bash
# Prova de que a atualização sabe QUEM parar antes de mexer no banco — com
# `docker` substituído por um dublê. Nada aqui toca a máquina de quem roda:
# nenhum contêiner sobe, nenhum contêiner para.
#
#   bash tests/shell/atualizacao-para-quem-fala-com-o-banco.test.sh
#
# ## Por que este arquivo existe
#
# O `baseline.sql` aplica cada regra de isolamento como APAGAR e depois CRIAR —
# é o único jeito portável, porque o Postgres não tem `create or replace
# policy`. Com tráfego vivo isso vira disputa de trava, e quando o CRIAR trava o
# APAGAR já valeu: a regra some, o banco passa a negar a leitura em silêncio, e
# a tela fica VAZIA sem um erro sequer.
#
# Medido numa instalação real, no mesmo dia e com o mesmo arquivo:
#   tudo de pé ................................ 113 travamentos
#   CRM parado ................................  60 travamentos
#   CRM + rest + realtime + studio parados ....   0 travamentos
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
falhas=0
ok()  { printf '  \342\234\223 %s\n' "$1"; }
nao() { printf '  \342\234\227 %s\n     esperava: %s\n     veio:     %s\n' "$1" "$2" "$3"; falhas=$((falhas + 1)); }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# Dublê de `docker`: devolve a lista de contêineres que a instalação REAL tem
# (medida em 2026-09-12), incluindo os de OUTROS sistemas na mesma VPS — é
# justamente contra eles que a lista precisa ser explícita.
cat > "$tmp/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then
  cat <<'LISTA'
deskcomm-app-1
deskcomm-worker-1
deskcomm-scheduler-1
realtime-dev.supabase-realtime
supabase-auth
supabase-db
supabase-rest
supabase-studio
imobplus-server-app-1
wordpress_app_pljr
LISTA
  exit 0
fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH"

# O `_common.sh` abre com `set -euo pipefail`; sem desarmar o `-e` depois de
# carregá-lo, o primeiro `grep` sem casamento derrubaria a suíte inteira em
# silêncio — e um arquivo de teste que morre cedo passa por "verde".
# shellcheck disable=SC1090
. "$RAIZ/hostgator-setup-kit/_common.sh"
set +e

echo "caso 0 — GUARDA DE VACUIDADE: a função existe"
# Sem este caso, os de baixo passam por acidente enquanto a função não existe:
# "a saída vazia não contém imobplus" é verdade, e "hospedado devolve vazio"
# também — um arquivo inteiro verde medindo o nada. Medido: rodando este teste
# antes da implementação, 3 dos 4 casos ficavam verdes.
if declare -F supabase_local_containers >/dev/null 2>&1; then
  ok "supabase_local_containers está declarada"
else
  nao "supabase_local_containers existe" "declarada em _common.sh" "ausente — os casos abaixo medem o nada"
fi

echo "caso 1 — acha as três peças do Supabase local"
saida="$(supabase_local_containers | sort | tr '\n' ' ')"
esperado="realtime-dev.supabase-realtime supabase-rest supabase-studio "
[ "$saida" = "$esperado" ] && ok "achou as três, e só elas" \
  || nao "as três peças" "$esperado" "$saida"

echo "caso 2 — NÃO leva sistema de terceiro junto"
case "$saida" in
  *imobplus*|*wordpress*) nao "não toca em outro sistema" "sem imobplus/wordpress" "$saida" ;;
  *) ok "imobplus e wordpress ficam de fora" ;;
esac

echo "caso 3 — NÃO leva o banco nem o auth"
# Parar o banco seria absurdo (é nele que o DDL roda) e derrubar o auth
# deslogaria quem está na tela sem necessidade nenhuma.
case "$saida" in
  *supabase-db*|*supabase-auth*) nao "poupa o banco e o auth" "sem supabase-db/auth" "$saida" ;;
  *) ok "supabase-db e supabase-auth ficam de pé" ;;
esac

echo "caso 4 — CONTROLE: Supabase hospedado devolve vazio"
# Sem este controle, uma função que devolvesse a lista inteira passaria nos três
# casos acima por acidente. E ele mede a decisão que torna o conserto portável:
# onde o Supabase é hospedado não há o que parar, e quem protege é a conferência.
cat > "$tmp/bin/docker" <<'DUBLE'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then printf 'deskcomm-app-1\ndeskcomm-worker-1\n'; exit 0; fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
vazio="$(supabase_local_containers | tr -d '[:space:]')"
[ -z "$vazio" ] && ok "hospedado: nada a parar" || nao "hospedado devolve vazio" "(vazio)" "$vazio"

# ── O CICLO INTEIRO, com `docker` gravando tudo que foi chamado ──────────────
#
# Daqui para baixo o dublê anota cada invocação num diário, e os casos leem o
# diário. É a única forma de provar QUEM foi parado e QUEM voltou sem parar nada
# de verdade.
diario="$tmp/chamadas.txt"
cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario"
if [ "\$1" = "ps" ]; then
  printf 'deskcomm-app-1\nrealtime-dev.supabase-realtime\nsupabase-rest\nsupabase-studio\nimobplus-server-app-1\n'
  exit 0
fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"

echo "caso 5 — GUARDA DE VACUIDADE: as funções do ciclo existem"
for f in pausar_o_que_fala_com_o_banco restaurar_servicos; do
  declare -F "$f" >/dev/null 2>&1 && ok "$f está declarada" \
    || nao "$f existe" "declarada em _common.sh" "ausente — os casos abaixo medem o nada"
done

echo "caso 6 — para as três peças do Supabase pelo nome exato"
: > "$diario"; REGRAS_FALTANDO=""
pausar_o_que_fala_com_o_banco >/dev/null 2>&1
grep -q 'stop realtime-dev.supabase-realtime supabase-rest supabase-studio' "$diario" \
  && ok "parou as três num comando só" \
  || nao "parar as três" "stop realtime-dev... supabase-rest supabase-studio" "$(tr '\n' ';' < "$diario")"
grep -q 'stop app worker scheduler' "$diario" \
  && ok "e parou o CRM, o worker e o agendador" \
  || nao "parar o CRM" "stop app worker scheduler" "$(tr '\n' ';' < "$diario")"

echo "caso 7 — com regra faltando, o CRM NÃO volta ao ar"
# Um CRM fora do ar é um problema visível que alguém resolve. Um CRM no ar sem
# regra de isolamento mostra tela vazia para todo mundo e ninguém sabe por quê —
# foi exatamente o que custou um dia inteiro nesta instalação.
: > "$diario"; REGRAS_FALTANDO="crm_leads_select|crm_leads"
restaurar_servicos >/dev/null 2>&1
grep -q 'start realtime-dev' "$diario" \
  && ok "as peças do Supabase voltam (elas não são o risco)" \
  || nao "peças do Supabase voltam" "start realtime-dev..." "$(tr '\n' ';' < "$diario")"
grep -q 'up -d app' "$diario" \
  && nao "o CRM fica parado" "sem 'up -d app'" "$(tr '\n' ';' < "$diario")" \
  || ok "o CRM fica parado de propósito"

echo "caso 8 — CONTROLE: sem regra faltando, o CRM volta"
# Sem este controle, uma implementação que NUNCA subisse o CRM passaria no caso
# 7 — e deixaria toda instalação do mundo fora do ar depois de atualizar.
: > "$diario"; REGRAS_FALTANDO=""
pausar_o_que_fala_com_o_banco >/dev/null 2>&1
: > "$diario"
restaurar_servicos >/dev/null 2>&1
grep -q 'up -d app' "$diario" && ok "tudo certo: o CRM volta" \
  || nao "o CRM volta" "up -d app" "$(tr '\n' ';' < "$diario")"


# ── O BOTÃO NÃO ACENDE ANTES DE A IMAGEM EXISTIR ─────────────────────────────
#
# MEDIDO em 2026-09-13, e quem viu foi o dono da instalação: a tela ofereceu a
# "Nova versão · 1.17.16" enquanto a imagem dela ainda estava sendo construída.
# O agente decidia olhando SÓ a etiqueta no Git — nunca perguntava se havia o
# que baixar. A janela entre publicar a etiqueta e a imagem ficar pronta é de
# uns seis minutos.
#
# Antes isto era um susto: a atualização avisava "a versão ainda está
# publicando, rode de novo em alguns minutos" e o sistema seguia no ar com a
# versão antiga, porque nada tinha sido parado.
#
# Depois da pausa dos serviços, deixou de ser susto. O app é PARADO antes do
# banco, e a volta usa o endereço da imagem NOVA — gravado antes de tentar
# baixá-la. Sem imagem, ele não volta. Um susto virou uma queda.
diario_img="$tmp/imagens.txt"
duble_registro() {  # duble_registro <tags que existem, separadas por espaço>
  cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario_img"
if [ "\$1" = "buildx" ] && [ "\$2" = "imagetools" ]; then
  for t in $1; do case "\$4" in *:\$t) exit 0 ;; esac; done
  exit 1
fi
if [ "\$1" = "ps" ]; then exit 0; fi
exit 0
DUBLE
  chmod +x "$tmp/bin/docker"
}

echo "caso 9 — GUARDA DE VACUIDADE: a função existe"
declare -F veredito_da_imagem_do_app >/dev/null 2>&1 \
  && ok "veredito_da_imagem_do_app está declarada" \
  || nao "veredito_da_imagem_do_app existe" "declarada em _common.sh" "ausente — os casos abaixo medem o nada"

echo "caso 10 — imagem publicada: pode anunciar"
duble_registro "1.17.16 1.17.15"
v="$(veredito_da_imagem_do_app 1.17.16 1.17.15)"
[ "$v" = "publicada" ] && ok "publicada" || nao "publicada" "publicada" "$v"

echo "caso 11 — imagem AINDA NÃO existe: não anuncia"
duble_registro "1.17.15"
v="$(veredito_da_imagem_do_app 1.17.16 1.17.15)"
[ "$v" = "ausente" ] && ok "ausente — a etiqueta saiu na frente da imagem" || nao "ausente" "ausente" "$v"

echo "caso 12 — CONTROLE: registro fora do ar NÃO apaga o botão"
# Este é o caso que impede o conserto de virar um defeito pior. Sem a segunda
# sonda, uma VPS sem saída para o registro pararia de oferecer atualização PARA
# SEMPRE, em silêncio — e ninguém liga o silêncio da tela a um problema de rede.
# A sonda de controle é a versão INSTALADA: ela existe, com certeza, porque está
# rodando. Se nem ela responde, o problema é a rede, não a imagem.
duble_registro ""
v="$(veredito_da_imagem_do_app 1.17.16 1.17.15)"
[ "$v" = "indisponivel" ] && ok "indisponível — na dúvida, anuncia" || nao "indisponivel" "indisponivel" "$v"

echo "caso 13 — instalação fora de release: sem controle possível, não silencia"
# Quem segue a main não tem versão instalada para servir de sonda de controle.
# Sem ela não dá para separar "imagem faltando" de "registro fora", e a resposta
# certa é a que não tira nada de ninguém.
duble_registro ""
v="$(veredito_da_imagem_do_app 1.17.16 "")"
[ "$v" = "indisponivel" ] && ok "sem sonda de controle: indisponível" || nao "sem controle" "indisponivel" "$v"

echo "caso 14 — o agente CONSULTA o veredito antes de anunciar"
AGENTE="$(cat "$RAIZ/hostgator-setup-kit/agent.sh")"
case "$AGENTE" in
  *veredito_da_imagem_do_app*) ok "agent.sh consulta o veredito" ;;
  *) nao "agent.sh consulta o veredito" "chamada a veredito_da_imagem_do_app" "ausente" ;;
esac
case "$AGENTE" in
  *'"$VEREDITO_IMAGEM" = "ausente"'*) ok "e só cala quando a imagem está AUSENTE" ;;
  *) nao "só cala em ausente" 'teste contra "ausente"' "ausente" ;;
esac


# -- A VOLTA DEIXA DE SER MUDA -----------------------------------------------
#
# MEDIDO em 2026-09-13, numa atualizacao real: a pausa funcionou, a conferencia
# rodou com tudo parado (92 de 92), e as tres pecas do Supabase NAO VOLTARAM.
# Ficaram paradas ate alguem perceber — e a atualizacao tinha dito "concluida".
#
# A causa daquela falha nao foi determinada: a cadeia inteira, reproduzida na
# mesma VPS com dubles, funciona. E a evidencia se perdeu ao subir as pecas, que
# era o certo a fazer com o sistema fora do ar. O que NAO pode se repetir e o
# silencio: `docker start ... >/dev/null 2>&1 || true` nao deixa rastro nenhum
# quando falha.
echo "caso 15 — a volta CONFERE se cada peca subiu"
: > "$diario"
cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario"
# ATENCAO: heredoc NAO citado — crase aqui dentro vira execucao de comando.
# Este comentario ja travou a suite por conter crases. Sem elas:
# start nao faz nada, e ps devolve vazio, ou seja, a peca NAO voltou.
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
PARADOS="peca-fantasma"; REGRAS_FALTANDO=""
saida_volta="$(restaurar_servicos 2>&1)"
case "$saida_volta" in
  *peca-fantasma*) ok "grita nomeando quem nao voltou" ;;
  *) nao "grita nomeando a peca" "menciona peca-fantasma" "$saida_volta" ;;
esac
case "$saida_volta" in
  *NAO\ VOLTARAM*|*nao\ voltaram*|*NÃO\ VOLTARAM*) ok "e diz que elas nao voltaram" ;;
  *) nao "diz que nao voltaram" "texto de alarme" "$saida_volta" ;;
esac
grep -qE "^start peca-fantasma$" "$diario" && grep -c "^start peca-fantasma$" "$diario" >/dev/null   && [ "$(grep -c "^start peca-fantasma$" "$diario")" -ge 2 ]   && ok "tenta de novo antes de desistir"   || nao "tenta de novo" "2 tentativas de start" "$(grep -c "^start peca-fantasma$" "$diario") tentativa(s)"

echo "caso 16 — CONTROLE: peca que VOLTA nao gera alarme"
# Sem este controle, uma implementacao que gritasse sempre passaria no caso 15 —
# e alarme que toca a toa ensina quem opera a ignorar o alarme de verdade.
: > "$diario"
cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario"
if [ "\$1" = "ps" ]; then printf 'peca-boa
'; fi
exit 0
DUBLE
chmod +x "$tmp/bin/docker"
PARADOS="peca-boa"; REGRAS_FALTANDO=""
saida_volta="$(restaurar_servicos 2>&1)"
case "$saida_volta" in
  *peca-boa*) nao "silencio quando tudo volta" "(sem alarme)" "$saida_volta" ;;
  *) ok "silencio quando tudo volta" ;;
esac

echo "caso 17 — o gatilho cobre INTERRUPCAO, nao so saida normal"
# Se o processo for interrompido (Ctrl+C, cron matando, reinicio da maquina), um
# `trap ... EXIT` sozinho nao dispara em todos os casos — e a instalacao fica com
# as pecas paradas, exatamente o desfecho medido.
UP="$(cat "$RAIZ/hostgator-setup-kit/update.sh")"
case "$UP" in
  *"trap restaurar_servicos EXIT INT TERM HUP"*) ok "cobre EXIT, INT, TERM e HUP" ;;
  *) nao "gatilho cobre sinais" "trap ... EXIT INT TERM HUP" "so EXIT" ;;
esac

if [ "$falhas" -eq 0 ]; then
  echo "TUDO VERDE"
  exit 0
else
  echo "$falhas caso(s) vermelho(s)"
  exit 1
fi
