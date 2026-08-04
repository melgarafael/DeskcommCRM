#!/usr/bin/env bash
#
# Testa os validadores do install.sh — as guardas que impedem alguém de avançar
# a instalação com um dado errado. Só casos que NÃO dependem de rede: formato,
# papel da chave, projeto cruzado, Direct-connection e senha não codificada.
# As checagens online (curl/psql) são provadas na instalação real.
#
#   bash hostgator-setup-kit/test-validators.sh
#
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

INSTALL_SH_LIB=1 . ./install.sh
set +e   # o install.sh liga `set -e`; aqui esperamos validadores falharem de propósito

fail=0
# ok <descrição> <pass|reject> <validador> <valor> [trecho esperado na mensagem]
#
# O trecho esperado não é firula: sem ele o teste passa por acaso. Provado —
# ao remover o guard da Direct connection, a URL seguia até o psql e era
# rejeitada por *falha de conexão*, com o teste ainda verde. Rejeição só conta
# quando é pelo motivo certo, e é a mensagem que diz o motivo à pessoa.
ok() {
  local desc="$1" expect="$2" fn="$3" val="${4-}" want="${5-}"
  local out rc
  if out="$("$fn" "$val" 2>&1)"; then rc=0; else rc=$?; fi
  if [ "$expect" = pass ]; then
    if [ $rc -eq 0 ]; then printf '  ✓ %s\n' "$desc"
    else printf '  ✗ %s  (esperava aceitar, rejeitou: %s)\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1; fi
    return
  fi
  if [ $rc -eq 0 ]; then
    printf '  ✗ %s  (esperava rejeitar, aceitou)\n' "$desc"; fail=1; return
  fi
  if [ -n "$want" ] && ! printf '%s' "$out" | grep -qi -- "$want"; then
    printf '  ✗ %s  (rejeitou, mas pelo motivo errado)\n     esperava falar de: %s\n     disse: %s\n' \
      "$desc" "$want" "$(printf '%s' "$out" | head -1)"; fail=1; return
  fi
  printf '  ✓ %s\n' "$desc"
}

# A anon/service_role e a db_url comparam contra o projeto declarado.
NEXT_PUBLIC_SUPABASE_URL="https://abcdefghijklmnop.supabase.co"

# JWT falso: header.payload.assinatura, payload com role e ref.
mkjwt() {
  local payload; payload="$(printf '{"iss":"supabase","ref":"%s","role":"%s"}' "$2" "$1" \
    | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=')"
  printf 'eyJhbGciOiJIUzI1NiJ9.%s.assinatura' "$payload"
}

echo "domínio"
ok "aceita subdomínio"        pass   v_domain "crm.empresa.com.br"
ok "rejeita com https://"     reject v_domain "https://crm.empresa.com.br"  "sem https"
ok "rejeita com caminho"      reject v_domain "crm.empresa.com.br/app"      "sem barra"
ok "rejeita sem ponto"        reject v_domain "localhost"                   "falta o ponto"

echo "e-mail"
ok "aceita e-mail válido"     pass   v_email "voce@empresa.com.br"
ok "rejeita sem @"            reject v_email "voce.empresa.com.br"          "inválido"

echo "chaves do Supabase (formato/papel/projeto)"
ok "rejeita service_role no campo anon" reject v_anon    "$(mkjwt service_role abcdefghijklmnop)" "preciso da 'anon'"
ok "rejeita anon no campo service_role" reject v_service "$(mkjwt anon abcdefghijklmnop)"         "preciso da 'service_role'"
ok "rejeita chave de outro projeto"     reject v_anon    "$(mkjwt anon zzzzzzzzzzzzzzzz)"         "OUTRO projeto"
ok "rejeita texto que não é chave"      reject v_anon    "minha-chave-secreta"                    "não parece uma chave"

echo "connection string"
ok "rejeita [YOUR-PASSWORD] não trocado" reject v_db_url "postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-1-us-west-2.pooler.supabase.com:5432/postgres" "troque isso pela senha"
ok "rejeita Direct connection (IPv6)"    reject v_db_url "postgresql://postgres:senha@db.abcdefghijklmnop.supabase.co:5432/postgres"                                "Session pooler"
ok "rejeita string de outro projeto"     reject v_db_url "postgresql://postgres.zzzzzzzzzzzzzzzz:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres"          "mesmo projeto"
ok "rejeita o que não é URL de Postgres" reject v_db_url "aws-1-us-west-2.pooler.supabase.com"                                                                     "começa com postgresql"

echo "chaves de IA e senha"
ok "rejeita chave Anthropic com prefixo errado" reject v_anthropic "sk-proj-abc123" "começa com 'sk-ant-'"
ok "rejeita chave OpenAI com prefixo errado"    reject v_openai    "minha-chave"    "começa com 'sk-'"
ok "aceita OpenAI vazia (é opcional)"           pass   v_openai    ""
ok "rejeita senha curta"                        reject v_password  "1234567"        "muito curta"
ok "aceita senha de 8+"                         pass   v_password  "12345678"

echo "leitura do .env (load_env)"
. ./_common.sh
set +e
TMP="$(mktemp -d)"
cat > "$TMP/.env" <<'EOF'
# comentário deve ser ignorado
APP_NAME='Loja do João'
SENHA_COM_HASH='a#b'
SENHA_COM_CIFRAO='p$ass'
COM_ASPAS_DUPLAS="valor com espaço"
SEM_ASPAS=simples
LEGADO_SEM_ASPAS=Loja Antiga
linha sem igual
EOF
( load_env "$TMP/.env"
  eq() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  esperava [%s] obteve [%s]\n' "$1" "$3" "$2"; exit 1; fi; }
  eq "nome com espaço"            "$APP_NAME"            "Loja do João"
  eq "senha com # não trunca"     "$SENHA_COM_HASH"      'a#b'
  eq "senha com \$ não expande"    "$SENHA_COM_CIFRAO"    'p$ass'
  eq "aspas duplas"               "$COM_ASPAS_DUPLAS"    "valor com espaço"
  eq "sem aspas"                  "$SEM_ASPAS"           "simples"
  eq "legado sem aspas c/ espaço" "$LEGADO_SEM_ASPAS"    "Loja Antiga"
) || fail=1
rm -rf "$TMP"

echo "credenciais do provisionamento (sb_carrega_credenciais)"
# Este bloco existe porque a leitura já foi feita com `eval`, e com `eval` ela
# EXECUTAVA o conteúdo: o provisionamento imprime `CHAVE='valor'` sem escapar a
# aspa simples, e SUPABASE_REGION — que vem do ambiente — é interpolada dentro da
# connection string. Medido: com `eval`, o marcador abaixo era criado.
TMP2="$(mktemp -d)"
(
  MARCA="$TMP2/executou"
  # Exatamente o que o provisionamento emite quando a região traz uma aspa simples.
  VENENO="postgresql://postgres.ref:senha@aws-0-sa-east-1'\$(touch $MARCA)'.pooler.supabase.com:5432/postgres"
  PATH_ANTES="$PATH"
  unset NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL

  sb_carrega_credenciais "$(printf "SUPABASE_DB_URL='%s'\n" "$VENENO")"

  eq() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  esperava [%s] obteve [%s]\n' "$1" "$3" "$2"; exit 1; fi; }
  if [ -e "$MARCA" ]; then printf '  ✗ aspa simples no valor EXECUTOU comando\n'; exit 1; fi
  printf '  ✓ aspa simples no valor não executa comando\n'
  eq "valor com aspa chega literal"    "${SUPABASE_DB_URL:-}"  "$VENENO"

  # Chave fora da lista fixa é ignorada — a saída não pode criar variável qualquer.
  sb_carrega_credenciais "PATH='/pwn'"
  eq "chave desconhecida é ignorada"   "$PATH"                 "$PATH_ANTES"

  # E o caminho feliz continua inteiro.
  unset SUPABASE_DB_URL
  sb_carrega_credenciais "$(printf "NEXT_PUBLIC_SUPABASE_URL='https://abc.supabase.co'\nSUPABASE_DB_URL='postgresql://u:p@h:5432/postgres'\n")"
  eq "url normal chega íntegra"        "${NEXT_PUBLIC_SUPABASE_URL:-}" "https://abc.supabase.co"
  eq "db_url normal chega íntegra"     "${SUPABASE_DB_URL:-}"          "postgresql://u:p@h:5432/postgres"
) || fail=1
rm -rf "$TMP2"

echo "integração: o install.sh não INTERPRETA a saída do provisionamento"
# O bloco de cima guarda a FUNÇÃO; este guarda o PONTO DE CHAMADA — trocar
# `sb_carrega_credenciais "$_sb_out"` de volta por `eval "$_sb_out"` passava
# despercebido, porque a função continuava correta e ninguém mais a chamava.
#
# Guarda o COMPORTAMENTO, não o texto: uma asserção do tipo "não existe a palavra
# eval" pegaria só a reincidência literal, e `. <(printf %s "$_sb_out")` executa
# igual. Aqui o install.sh roda de verdade (docker é stub, nada de rede) com um
# provisionamento que devolve uma aspa simples no valor; se qualquer mecanismo
# interpretar aquilo, o marcador aparece.
TMP3="$(mktemp -d)"
(
  MARCA="$TMP3/executou"
  mkdir -p "$TMP3/bin" "$TMP3/proj"
  cp install.sh _common.sh "$TMP3/"
  : > "$TMP3/proj/docker-compose.prod.yml"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP3/bin/docker"; chmod +x "$TMP3/bin/docker"
  cat > "$TMP3/supabase-provision.sh" <<'PROV'
#!/usr/bin/env bash
# O que o provisionamento emite quando SUPABASE_REGION (que vem do ambiente)
# traz uma aspa simples: ela fecha o literal do printf e o resto vira código.
VENENO="postgresql://u:p@aws-0-x'\$(touch $MARCA)'.pooler.supabase.com:5432/postgres"
printf "NEXT_PUBLIC_SUPABASE_URL='https://ref.supabase.co'\n"
printf "NEXT_PUBLIC_SUPABASE_ANON_KEY='a'\n"
printf "SUPABASE_SERVICE_ROLE_KEY='s'\n"
printf "SUPABASE_DB_URL='%s'\n" "$VENENO"
PROV

  saida="$(cd "$TMP3/proj" && env PATH="$TMP3/bin:$PATH" MARCA="$MARCA" \
    SUPABASE_ACCESS_TOKEN=fake NEXT_PUBLIC_SUPABASE_URL= \
    bash "$TMP3/install.sh" --yes 2>&1 || true)"

  # Sem esta checagem o teste passaria por VACUIDADE: se o install.sh morresse
  # antes do bloco (stub quebrado, refactor movendo o trecho), nada executaria o
  # veneno e o silêncio seria lido como aprovação.
  if ! printf '%s' "$saida" | grep -q "credenciais entraram sozinhas"; then
    printf '  ✗ o install.sh não chegou ao bloco do Supabase — teste inconclusivo, não verde\n'; exit 1
  fi
  if [ -e "$MARCA" ]; then
    printf '  ✗ o install.sh INTERPRETOU a saída do provisionamento (eval/source no ponto de chamada?)\n'; exit 1
  fi
  printf '  ✓ ponto de chamada não interpreta a saída\n'
) || fail=1
rm -rf "$TMP3"

echo "sincronia: o install.sh grava as chaves que o .env.hostgator.example promete"
# O install.sh monta o .env a partir de uma LISTA FECHADA de `envq` e fecha com
# `} > .env`, que TRUNCA. Chave fora da lista simplesmente não é gravada — e se a
# pessoa a tiver posto à mão, some no próximo install, num script que o README
# vende como idempotente. Medido: uma chave posta à mão é carregada por load_env
# e depois DESCARTADA na escrita.
#
# Passou despercebido porque o env-example-sync do repo compara .env.example com
# lib/env.ts e nunca olha para o install.sh — ninguém guardava esta ponta.
#
# DÍVIDA: chaves que o install.sh hoje não grava. A lista só pode ENCOLHER; se
# uma delas passar a ser gravada, o teste manda tirá-la daqui.
DIVIDA="AGENT_DISPATCH_CONSUMER NUVEMSHOP_APP_ID NUVEMSHOP_CLIENT_ID NUVEMSHOP_CLIENT_SECRET RESEND_API_KEY RESEND_FROM_EMAIL"
EXEMPLO="${EXEMPLO_ENV:-../.env.hostgator.example}"
if [ ! -f "$EXEMPLO" ]; then
  # Pular é aceitável (o kit também roda solto, fora do repo), mas em voz alta:
  # pulo silencioso é indistinguível de teste que passou.
  printf '  — pulado: %s não existe (kit fora do repositório)\n' "$EXEMPLO"
else
  GRAVA="$(grep -oE '^[[:space:]]*envq [A-Z_0-9]+' install.sh | awk '{print $2}' | sort -u)"
  novas=""
  for k in $(grep -oE '^[A-Z_0-9]+=' "$EXEMPLO" | tr -d '=' | sort -u); do
    printf '%s\n' "$GRAVA" | grep -qx "$k" && continue
    case " $DIVIDA " in *" $k "*) continue ;; esac
    novas="$novas $k"
  done
  if [ -n "$novas" ]; then
    printf '  ✗ o .env.hostgator.example promete chave(s) que o install.sh não grava:%s\n' "$novas"
    printf '     quem instalar pelo kit não recebe essa configuração; quem puser à mão perde no próximo install\n'
    fail=1
  else
    printf '  ✓ nenhuma chave nova fora da lista de escrita\n'
  fi
  estagnada=""
  for k in $DIVIDA; do
    printf '%s\n' "$GRAVA" | grep -qx "$k" && estagnada="$estagnada $k"
  done
  if [ -n "$estagnada" ]; then
    printf '  ✗ já é gravada pelo install.sh — tire da lista DÍVIDA deste teste:%s\n' "$estagnada"
    fail=1
  else
    printf '  ✓ dívida ainda condiz (%s chaves conhecidas, só pode encolher)\n' "$(printf '%s' "$DIVIDA" | wc -w | tr -d ' ')"
  fi
fi

echo "resposta afirmativa (resposta_sim)"
# O gate do DNS comparava a resposta com a string "s" EXATA: quem digitava "S"
# ou "sim" — a resposta certa, com a tecla errada — era morto por um `die` que
# ainda dizia "Ajuste o DNS", frase que não corresponde ao que a pessoa
# escolheu. Mesmo defeito no reset-mfa.sh. Estes casos são o contrato de que
# nenhum prompt do kit volte a ler a intenção pela grafia.
sim_ok() {  # sim_ok <descrição> <sim|nao> <entrada>
  local desc="$1" esperado="$2" val="${3-}" real
  if resposta_sim "$val"; then real=sim; else real=nao; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (esperava %s, deu %s para "%s")\n' "$desc" "$esperado" "$real" "$val"; fail=1; fi
}
sim_ok "s minúsculo"             sim "s"
sim_ok "S maiúsculo"             sim "S"
sim_ok "sim por extenso"         sim "sim"
sim_ok "SIM em caixa alta"       sim "SIM"
sim_ok "y (teclado em inglês)"   sim "y"
sim_ok "yes"                     sim "yes"
sim_ok "espaço em volta"         sim "  s  "
sim_ok "Enter (vazio) é não"     nao ""
sim_ok "n"                       nao "n"
sim_ok "nao"                     nao "nao"
sim_ok "não com acento"          nao "não"
sim_ok "palavra qualquer"        nao "talvez"
sim_ok "'sims' não vira sim"     nao "sims"

echo "gêmeas: resposta_sim vale nos DOIS arquivos"
# Esta suíte sourceia install.sh, mas outros blocos sourceiam _common.sh — e a
# definição que sobrevive é a do último. Descoberto sabotando: com a gêmea do
# install.sh devolvendo "sim" para tudo, os casos acima continuavam VERDES,
# porque quem respondia era a cópia boa do _common.sh. Metade da correção
# estava sem rede. Cada gêmea passa a ser exercitada dentro do seu arquivo,
# num shell separado.
gemea_ok() {  # gemea_ok <arquivo> <entrada> <sim|nao>
  local arq="$1" val="$2" esperado="$3" real
  if bash -c 'INSTALL_SH_LIB=1 . "./$0" >/dev/null 2>&1; resposta_sim "$1"' "$arq" "$val"
  then real=sim; else real=nao; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s: "%s" → %s\n' "$arq" "$val" "$real"
  else printf '  ✗ %s: "%s" deu %s, esperava %s\n' "$arq" "$val" "$real" "$esperado"; fail=1; fi
}
for arquivo in install.sh _common.sh; do
  gemea_ok "$arquivo" "S"      sim
  gemea_ok "$arquivo" "sim"    sim
  gemea_ok "$arquivo" "nao"    nao
  gemea_ok "$arquivo" ""       nao
done

echo "RAM: o aviso não pode cair em quem comprou a VPS recomendada"
# MemTotal é sempre MENOR que o vendido (o kernel reserva). Medido: 8 GiB
# configurados reportam 8025284 KB (95,7%). Os valores abaixo são o que cada
# tamanho de VPS realmente reporta — o de 4 GB é o caso que este teste existe
# para proteger, nas duas convenções em que provedores vendem "4 GB".
ram_ok() {  # ram_ok <descrição> <avisa|silencia> <mem_kb>
  local desc="$1" esperado="$2" kb="$3" real
  if ram_abaixo_do_recomendado "$kb"; then real=avisa; else real=silencia; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (%s KB → %s, esperava %s)\n' "$desc" "$kb" "$real" "$esperado"; fail=1; fi
}
ram_ok "VPS de 4 GiB (95,7% reportado)"        silencia 4012000
ram_ok "VPS de 4 GB decimais (pior caso)"      silencia 3735000
ram_ok "VPS de 8 GB (medido de verdade)"       silencia 8025284
ram_ok "VPS de 3 GB — abaixo do recomendado"   avisa    2900000
ram_ok "VPS de 2 GB — o plano que não dá conta" avisa   1950000

echo "saúde do app (wait_app_healthy)"
# O install.sh dava o app por bom quando a PORTA 3000 aceitava conexão — o que
# acontece assim que o Node sobe, antes de ele saber se alcança o banco. O caso
# "corpo vazio" abaixo é exatamente esse: com o probe antigo era verde, e o
# "Instalação concluída!" saía por cima de um app quebrado.
# Os payloads abaixo são o CONTRATO REAL da rota, capturado do app em produção
# — não um formato inventado aqui. A versão anterior destes testes mockava
# {"status":"ok"}, que o produto NUNCA emite: `ok` é o vocabulário dos checks
# individuais, e o status geral usa healthy|degraded|unhealthy. O teste passava
# validando um contrato que não existia.
HEALTHY='{"data":{"status":"healthy","version":"0.1.0","checks":{"supabase":{"status":"ok","latency_ms":268},"redis":{"status":"ok","latency_ms":4},"waha":{"status":"ok","latency_ms":6}}}}'
DEGRADED='{"data":{"status":"degraded","checks":{"supabase":{"status":"ok"},"waha":{"status":"degraded","error":"not_configured"}}}}'
UNHEALTHY='{"data":{"status":"unhealthy","checks":{"supabase":{"status":"down","error":"http_500"},"redis":{"status":"ok"}}}}'

saude_ok() {  # saude_ok <descrição> <saudavel|nao> <status> <corpo real>
  local desc="$1" esperado="$2" st="$3" corpo="$4" real
  if ST="$st" CORPO="$corpo" bash -c '
        . ./_common.sh
        app_health_probe() { printf "%s\n%s\n" "${ST}" "${CORPO}"; }
        wait_app_healthy 2 0
      ' >/dev/null 2>&1
  then real=saudavel; else real=nao; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
saude_ok "healthy (payload real de produção)"   saudavel healthy   "$HEALTHY"
saude_ok "degraded: serviço opcional sem config" saudavel degraded "$DEGRADED"
saude_ok "unhealthy AINDA QUE o redis esteja ok" nao      unhealthy "$UNHEALTHY"
saude_ok "porta aberta, app mudo"                nao      ''        ''
saude_ok "proxy devolveu HTML de erro"           nao      ''        '<html>502 Bad Gateway</html>'

echo "rascunho das respostas (save_partial → load_env)"
# Quem trava na connection string — a pergunta mais difícil, e a última das
# credenciais — perdia as 11 respostas anteriores. O que importa aqui é o
# ROUND-TRIP: o valor que volta tem de ser byte a byte o que foi digitado,
# senão a retomada entrega uma senha adulterada e o erro só aparece lá no
# psql. Os valores abaixo são os que quebram parser ingênuo.
partial_ok() {  # partial_ok <descrição> <valor>
  # kit capturado ANTES do cd: dentro de $( cd "$dir" && … ) o $PWD já é o
  # temporário, e passar ele como origem dos scripts fazia o subshell não achar
  # nem install.sh nem _common.sh — e o round-trip voltava vazio, indistinguível
  # de "o valor se perdeu no arquivo".
  local desc="$1" val="$2" dir out kit="$PWD"
  dir="$(mktemp -d)"
  # As duas fontes: envq/save_partial vivem no install.sh, load_env no
  # _common.sh — e o guard de biblioteca do install.sh retorna antes de
  # sourceá-lo. Carregar só um dos dois deixa a metade que falta indefinida, e
  # o round-trip volta vazio como se o valor tivesse se perdido.
  out="$(cd "$dir" && PARTIAL_FILE=".p" bash -c '
      . "$1/_common.sh"
      INSTALL_SH_LIB=1 . "$1/install.sh"
      SENHA="$2"
      save_partial SENHA
      unset SENHA
      load_env .p
      printf "%s" "$SENHA"
    ' _ "$kit" "$val")"
  rm -rf "$dir"
  if [ "$out" = "$val" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     escreveu: [%s]\n     voltou:   [%s]\n' "$desc" "$val" "$out"; fail=1; fi
}
partial_ok "senha simples"              'abc123'
partial_ok "com espaço"                 'minha senha boa'
partial_ok "com # (não é comentário)"   'se#nha'
partial_ok "com \$ (não expande)"       'se$nha$HOME'
partial_ok "com aspa simples"           "se'nha"
partial_ok "com aspas duplas"           'se"nha"'
partial_ok "connection string real"     'postgresql://postgres.abc:p%40ss@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'

echo "cron: instalar uma instância não pode silenciar a outra"
# Fixture = o crontab REAL de uma VPS com produção rodando (o Bearer trocado por
# placeholder). O filtro antigo era `grep -v 'event-log-drain'`, que casava com
# a linha de QUALQUER instalação: subir uma segunda instância na mesma máquina
# apagava as duas linhas da primeira, em silêncio.
CRONTAB_VIZINHO='0 8 * * * /root/trend-radar/run_full_vps.sh
* * * * * curl -fsS -H "Authorization: Bearer SEGREDO" "https://crm.deskcomm.com.br/api/v1/cron/event-log-drain" >/dev/null 2>&1
*/5 * * * * cd /root/Aula-Youtube/DeskcommCRM && bash hostgator-setup-kit/agent.sh >/dev/null 2>&1'

cron_ok() {  # cron_ok <descrição> <esperado_no_resultado> <marcador> <legado> <linha_nova>
  local desc="$1" espera="$2" marcador="$3" legado="$4" nova="$5" out
  out="$(printf '%s\n' "$CRONTAB_VIZINHO" | cron_merge "$marcador" "$legado" "$nova")"
  if printf '%s' "$out" | grep -qF -e "$espera"; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     sumiu do crontab: %s\n' "$desc" "$espera"; fail=1; fi
}
NOVO_TAG='# deskcomm:/root/instalacao-nova'
NOVA_URL='https://crm-novo.exemplo.com.br/api/v1/cron/event-log-drain'
cron_ok "o drain do vizinho sobrevive"  'crm.deskcomm.com.br/api/v1/cron/event-log-drain' \
        "$NOVO_TAG" "$NOVA_URL" "* * * * * curl \"$NOVA_URL\" $NOVO_TAG"
cron_ok "o agente do vizinho sobrevive" 'cd /root/Aula-Youtube/DeskcommCRM && bash hostgator-setup-kit/agent.sh' \
        "$NOVO_TAG" "cd /root/instalacao-nova && bash hostgator-setup-kit/agent.sh" \
        "*/5 * * * * cd /root/instalacao-nova && bash hostgator-setup-kit/agent.sh $NOVO_TAG"
cron_ok "a linha alheia (trend-radar) sobrevive" '/root/trend-radar/run_full_vps.sh' \
        "$NOVO_TAG" "$NOVA_URL" "* * * * * curl \"$NOVA_URL\" $NOVO_TAG"

# Re-executar a MESMA instalação substitui a própria linha em vez de empilhar —
# inclusive a legada, escrita antes de o marcador existir.
reexec="$(printf '%s\n' "$CRONTAB_VIZINHO" | cron_merge '# deskcomm:/root/Aula-Youtube/DeskcommCRM' \
          'cd /root/Aula-Youtube/DeskcommCRM && bash hostgator-setup-kit/agent.sh' \
          '*/5 * * * * cd /root/Aula-Youtube/DeskcommCRM && bash hostgator-setup-kit/agent.sh # deskcomm:/root/Aula-Youtube/DeskcommCRM')"
n_agent="$(printf '%s\n' "$reexec" | grep -cF 'hostgator-setup-kit/agent.sh')"
if [ "$n_agent" = 1 ]; then printf '  ✓ re-executar a mesma instalação não duplica a linha\n'
else printf '  ✗ re-executar duplicou: %s linhas de agent.sh\n' "$n_agent"; fail=1; fi

# As DUAS linhas da mesma instalação têm de coexistir. Com um marcador só por
# instalação (sem o papel), a segunda função a rodar apagava a linha da
# primeira — as duas casavam com o mesmo marcador. Medido na VPS: depois de
# instalar sobrava só o agente, e o CRM ficava SEM o drain de eventos, com a
# automação inteira parada em silêncio. Este teste roda as duas em sequência,
# como a instalação faz.
DIR=/root/instalacao-nova
TAG_DRAIN="# deskcomm:${DIR}:drain"; TAG_AGENT="# deskcomm:${DIR}:agent"
L_DRAIN="* * * * * curl \"https://novo.exemplo.com.br/api/v1/cron/event-log-drain\" $TAG_DRAIN"
L_AGENT="*/5 * * * * cd ${DIR} && bash hostgator-setup-kit/agent.sh $TAG_AGENT"
depois_drain="$(printf '%s\n' "$CRONTAB_VIZINHO" | cron_merge "$TAG_DRAIN" 'https://novo.exemplo.com.br/api/v1/cron/event-log-drain' "$L_DRAIN")"
depois_agent="$(printf '%s\n' "$depois_drain" | cron_merge "$TAG_AGENT" "cd ${DIR} && bash hostgator-setup-kit/agent.sh" "$L_AGENT")"
# Conta as DUAS linhas pelo que elas fazem (a URL do drain, o cd do agente), não
# pelo formato do marcador: uma asserção sobre o marcador reprovaria uma mudança
# de formato inofensiva e passaria por perto do que importa, que é as duas
# tarefas continuarem agendadas.
tem_drain="$(printf '%s\n' "$depois_agent" | grep -cF 'novo.exemplo.com.br/api/v1/cron/event-log-drain')"
tem_agent="$(printf '%s\n' "$depois_agent" | grep -cF "cd ${DIR} && bash hostgator-setup-kit/agent.sh")"
if [ "$tem_drain" -ge 1 ] && [ "$tem_agent" -ge 1 ]; then
  printf '  ✓ drain e agente da mesma instalação coexistem\n'
else
  printf '  ✗ uma apagou a outra (drain=%s, agente=%s — esperava 1 de cada)\n' "$tem_drain" "$tem_agent"; fail=1
fi

echo "provisionamento do Supabase: senha do banco"
# Dois testes distintos, porque o defeito e o contrato moram em lugares
# diferentes — e o primeiro teste que escrevi aqui era VÁCUO por não separá-los.
#
# (1) CALL SITE. O bug era a atribuição no escopo do script: com pipefail, o
#     SIGPIPE do `tr` virava o status da atribuição e o `set -e` matava tudo,
#     logo depois de a senha existir. Medido: o mesmo pipe DENTRO de uma função
#     sobrevive (o status passa a ser o do printf final), no escopo sai 141.
#     Então testar a função não pega a regressão que importa — quem pega é
#     rodar o script e exigir que ele CHEGUE ao passo seguinte.
#     O passo 3 imprime o título antes de tocar a rede, então a asserção não
#     depende de a API responder (e o token aqui é propositalmente inválido).
saida="$(SUPABASE_ACCESS_TOKEN=token-invalido-de-teste SUPABASE_ORG_ID=org-de-teste \
         bash ./supabase-provision.sh "Projeto de Teste" sa-east-1 2>&1 || true)"
if printf '%s' "$saida" | grep -q 'Criando o projeto'; then
  printf '  ✓ o script passa da geração da senha e chega ao passo de criar\n'
else
  printf '  ✗ o script MORREU antes de criar o projeto (o defeito voltou)\n'
  printf '     última linha vista: %s\n' "$(printf '%s' "$saida" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -v '^$' | tail -1)"
  fail=1
fi

# (2) CONTRATO da senha. Ela entra na connection string: um '@' ou '/' aqui
#     parte o host no meio, e o erro só apareceria no psql.
senha="$(bash -c 'set -euo pipefail; SUPABASE_PROVISION_LIB=1 . ./supabase-provision.sh; gen_db_pass' 2>/dev/null)"
if [ "${#senha}" = 32 ]; then printf '  ✓ 32 caracteres\n'
else printf '  ✗ senha com %s caracteres, esperava 32\n' "${#senha}"; fail=1; fi
case "$senha" in
  *[!A-Za-z0-9]*) printf '  ✗ tem caractere que quebra a connection string\n'; fail=1;;
  '')             printf '  ✗ senha vazia\n'; fail=1;;
  *)              printf '  ✓ só alfanuméricos (não parte a connection string)\n';;
esac

echo "proxy reverso: quem está com as portas 80/443"
# A versão anterior só sabia procurar Traefik. Qualquer outro proxy — inclusive o
# Caddy de OUTRO DeskcommCRM na mesma VPS — caía no ramo "portas livres", e a
# instalação seguia até a fase 4 para morrer com "Bind for 0.0.0.0:80 failed:
# port is already allocated". Medido numa VPS com produção rodando.
# dono_das_portas lê o que o `docker ps` imprime de verdade. Os casos com "->"
# vêm da coluna Ports real; o que decide é o lado ANTES da seta (a porta do
# HOST). A primeira versão disto olhava a porta INTERNA e errava dos dois lados.
dono_ok() {  # dono_ok <descrição> <esperado: nome|imagem ou vazio> <linhas do docker ps>
  local desc="$1" esperado="$2" linhas="$3" real
  real="$(printf '%s\n' "$linhas" | dono_das_portas || true)"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     deu:      [%s]\n     esperava: [%s]\n' "$desc" "$real" "$esperado"; fail=1; fi
}
dono_ok "proxy publicando 80 no host é encontrado" \
  'traefik|infra|traefik:v3.3' 'traefik|infra|traefik:v3.3|0.0.0.0:80->80/tcp, [::]:80->80/tcp'
dono_ok "app em 8080->80 NÃO é ocupante (80 do host livre)" \
  '' 'phpmyadmin|web|phpmyadmin:latest|0.0.0.0:8080->80/tcp'
dono_ok "proxy sem privilégio (80->8080) É ocupante" \
  'traefik|infra|traefik:v3' 'traefik|infra|traefik:v3|0.0.0.0:80->8080/tcp'
dono_ok "Caddy de outro Deskcomm é encontrado" \
  'outro-caddy-1|outro|caddy:2-alpine' 'outro-caddy-1|outro|caddy:2-alpine|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp'
dono_ok "contêiner sem porta publicada é ignorado" \
  '' 'worker|app|meu/worker|'
dono_ok "só 443 no host também conta" \
  'proxy|infra|nginx' 'proxy|infra|nginx|0.0.0.0:443->443/tcp'
# A varredura NÃO exclui mais ninguém: quem decide é o chamador, comparando o
# projeto. Excluir aqui produzia um "ocupado por ninguém" — bloqueio sem
# comando acionável — porque o teste de bind não tem como se auto-excluir.
dono_ok "contêiner desta instalação é IDENTIFICADO (com o projeto)" \
  'crm-caddy-1|meu-projeto|caddy:2-alpine' 'crm-caddy-1|meu-projeto|caddy:2-alpine|0.0.0.0:80->80/tcp'
# Sem label de compose, o campo do meio vem VAZIO — com IFS de tab ele colapsava
# e a imagem sumia, fazendo um Traefik de `docker run` virar intruso.
dono_ok "contêiner sem label de compose mantém a imagem" \
  'meu-traefik||traefik:v3.1' 'meu-traefik||traefik:v3.1|0.0.0.0:80->80/tcp'

echo "proxy reverso: é um Traefik?"
tk_ok() {  # tk_ok <descrição> <sim|nao> <imagem> <nome>
  local desc="$1" esperado="$2" real
  if eh_traefik "${3:-}" "${4:-}"; then real=sim; else real=nao; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
tk_ok "imagem traefik"                   sim "traefik:v3.3"      "proxy-01"
tk_ok "nome com maiúsculas (TRAEFIK)"    sim "meureg/proxy:3"    "TRAEFIK-PROXY"
tk_ok "coolify-proxy é traefik na imagem" sim "traefik:v2.11"    "coolify-proxy"
tk_ok "caddy não é traefik"              nao "caddy:2-alpine"    "outro-caddy-1"
tk_ok "nginx não é traefik"              nao "nginxproxy/nginx"  "webproxy"

echo "proxy reverso: a decisão"
dec_ok() {  # dec_ok <descrição> <esperado> <ocupadas> <proj_dono> <proj_atual> <img> <nome>
  local desc="$1" esperado="$2" real
  real="$(decide_proxy "${3:-}" "${4:-}" "${5:-}" "${6:-}" "${7:-}")"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
dec_ok "portas livres → nosso Caddy"        caddy    ""        ""          "crm" ""              ""
# ESTE é o caso que a revisão pegou: o teste de bind não tem como se
# auto-excluir, então numa re-execução as portas aparecem ocupadas — pelo nosso
# PRÓPRIO Caddy. Tratar isso como intruso bloqueia a instalação que o kit manda
# rodar de novo para corrigir uma resposta, e sem nem um comando acionável.
dec_ok "re-execução: portas com esta mesma instalação" caddy "80 e 443" "crm" "crm" "caddy:2-alpine" "crm-caddy-1"
dec_ok "Caddy de OUTRO Deskcomm → bloqueia" bloqueia "80 e 443" "outro"     "crm" "caddy:2-alpine" "outro-caddy-1"
dec_ok "Traefik da hospedagem → por ele"    traefik  "80 e 443" "coolify"   "crm" "traefik:v3.3"   "coolify-proxy"
dec_ok "ocupante não identificado → bloqueia" bloqueia "80"     ""          "crm" ""              ""
dec_ok "projeto vazio não casa projeto vazio" bloqueia "80"     ""          ""    "nginx"         "web"

echo "proxy reverso: os nomes dos entrypoints do Traefik"
# Os defaults `web`/`websecure` são os do Dokploy, não uma convenção. Easypanel
# usa `http`/`https`, e o erro é MUDO: o Traefik não reclama de label apontando
# para entrypoint inexistente, só não cria a rota — o domínio cai no 404
# catch-all e o `up -d` termina dizendo "Started". Medido em produção (Easypanel,
# Traefik 3.6.7).
#
# Os dois casos que decidem o resultado saíram de medir um Traefik v3.6 real,
# não da documentação — e um deles é contra-intuitivo (argumento SUBSTITUI o
# ambiente em vez de somar). Estão marcados abaixo.
tn_ok() {  # tn_ok <descrição> <esperado "http|https|cert"> <blob>
  local desc="$1" esperado="$2" real
  real="$(traefik_nomes "$3")"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     deu:      [%s]\n     esperava: [%s]\n' "$desc" "$real" "$esperado"; fail=1; fi
}

# Easypanel, copiado da VPS de produção onde o bug apareceu.
tn_ok "Easypanel (env): http/https" 'http|https|letsencrypt' 'env TRAEFIK_ENTRYPOINTS_HTTP_ADDRESS=:80
env TRAEFIK_ENTRYPOINTS_HTTPS_ADDRESS=:443
env TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL=dono@exemplo.com.br
env TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_STORAGE=/etc/traefik/acme.json
env PATH=/usr/local/bin:/usr/bin'

# Dokploy — o par que o kit já assumia. Detectar não pode mudar o que já
# funciona: aqui a detecção precisa CONFIRMAR o default, não substituí-lo.
tn_ok "Dokploy (args): web/websecure" 'web|websecure|letsencrypt' 'cmd --providers.docker=true
cmd --entrypoints.web.address=:80
cmd --entrypoints.websecure.address=:443
cmd --certificatesresolvers.letsencrypt.acme.httpchallenge=true'

# MEDIDO em traefik:v3.6 — a linha de comando não SOMA ao ambiente, SUBSTITUI o
# mapa inteiro. Com env http/https + arg `outro`, a API do Traefik lista só
# `outro`: os entrypoints do ambiente somem. Ler as duas fontes juntas daria
# `http`, um entrypoint que naquele proxy não existe mais.
tn_ok "argumento apaga o mapa que veio do ambiente" '|outro|' 'env TRAEFIK_ENTRYPOINTS_HTTP_ADDRESS=:80
env TRAEFIK_ENTRYPOINTS_HTTPS_ADDRESS=:443
cmd --entrypoints.outro.address=:443'

# MEDIDO em traefik:v3.6 — o nome vindo do ambiente vira minúscula
# (TRAEFIK_ENTRYPOINTS_HTTP_ADDRESS → `http`), o vindo de argumento mantém a
# caixa (--entryPoints.WebSecure → `WebSecure`). O label cita o nome exato, e
# nomear `websecure` um entrypoint que se chama `WebSecure` é o mesmo 404.
tn_ok "argumento preserva a caixa do nome" '|WebSecure|' 'cmd --entryPoints.WebSecure.address=:443'
tn_ok "ambiente minúscula o nome"          '|websecure|' 'env TRAEFIK_ENTRYPOINTS_WEBSECURE_ADDRESS=:443'

tn_ok "endereço com host explícito"    'web|websecure|' 'cmd --entrypoints.web.address=0.0.0.0:80
cmd --entrypoints.websecure.address=[::]:443'
# QUIC/HTTP3 declara :443/udp num entrypoint separado. Ele não serve rota HTTP —
# escolhê-lo é o mesmo 404, com o agravante de parecer certo.
tn_ok "entrypoint /udp (QUIC) não é o da rota" '|websecure|' 'cmd --entrypoints.websecure.address=:443
cmd --entrypoints.quic.address=:443/udp'
tn_ok "porta que não é 80/443 é ignorada" '||' 'cmd --entrypoints.traefik.address=:8080'
# Traefik configurado por traefik.yml montado não expõe nada em env nem em args.
# Nada detectado tem de sair vazio: é o que faz o chamador cair no default de
# hoje, em vez de gravar um nome inventado.
tn_ok "config por arquivo → nada detectado" '||' 'env PATH=/usr/bin
cmd --configfile=/etc/traefik/traefik.yml'
tn_ok "entrada vazia não inventa nome" '||' ''
# Só a 443 configurada: cada porta se resolve sozinha, e a que faltou volta ao
# default. Um campo vazio não pode arrastar o outro.
tn_ok "detecção parcial não contamina a outra" '|https|' 'env TRAEFIK_ENTRYPOINTS_HTTPS_ADDRESS=:443'

echo "nome do projeto que o docker compose usa"
# O compose faz TrimLeft("_-") no basename. Sem isso, uma pasta /root/_deskcomm
# faz o kit calcular "_deskcomm" enquanto os contêineres carregam "deskcomm" — a
# instalação deixa de se reconhecer e se trata como intrusa. Medido contra o
# docker compose v2.38.2.
np_ok() {  # np_ok <caminho> <esperado>
  local real; real="$(nome_do_projeto_compose "$1")"
  if [ "$real" = "$2" ]; then printf '  ✓ %s → %s\n' "$1" "$real"
  else printf '  ✗ %s → deu [%s], esperava [%s]\n' "$1" "$real" "$2"; fail=1; fi
}
np_ok /root/deskcommcrm  deskcommcrm
np_ok /root/DeskcommCRM  deskcommcrm
np_ok /root/_deskcomm    deskcomm
np_ok /root/-deskcomm    deskcomm
np_ok /root/_-_crm       crm
np_ok /root/_123         123
np_ok /root/deskcomm.crm deskcommcrm
np_ok /root/crm_cliente  crm_cliente

echo
if [ "$fail" = 0 ]; then echo "todos os validadores passaram"; else echo "FALHOU"; fi
exit "$fail"
