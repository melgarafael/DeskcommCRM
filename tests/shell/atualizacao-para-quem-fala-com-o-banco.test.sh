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


echo "caso 18 — o banco RELIGA logo depois do banco, nao no fim do script"
# MEDIDO na instalacao real, 2026-09-13: as pecas pararam as 03:10:18 e o script
# so terminou as 03:13:09. Quase TRES MINUTOS sem o Supabase — nao por falha,
# por DESENHO: a pausa acontecia na etapa do banco e a volta so no gatilho de
# saida, depois de baixar imagem, recriar conteiner e esperar healthcheck.
#
# Esses tres minutos existem mesmo quando tudo da certo, e ninguem os mediu
# porque o alvo era outro. A volta tem de acontecer assim que o banco termina;
# o gatilho continua existindo, mas como rede de seguranca, nao como caminho.
UP="$(cat "$RAIZ/hostgator-setup-kit/update.sh")"
declare -F religar_o_supabase >/dev/null 2>&1   && ok "religar_o_supabase esta declarada"   || nao "religar_o_supabase existe" "declarada em _common.sh" "ausente"

pos_religa="$(printf '%s' "$UP" | grep -n "religar_o_supabase" | head -1 | cut -d: -f1)"
pos_app="$(printf '%s' "$UP" | grep -n "Baixando a versao nova do app\|Baixando a versão nova do app" | head -1 | cut -d: -f1)"
if [ -n "$pos_religa" ] && [ -n "$pos_app" ] && [ "$pos_religa" -lt "$pos_app" ]; then
  ok "religa ANTES de baixar a imagem nova"
else
  nao "religa antes da etapa do app" "religar_o_supabase antes da etapa 5" "religa=$pos_religa app=$pos_app"
fi

echo "caso 19 — CONTROLE: religar duas vezes nao reclama nem repete"
# O gatilho de saida continua chamando a volta. Se ela nao fosse idempotente,
# toda atualizacao bem-sucedida terminaria com um alarme falso.
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
# ATENCAO: NADA de `$( )` aqui. Command substitution roda em SUBSHELL, e a
# limpeza de `PARADOS` que a funcao faz nao voltaria para este shell — o teste
# mediria o proprio artefato e acusaria "repetiu o start" num codigo correto.
# Ja aconteceu ao escrever este caso.
religar_o_supabase > "$tmp/religa1.txt" 2>&1
religar_o_supabase > "$tmp/religa2.txt" 2>&1
[ ! -s "$tmp/religa1.txt" ] && [ ! -s "$tmp/religa2.txt" ] && ok "duas chamadas, nenhum alarme"   || nao "idempotente e calada" "(vazio)" "$(cat "$tmp/religa1.txt" "$tmp/religa2.txt")"
[ "$(grep -c "^start " "$diario")" -le 1 ] && ok "a segunda chamada nao repete o start"   || nao "nao repete o start" "no maximo 1" "$(grep -c "^start " "$diario")"


# -- O AVISO DE MANUTENCAO ---------------------------------------------------
#
# Ate aqui, quem estivesse com o CRM aberto durante a atualizacao via o erro de
# conexao do proprio navegador — uma tela que nao diz de quem e o problema nem
# quanto tempo dura. A pausa caiu de ~171s para 7s, o que encolheu a janela mas
# nao mudou o que se ve dentro dela.
#
# ⚠️ Sao DUAS hospedagens com caminhos diferentes, e os casos cobrem as duas:
# com proxy externo o roteamento vem de LABELS; com o Caddy do proprio kit a
# regra mora num arquivo dentro do conteiner, e o aviso assume o apelido `app`
# na rede interna.
export KIT_DIR="$RAIZ/hostgator-setup-kit"
# shellcheck disable=SC1090
. "$KIT_DIR/manutencao.sh"
set +e

duble_diario() {
  cat > "$tmp/bin/docker" <<DUBLE
#!/usr/bin/env bash
echo "\$*" >> "$diario"
exit 0
DUBLE
  chmod +x "$tmp/bin/docker"
}

echo "caso 20 — GUARDA DE VACUIDADE: as duas funcoes existem"
# Sem este caso os de baixo passam por acidente: "a saida nao contem tls=true" e
# verdade quando nao ha saida nenhuma.
if declare -F manutencao_sobe >/dev/null 2>&1 && declare -F manutencao_desce >/dev/null 2>&1; then
  ok "manutencao_sobe e manutencao_desce estao declaradas"
else
  nao "as duas funcoes existem" "declaradas em manutencao.sh" "ausente — os casos abaixo medem o nada"
fi

echo "caso 21 — com proxy externo, o aviso sobe roteado pelo dominio REAL"
: > "$diario"; duble_diario
REVERSE_PROXY=traefik DOMAIN="crm.exemplo.com.br" TRAEFIK_NETWORK=traefik manutencao_sobe >/dev/null 2>&1
linha="$(cat "$diario")"
case "$linha" in
  *"deskcomm-manutencao"*) ok "o aviso subiu" ;;
  *) nao "o aviso sobe" "run ... deskcomm-manutencao" "$linha" ;;
esac
case "$linha" in
  *"crm.exemplo.com.br"*) ok "com o dominio da instalacao na regra" ;;
  *) nao "dominio na regra" "Host(crm.exemplo.com.br)" "$linha" ;;
esac

echo "caso 22 — ⛔ REGRESSAO: certificado do Let's Encrypt, nao o interno do proxy"
# O plano desta onda escrevia `tls=true` sem resolvedor. O Traefik entao serve o
# certificado interno dele, e quem abrisse o CRM durante a atualizacao veria um
# aviso de SITE INSEGURO — pior que o erro de conexao que esta pagina veio tirar.
case "$linha" in
  *"tls.certresolver="*) ok "pede o certificado ao resolvedor de verdade" ;;
  *) nao "tls.certresolver" "tls.certresolver=<nome>" "$linha" ;;
esac
case "$linha" in
  *"tls=true"*) nao "sem tls=true pelado" "(ausente)" "$linha" ;;
  *) ok "e nao usa o tls=true pelado" ;;
esac

echo "caso 23 — ⛔ REGRESSAO: a variavel do dominio e DOMAIN, nao APP_DOMAIN"
# `APP_DOMAIN` nao existe em lugar nenhum do kit (medido: docker-compose.traefik.yml
# usa `${DOMAIN}`). Sob `set -u` a atualizacao morreria nessa linha — com o CRM
# JA PARADO, que e o pior momento possivel para o script morrer.
#
# ⚠️ A sonda le o CODIGO, nao o arquivo: as linhas de comentario sao removidas
# antes. A primeira versao olhava o arquivo inteiro e ficou vermelha por causa
# do comentario logo acima, que CITA `${APP_DOMAIN}` para explicar o erro. Guarda
# que reprova a documentacao do proprio erro ensina a apagar a documentacao.
codigo_manutencao="$(grep -v '^[[:space:]]*#' "$KIT_DIR/manutencao.sh")"
case "$codigo_manutencao" in
  *'${APP_DOMAIN'*) nao "nao usa APP_DOMAIN" "(ausente)" "manutencao.sh usa APP_DOMAIN no codigo" ;;
  *) ok "usa a variavel que o compose realmente define" ;;
esac
case "$codigo_manutencao" in
  *'${DOMAIN'*) ok "e a variavel usada e DOMAIN" ;;
  *) nao "usa DOMAIN" 'leitura de ${DOMAIN}' "ausente — a rota nasceria sem host" ;;
esac

echo "caso 24 — com o Caddy do kit, o aviso atende onde o Caddy procura"
: > "$diario"; duble_diario
REVERSE_PROXY=caddy PROJECT_DIR="/root/DeskcommCRM" manutencao_sobe >/dev/null 2>&1
linha_caddy="$(cat "$diario")"
case "$linha_caddy" in
  *"--network-alias app"*) ok "assume o apelido 'app' na rede interna" ;;
  *) nao "apelido app" "--network-alias app" "$linha_caddy" ;;
esac

echo "caso 24b — ⛔ o apelido vale TAMBEM com proxy externo (o terceiro arranjo)"
# MEDIDO na nossa VPS: o `.env` diz `REVERSE_PROXY=traefik` e NAO HA TRAEFIK. Quem
# atende 80/443 e o nginx do HOST, com `proxy_pass 127.0.0.1:3000`, e ali mora uma
# ponte `socat ... tcp-connect:app:3000`. Ninguem le rotulo. Sem o apelido nos dois
# ramos, a pagina sobe certinha e ninguem a ve — foi o que aconteceu na v1.17.21,
# 87 segundos de erro de navegador com o aviso de pe e correto.
case "$linha" in
  *"--network-alias app"*) ok "o apelido vem sempre, nao so no ramo do Caddy" ;;
  *) nao "apelido no ramo do proxy externo" "--network-alias app" "$linha" ;;
esac
case "$linha_caddy" in
  *"_internal"*) ok "na rede interna do projeto" ;;
  *) nao "rede interna" "<projeto>_internal" "$linha_caddy" ;;
esac

echo "caso 25 — o aviso desce quando o CRM volta"
: > "$diario"; duble_diario
REGRAS_FALTANDO="" PARADOS="" restaurar_servicos >/dev/null 2>&1
grep -q 'rm -f deskcomm-manutencao' "$diario" && ok "o aviso desceu" \
  || nao "aviso desce" "rm -f deskcomm-manutencao" "$(tr '\n' ';' < "$diario")"

echo "caso 26 — ⛔ CONTROLE: com regra faltando, o aviso FICA de pe"
# O CRM nao volta ao ar com regra de isolamento faltando. Nesse caso a pagina e a
# UNICA coisa que explica a quem tentar abrir por que o sistema nao responde.
: > "$diario"; duble_diario
REGRAS_FALTANDO="crm_leads_select|crm_leads" PARADOS="" restaurar_servicos >/dev/null 2>&1
grep -q 'rm -f deskcomm-manutencao' "$diario" \
  && nao "o aviso fica" "sem 'rm -f deskcomm-manutencao'" "$(tr '\n' ';' < "$diario")" \
  || ok "o aviso fica de pe explicando por que o CRM nao voltou"

echo "caso 27 — o aviso desce ANTES de o CRM subir, nunca depois"
# Com o Caddy os dois disputam o apelido `app`: o Docker faz rodizio, e metade
# das pessoas veria "estamos atualizando" com o CRM ja no ar.
COMUM="$(cat "$RAIZ/hostgator-setup-kit/_common.sh")"
p_desce="$(printf '%s' "$COMUM" | grep -n "manutencao_desce" | head -1 | cut -d: -f1)"
p_up="$(printf '%s' "$COMUM" | grep -n "dc up -d app worker scheduler" | head -1 | cut -d: -f1)"
if [ -n "$p_desce" ] && [ -n "$p_up" ] && [ "$p_desce" -lt "$p_up" ]; then
  ok "desce antes do 'up -d app'"
else
  nao "ordem da descida" "manutencao_desce antes de 'dc up -d app'" "desce=$p_desce up=$p_up"
fi

echo "caso 28 — o aviso sobe ANTES de o CRM parar"
# Entre parar e anunciar, quem estivesse com a tela aberta veria exatamente o
# erro de navegador que esta onda existe para tirar.
UP="$(cat "$RAIZ/hostgator-setup-kit/update.sh")"
q_sobe="$(printf '%s' "$UP" | grep -n "manutencao_sobe" | head -1 | cut -d: -f1)"
q_para="$(printf '%s' "$UP" | grep -n "pausar_o_que_fala_com_o_banco" | head -1 | cut -d: -f1)"
if [ -n "$q_sobe" ] && [ -n "$q_para" ] && [ "$q_sobe" -lt "$q_para" ]; then
  ok "sobe antes da pausa"
else
  nao "ordem da subida" "manutencao_sobe antes de pausar" "sobe=$q_sobe para=$q_para"
fi

echo "caso 29 — a pagina responde 503, e nao 200"
# Robo de monitoramento que recebe 200 nao avisa ninguem, e um buscador
# indexaria "estamos atualizando" como se fosse a tela inicial do CRM.
case "$(cat "$KIT_DIR/manutencao/nginx.conf")" in
  *"return 503"*) ok "diz 503 a quem pergunta por maquina" ;;
  *) nao "503" "return 503" "ausente" ;;
esac

echo "caso 30 — ⛔ o aviso desce no PROPRIO update.sh, antes do 'up -d' que traz o CRM"
# MEDIDO na atualizacao real para a v1.17.21: pendurar a descida so no gatilho de
# saida nao basta. O gatilho roda depois de mais quatro etapas, e o roteamento do
# aviso tem prioridade ACIMA da regra do app — entao o CRM voltava ao ar e quem
# abrisse continuava vendo "estamos atualizando" por minutos. Aviso que mente e
# pior que aviso nenhum.
q_desce="$(printf '%s' "$UP" | grep -n "^manutencao_desce$" | head -1 | cut -d: -f1)"
q_up="$(printf '%s' "$UP" | grep -n "^dc up -d$" | head -1 | cut -d: -f1)"
if [ -n "$q_desce" ] && [ -n "$q_up" ] && [ "$q_desce" -lt "$q_up" ]; then
  ok "desce antes do 'dc up -d' do proprio script"
else
  nao "descida no update.sh" "manutencao_desce antes de 'dc up -d'" "desce=$q_desce up=$q_up"
fi

echo "caso 31 — ⛔ a pagina NAO responde pela API do agente"
# MEDIDO na instalacao real: o agente reporta o proprio progresso em
# `POST /api/v1/system/agent`, pelo MESMO endereco publico que o navegador usa.
# Com o aviso de pe ele recebia a PAGINA INTEIRA de volta — 18 KB de HTML no
# registro de erro dele — e ficava cego justamente durante a janela que precisa
# narrar. Provado com nginx de verdade na VPS: navegador 503+pagina, API 503+JSON.
CONF="$(cat "$KIT_DIR/manutencao/nginx.conf")"
case "$CONF" in
  *"location ^~ /api/"*) ok "a API tem rota propria" ;;
  *) nao "rota propria para a API" "location ^~ /api/" "ausente" ;;
esac
# A ordem do `error_page` e o que separa o conserto do defeito: no `server` ele
# valeria tambem para o 503 da API, e a API voltaria a receber HTML.
if printf '%s' "$CONF" | grep -qE "^  location / \{" && printf '%s' "$CONF" | grep -qE "^    error_page 503"; then
  ok "o error_page mora DENTRO do location /, nao no server"
else
  nao "error_page escopado" "error_page 503 indentado dentro de location /" "fora de escopo"
fi

if [ "$falhas" -eq 0 ]; then
  echo "TUDO VERDE"
  exit 0
else
  echo "$falhas caso(s) vermelho(s)"
  exit 1
fi
