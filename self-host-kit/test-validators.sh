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

# O _common.sh vem antes porque é dele que saem `nome_do_projeto_compose`,
# `veredito_rede_do_proxy` e `garantir_rede_do_proxy` — o install.sh e o update.sh
# compartilham essas três, e a suíte exercita as três de um lugar só.
. ./_common.sh

# Lê UMA chave do .env pelo `load_env` do kit, e não por grep de formato.
#
# Os três laços de packaging abaixo casavam a LINHA (`^CHAVE='?valor'?$`), o que
# amarrava a asserção ao encoding do `.env` — e quebrou quando o `envq` passou a
# escrever aspas duplas para o Docker Compose aceitar apóstrofo (`Sant'Ana`).
# Comparar VALOR em vez de TEXTO torna o teste imune ao encoding, que é
# justamente o que ele nunca quis testar. `load_env` roda em subshell: não
# vaza variável para o caso seguinte.
valor_no_env() {
  ( load_env "$1" >/dev/null 2>&1; eval "printf '%s' \"\${$2:-}\"" )
}

INSTALL_SH_LIB=1 . ./install.sh
set +e   # os dois ligam `set -e`; aqui esperamos validadores falharem de propósito

fail=0

# ── Sandbox: a suíte NÃO pode escrever no crontab da máquina de quem a roda ──
# Não é hipótese: os testes JÁ sujaram o crontab do mantenedor com 10 linhas
# órfãs — uma delas um `curl` com Bearer batendo num domínio de exemplo a cada
# minuto, apontando para um diretório temporário que a própria suíte apaga.
# Daqui em diante o `crontab` que os testes enxergam é um dublê que grava em
# CRONTAB_SANDBOX; a checagem no fim do arquivo compara o crontab REAL de antes
# com o de depois e reprova se mudou.
SUITE_TMP="$(mktemp -d)"
trap 'rm -rf "$SUITE_TMP"' EXIT
CRONTAB_SANDBOX="$SUITE_TMP/crontab-dubles.txt"      # o que os testes escreveram
CRONTAB_REAL_ANTES="$SUITE_TMP/crontab-real-antes.txt"
CRONTAB_REAL_DEPOIS="$SUITE_TMP/crontab-real-depois.txt"
# Sem crontab na máquina, `crontab -l` sai 1 e o arquivo fica vazio — o mesmo
# estado de "usuário sem crontab". A distinção não importa para a comparação;
# o que importa é ela ser feita com o MESMO comando nas duas pontas.
crontab -l >"$CRONTAB_REAL_ANTES" 2>/dev/null || : >"$CRONTAB_REAL_ANTES"
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

echo "URL do Supabase: a da nuvem E a de um Supabase próprio"
# O gate de formato exigia `.supabase.co` e matava quem roda Supabase
# self-hosted com a frase "Ela termina em .supabase.co" — recusa do dado CERTO, e
# sem saída nenhuma: não existe o que digitar que passe. Agora o formato só exige
# https://, e a mensagem de recusa precisa ensinar os DOIS casos, senão ela
# recria o mesmo beco em prosa.
#
# FRONTEIRA (o cabeçalho deste arquivo): aqui se mede só o `case` de formato. A
# chamada a /auth/v1/health é dublada, porque prender esta suíte a DNS é trocar
# um teste por um oráculo. O que aquela chamada prova de fato — e o que ela NÃO
# prova — é medição de instalação real; ver o relatório da triagem.
sburl_ok() {  # sburl_ok <descrição> <pass|reject> <url> [trecho esperado]...
  local desc="$1" expect="$2" url="$3" out rc want
  shift 3
  out="$(bash -c '
      INSTALL_SH_LIB=1 . ./install.sh
      set +e
      # Só o formato está sob teste: para o dublê, a rede responde 200 a todos.
      curl() { printf 200; }
      v_supabase_url "$1"' _ "$url" 2>&1)"; rc=$?
  if [ "$expect" = pass ]; then
    if [ $rc -eq 0 ]; then printf '  ✓ %s\n' "$desc"
    else printf '  ✗ %s  (esperava aceitar, rejeitou: %s)\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1; fi
    return
  fi
  if [ $rc -eq 0 ]; then printf '  ✗ %s  (esperava rejeitar, aceitou)\n' "$desc"; fail=1; return; fi
  for want in "$@"; do
    if ! printf '%s' "$out" | grep -qi -- "$want"; then
      printf '  ✗ %s  (rejeitou, mas a mensagem não fala de: %s)\n     disse: %s\n' \
        "$desc" "$want" "$(printf '%s' "$out" | head -1)"; fail=1; return
    fi
  done
  printf '  ✓ %s\n' "$desc"
}
sburl_ok "aceita a URL da nuvem"                pass   "https://abcdefghijklmnop.supabase.co"
# ESTE é o caso que não existia: Supabase próprio, host que não tem .supabase.co.
sburl_ok "aceita Supabase próprio (self-hosted)" pass  "https://db-crm.exemplo.com.br"
sburl_ok "aceita host sem ponto (Supabase na rede interna)" pass "https://supabase-interno"
# Sem https:// continua sendo recusa — é o que quebra o curl logo abaixo, e o
# caso do `.supabase.co` colado sem esquema tem mensagem própria, mais específica.
sburl_ok "rejeita .supabase.co colado sem esquema" reject "abcdefghijklmnop.supabase.co" "https://"
sburl_ok "rejeita http:// (sem TLS)"               reject "http://db-crm.exemplo.com.br" "https://"
# A mensagem tem de nomear os DOIS mundos. Uma recusa que só fala da nuvem
# devolve o self-hoster ao beco de onde esta correção o tirou — o defeito
# migraria do `case` para a prosa, onde não há catraca nenhuma.
sburl_ok "a recusa ensina o caso da NUVEM"         reject "meu-supabase" "supabase.co"
sburl_ok "a recusa ensina o caso do Supabase PRÓPRIO" reject "meu-supabase" "servidor"

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

echo "connection string: Supabase PRÓPRIO não tem <ref> de projeto"
# A comparação de projeto lê o `postgres.<ref>` do pooler DA NUVEM. Num Supabase
# self-hosted não existe <ref> e a role pode ser qualquer uma, então a checagem
# acusava "a string é do projeto 'crmuser', mas a URL é do projeto 'db-crm'" —
# frase sobre duas coisas que não existem, e sem saída. Agora ela só roda quando
# a URL é mesmo da nuvem.
#
# O caso da nuvem está aqui de novo (já existe acima) porque a asserção é OUTRA:
# lá se mede a mensagem, aqui se mede que a recusa acontece ANTES de encostar no
# banco. É essa fronteira que o `case` novo poderia ter movido sem ninguém ver.
#
# O que sobra barrando o dado errado no caminho self-hosted é SÓ o `select 1`, e
# ele prova que o banco RESPONDE, não que é o banco certo: medido, uma string
# apontando para o banco de outra pessoa passa. Isto está no relatório da
# triagem como achado — não é um teste vermelho aqui de propósito.
db_ok() {  # db_ok <descrição> <pass|reject> <NEXT_PUBLIC_SUPABASE_URL> <string> [trecho esperado]
  local desc="$1" expect="$2" sburl="$3" conn="$4" want="${5-}" dir out rc tocou
  dir="$(mktemp -d)"; mkdir -p "$dir/bin"
  # O `select 1` roda via `docker run postgres:17-alpine`. O dublê não é
  # conveniência: sem ele um caso de ACEITE baixaria imagem e abriria conexão de
  # rede, que é justamente o que o cabeçalho deste arquivo promete não fazer.
  # Ele deixa um rastro para a asserção de vacuidade logo abaixo.
  printf '#!/usr/bin/env bash\ntouch "%s/tocou-no-banco"\nprintf 1\n' "$dir" > "$dir/bin/docker"
  chmod +x "$dir/bin/docker"
  out="$(env PATH="$dir/bin:$PATH" NEXT_PUBLIC_SUPABASE_URL="$sburl" bash -c '
      INSTALL_SH_LIB=1 . ./install.sh
      set +e
      v_db_url "$1"' _ "$conn" 2>&1)"; rc=$?
  tocou=nao; [ -e "$dir/tocou-no-banco" ] && tocou=sim
  rm -rf "$dir"
  if [ "$expect" = pass ]; then
    if [ $rc -ne 0 ]; then
      printf '  ✗ %s  (esperava aceitar, rejeitou: %s)\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1
    elif [ "$tocou" != sim ]; then
      # Vacuidade: aceitar SEM chegar ao psql é outro defeito com a mesma cara de
      # verde — seria um `return 0` antecipado, e a instalação seguiria com uma
      # connection string que ninguém testou.
      printf '  ✗ %s  (aceitou sem nunca tentar conectar — return 0 antecipado?)\n' "$desc"; fail=1
    else printf '  ✓ %s\n' "$desc"; fi
    return
  fi
  if [ $rc -eq 0 ]; then printf '  ✗ %s  (esperava rejeitar, aceitou)\n' "$desc"; fail=1; return; fi
  if [ -n "$want" ] && ! printf '%s' "$out" | grep -qi -- "$want"; then
    printf '  ✗ %s  (rejeitou, mas pelo motivo errado)\n     disse: %s\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1; return
  fi
  if [ "$tocou" = sim ]; then
    printf '  ✗ %s  (recusou só DEPOIS de tentar conectar — a guarda é de formulário)\n' "$desc"; fail=1; return
  fi
  printf '  ✓ %s\n' "$desc"
}
db_ok "próprio: role arbitrária deixa de virar 'projeto'" pass \
  "https://db-crm.exemplo.com.br" "postgresql://crmuser:senha@db-crm.exemplo.com.br:5432/postgres"
db_ok "próprio: role 'postgres' segue passando"           pass \
  "https://db-crm.exemplo.com.br" "postgresql://postgres:senha@db-crm.exemplo.com.br:5432/postgres"
# A regressão que importa: afrouxar o self-hosted não podia afrouxar a NUVEM,
# onde o <ref> existe e apontar para o projeto errado é o erro clássico.
db_ok "NUVEM: projeto cruzado continua barrado antes do banco" reject \
  "https://abcdefghijklmnop.supabase.co" \
  "postgresql://postgres.zzzzzzzzzzzzzzzz:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres" \
  "mesmo projeto"
db_ok "NUVEM: mesmo projeto passa"                        pass \
  "https://abcdefghijklmnop.supabase.co" \
  "postgresql://postgres.abcdefghijklmnop:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres"
# A URL da nuvem NÃO chega sempre terminando em '.supabase.co'. O address bar do
# navegador entrega barra final; quem copia da documentação traz caminho; quem
# cola com o mouse traz espaço. Decidir "é nuvem?" pela string inteira desliga a
# comparação de projeto em silêncio nesses três casos — e o desfecho é o pior
# possível: o baseline.sql vai para um banco e o app fala com outro, cada um de
# um projeto. Estes três casos guardam a extração de HOST que impede isso.
for _sufixo in "/" "/rest/v1" " "; do
  db_ok "NUVEM com '${_sufixo}' na URL: projeto cruzado continua barrado" reject \
    "https://abcdefghijklmnop.supabase.co${_sufixo}" \
    "postgresql://postgres.zzzzzzzzzzzzzzzz:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres" \
    "mesmo projeto"
done
unset _sufixo
# E o outro lado da mesma extração: Supabase próprio com barra final continua
# sendo Supabase próprio — a correção acima não pode reintroduzir a recusa do
# dado certo que este PR veio tirar.
db_ok "próprio com barra final segue sem comparar projeto" pass \
  "https://db-crm.exemplo.com.br/" "postgresql://crmuser:senha@db-crm.exemplo.com.br:5432/postgres"
# Quem responde a connection string ANTES da URL (ou pula a URL) não tem com o
# que comparar — e não pode ser barrado por isso.
db_ok "sem URL respondida ainda: não há o que comparar"   pass \
  "" "postgresql://postgres.zzzzzzzzzzzzzzzz:senha@aws-1-us-west-2.pooler.supabase.com:5432/postgres"

echo "chaves de IA e senha"
ok "rejeita chave Anthropic com prefixo errado" reject v_anthropic "sk-proj-abc123" "começa com 'sk-ant-'"
# `v_openrouter` foi referenciada como validador do campo da OpenRouter sem
# nunca ter sido definida — e a suíte não tinha uma linha sequer que a
# mencionasse. Este caso é o que faz a AUSÊNCIA da função ser vermelha: um nome
# inexistente devolve 127, que `ok` lê como rejeição, então o par (rejeita por
# prefixo / aceita vazio-não) é o que separa "existe e valida" de "não existe".
ok "rejeita chave OpenRouter com prefixo errado" reject v_openrouter "sk-ant-abc123" "começa com 'sk-or-'"
ok "rejeita chave OpenRouter vazia"              reject v_openrouter ""              "começa com 'sk-or-'"
ok "rejeita chave OpenAI com prefixo errado"    reject v_openai    "minha-chave"    "começa com 'sk-'"
ok "aceita OpenAI vazia (é opcional)"           pass   v_openai    ""
ok "rejeita senha curta"                        reject v_password  "1234567"        "muito curta"
ok "aceita senha de 8+"                         pass   v_password  "12345678"

echo "rede fora do ar: o sentinela 000 (issue #190)"
# O dublê de curl das outras seções é `printf 200` INCONDICIONAL, então o ramo
# `000` de todos os seis validadores nunca era exercitado por nenhum caso — e foi
# assim que ele passou 6 versões sendo código morto.
#
# O dublê aqui imita o curl DE VERDADE quando a rede falha: `-w '%{http_code}'`
# faz ele IMPRIMIR `000` e sair com código de erro. Era essa dupla que quebrava o
# `|| echo 000` de dentro da substituição de comando: o echo CONCATENAVA com o
# que o curl já tinha impresso e a variável virava `000000`, que não casa com
# nenhum ramo. Os dois desfechos eram errados, em direções opostas — e os dois
# estão cobertos abaixo, porque consertar um e não medir o outro deixaria metade
# do defeito viva.
rede_morta() {  # rede_morta <descrição> <pass|reject> <validador> <valor> [trecho esperado]...
  local desc="$1" expect="$2" fn="$3" val="$4" out rc want
  shift 4
  out="$(bash -c '
      INSTALL_SH_LIB=1 . ./install.sh
      NEXT_PUBLIC_SUPABASE_URL="https://abcdefghijklmnop.supabase.co"
      set +e
      # curl real com -w: imprime 000 E devolve exit != 0.
      curl() { printf 000; return 6; }
      "$1" "$2"' _ "$fn" "$val" 2>&1)"; rc=$?
  if [ "$expect" = pass ] && [ $rc -ne 0 ]; then
    printf '  ✗ %s  (esperava seguir, barrou: %s)\n' "$desc" "$(printf '%s' "$out" | head -1)"; fail=1; return
  fi
  if [ "$expect" = reject ] && [ $rc -eq 0 ]; then
    printf '  ✗ %s  (esperava barrar, seguiu)\n' "$desc"; fail=1; return
  fi
  for want in "$@"; do
    if ! printf '%s' "$out" | grep -qi -- "$want"; then
      printf '  ✗ %s  (a mensagem não fala de: %s)\n     disse: %s\n' \
        "$desc" "$want" "$(printf '%s' "$out" | head -1)"; fail=1; return
    fi
  done
  printf '  ✓ %s\n' "$desc"
}

# LADO 1 — o relatado: a URL inalcançável era ACEITA. `v_supabase_url` é o único
# dos seis que exige resposta online, e o `000` dele era inalcançável: medido em
# f9abedd0, `rc=0` e saída vazia para um host que não resolve.
rede_morta "URL de Supabase inalcançável é RECUSADA" reject v_supabase_url \
  "https://abcdefghijklmnop.supabase.co" "não consegui alcançar"

# LADO 2 — o oposto, e pior para quem instala: com a rede fora, a chave CERTA
# caía no ramo `*)` e era RECUSADA com "Confira a chave e o projeto" — o erro
# acusando quem configurou, num laço do qual não se sai digitando certo. O código
# sempre quis avisar e seguir; era a variável `000000` que não deixava.
rede_morta "chave service_role correta SEGUE com aviso" pass v_service \
  "$(mkjwt service_role abcdefghijklmnop)" "não consegui checar" "sigo com ela"
rede_morta "chave anon correta SEGUE com aviso"         pass v_anon \
  "$(mkjwt anon abcdefghijklmnop)"         "sigo com ela"

# Os três de IA já seguiam (o `*)` deles também é tolerante), mas a mensagem
# mostrava `000000` ao usuário. Aqui se cobra o ramo certo, não só o desfecho:
# sem checar o texto, um `*)` disfarçado de `000` passaria.
rede_morta "chave Anthropic segue pelo ramo 000"  pass v_anthropic  "sk-ant-abc123" "não consegui checar"
rede_morta "chave OpenRouter segue pelo ramo 000" pass v_openrouter "sk-or-abc123"  "não consegui checar"
rede_morta "chave OpenAI segue pelo ramo 000"     pass v_openai     "sk-abc123"     "não consegui checar"

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
DIVIDA="AGENT_DISPATCH_CONSUMER NUVEMSHOP_APP_ID NUVEMSHOP_CLIENT_ID NUVEMSHOP_CLIENT_SECRET"
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
partial_ok "com barra invertida"        'C:\rota\nova'
partial_ok "com crase"                  'se`nha`'
partial_ok "connection string real"     'postgresql://postgres.abc:p%40ss@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'

echo "formato do .env: os TRÊS consumidores leem o que o envq escreve"
# O .env não tem um leitor, tem três, e cada um traz um parser diferente:
#
#   1. `load_env` (_common.sh) — leitura manual, por onde passa todo script do kit
#   2. `env_file: .env` do docker-compose.prod.yml (:34 e :71)
#   3. `source .env && curl …` — a receita do README (:143)
#
# Até 2026-08 esta suíte só exercitava o (1), e com um fixture sem apóstrofo. O
# (2) é o buraco por onde o defeito passou: com aspas simples, o envq gravava
# `APP_NAME='Sant'\''Ana Odontologia'` — shell válido, e recusado INTEIRO pelo
# parser de dotenv do Compose (medido no v2.38.2):
#
#   failed to read .env: line 1: unexpected character "\" in variable name
#   "\''Ana Odontologia'"
#
# Não era um comando: `config`, `ps` e `pull` saíam todos rc=1. O comprador
# terminava a instalação com Supabase provisionado, schema aplicado, admin
# criado, e todo comando docker do kit morto — por causa do apóstrofo do nome da
# clínica dele.
#
# Por isso a lista de valores é UMA só e os três blocos abaixo a percorrem
# inteira: um encoding que agrada dois leitores e quebra o terceiro é
# exatamente a forma que o defeito teve.
ENV_CASOS=(
  "apóstrofo — o caso que quebrava o Compose|Sant'Ana Odontologia"
  'aspas duplas|Casa "Bela"'
  'cifrão não expande|Loja P$ss'
  'cerquilha não é comentário|Loja #1'
  "combinado, como um nome real|D'Ávila & Cia #2 \$X"
  'barra invertida|C:\rota\nova'
  'senha com apóstrofo|se nh@ Sant'"'"'Ana 8'
  # A crase é o caractere que separa "valor errado" de "comando executado": sem
  # escape, o `source` do README roda o que estiver entre elas. RESIDUAL MEDIDO:
  # o parser de dotenv do Compose desfaz `\"`, `\\` e `\$`, mas NÃO desfaz a
  # crase escapada — o contêiner recebe `Loja \`date\` Ltda`. Escapá-la assim
  # mesmo é a escolha registrada no comentário do envq (valor feio no contêiner
  # < execução de comando). Os dois outros consumidores recebem o valor intacto,
  # e é isso que os casos abaixo exigem deles.
  'crase (sem escape o source EXECUTA)|Loja `date` Ltda'
)

# Escreve UM .env com o envq REAL do install.sh, na pasta pedida. Sai do
# install.sh de verdade (não uma reimplementação): um envq copiado para cá
# ficaria verde com o install.sh sabotado, que é o modo de falha registrado no
# bloco `reexec_neg` no fim deste arquivo.
env_fixture() {  # env_fixture <dir> <dir do kit> <valor>
  rm -f "$1/.env"
  ( cd "$1" && KIT="$2" VAL="$3" bash -c '
      INSTALL_SH_LIB=1 . "$KIT/install.sh"
      envq APP_NAME "$VAL" > .env
    ' )
  # A pasta do bloco do Compose é REUSADA entre os casos: sem esta conferência,
  # uma geração que falhasse deixaria o .env do caso ANTERIOR no lugar e o caso
  # seguinte passaria medindo o fixture do vizinho — verde por vacuidade.
  [ -s "$1/.env" ]
}

le_ok() {  # le_ok <descrição> <valor>
  local desc="$1" val="$2" dir out kit="$PWD"
  dir="$(mktemp -d)"
  if ! env_fixture "$dir" "$kit" "$val"; then
    printf '  ✗ %s — o envq não gerou .env nenhum\n' "$desc"; fail=1; rm -rf "$dir"; return
  fi
  out="$(cd "$dir" && KIT="$kit" bash -c '
      . "$KIT/_common.sh"
      load_env .env
      printf "%s" "$APP_NAME"
    ')"
  rm -rf "$dir"
  if [ "$out" = "$val" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     escreveu: [%s]\n     voltou:   [%s]\n' "$desc" "$val" "$out"; fail=1; fi
}

# Este é o consumidor que NÃO perdoa: `source` é o shell interpretando o
# arquivo, então uma crase mal escapada não devolve valor errado — EXECUTA. É
# por isso que o envq escapa a crase mesmo sabendo que o Compose não a desfaz.
src_ok() {  # src_ok <descrição> <valor>
  local desc="$1" val="$2" dir out kit="$PWD"
  dir="$(mktemp -d)"
  if ! env_fixture "$dir" "$kit" "$val"; then
    printf '  ✗ %s — o envq não gerou .env nenhum\n' "$desc"; fail=1; rm -rf "$dir"; return
  fi
  # Processo separado: se o encoding regredir, quem executa o conteúdo do .env
  # é este bash descartável, não a suíte.
  out="$(cd "$dir" && bash -c 'set -a; . ./.env; set +a; printf "%s" "$APP_NAME"' 2>/dev/null)"
  rm -rf "$dir"
  if [ "$out" = "$val" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     escreveu: [%s]\n     voltou:   [%s]\n' "$desc" "$val" "$out"; fail=1; fi
}

echo "  consumidor 1 — load_env (todo script do kit)"
for _caso in "${ENV_CASOS[@]}"; do le_ok  "${_caso%%|*}" "${_caso#*|}"; done
echo "  consumidor 3 — source (a receita do README)"
for _caso in "${ENV_CASOS[@]}"; do src_ok "${_caso%%|*}" "${_caso#*|}"; done
unset _caso

echo "  consumidor 2 — docker compose (env_file: .env)"
# `docker compose config` é 100% client-side: não fala com o daemon nem baixa
# imagem (medido — com DOCKER_HOST apontando para um socket inexistente ele
# ainda acusa o erro de parse do .env). Ou seja, cabe no que o cabeçalho deste
# arquivo promete: sem rede.
#
# A asserção é "o Compose CONSEGUE LER o arquivo", e não a igualdade do valor,
# por uma razão medida: a saída do `config` re-escapa `$` como `$$` (é o
# encoding de interpolação do próprio compose), então comparar byte a byte
# reprovaria um arquivo correto. E ler é o que o defeito impedia — rc=1 em
# config, ps e pull.
if ! docker compose version >/dev/null 2>&1; then
  # Pulo em voz alta, nomeando o que ficou sem cobertura: pulo silencioso é
  # indistinguível de teste que passou.
  printf '  — pulado: sem `docker compose` nesta máquina\n'
  printf '     NÃO foi medido: se o .env gerado pelo envq é legível pelo `env_file:` do compose\n'
  printf '     (é o consumidor pelo qual o defeito do apóstrofo passou; os outros dois acima rodaram)\n'
else
  DC_DIR="$(mktemp -d)"
  cat > "$DC_DIR/docker-compose.yml" <<'YML'
services:
  app:
    image: alpine:3.20
    env_file: .env
YML
  dc_ok() {  # dc_ok <descrição> <valor>
    local desc="$1" val="$2" err rc kit="$PWD"
    if ! env_fixture "$DC_DIR" "$kit" "$val"; then
      printf '  ✗ %s — o envq não gerou .env nenhum\n' "$desc"; fail=1; return
    fi
    err="$(cd "$DC_DIR" && docker compose config -q 2>&1)"; rc=$?
    if [ $rc -eq 0 ]; then printf '  ✓ %s\n' "$desc"
    else printf '  ✗ %s — o Compose recusou o .env (rc=%s)\n     %s\n' "$desc" "$rc" "$(printf '%s' "$err" | head -1)"; fail=1; fi
  }
  for _caso in "${ENV_CASOS[@]}"; do dc_ok "${_caso%%|*}" "${_caso#*|}"; done
  unset _caso

  # CONTROLE POSITIVO. Sem ele os casos acima passariam por vacuidade: um
  # `docker compose config` que ignorasse o env_file, ou um .env vazio, também
  # sairiam rc=0. Aqui o formato ANTIGO é escrito à mão — é o que o kit gravava
  # antes de 2026-08 — e TEM de ser recusado. Se um dia isto ficar verde, o
  # Compose passou a aceitar `'\''` e a razão de existir do encoding novo mudou:
  # releia o comentário do envq antes de mexer em qualquer coisa.
  cat > "$DC_DIR/.env" <<'EOF'
APP_NAME='Sant'\''Ana Odontologia'
EOF
  if (cd "$DC_DIR" && docker compose config -q >/dev/null 2>&1); then
    printf '  ✗ controle positivo: o Compose ACEITOU o formato antigo de aspas simples\n'
    printf '     os casos acima deixaram de distinguir o defeito da correção\n'; fail=1
  else
    printf '  ✓ controle positivo: o formato ANTIGO (aspas simples) é recusado pelo Compose\n'
  fi
  rm -rf "$DC_DIR"
fi

echo "retrocompatibilidade: o .env de uma instalação antiga continua legível"
# Quem instalou antes de 2026-08 tem um .env em aspas simples com `'\''`, e ele
# NÃO é reescrito ao atualizar: o update.sh só troca APP_IMAGE e APP_PULL_POLICY
# (:159 e :165) e deixa as outras chaves como estavam. Se o ramo de
# aspas simples do load_env sumir num "agora é tudo aspas duplas", o kit novo
# passa a devolver senha e connection string com quatro caracteres a mais, e a
# instalação antiga quebra na atualização, longe de qualquer pista.
#
# O fixture é escrito à mão, no formato ANTIGO, de propósito: gerá-lo com o
# envq de hoje mediria o formato de hoje e não teria nada de retrocompatível.
TMP_LEGADO="$(mktemp -d)"
cat > "$TMP_LEGADO/.env" <<'EOF'
APP_NAME='Sant'\''Ana Odontologia'
SENHA_LEGADA='se'\''nha com espaço'
DB_LEGADA='postgresql://postgres.abc:p%40ss@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
CIFRAO_LEGADO='p$ass'
EOF
( . ./_common.sh
  load_env "$TMP_LEGADO/.env"
  eq() { if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s  esperava [%s] obteve [%s]\n' "$1" "$3" "$2"; exit 1; fi; }
  eq "nome antigo com apóstrofo"   "$APP_NAME"      "Sant'Ana Odontologia"
  eq "senha antiga com apóstrofo"  "$SENHA_LEGADA"  "se'nha com espaço"
  eq "connection string antiga"    "$DB_LEGADA"     'postgresql://postgres.abc:p%40ss@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
  eq "cifrão antigo não expande"   "$CIFRAO_LEGADO" 'p$ass'
) || fail=1
rm -rf "$TMP_LEGADO"

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

echo "e-mails de acesso: marca-emails.sh"
# POR QUE ESTE BLOCO EXISTE: o e-mail de confirmação de conta é o PRIMEIRO
# artefato que um cliente do revendedor recebe, e ele é montado por um processo
# de TERCEIRO (o GoTrue). Nenhum teste do app o alcança — o único jeito de
# vigiar isso é exercitar o script que empurra o texto.
#
# Os casos abaixo cobrem tudo o que dá para provar SEM rede: renderização,
# escape, e as três saídas que não podem derrubar a instalação. O caminho com
# rede (PATCH + releitura) foi medido à mão contra a Management API em
# 2026-08-14 e está declarado no cabeçalho do script.
ME_TMP="$(mktemp -d)"

# (1) Sem token, sai 0 e ENSINA o passo manual. Este é o caso comum: quem cria
#     o projeto no painel e cola as 4 credenciais nunca teve token nenhum.
saida_me="$(SUPABASE_ACCESS_TOKEN= bash ./marca-emails.sh --env /dev/null 2>&1)"; rc_me=$?
if [ $rc_me -ne 0 ]; then
  printf '  ✗ sem token o script saiu %s — ele NÃO pode derrubar o install.sh\n' "$rc_me"; fail=1
else
  printf '  ✓ sem token: sai 0 (a instalação continua)\n'
fi
if printf '%s' "$saida_me" | grep -q 'SUPABASE_ACCESS_TOKEN'; then
  printf '  ✓ sem token: diz qual é a chave que falta\n'
else
  printf '  ✗ sem token: a mensagem não nomeia SUPABASE_ACCESS_TOKEN\n'; fail=1
fi
# O passo manual tem de ensinar `&`. Foi um `?` nesta mesma receita (na doc de
# deploy) que gravou o link quebrado no projeto de produção.
if printf '%s' "$saida_me" | grep -q '{{ .RedirectTo }}&token_hash'; then
  printf '  ✓ sem token: o passo manual ensina o separador & (nunca ?)\n'
else
  printf '  ✗ sem token: o passo manual não mostra o link com &\n'; fail=1
fi

# (2) Supabase PRÓPRIO (self-hosted) não tem Management API: com token e tudo,
#     o certo é ensinar o caminho do GoTrue, não tentar um PATCH que não existe.
saida_me="$(SUPABASE_ACCESS_TOKEN=sbp_de_teste NEXT_PUBLIC_SUPABASE_URL=https://supabase.meucliente.com.br \
            bash ./marca-emails.sh --env /dev/null 2>&1)"; rc_me=$?
if [ $rc_me -eq 0 ] && printf '%s' "$saida_me" | grep -q 'GOTRUE_MAILER_TEMPLATES'; then
  printf '  ✓ Supabase próprio: sai 0 e manda para o caminho do GoTrue\n'
else
  printf '  ✗ Supabase próprio: rc=%s, mensagem sem GOTRUE_MAILER_TEMPLATES\n' "$rc_me"; fail=1
fi

# (3) VACUIDADE: os modelos no disco precisam TER o placeholder, senão o caso
#     (4) compararia a ausência de marca com a ausência de marca e passaria.
for modelo in ../supabase/templates/confirmation.html ../supabase/templates/recovery.html; do
  if grep -q '__APP_NAME__' "$modelo"; then
    printf '  ✓ %s tem __APP_NAME__ para substituir\n' "$(basename "$modelo")"
  else
    printf '  ✗ %s NÃO tem __APP_NAME__ — a substituição abaixo não prova nada\n' "$(basename "$modelo")"; fail=1
  fi
done

# (4) Renderização com um nome HOSTIL. `&` no lado direito de um `sed` (ou de um
#     `${x//p/r}` no bash 5.2) vale como "o trecho casado" — medido: `Loja
#     <b>Top</b> & Cia` saía `Loja <lt;b>gt;Top…`. E `<b>` cru injetaria markup
#     no corpo do e-mail de todo cliente do revendedor.
SUPABASE_ACCESS_TOKEN= APP_NAME='Loja <b>Top</b> & Cia' APP_ACCENT_HEX='#f2c94c' \
  bash ./marca-emails.sh --env /dev/null --render-em "$ME_TMP/render" >/dev/null 2>&1
rend="$ME_TMP/render/confirmation.html"
if [ ! -f "$rend" ]; then
  printf '  ✗ --render-em não escreveu confirmation.html\n'; fail=1
else
  if grep -q '__APP_NAME__\|__ACCENT__\|__ACCENT_FG__' "$rend"; then
    printf '  ✗ sobrou placeholder no HTML renderizado: %s\n' "$(grep -o '__[A-Z_]*__' "$rend" | sort -u | tr '\n' ' ')"; fail=1
  else
    printf '  ✓ nenhum placeholder sobrou no HTML renderizado\n'
  fi
  if grep -qF 'Loja &lt;b&gt;Top&lt;/b&gt; &amp; Cia' "$rend"; then
    printf '  ✓ o nome da marca sai escapado (nada de markup injetado no e-mail)\n'
  else
    printf '  ✗ o nome da marca NÃO saiu escapado: %s\n' "$(grep -o 'Sua conta no [^.]*' "$rend" | head -1)"; fail=1
  fi
  # Amarelo é claro: texto branco em cima seria ilegível. É o caso exato que o
  # `#ffffff` fixo produzia — e é a marca que um revendedor cola sem avisar.
  if grep -q 'color: #171f15' "$rend"; then
    printf '  ✓ accent claro (#f2c94c) escolhe texto ESCURO\n'
  else
    printf '  ✗ accent claro não escolheu texto escuro: %s\n' "$(grep -o 'background: #f2c94c[^"]*' "$rend" | head -1)"; fail=1
  fi
  # A nota de manutenção do topo do modelo fala de placeholder e de --render-em:
  # é endereçada a quem edita o repositório, não ao cliente final.
  if grep -q 'MODELO — os' "$rend"; then
    printf '  ✗ a nota interna do modelo foi junto para dentro do e-mail\n'; fail=1
  else
    printf '  ✓ a nota interna do modelo fica fora do e-mail\n'
  fi
fi

# (5) O par claro/escuro: accent escuro tem de escolher BRANCO. Sem este caso,
#     um `frente_sobre` que devolvesse sempre "#171f15" passaria no caso (4).
SUPABASE_ACCESS_TOKEN= APP_NAME='Marca Escura' APP_ACCENT_HEX='#0b3d2e' \
  bash ./marca-emails.sh --env /dev/null --render-em "$ME_TMP/escuro" >/dev/null 2>&1
if grep -q 'color: #ffffff' "$ME_TMP/escuro/confirmation.html" 2>/dev/null; then
  printf '  ✓ accent escuro (#0b3d2e) escolhe texto BRANCO\n'
else
  printf '  ✗ accent escuro não escolheu texto branco\n'; fail=1
fi

# (6) Hex inválido no .env não pode virar CSS quebrado no e-mail: cai no accent
#     do produto, que é o mesmo piso de lib/branding/saida.ts.
SUPABASE_ACCESS_TOKEN= APP_NAME='Marca Torta' APP_ACCENT_HEX='verde-limão' \
  bash ./marca-emails.sh --env /dev/null --render-em "$ME_TMP/torto" >/dev/null 2>&1
if grep -q 'background: #506d48; background: #506d48' "$ME_TMP/torto/confirmation.html" 2>/dev/null; then
  printf '  ✓ APP_ACCENT_HEX inválido cai no accent do produto\n'
else
  printf '  ✗ APP_ACCENT_HEX inválido virou CSS inválido: %s\n' \
    "$(grep -o 'background: [^;]*;' "$ME_TMP/torto/confirmation.html" 2>/dev/null | head -2 | tr '\n' ' ')"; fail=1
fi

rm -rf "$ME_TMP"

# (7) O VALIDADOR da cor, no install.sh — a outra ponta dos casos (4)-(6).
#     `v_hex` é estreito de propósito: aceita SÓ `#` + 6 dígitos, que é a única
#     forma que o `case` de `marca-emails.sh:125` reconhece. O `ehHexValido` do app
#     (`lib/branding/rampa.ts:49`) aceita mais quatro (`#abc`, `abc`, `aabbcc`),
#     e deixá-las passar aqui produziria o pior desfecho: a cor do revendedor na
#     tela e o verde do produto no primeiro e-mail — split-brain que ninguém
#     percebe, porque cada metade parece certa sozinha.
ok "cor em hex de 6 dígitos"                pass   v_hex "#7a5cd6"
ok "cor vazia (Enter) — o campo é opcional" pass   v_hex ""
ok "nome de cor não é hex"                  reject v_hex "verde-limão" "6 dígitos"
ok "hex de 3 dígitos: o e-mail não o lê"    reject v_hex "#7a5"        "6 dígitos"

# (8) REGRESSÃO DO LAÇO. O caso de integração da VPS limpa já prova o
#     comportamento (a cor respondida volta pelo `load_env`); este aqui existe
#     para NOMEAR a linha que falta quando aquele reprova — "a cor não voltou"
#     não diz a quem lê que o buraco é a lista de `envq`.
if grep -qE '^[[:space:]]*envq APP_ACCENT_HEX' install.sh; then
  printf '  ✓ o install.sh grava APP_ACCENT_HEX no .env\n'
else
  printf '  ✗ o install.sh NÃO grava APP_ACCENT_HEX: perguntar sem gravar faz a pessoa\n'
  printf '     responder e perder a resposta na mesma execução (o bloco fecha com `} > .env`,\n'
  printf '     que trunca a partir da lista de envq).\n'; fail=1
fi

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

echo "proxy reverso: Traefik em MODO HOST (o caso da Hostinger, issue #139)"
# Os fixtures acima têm todos porta publicada, e por isso a suíte inteira passava
# sem nunca exercitar o proxy em modo host — o cenário que gerou a issue.
# Medido no docker 28.3.2: contêiner em `--network host` sai do `docker ps` com a
# coluna Ports VAZIA, inclusive quando subido com `-p 80:80` (o daemon avisa
# "Published ports are discarded when using host network mode"). Controle
# positivo: o mesmo nginx numa bridge com `-p 8080:80` sai com
# "0.0.0.0:8080->80/tcp". Logo, dono_das_portas NUNCA o encontra — é por isso que
# existe uma segunda varredura, sobre `docker ps --filter network=host`.
uni_ok() {  # uni_ok <descrição> <esperado: nome|projeto|imagem ou vazio> <linhas>
  local desc="$1" esperado="$2" linhas="$3" real
  real="$(printf '%s\n' "$linhas" | unico_traefik || true)"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s\n     deu:      [%s]\n     esperava: [%s]\n' "$desc" "$real" "$esperado"; fail=1; fi
}
# Ports vazio é o dado REAL do modo host, não um campo esquecido no fixture.
uni_ok "Traefik em modo host (Ports vazio) é encontrado" \
  'traefik|hostinger|traefik:v3.3' 'traefik|hostinger|traefik:v3.3|'
uni_ok "entre outros contêineres em modo host, acha o Traefik" \
  'proxy-hostinger||traefik:v3' 'node-exporter||prom/node-exporter|
proxy-hostinger||traefik:v3|
netdata||netdata/netdata|'
# Fecha FECHADO no plural: com dois não dá para saber qual está com 80/443, e
# apontar para o errado publica um CRM que instala "com sucesso" e não responde.
uni_ok "dois Traefiks → não elege ninguém" \
  '' 'traefik-a||traefik:v3|
traefik-b||traefik:v2.11|'
uni_ok "nenhum Traefik → não elege ninguém" \
  '' 'nginx-host||nginx:alpine|'
uni_ok "lista vazia → não elege ninguém" '' ''

echo "proxy reverso: qual rede gravar em TRAEFIK_NETWORK"
# As duas conclusões são OPOSTAS e as duas foram, em algum momento, a única
# implementada. Bridge própria → a rede do PROXY (medido com Traefik v3.3: com o
# label na rede do projeto a requisição fica em HTTP 000). Modo host → uma bridge
# NOSSA (medido: contêiner em `--network host` alcança por IP um contêiner numa
# bridge separada, HTTP 200; e o compose recusa `external` apontando para a rede
# que ele mesmo criaria).
rt_ok() {  # rt_ok <descrição> <esperado> <netmode> <redes do contêiner> <bridge do projeto>
  local desc="$1" esperado="$2" real
  real="$(rede_do_traefik "${3:-}" "${4:-}" "${5:-}")"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu [%s], esperava [%s])\n' "$desc" "$real" "$esperado"; fail=1; fi
}
# NetworkMode e Networks medidos no docker 28.3.2 (não inventados): rede custom
# devolve o nome dela nos dois campos; modo host devolve "host" nos dois.
rt_ok "Traefik em bridge própria → a rede DELE"  coolify    coolify    "coolify "        crm_proxy
rt_ok "Traefik na bridge default → bridge"       bridge     bridge     "bridge "         crm_proxy
rt_ok "Traefik em 2 redes → a primeira"          coolify    coolify    "coolify web "    crm_proxy
# ESTE é o defeito da issue #139: em modo host `.NetworkSettings.Networks` devolve
# a string "host", que é uma rede de driver `host` — gravá-la em TRAEFIK_NETWORK
# mata o `up -d` com "network host declared as external, but could not be found".
rt_ok "modo host NÃO grava a pseudo-rede 'host'" crm_proxy  host       "host "           crm_proxy

echo "proxy reverso: a rede externa existe e serve?"
vr_ok() {  # vr_ok <descrição> <esperado> <driver encontrado> <rede> <bridge do projeto> [attachable]
  local desc="$1" esperado="$2" real
  # O attachable só é passado quando o caso o declara, e isso NÃO é firula de
  # assinatura: a chamada de 3 argumentos é o call site de antes do Swarm, e ela
  # tem de continuar recusando overlay. Passar "" sempre apagaria essa medição em
  # silêncio — a função trata ausente e vazio igual, então os dois casos ficariam
  # verdes pelo mesmo caminho e o de compatibilidade deixaria de existir.
  if [ $# -ge 6 ]; then real="$(veredito_rede_do_proxy "${3:-}" "${4:-}" "${5:-}" "$6")"
  else                  real="$(veredito_rede_do_proxy "${3:-}" "${4:-}" "${5:-}")"; fi
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
vr_ok "bridge existente → segue"                  ok            bridge  coolify    crm_proxy
# Sem este caso a instalação NOVA em modo host morre: a bridge do projeto ainda
# não existe (quem a cria é este instalador), e recusar aqui só deixaria instalar
# quem já tivesse instalado antes.
vr_ok "a bridge do PROJETO ainda não existe → cria" criar       ""      crm_proxy  crm_proxy
vr_ok "rede de outro que não existe → morre"      inexistente   ""      coolify    crm_proxy
# TRAEFIK_NETWORK=host escrito à mão: existe, mas não aceita contêiner de bridge.
vr_ok "driver host → morre"                       driver_errado host    host       crm_proxy
# Chamada com 3 argumentos DE PROPÓSITO: é o call site de antes do attachable.
# Sem este caso, apagar o `att` de garantir_rede_do_proxy (deixando a função
# intacta e o símbolo presente) não seria pego por teste nenhum.
vr_ok "driver overlay, chamada de 3 args → morre" driver_errado overlay traefik    crm_proxy
# Sem bridge do projeto conhecida (chamada defensiva), ausência volta a ser morte.
vr_ok "sem rede nossa declarada → não inventa"    inexistente   ""      crm_proxy  ""

# ── Overlay do Swarm ────────────────────────────────────────────────────────
# Numa VPS com Docker Swarm o Traefik vive numa overlay, e a recusa por driver
# matava a instalação com "ponha a bridge certa em TRAEFIK_NETWORK" — instrução
# impossível de seguir, porque ali bridge do Traefik não existe. O que separa a
# overlay que SERVE da que não serve é o --attachable: sem ele um contêiner de
# compose comum não entra na rede e o `up -d` morre em "could not attach to
# network". Por isso o veredito lê os DOIS campos, nunca só o driver.
#
# Os valores abaixo são o que `docker network inspect -f '{{.Attachable}}'`
# imprime DE VERDADE (medido no docker 28.3.2): `true` ou `false`, minúsculo e
# sem aspas, e VAZIO quando a rede não existe (aí o inspect sai != 0). Um teste
# escrito com "True" ou "1" guardaria um formato que o Docker não emite.
vr_ok "overlay attachable → serve como bridge"     ok            overlay traefik crm_proxy true
vr_ok "overlay SEM attachable → morre"             driver_errado overlay traefik crm_proxy false
# Vazio é a resposta de quem não sabe, não um "pode entrar". Tratar ausência de
# resposta como permissão é exatamente o falhar-em-verde que este arquivo existe
# para impedir.
vr_ok "overlay com attachable vazio → morre"       driver_errado overlay traefik crm_proxy ""
# O attachable NÃO pode virar critério único: a bridge default do Docker e as que
# os painéis criam reportam Attachable=false (medido no docker 28.3.2, inclusive
# na rede `bridge`). Exigi-lo de todo mundo quebraria toda instalação com Traefik
# em bridge que hoje funciona — que é a maioria.
vr_ok "bridge com attachable=false segue ok"       ok            bridge  coolify crm_proxy false
# E o driver continua mandando: attachable=true numa rede `host` não muda que
# contêiner de bridge não entra nela.
vr_ok "host com attachable=true continua morrendo" driver_errado host    host    crm_proxy true

echo "proxy reverso: o CALL SITE pergunta o attachable ao Docker"
# Guardar a função não guarda a correção. Apagar o `att=` e o 4º argumento de
# `garantir_rede_do_proxy` deixa `veredito_rede_do_proxy` intacta, o símbolo
# presente e todo grep verde — e a VPS com Swarm volta a morrer, no update.sh
# que o agent.sh roda sozinho a cada 5 minutos, sem ninguém lendo a tela. É o
# call site que precisa de rede, e aqui o _common.sh roda de verdade contra um
# `docker` dublê que responde como um Swarm responderia.
rede_e2e() {  # rede_e2e <descrição> <segue|morre> <driver> <attachable>
  local desc="$1" esperado="$2" drv="$3" att="$4" dir real perguntou kit="$PWD"
  dir="$(mktemp -d)"; mkdir -p "$dir/bin"
  cat > "$dir/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$dir/chamadas.log"
if [ "\$1" = network ] && [ "\$2" = inspect ]; then
  case "\$*" in
    *Driver*)     printf '$drv\n'; exit 0 ;;
    *Attachable*) printf '$att\n'; exit 0 ;;
  esac
fi
exit 0
STUB
  chmod +x "$dir/bin/docker"
  # O kit é capturado ANTES do cd: dentro do subshell o \$PWD já é o temporário,
  # e o _common.sh não seria encontrado — o teste "morreria" por não achar o
  # arquivo, indistinguível de uma recusa legítima.
  if (cd "$dir" && env PATH="$dir/bin:$PATH" REVERSE_PROXY=traefik \
        TRAEFIK_NETWORK=traefik PROJECT_DIR="$dir" \
        bash -c '. "$1/_common.sh"; garantir_rede_do_proxy' _ "$kit") >/dev/null 2>&1
  then real=segue; else real=morre; fi
  # Vacuidade: "segue" só significa alguma coisa se o call site TIVER perguntado
  # o attachable ao Docker. Sem esta checagem, um call site que parasse de
  # perguntar — e um veredito que aceitasse overlay de olhos fechados — passaria
  # com a mesma cara de aprovado.
  perguntou=nao
  grep -q 'Attachable' "$dir/chamadas.log" 2>/dev/null && perguntou=sim
  rm -rf "$dir"
  if [ "$perguntou" != sim ]; then
    printf '  ✗ %s  (o call site não perguntou o attachable ao Docker)\n' "$desc"; fail=1
  elif [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
rede_e2e "overlay attachable: install/update seguem" segue overlay true
rede_e2e "overlay sem attachable: morre explicando"  morre overlay false

echo "proxy reverso: quanta confiança a eleição merece"
# A eleição por porta publicada traz a evidência (a coluna Ports diz ':80->'); a
# varredura por modo host não traz nenhuma — em modo host a coluna é vazia para
# TODOS, então ela só sabe dizer "há um único Traefik em modo host aqui".
cf_ok() {  # cf_ok <descrição> <esperado> <veio da varredura host> <noninteractive>
  local desc="$1" esperado="$2" real
  real="$(confianca_no_dono_das_portas "${3:-}" "${4:-}")"
  if [ "$real" = "$esperado" ]; then printf '  ✓ %s\n' "$desc"
  else printf '  ✗ %s  (deu %s, esperava %s)\n' "$desc" "$real" "$esperado"; fail=1; fi
}
cf_ok "dono pela coluna Ports → segue (tem prova)"          segue    0 0
cf_ok "dono pela coluna Ports, --yes → segue"               segue    0 1
cf_ok "eleito pela varredura host, interativo → pergunta"   pergunta 1 0
cf_ok "eleito pela varredura host, --yes → recusa"          recusa   1 1

# ── Fixture de VPS: os scripts do kit rodam DE VERDADE contra dublês ────────
# Os blocos de unidade acima guardam as FUNÇÕES; os de integração abaixo guardam
# o CAMINHO INTEIRO, que é onde esta correção já falhou uma vez. O ramo do modo
# host chegou a ser escrito sendo INALCANÇÁVEL: dependia de `traefik_container`,
# atribuído só quando o dono das portas era identificado pela coluna Ports —
# vazia em modo host. As funções ficavam certas e a VPS continuava morrendo no
# painel "porta 80 já ocupada".
#
# São três VPS diferentes daqui pra frente, e o que muda entre elas é SÓ o dublê
# do `docker`. Curl, crontab e .env são os mesmos: uma cópia por cenário seria
# uma cópia para envelhecer sozinha.
#
# .env completo para o modo --yes: o que interessa aqui é o proxy, e as demais
# respostas só precisam passar pelos validadores. REVERSE_PROXY e TRAEFIK_NETWORK
# ficam de FORA — são justamente o que o instalador decide. É preciso reescrever
# a cada rodada: o próprio install.sh grava as duas de volta no .env, e a segunda
# rodada não estaria mais decidindo nada.
BASE_ENV="DOMAIN='crm.exemplo.com.br'
ACME_EMAIL='eu@exemplo.com.br'
NEXT_PUBLIC_SUPABASE_URL='https://abcdefghijklmnop.supabase.co'
NEXT_PUBLIC_SUPABASE_ANON_KEY='$(mkjwt anon abcdefghijklmnop)'
SUPABASE_SERVICE_ROLE_KEY='$(mkjwt service_role abcdefghijklmnop)'
SUPABASE_DB_URL='postgresql://postgres.abcdefghijklmnop:senha@aws-1-sa-east-1.pooler.supabase.com:5432/postgres'
ANTHROPIC_API_KEY='sk-ant-teste'
OWNER_EMAIL='eu@exemplo.com.br'
OWNER_PASSWORD='senha12345'"

# montar_vps <raiz> <pasta do projeto>   < corpo do dublê de `docker`
# Define VPS_RAIZ / VPS_PROJ / VPS_LOG para o `rodar` logo abaixo.
montar_vps() {
  local raiz="$1" pasta="$2"
  VPS_RAIZ="$raiz"; VPS_PROJ="$raiz/$pasta"; VPS_LOG="$raiz/docker.log"
  mkdir -p "$raiz/bin" "$VPS_PROJ"
  cp install.sh update.sh backup.sh _common.sh "$raiz/"
  : > "$VPS_PROJ/docker-compose.prod.yml"
  cat > "$raiz/bin/docker"
  # Só o v_supabase_url exige resposta online (000 reprova); os outros toleram.
  #
  # O dublê fala DOIS protocolos porque o install.sh passou a sondar o GHCR
  # antes de pinar as imagens (`ghcr_status`/`trio_publicado` no _common.sh): o
  # endpoint de token devolve JSON, o de manifest devolve o código HTTP. Um
  # dublê que respondesse `200` para tudo faria o `sed` do token sair vazio, a
  # sonda devolver `000`, e a suíte passaria a exercitar o ramo de fallback
  # achando que exercita o normal — verde medindo outra coisa.
  #
  # `DUBLE_GHCR` permite ao teste escolher o cenário: vazio/`200` = as três
  # imagens publicadas; `403` = pacote privado; `404` = não existe.
  cat > "$raiz/bin/curl" <<'STUBCURL'
#!/usr/bin/env bash
case "$*" in
  *ghcr.io/token*) printf '{"token":"dublê"}' ;;
  *ghcr.io/v2/*)   printf '%s' "${DUBLE_GHCR:-200}" ;;
  *)               printf 200 ;;
esac
STUBCURL
  # O install.sh e o update.sh vão até o fim, e no fim eles AGENDAM CRON. Sem
  # dublê a suíte escreveria no crontab de quem a roda — apontando para um
  # diretório temporário que ela mesma apaga em seguida. Teste que suja a máquina
  # do desenvolvedor é defeito do teste; medido: 10 linhas órfãs no crontab do
  # mantenedor, uma delas um `curl` com Bearer batendo numa URL de exemplo a cada
  # minuto.
  #
  # O dublê imita o crontab de verdade em vez de engolir tudo. A versão anterior
  # era `cat >/dev/null` INCONDICIONAL, e isso TRAVAVA A SUÍTE PARA SEMPRE: o
  # _common.sh faz `crontab -l | grep -qF ...`, o `cat` do dublê ficava lendo o
  # stdin herdado do processo — num terminal, o tty, que nunca dá EOF — e o
  # `grep` do outro lado esperava um fim que não vinha. Medido: com stdin no tty,
  # morta a marteladas depois de 90s numa suíte que roda inteira em menos disso;
  # com `< /dev/null`, passava. Um dublê só pode consumir stdin onde o comando
  # real consumiria: `crontab -` e `crontab <arquivo>`, nunca `crontab -l`.
  cat > "$raiz/bin/crontab" <<'STUB'
#!/usr/bin/env bash
: "${CRONTAB_SANDBOX:?dublê de crontab sem sandbox — não vou tocar no crontab real}"
# Substituição ATÔMICA, como o crontab de verdade (escreve um temporário e
# renomeia sobre o spool). Sem isso o dublê mente num ponto que importa: o kit
# faz `crontab -l | ... | crontab -`, os dois lados do cano rodam ao mesmo tempo,
# e um `cat > arquivo` truncava o arquivo que o leitor ainda estava lendo. O
# merge recebia um crontab vazio e cada gravação apagava a linha da anterior —
# a suíte "isolava" bem e media pouco.
grava() { cat > "$CRONTAB_SANDBOX.novo" && mv "$CRONTAB_SANDBOX.novo" "$CRONTAB_SANDBOX"; }
case "${1:-}" in
  -l) [ -f "$CRONTAB_SANDBOX" ] || { printf 'no crontab for %s\n' "$(id -un)" >&2; exit 1; }
      cat "$CRONTAB_SANDBOX" ;;
  -r) rm -f "$CRONTAB_SANDBOX" ;;
  -)  grava ;;
  -*) ;;                                # flag que o kit não usa: nada a fazer
  *)  [ -n "${1:-}" ] && grava < "$1" ;;
esac
exit 0
STUB
  chmod +x "$raiz/bin/docker" "$raiz/bin/curl" "$raiz/bin/crontab"
}

# rodar <script> <flags> [linha extra do .env] [respostas do modo interativo]
#   → ecoa a saída sem ANSI, zerando o log do docker antes.
#
# Sem respostas o stdin é o DA SUÍTE, de propósito: um `< /dev/null` aqui
# esconderia a trava que o dublê de crontab acima existe para não ter (era
# `cat >/dev/null` incondicional, e num tty a suíte nunca terminava). Com
# respostas, lê de um arquivo — é o único jeito de exercitar uma PERGUNTA.
# `SUPABASE_ACCESS_TOKEN=` no `env`: o install.sh chama o marca-emails.sh, e um
# token EXPORTADO no shell de quem roda a suíte entraria no cenário sem ninguém
# pedir — o teste passaria a depender da máquina, e faria chamada de rede a
# partir de um .env de mentira. O cenário declara o próprio ambiente.
rodar() {
  local script="$1" flags="$2"
  printf '%s\n%s\n' "$BASE_ENV" "${3-}" > "$VPS_PROJ/.env"
  : > "$VPS_LOG"
  if [ $# -ge 4 ]; then
    printf '%s' "$4" > "$VPS_RAIZ/respostas.txt"
    (cd "$VPS_PROJ" && env PATH="$VPS_RAIZ/bin:$PATH" DOCKER_LOG="$VPS_LOG" CRONTAB_SANDBOX="$CRONTAB_SANDBOX" \
      SUPABASE_ACCESS_TOKEN= \
      bash "$VPS_RAIZ/$script" $flags <"$VPS_RAIZ/respostas.txt" 2>&1 || true) | sed -E 's/\x1b\[[0-9;]*m//g'
  else
    (cd "$VPS_PROJ" && env PATH="$VPS_RAIZ/bin:$PATH" DOCKER_LOG="$VPS_LOG" CRONTAB_SANDBOX="$CRONTAB_SANDBOX" \
      SUPABASE_ACCESS_TOKEN= \
      bash "$VPS_RAIZ/$script" $flags 2>&1 || true) | sed -E 's/\x1b\[[0-9;]*m//g'
  fi
}
# Vacuidade, usada em toda rodada do install.sh: sem isto, um install.sh que
# morresse ANTES da detecção (dublê incompleto, refactor movendo o bloco)
# passaria — a ausência do painel de bloqueio seria lida como aprovação. O
# marcador é a MECÂNICA, não uma frase: o teste de bind é a porta de entrada.
chegou_na_deteccao() {
  grep -q -- '-p 80:80' "$VPS_LOG" && return 0
  printf '  ✗ o install.sh não chegou a testar a porta 80 — teste inconclusivo, não verde\n'
  return 1
}
# As RESPOSTAS do modo interativo, na ordem em que o instalador pergunta: o
# proxy (o que se testa aqui), depois os 7 campos que o BASE_ENV deixa vazios de
# propósito (APP_IMAGE, OPENAI_API_KEY, APP_NAME, APP_ACCENT_HEX, SUPPORT_EMAIL,
# RESEND_API_KEY, RESEND_FROM_EMAIL — todos com Enter), a tela de conferência,
# a telemetria e o aviso de DNS ('c' = seguir assim mesmo).
# As respostas que vêm DEPOIS da do proxy reverso, na ordem em que o install.sh
# as consome. É uma fila posicional: pergunta nova no meio do script desloca
# tudo daqui para baixo, e o sintoma NÃO aponta para cá — o cenário simplesmente
# não chega onde esperava e reprova com outro nome (medido: a pergunta de qual
# IA vai atender, em `install.sh:916`, derrubou o caso do TRAEFIK_NETWORK).
#
# O primeiro `\n` é o "Enter = padrão" de `escolher_provedor` (install.sh:916),
# que roda depois da pergunta do proxy (:768) e antes da entrevista (:975).
# Quem acrescentar pergunta interativa ao install.sh acrescenta a resposta aqui,
# na mesma posição relativa.
#
# Contagem de Enters antes do 'c', medida com
#   eval "$(grep -m1 '^RESTO_DAS_PERGUNTAS=' test-validators.sh)"
#   printf '%s' "${RESTO_DAS_PERGUNTAS%%c*}" | grep -c ''
# → era 9 antes de APP_ACCENT_HEX entrar em FIELDS, é 10 agora.
RESTO_DAS_PERGUNTAS=$'\n\n\n\n\n\n\n\n\n\nc\n'

# A posição da cor DENTRO da fila acima — 1 provedor + APP_IMAGE + OPENAI +
# APP_NAME e ela é a 5ª. Fica numa variável porque a fila com a cor RESPONDIDA
# (abaixo) é DERIVADA da de cima em vez de copiada: duas filas posicionais
# mantidas à mão desincronizam no primeiro campo novo, e aí uma passa e a outra
# reprova com um nome que não é o dela.
POSICAO_DA_COR=5
COR_DE_TESTE='#f2c94c'
# fila_com <fila> <posição> <valor> → a mesma fila, com uma resposta no lugar de
# um Enter. `awk` porque a substituição é por NÚMERO DE LINHA: um `sed s///`
# casaria a primeira linha vazia, que é outra pergunta.
fila_com() { printf '%s' "$1" | awk -v n="$2" -v v="$3" 'NR==n{print v; next} {print}'; }

echo "integração: instalação NOVA numa VPS LIMPA (o caminho do Caddy)"
# O caminho mais percorrido de todos — VPS crua, portas livres, o kit sobe o
# próprio Caddy — e o que menos aparecia aqui: os cenários de proxy externo são
# os interessantes, então a integração só cobria eles. Um caminho sem teste é um
# caminho onde um refactor de proxy quebra a instalação COMUM sem ninguém ver:
# `set -u` está ligado, e basta uma variável do bloco Traefik deixar de receber
# default para a VPS limpa morrer em "unbound variable" na hora de escrever o
# .env — com todas as asserções de Traefik verdes.
TMP3B="$(mktemp -d)"
(
  montar_vps "$TMP3B" "crmlimpa" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
esac
# VPS crua: o bind de teste PASSA (ninguém nas portas) e não há contêiner nenhum.
exit 0
STUB
  saida="$(rodar install.sh --yes)"
  chegou_na_deteccao || exit 1
  if ! grep -qx 'REVERSE_PROXY="caddy"' "$VPS_PROJ/.env"; then
    printf '  ✗ a VPS limpa não escolheu o Caddy: %s\n' \
      "$(grep -E '^REVERSE_PROXY=' "$VPS_PROJ/.env" || echo '(ausente)')"; exit 1
  fi
  # O .env inteiro sai de um `{ … } > .env`: uma variável sem default aborta o
  # bloco no meio e o arquivo fica PELA METADE — REVERSE_PROXY (linha do começo)
  # presente, e nada do resto. Por isso a asserção olha a ÚLTIMA linha do bloco,
  # não a mensagem de erro: `set -u` fala na língua do shell de quem roda
  # ("unbound variable" aqui, "variável sem associação" num shell em pt-BR), e
  # teste preso a texto de sistema passa em silêncio na máquina errada.
  if ! grep -qE '^OWNER_PASSWORD="' "$VPS_PROJ/.env"; then
    printf '  ✗ o .env saiu pela metade (parou antes da última linha do bloco)\n'
    printf '     últimas chaves gravadas: %s\n' \
      "$(grep -oE '^[A-Z_]+=' "$VPS_PROJ/.env" | tail -3 | tr '\n' ' ')"; exit 1
  fi
  printf '  ✓ portas livres → Caddy, e o .env sai inteiro mesmo sem proxy externo\n'

  # `--yes` não pergunta nada, e campo sem default e sem `opcional` morre em
  # `die` — a linha acima já provaria isso pela metade (o .env sairia truncado).
  # O que ESTA asserção acrescenta é a diferença entre AUSENTE e DECLARADA E
  # VAZIA, que `valor_no_env` não enxerga: `lib/branding/resolve.ts:416` chama a
  # chave vazia de "estado de fábrica do install.sh" e trata a camada como
  # silenciosa sobre cor. Chave ausente é a mesma coisa para o resolvedor, mas
  # não para quem abre o .env procurando onde trocar a cor.
  if ! grep -qE '^APP_ACCENT_HEX=' "$VPS_PROJ/.env"; then
    printf '  ✗ em --yes o APP_ACCENT_HEX nem apareceu no .env (esperado: declarado e vazio)\n'; exit 1
  fi
  if [ -n "$(valor_no_env "$VPS_PROJ/.env" APP_ACCENT_HEX)" ]; then
    printf '  ✗ em --yes o APP_ACCENT_HEX veio com valor: [%s] — ninguém respondeu nada\n' \
      "$(valor_no_env "$VPS_PROJ/.env" APP_ACCENT_HEX)"; exit 1
  fi
  printf '  ✓ em --yes a cor sai DECLARADA e vazia (o "estado de fábrica" do resolve.ts)\n'

  # ── A regra de ouro da doutrina de packaging, no ponto onde ela vale ───────
  # Uma instalação nova gravava `APP_IMAGE=…:latest`, e `latest` aqui significa
  # TOPO DA MAIN (o canal segue a branch default), não a última
  # release. Duas instalações feitas em semanas diferentes rodavam código
  # diferente, ambas dizendo "estou no latest" — e a issue #184 chegou com o
  # ambiente descrito como "latest do dia 06/08/2026".
  #
  # Esta prova existe porque a anterior não pegava: sabotei o install.sh para
  # voltar a gravar `:latest` fixo e a suíte inteira passou verde. A regra mais
  # importante da doutrina não tinha gate nenhum.
  #
  # Nota: nesta fixture o remoto é um dublê sem tags, então `ultima_versao_publicada`
  # devolve vazio e o install cai — de propósito — no canal móvel. Por isso a
  # asserção não é "a tag é 1.2.3": é que as TRÊS imagens saem na MESMA
  # referência e com o pull_policy que combina com ela. É o invariante que
  # sobrevive aos dois caminhos, com rede e sem.
  img_app="$(valor_no_env "$VPS_PROJ/.env" APP_IMAGE)"
  tag_app="${img_app##*:}"
  for par in "WORKER_IMAGE:deskcomm-worker" "SCHEDULER_IMAGE:deskcomm-scheduler"; do
    chave="${par%%:*}"; repo="${par##*:}"
    if [ "$(valor_no_env "$VPS_PROJ/.env" "$chave")" != "ghcr.io/melgarafael/${repo}:${tag_app}" ]; then
      printf '  ✗ %s não acompanha a versão do app (%s): %s\n' "$chave" "$tag_app" \
        "$(grep -E "^${chave}=" "$VPS_PROJ/.env" || echo '(ausente)')"
      printf '     app numa versão e worker em outra é a matriz que ninguém testou.\n'; exit 1
    fi
  done
  case "$tag_app" in
    latest|main|stable) esperado="always" ;;
    *)                  esperado="missing" ;;
  esac
  for chave in APP_PULL_POLICY WORKER_PULL_POLICY SCHEDULER_PULL_POLICY; do
    if [ "$(valor_no_env "$VPS_PROJ/.env" "$chave")" != "$esperado" ]; then
      printf '  ✗ %s devia ser %s para a tag %s: %s\n' "$chave" "$esperado" "$tag_app" \
        "$(grep -E "^${chave}=" "$VPS_PROJ/.env" || echo '(ausente)')"; exit 1
    fi
  done
  printf '  ✓ as três imagens saem na MESMA referência (%s), com pull_policy=%s\n' "$tag_app" "$esperado"

  # O .env VENCE o compose — e é por isso que este bloco existe. O compose já
  # pinava o WAHA, e o install gravava `WAHA_IMAGE=devlikeapro/waha` (sem tag,
  # isto é `:latest`) por cima: o pin existia e não alcançava ninguém. Um gate
  # que olha só o compose dá verde para essa classe inteira de defeito, e foi
  # uma sabotagem que revelou o ponto cego.
  img_waha="$(grep -E '^WAHA_IMAGE=' "$VPS_PROJ/.env" | head -1 | cut -d= -f2- | tr -d "'\"")"
  ref_waha="${img_waha##*/}"
  case "$ref_waha" in
    *:*) tag_waha="${ref_waha##*:}" ;;
    *)   tag_waha="latest" ;;   # imagem sem ':' é :latest por definição do Docker
  esac
  if [ -z "$img_waha" ] || [ "$tag_waha" = "latest" ]; then
    printf '  ✗ WAHA gravado sem pin no .env: %s (tag resolvida: %s)\n' "${img_waha:-(ausente)}" "$tag_waha"
    printf '     sem tag = :latest, e o `dc pull` de cada update entrega ao cliente qualquer\n'
    printf '     versão que o upstream publicar — sem ninguém ter testado.\n'; exit 1
  fi
  printf '  ✓ o WAHA sai pinado no .env (%s), não em :latest\n' "$img_waha"

  # ── A cor da marca sai da ENTREVISTA e chega ao .env ───────────────────────
  # Este é o caso que prova o defeito que o épico da marca deixou aberto: o
  # revendedor punha o nome dele e recebia o VERDE DO PRODUTO em todo e-mail de
  # acesso, porque `install.sh` nunca perguntava nem gravava `APP_ACCENT_HEX`
  # (medido em `c8fc877d`: `grep -c APP_ACCENT_HEX install.sh` → 0).
  #
  # Tem de ser INTERATIVO, e num `.env` que NÃO traz a chave. Duas armadilhas do
  # próprio kit tornam qualquer atalho vacuoso:
  #   1. `ask_one` devolve na primeira linha se a variável já tem valor, e o
  #      `load_env .env` de `install.sh:757` roda ANTES da entrevista — semear o .env
  #      faria o teste passar sem a pergunta nunca existir;
  #   2. enquanto a chave esteve fora da lista de `envq`, ela também estava fora
  #      de `CONHECIDAS`, então um valor posto à mão voltava pelo laço de
  #      PRESERVAÇÃO — verde medindo a preservação, não a entrevista.
  # Com a entrevista respondendo e o .env nascendo sem a chave, o único caminho
  # que produz o valor de volta é `FIELDS` + `envq`, os dois.
  saida="$(rodar install.sh "" "" "$(fila_com "$RESTO_DAS_PERGUNTAS" "$POSICAO_DA_COR" "$COR_DE_TESTE")")"
  chegou_na_deteccao || exit 1
  cor_gravada="$(valor_no_env "$VPS_PROJ/.env" APP_ACCENT_HEX)"
  if [ "$cor_gravada" != "$COR_DE_TESTE" ]; then
    printf '  ✗ a cor respondida na entrevista não chegou ao .env: [%s]\n' "$cor_gravada"
    # As duas metades falham com a MESMA cara — medido sabotando cada uma: sem o
    # `envq` a resposta é colhida e descartada; sem o campo em `FIELDS` a
    # pergunta nem acontece e o `#f2c94c` cai no campo seguinte. Quem lê precisa
    # das duas pontas, senão conserta a que já estava certa.
    printf '     esperava [%s]. São dois pontos, e o sintoma é o mesmo nos dois:\n' "$COR_DE_TESTE"
    printf '       (a) o campo APP_ACCENT_HEX em FIELDS — sem ele a pergunta não existe;\n'
    printf '       (b) o `envq APP_ACCENT_HEX` no bloco que fecha com `} > .env` — ele TRUNCA\n'
    printf '           a partir da lista de envq, então responder sem gravar perde a resposta.\n'
    printf '     últimas chaves gravadas: %s\n' \
      "$(grep -oE '^[A-Z_]+=' "$VPS_PROJ/.env" | tail -5 | tr '\n' ' ')"; exit 1
  fi
  # Vacuidade da fila: se a pergunta da cor tivesse saído de FIELDS, a resposta
  # `#f2c94c` cairia no campo seguinte (SUPPORT_EMAIL, com v_email) e o
  # instalador rejeitaria — a fila inteira desanda a partir dali. Sem esta
  # asserção o caso acima ainda passaria pelo laço de preservação num .env que
  # alguém venha a semear.
  if [ "$(valor_no_env "$VPS_PROJ/.env" SUPPORT_EMAIL)" != "" ]; then
    printf '  ✗ a fila de respostas desandou: SUPPORT_EMAIL ficou [%s], devia estar vazio\n' \
      "$(valor_no_env "$VPS_PROJ/.env" SUPPORT_EMAIL)"; exit 1
  fi
  printf '  ✓ a cor respondida na entrevista (%s) chega ao .env, e a fila não desandou\n' "$COR_DE_TESTE"
) || fail=1
rm -rf "$TMP3B"

echo "packaging: a instalação resolve a última versão publicada"
# O outro lado da regra de ouro: com um remoto que TEM tags, o install precisa
# escolher a maior — e não a primeira que aparecer. `git ls-remote` devolve por
# ordem alfabética de ref, onde "v1.10.0" vem ANTES de "v1.9.0"; sem o
# `--sort=-v:refname` a instalação nasceria numa versão velha achando que é a
# nova. É o tipo de erro que só aparece na décima release.
(
  # `ultima_versao_publicada` já está no escopo: o preâmbulo desta suíte faz
  # `. ./_common.sh`. Sourcear de novo dentro de um subshell que muda de
  # diretório é como a primeira versão disto quebrou.
  repo_falso="$(mktemp -d)"
  git init --quiet --bare "$repo_falso/origem.git"
  trabalho="$(mktemp -d)"
  git clone --quiet "$repo_falso/origem.git" "$trabalho/w" 2>/dev/null
  (
    cd "$trabalho/w" || exit 1
    git config user.email t@t; git config user.name t
    echo x > a; git add -A; git commit --quiet -m init
    for t in v1.0.0 v1.9.0 v1.10.0 v1.2.0; do git tag "$t"; done
    git push --quiet origin HEAD --tags 2>/dev/null
  )

  achou="$(ultima_versao_publicada "$repo_falso/origem.git")"
  if [ "$achou" != "1.10.0" ]; then
    printf '  ✗ escolheu a versão errada: esperado 1.10.0, veio "%s"\n' "$achou"
    printf '     (ordem alfabética põe v1.9.0 depois de v1.10.0 — precisa de --sort=-v:refname)\n'
    rm -rf "$repo_falso" "$trabalho"; exit 1
  fi
  printf '  ✓ entre v1.0.0/v1.2.0/v1.9.0/v1.10.0, escolhe 1.10.0 (ordem de VERSÃO, não alfabética)\n'

  vazio="$(mktemp -d)"; git init --quiet --bare "$vazio/sem-tags.git"
  semtag="$(ultima_versao_publicada "$vazio/sem-tags.git")"
  if [ -n "$semtag" ]; then
    printf '  ✗ remoto sem tag devia devolver vazio, veio "%s"\n' "$semtag"
    rm -rf "$repo_falso" "$trabalho" "$vazio"; exit 1
  fi
  printf '  ✓ remoto sem tag nenhuma devolve vazio (o install cai no canal móvel e avisa)\n'
  rm -rf "$repo_falso" "$trabalho" "$vazio"
) || fail=1

echo "packaging: a instalação GRAVA a versão resolvida (não só sabe qual é)"
# A prova acima mostra que a função escolhe certo; esta mostra que o install.sh
# a USA. São coisas diferentes, e a diferença não é acadêmica: sabotei o install
# para voltar a gravar `:latest` fixo e TODA a suíte passou verde, porque nada
# ligava a função ao arquivo que o cliente recebe.
#
# Offline de propósito: REPO_URL aponta para um repositório local com tags
# conhecidas, então a asserção é exata (1.10.0) e não depende de o CI alcançar o
# GitHub. Um teste que precisa de rede para provar pinagem falha por motivo
# errado no dia em que a rede oscila.
TMP_PIN="$(mktemp -d)"
(
  origem="$TMP_PIN/origem.git"
  git init --quiet --bare "$origem"
  (
    cd "$TMP_PIN" || exit 1
    git clone --quiet "$origem" w 2>/dev/null
    cd w || exit 1
    git config user.email t@t; git config user.name t
    echo x > a; git add -A; git commit --quiet -m init
    for t in v1.0.0 v1.9.0 v1.10.0; do git tag "$t"; done
    git push --quiet origin HEAD --tags 2>/dev/null
  )

  montar_vps "$TMP_PIN/vps" "crmpin" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
esac
exit 0
STUB
  export REPO_URL="$origem"
  rodar install.sh --yes >/dev/null
  unset REPO_URL

  for par in "APP_IMAGE:deskcommcrm" "WORKER_IMAGE:deskcomm-worker" "SCHEDULER_IMAGE:deskcomm-scheduler"; do
    chave="${par%%:*}"; repo="${par##*:}"
    if [ "$(valor_no_env "$VPS_PROJ/.env" "$chave")" != "ghcr.io/melgarafael/${repo}:1.10.0" ]; then
      printf '  ✗ %s não foi pinado na versão resolvida (1.10.0): %s\n' "$chave" \
        "$(grep -E "^${chave}=" "$VPS_PROJ/.env" || echo '(ausente)')"
      printf '     instalação de cliente NUNCA nasce em tag móvel — docs/doctrine/packaging.md, invariante 3.\n'
      exit 1
    fi
  done
  if [ "$(valor_no_env "$VPS_PROJ/.env" APP_PULL_POLICY)" = "always" ]; then
    printf '  ✗ tag imutável com pull_policy=always: o CRM só sobe se o GHCR estiver de pé\n'; exit 1
  fi
  printf '  ✓ com v1.0.0/v1.9.0/v1.10.0 no remoto, o .env nasce pinado em 1.10.0 (as três imagens)\n'
) || fail=1
rm -rf "$TMP_PIN"

echo "packaging: a tag do git não basta — as imagens têm de existir"
# A tag nasce minutos antes das imagens, e as do worker/scheduler só passaram a
# existir depois das releases que já estão publicadas: `deskcomm-worker:1.2.1`
# nunca vai existir, porque a v1.2.1 é passado. Sem sondar o registry, o .env do
# cliente receberia referências impossíveis e o kit as construiria aqui EM
# SILÊNCIO, do topo da main — app de uma release, worker de outro código.
#
# 403 é o caso que trava na estreia de uma imagem nova: pacote recém-criado no
# GHCR nasce privado, e repositório público não muda isso.
TMP_PRIV="$(mktemp -d)"
(
  montar_vps "$TMP_PRIV/vps" "crmpriv" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
esac
exit 0
STUB
  export DUBLE_GHCR=403          # pacote existe mas está PRIVADO
  saida="$(rodar install.sh --yes)"
  unset DUBLE_GHCR

  if ! printf '%s' "$saida" | grep -q "construídas neste servidor"; then
    printf '  ✗ com as imagens inalcançáveis, o instalador não avisou que ia construir aqui\n'
    printf '     silêncio aqui é o defeito: o dono não descobre que duas peças saíram do fonte local.\n'
    exit 1
  fi
  printf '  ✓ imagens inalcançáveis (403): avisa que vai construir no servidor, em vez de calar\n'

  # E ainda assim a instalação COMPLETA — construir é lento, não é impedimento.
  if ! grep -qE "^APP_IMAGE=" "$VPS_PROJ/.env"; then
    printf '  ✗ a instalação não chegou a escrever o .env\n'; exit 1
  fi
  printf '  ✓ e mesmo assim conclui a instalação (constrói é lento, não é impedimento)\n'
) || fail=1
rm -rf "$TMP_PRIV"

echo "integração: os TRÊS provedores de IA que o instalador oferece"
# A pergunta "qual IA vai atender" tem três respostas, e até aqui só uma delas
# era exercitada: todo cenário desta suíte responde Enter, e Enter é [2]
# Anthropic. As outras duas estavam quebradas, cada uma de um jeito, e a suíte
# inteira ficava verde:
#
#   [1] OpenRouter → `v_openrouter` era declarada como validador do campo e
#       nunca definida. `ask_one` despacha o validador pelo NOME, então o nome
#       inexistente vira exit 127: no modo interativo o laço repete a pergunta
#       para sempre, e no `--yes` vira "OPENROUTER_API_KEY inválido / corrija o
#       .env" com o .env certo.
#   [3] OpenAI    → quem escolhe OpenAI nunca passa pelo campo da Anthropic, e
#       o bloco que escreve o .env fazia `envq ANTHROPIC_API_KEY
#       "$ANTHROPIC_API_KEY"` sem default. Sob `set -u` isso aborta o `{ … } >
#       .env` no meio: arquivo pela metade, instalação sem como continuar.
#
# O caminho medido é o `--yes`, porque é o que o `update.sh` e a 2ª execução
# usam, e porque nele a escolha vem do .env — que é como uma instalação que já
# existe chega aqui. A asserção é a MESMA das outras rodadas: a última linha do
# bloco tem de estar presente, senão o .env saiu pela metade.
provedor_ok() {  # provedor_ok <descrição> <VAR da chave> <valor> <AI_PROVIDER esperado>
  local desc="$1" var="$2" val="$3" esperado="$4" raiz env_ia
  raiz="$(mktemp -d)"
  (
    montar_vps "$raiz" "crmia" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
esac
exit 0
STUB
    # O .env de quem escolheu ESTE provedor: a chave dele, e NENHUMA outra. É o
    # ponto todo — um .env com as três chaves esconderia os dois defeitos.
    env_ia="$(printf '%s\n' "$BASE_ENV" | grep -v '^ANTHROPIC_API_KEY=')"
    printf '%s\n%s=%s\n' "$env_ia" "$var" "'$val'" > "$raiz/crmia/.env"
    : > "$raiz/docker.log"
    saida="$(cd "$raiz/crmia" && env PATH="$raiz/bin:$PATH" DOCKER_LOG="$raiz/docker.log" \
      CRONTAB_SANDBOX="$CRONTAB_SANDBOX" bash "$raiz/install.sh" --yes 2>&1 || true \
      | sed -E 's/\x1b\[[0-9;]*m//g')"
    if printf '%s' "$saida" | grep -q 'comando não encontrado\|command not found'; then
      printf '  ✗ %s — o instalador chamou um comando que não existe:\n' "$desc"
      printf '%s\n' "$saida" | grep 'comando não encontrado\|command not found' | head -2 | sed 's/^/       /'
      exit 1
    fi
    if ! grep -qE '^OWNER_PASSWORD="' "$raiz/crmia/.env"; then
      printf '  ✗ %s — o .env saiu pela metade (parou antes da última linha do bloco)\n' "$desc"
      printf '     últimas chaves gravadas: %s\n' \
        "$(grep -oE '^[A-Z_]+=' "$raiz/crmia/.env" | tail -3 | tr '\n' ' ')"
      exit 1
    fi
    # A escolha precisa SOBREVIVER no .env, senão a 2ª execução re-adivinha —
    # e re-adivinhar é como uma instalação só-OpenRouter volta a ser tratada
    # como Anthropic.
    if ! grep -qx "AI_PROVIDER=\"$esperado\"" "$raiz/crmia/.env"; then
      printf '  ✗ %s — AI_PROVIDER não foi gravado como %s: %s\n' "$desc" "$esperado" \
        "$(grep -E '^AI_PROVIDER=' "$raiz/crmia/.env" || echo '(ausente)')"
      exit 1
    fi
    # E a chave que a pessoa tinha continua lá, com o valor dela.
    #
    # O fixture entra no formato ANTIGO (o `"'$val'"` acima, aspas simples) e sai
    # daqui no formato NOVO: o valor atravessou o load_env de um kit atualizado
    # lendo o .env de uma instalação velha, que é a rota de quem re-roda o
    # install.sh depois de atualizar o kit. Por isso a asserção compara o VALOR,
    # e o formato de entrada difere de propósito do de saída.
    if ! grep -qx "$var=\"$val\"" "$raiz/crmia/.env"; then
      printf '  ✗ %s — %s não sobreviveu: %s\n' "$desc" "$var" \
        "$(grep -E "^$var=" "$raiz/crmia/.env" || echo '(ausente)')"
      exit 1
    fi
    printf '  ✓ %s\n' "$desc"
  ) || fail=1
  rm -rf "$raiz"
}
provedor_ok "OpenRouter: instala e o .env sai inteiro"  OPENROUTER_API_KEY sk-or-v1-teste openrouter
provedor_ok "OpenAI: instala e o .env sai inteiro"      OPENAI_API_KEY     sk-teste       openai
provedor_ok "Anthropic: instala e o .env sai inteiro"   ANTHROPIC_API_KEY  sk-ant-teste   anthropic


echo "integração: instalação NOVA numa VPS com Traefik em modo host"
# O install.sh roda contra um `docker` dublê que imita a Hostinger: 80/443
# ocupadas, NINGUÉM publicando, um Traefik em `--network host`, e a rede do
# projeto ainda não existindo (é uma instalação nova). As três pontas medidas no
# docker 28.3.2 e no compose v2.38.2 estão nos comentários do install.sh.
#
# A pasta tem ponto e maiúscula de propósito: o nome do projeto que o compose usa
# é `crmhost_teste`, e um `basename` cru mandaria o instalador criar
# `CRM.Host_Teste_proxy` enquanto o compose procuraria outra rede.
TMP4="$(mktemp -d)"
(
  montar_vps "$TMP4" "CRM.Host_Teste" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  # `dc exec app node` é a sonda de saúde. Sem resposta o instalador tenta 30
  # vezes com 3s de intervalo, e cada rodada deste teste custaria 90 segundos —
  # suíte lenta é suíte que ninguém roda.
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
  # `--entrypoint` só aparece no porta_publicavel: o bind falha, 80/443 ocupadas.
  # Os demais `docker run` (psql do validador) seguem normais.
  run)     case "$*" in *--entrypoint*) exit 1 ;; esac; exit 0 ;;
  # Ninguém publica porta; o Traefik só aparece filtrando por rede host.
  ps)      for a in "$@"; do [ "$a" = "network=host" ] && em_host=1; done
           [ "${em_host:-0}" = 1 ] && printf 'traefik-hostinger|hostinger|traefik:v3.3|\n'; exit 0 ;;
  inspect) case "$*" in *NetworkMode*) printf 'host\n';; *Networks*) printf 'host \n';; esac; exit 0 ;;
  # Instalação nova: a rede do projeto ainda NÃO existe.
  network) case "$2" in inspect) exit 1 ;; esac; exit 0 ;;
esac
exit 0
STUB
  LOG="$VPS_LOG"; PROJ="$VPS_PROJ"

  # ── 1) --yes sem REVERSE_PROXY: a varredura ACHA, mas não pode agir sozinha ──
  # Em modo host o Docker não mostra porta para NINGUÉM, então "único Traefik em
  # modo host" não prova "é ele quem está com as portas": com um nginx nativo
  # segurando 80/443 e um Traefik em modo host servindo outra coisa, o CRM subiria
  # atrás de um proxy que não atende — instalação "com sucesso" e site mudo. Sem
  # ninguém para perguntar, o certo é parar. E parar tem que ser DIFERENTE de não
  # achar: a recusa nomeia o contêiner encontrado e ensina a saída.
  saida="$(rodar install.sh --yes)"
  chegou_na_deteccao || exit 1
  if printf '%s' "$saida" | grep -q 'já estão ocupadas'; then
    printf '  ✗ caiu no painel genérico: a varredura de modo host não achou o Traefik\n'
    printf '     %s\n' "$(printf '%s' "$saida" | grep -m1 'já estão ocupadas')"; exit 1
  fi
  if ! printf '%s' "$saida" | grep -q "traefik-hostinger"; then
    printf '  ✗ a recusa não nomeia o Traefik encontrado — quem lê não sabe o que confirmar\n'; exit 1
  fi
  if ! printf '%s' "$saida" | grep -q 'REVERSE_PROXY=traefik'; then
    printf '  ✗ a recusa não ensina a saída (REVERSE_PROXY=traefik no .env)\n'; exit 1
  fi
  if grep -qE '^TRAEFIK_NETWORK=' "$PROJ/.env"; then
    printf '  ✗ recusou mas agiu: gravou %s no .env\n' "$(grep -E '^TRAEFIK_NETWORK=' "$PROJ/.env")"; exit 1
  fi
  printf '  ✓ --yes: acha o Traefik em modo host e RECUSA nomeando o que achou\n'

  # ── 2 e 3) interativo: a MESMA VPS, a mesma .env, só muda a resposta ────────
  # O par é o teste. Se o instalador tivesse voltado a decidir sozinho pela
  # varredura, os dois lados dariam o mesmo desfecho e um deles reprovaria — não
  # dá para passar nos dois sem ler a resposta. Por isso aqui não se procura o
  # TEXTO da pergunta: o `read -p` do bash só imprime o prompt quando o stdin é
  # um terminal, e prender o teste à prosa é prender o comportamento à redação.
  saida="$(rodar install.sh "" "" "s${RESTO_DAS_PERGUNTAS}")"
  chegou_na_deteccao || exit 1
  if ! printf '%s' "$saida" | grep -q 'traefik-hostinger'; then
    printf '  ✗ o instalador nem mostrou o que encontrou antes de agir\n'; exit 1
  fi
  # A rede é EXTERNA no compose: se não existir, o `up -d` morre em "declared as
  # external, but could not be found" — inclusive numa instalação nova, que é o
  # normal. Criar é a resposta; recusar deixaria instalar só quem já instalou.
  if ! grep -qx 'network create crmhost_teste_proxy' "$LOG"; then
    printf '  ✗ a rede do projeto não foi criada — o "up -d" morreria em "declared as external"\n'
    printf '     chamadas de rede vistas: %s\n' "$(grep '^network' "$LOG" | tr '\n' ' ')"; exit 1
  fi
  if ! grep -qx 'TRAEFIK_NETWORK="crmhost_teste_proxy"' "$PROJ/.env"; then
    printf '  ✗ TRAEFIK_NETWORK errado no .env: %s\n' "$(grep -E '^TRAEFIK_NETWORK=' "$PROJ/.env" || echo '(ausente)')"
    exit 1
  fi
  printf '  ✓ confirmando "s": cria a bridge e grava a rede com o nome que o compose usa\n'

  saida="$(rodar install.sh "" "" "n${RESTO_DAS_PERGUNTAS}")"
  chegou_na_deteccao || exit 1
  if grep -qx 'network create crmhost_teste_proxy' "$LOG"; then
    printf '  ✗ respondendo "n" o instalador seguiu assim mesmo (criou a rede)\n'; exit 1
  fi
  if grep -qE '^TRAEFIK_NETWORK=' "$PROJ/.env"; then
    printf '  ✗ respondendo "n" ainda gravou %s no .env\n' "$(grep -E '^TRAEFIK_NETWORK=' "$PROJ/.env")"; exit 1
  fi
  printf '  ✓ respondendo "n": para, sem gravar proxy nenhum\n'

  # ── 4) REVERSE_PROXY=traefik à mão: a escolha é de quem instala ─────────────
  # É o caminho que o painel de bloqueio ENSINA — e o mais percorrido de todos.
  # Quem obedece PULA a detecção inteira e morria adiante em "Não consegui
  # descobrir a rede Docker do seu Traefik", porque `traefik_container` só era
  # preenchido dentro do ramo que foi pulado. O instalador mandava fazer uma
  # coisa que ele mesmo não sabia terminar. Aqui não há pergunta: a declaração
  # explícita no .env já é a resposta, inclusive em --yes.
  saida="$(rodar install.sh --yes "REVERSE_PROXY='traefik'")"
  chegou_na_deteccao || exit 1
  if printf '%s' "$saida" | grep -q 'Não consegui descobrir a rede'; then
    printf '  ✗ com REVERSE_PROXY=traefik no .env o instalador morre sem achar a rede\n'; exit 1
  fi
  if ! grep -qx 'TRAEFIK_NETWORK="crmhost_teste_proxy"' "$PROJ/.env"; then
    printf '  ✗ REVERSE_PROXY=traefik à mão: TRAEFIK_NETWORK saiu %s\n' \
      "$(grep -E '^TRAEFIK_NETWORK=' "$PROJ/.env" || echo '(ausente)')"; exit 1
  fi
  printf '  ✓ REVERSE_PROXY=traefik escrito à mão também acha a rede, sem perguntar\n'
) || fail=1
rm -rf "$TMP4"

echo "integração: instalação NOVA numa VPS com Traefik em bridge PRÓPRIA (Coolify)"
# O caminho NÃO-host, que é a maioria das VPS com painel — e o que a pergunta
# nova poderia ter estragado sem ninguém ver. Aqui a coluna Ports do `docker ps`
# diz quem tem as portas: existe PROVA, então não se pergunta nada, nem em --yes.
# Apertar a eleição do modo host não podia custar uma pergunta a quem nunca
# precisou dela — nem uma rede criada à toa: a bridge do painel já existe, e a
# rede a apontar é a DELE (medido com Traefik v3.3 real: com o label na rede do
# projeto a requisição fica em HTTP 000; na rede do proxy, HTTP 200).
TMP5="$(mktemp -d)"
(
  montar_vps "$TMP5" "crmcoolify" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
  run)     case "$*" in *--entrypoint*) exit 1 ;; esac; exit 0 ;;
  # O Traefik do painel PUBLICA as portas — a coluna Ports é exatamente a prova
  # que falta no modo host. A varredura por rede host não acha nada aqui.
  ps)      for a in "$@"; do [ "$a" = "network=host" ] && em_host=1; done
           [ "${em_host:-0}" = 1 ] && exit 0
           printf 'traefik-coolify|coolify|traefik:v3.3|0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\n'
           exit 0 ;;
  inspect) case "$*" in *NetworkMode*) printf 'coolify\n';; *Networks*) printf 'coolify \n';; esac; exit 0 ;;
  # A rede do painel já existe, e é bridge.
  network) case "$2" in inspect) printf 'bridge\n' ;; esac; exit 0 ;;
esac
exit 0
STUB
  saida="$(rodar install.sh --yes)"
  chegou_na_deteccao || exit 1
  if printf '%s' "$saida" | grep -q 'paro aqui em vez de chutar'; then
    printf '  ✗ recusou uma eleição que TEM prova (a coluna Ports diz quem publica)\n'; exit 1
  fi
  if ! grep -qx 'TRAEFIK_NETWORK="coolify"' "$VPS_PROJ/.env"; then
    printf '  ✗ TRAEFIK_NETWORK devia ser a rede do proxy: saiu %s\n' \
      "$(grep -E '^TRAEFIK_NETWORK=' "$VPS_PROJ/.env" || echo '(ausente)')"; exit 1
  fi
  if grep -q '^network create' "$VPS_LOG"; then
    printf '  ✗ criou rede à toa: %s\n' "$(grep -m1 '^network create' "$VPS_LOG")"; exit 1
  fi
  printf '  ✓ com prova na coluna Ports segue sem perguntar, e usa a rede do proxy\n'
) || fail=1
rm -rf "$TMP5"

echo "integração: update.sh quando a rede do proxy sumiu"
# O guard da rede nasceu só no install.sh, e o `dc up -d` do update.sh corre o
# mesmo risco: a bridge é um artefato como outro qualquer e some num
# `docker network prune` — ou no `down -v` que o próprio kit ensina como caminho
# de recomeço. Sem o guard, a atualização morre no opaco "network X declared as
# external, but could not be found", e pior: quem roda o update.sh é o agent.sh,
# a cada 5 minutos, sem ninguém lendo a tela.
#
# A ORDEM é metade do teste: criar a rede DEPOIS do `up -d` não serviria de nada.
TMP6="$(mktemp -d)"
(
  montar_vps "$TMP6" "crmupdate" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  compose) case "$*" in *" exec "*) printf 'healthy\n{"data":{"status":"healthy"}}\n' ;; esac; exit 0 ;;
  # A rede sumiu (prune / down -v): o `network inspect` não acha.
  network) case "$2" in inspect) exit 1 ;; esac; exit 0 ;;
esac
exit 0
STUB
  # O update.sh decide o que instalar por TAG: sem repositório com versão
  # publicada ele para antes de chegar ao `up -d`, e o teste passaria vazio.
  (cd "$VPS_PROJ" && git init -q -b main . \
    && git -c user.email=t@exemplo -c user.name=teste add -A \
    && git -c user.email=t@exemplo -c user.name=teste commit -qm base \
    && git tag v9.9.9) >/dev/null 2>&1

  # INTERNAL_SECRET/NEXT_PUBLIC_APP_URL entram porque é o que faz o update.sh
  # chegar ao agendamento de cron — o dublê do crontab precisa ser exercitado
  # aqui também (é o que dá lastro à checagem de isolamento no fim do arquivo).
  saida="$(rodar update.sh --skip-backup "REVERSE_PROXY='traefik'
TRAEFIK_NETWORK='crmupdate_proxy'
INTERNAL_SECRET='segredo-de-teste'
NEXT_PUBLIC_APP_URL='https://crm.exemplo.com.br'")"

  # Vacuidade: se o update.sh parou antes (git, tag, dublê incompleto), a
  # ausência do erro do compose não prova nada.
  n_up="$(grep -n -E '^compose .* up -d$' "$VPS_LOG" | head -1 | cut -d: -f1)"
  if [ -z "$n_up" ]; then
    printf '  ✗ o update.sh não chegou ao "up -d" — teste inconclusivo, não verde\n'
    printf '     última linha da saída: %s\n' "$(printf '%s' "$saida" | tail -1)"; exit 1
  fi
  n_create="$(grep -n -x 'network create crmupdate_proxy' "$VPS_LOG" | head -1 | cut -d: -f1)"
  if [ -z "$n_create" ]; then
    printf '  ✗ o update.sh não recriou a rede — o "up -d" morreria em "declared as external"\n'
    printf '     chamadas de rede vistas: %s\n' "$(grep '^network' "$VPS_LOG" | tr '\n' ' ')"; exit 1
  fi
  if [ "$n_create" -gt "$n_up" ]; then
    printf '  ✗ a rede foi criada DEPOIS do "up -d" (linha %s vs %s) — tarde demais\n' "$n_create" "$n_up"; exit 1
  fi
  printf '  ✓ o update.sh recria a bridge do proxy antes de subir a stack\n'
) || fail=1
rm -rf "$TMP6"

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

echo "re-execução: o kit é chamado por caminho RELATIVO, como o README manda"
# O harness acima sempre invoca `bash "$VPS_RAIZ/$script"` — ABSOLUTO. O README
# documenta `bash install.sh` (:34) e a re-execução como suportada (:126, :138),
# e é aí que mora a diferença: um `grep ... "$0"` DEPOIS do `cd` para o diretório
# do projeto procura o script no lugar errado e morre em "No such file or
# directory", matando a 2ª execução. Passou verde por anos porque a única sonda
# que rodava o instalador usava caminho absoluto.
#
# Este caso não roda o install.sh inteiro: isola o mecanismo (o `cd` seguido da
# leitura do próprio script), que é o que regride em silêncio.
reexec_ok() {
  local desc="$1" dir raiz achou linha
  raiz="$(mktemp -d)"; dir="$raiz/deskcommcrm"; mkdir -p "$dir"
  cp ./install.sh "$raiz/install.sh"
  # A LINHA REAL do install.sh, extraída do arquivo — não uma reimplementação.
  # Reimplementar o mecanismo aqui deixaria este caso VERDE com o install.sh
  # sabotado (medido: previ 1 vermelho e observei 0 na primeira versão deste
  # arquivo). O teste tem de executar o que o kit executa.
  linha="$(grep -n 'CONHECIDAS=' "$raiz/install.sh" | head -1 | cut -d: -f2-)"
  if [ -z "$linha" ]; then
    printf '  ✗ %s — não achei a linha CONHECIDAS= no install.sh (o teste ficou cego)\n' "$desc"; fail=1; return
  fi
  achou="$(cd "$dir" && KIT_DIR="$raiz" bash -c "
    set +e
    $linha
    printf '%s' \"\$CONHECIDAS\" | grep -c . 
  " install.sh 2>/dev/null)"
  rm -rf "$raiz"
  if [ "${achou:-0}" -gt 0 ]; then printf '  ✓ %s (%s vars)\n' "$desc" "$achou"
  else printf '  ✗ %s — o kit não se encontra depois do cd; a 2ª execução morre\n' "$desc"; fail=1; fi
}
# O CONTROLE NEGATIVO. Ele foi PROMETIDO por escrito no comentário acima e
# chamado aqui, mas nunca definido — `reexec_neg` era um comando inexistente,
# que sob um script sem `set -e` só imprime "command not found" no stderr e
# segue em frente. A suíte então terminava em "todos os validadores passaram"
# tendo executado uma asserção a menos do que dizia.
#
# Sem ele, `reexec_ok` sozinho não prova nada: uma sonda que devolvesse "achei
# vars" em qualquer circunstância também ficaria verde. Este caso roda a MESMA
# linha extraída do install.sh, trocando só `$KIT_DIR/install.sh` por `"$0"` —
# a forma que o kit tinha antes do conserto — e exige que ela FALHE. Se ela
# passar, a sonda não distingue o defeito da correção e o caso de cima é
# decorativo.
reexec_neg() {
  local dir raiz linha achou
  raiz="$(mktemp -d)"; dir="$raiz/deskcommcrm"; mkdir -p "$dir"
  cp ./install.sh "$raiz/install.sh"
  linha="$(grep -n 'CONHECIDAS=' "$raiz/install.sh" | head -1 | cut -d: -f2-)"
  if [ -z "$linha" ]; then
    printf '  ✗ controle negativo — não achei a linha CONHECIDAS= no install.sh (o teste ficou cego)\n'; fail=1; rm -rf "$raiz"; return
  fi
  # A checagem de alvo vem ANTES da substituição, e olha a linha ORIGINAL. Se
  # ela olhasse a linha já reescrita, um install.sh sabotado de volta para `"$0"`
  # deixaria este caso VERDE — ele estaria medindo exatamente o que o caso de
  # cima mede, e um controle negativo que ecoa o positivo não controla nada.
  # (Medido: previ 2 vermelhos ao sabotar o fonte e observei 1, e foi assim que
  # esta vacuidade apareceu.)
  case "$linha" in
    *'"$KIT_DIR/install.sh"'*) ;;
    *) printf '  ✗ controle negativo — a linha CONHECIDAS= não usa mais $KIT_DIR; o defeito voltou ou o caso perdeu o alvo\n'; fail=1; rm -rf "$raiz"; return;;
  esac
  # A forma ANTIGA, reconstruída a partir da linha real: o `$KIT_DIR/install.sh`
  # vira `"$0"`, e nada mais muda.
  linha="${linha//\"\$KIT_DIR\/install.sh\"/\"\$0\"}"
  achou="$(cd "$dir" && KIT_DIR="$raiz" bash -c "
    set +e
    $linha
    printf '%s' \"\$CONHECIDAS\" | grep -c .
  " install.sh 2>/dev/null)"
  rm -rf "$raiz"
  if [ "${achou:-0}" -eq 0 ]; then printf '  ✓ controle negativo: com "$0" relativo depois do cd, o kit NÃO se acha\n'
  else printf '  ✗ controle negativo FALHOU — a sonda achou %s vars mesmo com o defeito; ela não distingue nada\n' "$achou"; fail=1; fi
}
reexec_neg
reexec_ok "o bloco de variáveis conhecidas acha o kit depois do cd"

echo "isolamento: a suíte não escreve no crontab da máquina"
# Isto não é hipótese defensiva: os testes JÁ escreveram 10 linhas órfãs no
# crontab do mantenedor, uma delas um `curl` com Bearer disparando a cada minuto
# para um domínio de exemplo e apontando para um diretório temporário que a
# própria suíte apaga. Rodar teste não pode mexer na máquina de quem roda.
#
# A comparação sozinha passaria por vacuidade — um crontab que ninguém tentou
# escrever fica igual por falta de tentativa, não por isolamento. Por isso a
# primeira asserção é o CONTROLE POSITIVO: o dublê tem de ter recebido as linhas
# do kit. Só quando existe uma escrita capturada é que "o real não mudou"
# significa alguma coisa.
crontab -l >"$CRONTAB_REAL_DEPOIS" 2>/dev/null || : >"$CRONTAB_REAL_DEPOIS"
if [ ! -s "$CRONTAB_SANDBOX" ] || ! grep -q '# deskcomm:' "$CRONTAB_SANDBOX"; then
  printf '  ✗ nada foi escrito no crontab de mentira — o teste não mediu isolamento nenhum\n'
  printf '     (o kit deveria ter agendado drain e agente nas rodadas de integração)\n'
  fail=1
elif ! cmp -s "$CRONTAB_REAL_ANTES" "$CRONTAB_REAL_DEPOIS"; then
  printf '  ✗ o crontab REAL da máquina mudou durante a suíte:\n'
  diff "$CRONTAB_REAL_ANTES" "$CRONTAB_REAL_DEPOIS" | sed 's/^/       /'
  fail=1
else
  printf '  ✓ o kit agendou %s linha(s) — todas no sandbox, o crontab real intacto\n' \
    "$(grep -c '# deskcomm:' "$CRONTAB_SANDBOX")"
fi

echo
if [ "$fail" = 0 ]; then echo "todos os validadores passaram"; else echo "FALHOU"; fi
exit "$fail"
