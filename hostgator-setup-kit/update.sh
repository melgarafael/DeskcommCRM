#!/usr/bin/env bash
# Atualiza o DeskcommCRM na VPS: código novo + banco + app — com BACKUP antes e
# CHECAGEM DE SAÚDE depois. Um comando só, pensado pra quem não é técnico:
#
#   bash hostgator-setup-kit/update.sh
#
# Flags:
#   --force        instala a versão pedida mesmo que ela seja igual ou ANTERIOR
#                  à que já está aqui (é o jeito explícito de voltar no tempo)
#   --skip-backup  pula o backup automático (não recomendado)
#   --to <tag>     instala essa tag em vez da mais recente publicada
# Absoluto e resolvido ANTES do `enter_project`, que faz `cd`: depois dele um
# `dirname "$0"` relativo apontaria para o lugar errado, e o único sintoma seria
# um script do kit "não encontrado" no meio da atualização.
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$KIT_DIR/_common.sh"
enter_project

FORCE=""; SKIP_BACKUP=""; TARGET_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --to) shift; TARGET_TAG="$1" ;;
  esac
  shift
done

# ── 0-. Esta cópia do repo é a dona dos contêineres? ─────────────────────────
# Antes do cron e antes do git: uma segunda cópia que atualiza por cima recria o
# parque com o .env DELA. Foi o que deixou o WhatsApp de uma VPS real três dias
# em 401. Ver `recusar_projeto_de_outra_arvore` em _common.sh.
recusar_projeto_de_outra_arvore || die "Atualização interrompida para não quebrar a instalação que está no ar."

# ── 0. Liga o agente da tela ANTES de qualquer decisão de versão ─────────────
# Instalar o cron aqui, e não no fim, é o que faz o bootstrap ter fim: os
# caminhos "já está na versão mais recente" e "essa versão é anterior à sua"
# saem do script mais abaixo, e se o cron dependesse deles a atualização pela
# tela nunca ligaria justamente em quem já está em dia. É idempotente.
setup_update_agent_cron

# ── 1. Tem atualização mesmo? ────────────────────────────────────────────────
step "Procurando atualizações"
git fetch --tags --quiet origin 2>/dev/null || c_ylw "⚠ não consegui falar com o GitHub — sigo com o código que já está aqui."
[ -n "$TARGET_TAG" ] || TARGET_TAG="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[ -n "$TARGET_TAG" ] || die "Não encontrei nenhuma versão publicada para instalar."
git rev-parse --verify --quiet "${TARGET_TAG}^{commit}" >/dev/null \
  || die "Não conheço a versão $TARGET_TAG aqui. Confira o nome (ex.: v1.1.0) ou tente de novo quando o servidor conseguir falar com o GitHub."
CURRENT_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"

# O código estar em dia NÃO significa que o app está: quem roda é a imagem.
# Uma atualização interrompida depois do checkout (queda de rede, falta de
# memória no meio do docker pull) deixa o repositório novo e a imagem velha — e
# a partir dali TODO update.sh respondia "já está na versão mais recente",
# prendendo o CRM na versão antiga sem nenhuma saída visível para o dono.
# Também cobre imagem republicada sem commit novo (rebuild de segurança).
# (Veio da `main`; a versão por tag cai exatamente na mesma armadilha, porque a
# comparação de tags também fica satisfeita com a imagem velha no lugar.)
image_desatualizada() {
  # O fallback vem de `IMG_APP` (_common.sh, sourceado no topo deste arquivo) e não de
  # um literal: num fork com namespace próprio, o literal apontava para a
  # imagem do UPSTREAM, e um `.env` sem APP_IMAGE comparava o digest local
  # contra um registry que não é o dele.
  local img="${APP_IMAGE:-${IMG_APP}:latest}" local_d remote_d
  local_d="$(docker image inspect "$img" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//')"
  [ -z "$local_d" ] && return 0                 # nem baixada ainda → atualizar
  remote_d="$(docker buildx imagetools inspect "$img" 2>/dev/null | awk '/^Digest:/{print $2; exit}')"
  [ -z "$remote_d" ] && return 1                # sem como consultar → não forçar
  [ "$local_d" != "$remote_d" ]
}

MESMA_TAG=""
[ "$CURRENT_TAG" = "$TARGET_TAG" ] && MESMA_TAG=1

if [ -n "$MESMA_TAG" ] && [ -z "$FORCE" ] && ! image_desatualizada; then
  c_grn "✓ Você já está na versão mais recente ($TARGET_TAG). Nada a atualizar."
  exit 0
fi

# Alvo que JÁ está contido no que roda aqui = andar pra trás, não pra frente.
# Numa instalação que segue a `main`, `git describe --exact-match` é vazio: a
# comparação de tags acima passa batido e, sem esta guarda, o script instalaria
# alegremente uma versão MAIS VELHA que a instalada — desligando o que o dono
# já tem (foi assim que este próprio botão se autodestruiria, voltando pra uma
# imagem que não conhece o agente de atualização). Recusar é o padrão; voltar
# no tempo continua possível, mas só quando alguém pede de propósito.
# Quando o alvo é a MESMA tag já instalada, a guarda não se aplica: não há para
# onde voltar no tempo — só a imagem é que ficou para trás.
if [ -z "$FORCE" ] && [ -z "$MESMA_TAG" ]; then
  is_already_in_head "$TARGET_TAG" && CONTIDA=0 || CONTIDA=$?
  case "$CONTIDA" in
    0) refuse "A versão $TARGET_TAG é ANTERIOR à que já está instalada neste servidor.
     Instalar ela seria voltar no tempo e desligar coisas que você já tem.
     Não mexi em nada: nem no banco, nem no app — está tudo como estava.
     Se você REALMENTE quer voltar para a $TARGET_TAG, rode:
       bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force" ;;
    2) refuse "Não consegui ter CERTEZA de que a versão $TARGET_TAG é mais nova que a instalada
     aqui — a cópia do código neste servidor veio abreviada e eu não consegui completá-la
     (o servidor precisa conseguir falar com o GitHub para isso).
     Prefiro não mexer a arriscar te levar para uma versão anterior sem querer.
     Não mexi em nada. Tente de novo em alguns minutos; se insistir, confira a internet do
     servidor. Para instalar assim mesmo, por sua conta:
       bash hostgator-setup-kit/update.sh --to $TARGET_TAG --force" ;;
  esac
fi
if [ -n "$MESMA_TAG" ]; then
  c_ylw "O código já está na $TARGET_TAG, mas o app está rodando uma imagem antiga. Vou atualizar a imagem."
else
  c_ylw "Vou atualizar para a versão $TARGET_TAG com segurança."
fi

# ── 2. Backup de segurança ANTES de tocar no banco ───────────────────────────
if [ -z "$SKIP_BACKUP" ]; then
  step "Backup de segurança (antes de mexer no banco)"
  if bash "$(dirname "$0")/backup.sh"; then
    c_grn "✓ backup feito — se algo der errado, dá pra restaurar (restore.sh)."
  else
    c_ylw "⚠ o backup falhou. A atualização NÃO apaga dados (só reorganiza os contatos),"
    c_ylw "  mas o ideal é ter backup. Ctrl+C pra parar e investigar; continuo em 8s…"
    sleep 8
  fi
fi
# Avisa o agente do host (se for ele quem está dirigindo) — é o que faz a tela
# de atualização avançar passo a passo enquanto o app ainda está de pé.
# Na SEGUNDA volta (depois do re-exec) estes dois passos ja foram
# reportados. Reportar de novo faria a tela de quem esta olhando andar
# PARA TRAS por um instante, e voltar atras numa barra de progresso le-se
# como "deu errado e recomecou".
[ -z "${DESKCOMM_UPDATE_REEXEC:-}" ] && [ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" backup

# ── 3. Código novo ───────────────────────────────────────────────────────────
step "Baixando o código novo"
if ! git checkout --quiet "$TARGET_TAG" 2>&1; then
  die "Não consegui trocar para a versão $TARGET_TAG (parece haver mudanças locais que divergem).
     Rode 'git status' pra ver, ou peça ajuda. NÃO mexi no banco — está tudo como estava."
fi
# Na SEGUNDA volta (depois do re-exec) estes dois passos ja foram
# reportados. Reportar de novo faria a tela de quem esta olhando andar
# PARA TRAS por um instante, e voltar atras numa barra de progresso le-se
# como "deu errado e recomecou".
[ -z "${DESKCOMM_UPDATE_REEXEC:-}" ] && [ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" codigo

# ── DAQUI PRA FRENTE, QUEM MANDA E A VERSAO NOVA ─────────────────────────────
#
# MEDIDO na instalacao real em 2026-09-13, e e um defeito de anos, nao de uma
# entrega: a v1.17.15 trouxe uma pausa dos servicos antes de mexer no banco, e
# depois de atualizar as tres pecas do Supabase estavam de pe havia duas horas e
# meia. A pausa nao rodou.
#
# Por que: `source _common.sh` acontece na PRIMEIRA linha deste arquivo, e o
# `git checkout` da versao nova so aqui, na etapa 3. Quem executa a atualizacao
# e a versao ANTERIOR — aplicando o banco da versao nova. Ou seja, TODA correcao
# do instalador chegava um update atrasada: a versao que traz o conserto era
# instalada pela versao que ainda tem o defeito.
#
# E ha uma segunda aresta na mesma pedra: o `git checkout` troca o arquivo deste
# script ENQUANTO o interpretador o le, e ele acompanha o arquivo por posicao em
# BYTES. Arquivo novo de tamanho diferente = retomada no meio de uma linha.
# Sobreviver a isso e sorte, nao desenho. O `exec` fecha as duas de uma vez.
#
# As flags nao sao enfeite:
#   --to      o alvo ja foi decidido; redecidir arriscaria escolher outro
#   --force   depois do checkout, HEAD JA E a tag alvo, e sem isto a segunda
#             volta diria "voce ja esta na versao mais recente" e sairia sem
#             tocar no banco — exatamente o passo que precisa rodar
#   --skip-backup  o backup ja foi feito na primeira volta, e refaze-lo dobraria
#             o tempo da atualizacao sem proteger mais ninguem
if [ -z "${DESKCOMM_UPDATE_REEXEC:-}" ]; then
  export DESKCOMM_UPDATE_REEXEC=1
  c_ylw "Seguindo com o instalador da propria versao $TARGET_TAG."
  exec bash "$KIT_DIR/update.sh" --to "$TARGET_TAG" --force --skip-backup
fi

# ── 4. Banco: schema + correções de dados (schema ANTES do app) ──────────────
# O baseline é idempotente e auto-curativo. Re-aplicar numa base que JÁ existe
# gera erros do tipo "já existe" / "multiple primary keys" — isso é ESPERADO e
# inofensivo (são objetos que já estavam lá). Filtramos esse ruído e só
# mostramos problemas de verdade.
# Re-aplicar o baseline é DDL, então vai por `url_do_schema` (_common.sh) e não
# pela string do app: numa instalação em Supabase próprio, com a role menor no
# `.env` como recomendamos, este passo passava a falhar em silêncio a cada
# atualização — e é o update.sh que entrega migration nova ao clone (issue #192).
# ── NINGUÉM FALA COM O BANCO ENQUANTO ELE MUDA ───────────────────────────────
#
# Medido nesta instalação, no mesmo dia e com o mesmo arquivo:
#   tudo de pé ................................ 113 travamentos
#   CRM parado ................................  60 travamentos
#   CRM + rest + realtime + studio parados ....   0 travamentos
#
# Travamento aqui não é lentidão: quando o `create policy` trava, o `drop` que
# veio antes já valeu. A regra some, o banco nega a leitura em silêncio, e a
# tela fica vazia — indistinguível de "não há nada aqui".
#
# Custa ~16s (medido: parar 10,3s, subir 6,0s) numa atualização cuja mediana
# real é 308s e cuja variação natural entre duas rodadas foi de 785s. Fica
# abaixo do ruído que já existe.
#
# O `trap` é o que impede um erro no meio de deixar a instalação pela metade:
# qualquer saída — sucesso, erro ou interrupção — devolve as peças do Supabase.
trap restaurar_servicos EXIT

step "Atualizando o banco de dados"
if [ -f supabase/baseline.sql ]; then
  pausar_o_que_fala_com_o_banco
  # Extensões que o schema exige (idempotente; iguais ao install.sh).
  docker run --rm postgres:17-alpine psql "$(url_do_schema)" -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 || true

  raw="$(docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/b.sql:ro" \
        postgres:17-alpine psql "$(url_do_schema)" -f /b.sql 2>&1 || true)"

  # Erros benignos ao re-aplicar sobre uma base existente:
  benign='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
  unexpected="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$benign" || true)"

  if [ -n "$unexpected" ]; then
    c_ylw "⚠ Apareceram avisos no banco que NÃO são os esperados:"
    printf '%s\n' "$unexpected" | head -20
    c_ylw "  O app pode ainda funcionar. Se algo estiver errado, restaure o backup (restore.sh)."
    case "$unexpected" in
      *permission\ denied*|*must\ be\ owner*|*permissão\ negada*)
        c_ylw "  Os erros são de PERMISSÃO: a conexão do .env não é o dono do banco. Num Supabase"
        c_ylw "  próprio, declare SUPABASE_DB_ADMIN_URL no .env — é ela que roda o schema." ;;
    esac
  else
    c_grn "✓ banco atualizado (e conversas reorganizadas, se havia bagunça)."
  fi

  # ── O LOG DO BANCO FICA GUARDADO ──────────────────────────────────────────
  #
  # Ele era descartado: `raw` servia só para o filtro acima e morria com a
  # função. O que o agente guarda em `system_update_runs.log_tail` é a CAUDA da
  # atualização — Docker e reinício —, e o banco acontece antes disso.
  #
  # Medido em 2026-09-12, numa instalação real: duas regras de isolamento
  # sumiram durante uma atualização, o funil ficou vazio para todo mundo, e não
  # houve como saber por quê — a evidência tinha sido jogada fora. A única coisa
  # que restou foi a hipótese.
  printf '%s\n' "$raw" > "$PROJECT_DIR/.deskcomm-banco.log" 2>/dev/null || true

  # ── E AS REGRAS DE ISOLAMENTO SÃO CONFERIDAS ──────────────────────────────
  #
  # ## Por que isto existe
  #
  # O baseline aplica cada regra como APAGAR e depois CRIAR — é o único jeito
  # portável, porque o Postgres não tem `create or replace policy`. E esta
  # atualização roda SEM parar em erro, de propósito, para um clone bagunçado
  # conseguir se curar.
  #
  # As duas coisas juntas têm um desfecho ruim: se o "criar" falha, o "apagar"
  # já valeu. A regra some, a atualização segue e reporta SUCESSO. Com a regra
  # de leitura ausente e a segurança por linha ligada, o Postgres nega tudo —
  # sem erro, sem aviso. A tela mostra uma lista vazia, que é indistinguível de
  # "não há nada aqui".
  #
  # Medido: o dono de uma instalação descobriu horas depois, pelo funil vazio, e
  # não pela atualização que tinha acabado de dizer "concluída com sucesso".
  #
  # ## A régua, e por que não é "toda regra que o arquivo cria"
  #
  # O baseline CRIA e depois APAGA a mesma regra de propósito em vários pontos —
  # é assim que uma regra antiga vira três novas (`conversations_agent_write`
  # virou insert/update/delete). Contar toda criação daria falso positivo em
  # cima de decisão deliberada, e falso positivo derruba a confiança no aviso
  # inteiro. Vale a ÚLTIMA operação de cada regra no arquivo: quem termina
  # criada é esperada; quem termina apagada, não.
  esperadas="$(awk '
    match($0, /drop policy if exists "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/) {
      linha = substr($0, RSTART, RLENGTH); acao = "drop"
    }
    match($0, /create policy "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/) {
      linha = substr($0, RSTART, RLENGTH); acao = "create"
    }
    acao != "" {
      gsub(/.*policy (if exists )?"?/, "", linha); gsub(/"? on public\./, "|", linha)
      estado[linha] = acao; acao = ""
    }
    END { for (k in estado) if (estado[k] == "create") print k }
  ' supabase/baseline.sql | sort -u)"

  existentes="$(docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" -t -A -F'|' -c \
    "select p.polname, c.relname from pg_policy p join pg_class c on c.oid=p.polrelid
       join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';" 2>/dev/null | sort -u)"

  faltando="$(comm -23 <(printf '%s\n' "$esperadas") <(printf '%s\n' "$existentes") || true)"

  if [ -n "$faltando" ]; then
    # ── RECRIAR AS QUE FALTAM, NUNCA REAPLICAR O ARQUIVO ─────────────────────
    #
    # ⚠️ Isto corrige o que este script fazia antes: reaplicar o baseline inteiro
    # e conferir de novo. Aquilo era o que eu tinha feito no servidor, e a
    # medição mostrou que NÃO FECHA — reaplicar não converge. A segunda passada
    # devolveu `conversations_select` e levou embora `conversations_agent_insert`;
    # a terceira trocou o conjunto outra vez. Cada passada sorteia, porque cada
    # passada é a mesma corrida de APAGAR e CRIAR 92 vezes.
    #
    # Recriar só o que falta é um punhado de comandos rápidos, com muito menos
    # superfície para travar. E roda com os serviços ainda PARADOS, que é a
    # única janela sem disputa.
    #
    # E não é uma segunda cópia das 92 declarações: o comando sai do PRÓPRIO
    # `baseline.sql`, recortado dele. Nada aqui sabe o que uma regra diz.
    c_ylw "⚠ Faltaram regras de isolamento. Recriando exatamente as que faltam…"
    faltam_arq="$PROJECT_DIR/.deskcomm-regras-faltando.txt"
    printf '%s\n' "$faltando" > "$faltam_arq"

    # A régua junta o comando INTEIRO — uma regra real ocupa várias linhas, e
    # recortar só a primeira produziria SQL sem predicado e sem `;`, que falha
    # deixando a impressão de que tentou. E vale a ÚLTIMA operação de cada
    # regra: quem o arquivo cria e depois apaga de propósito não é recriada.
    # /!\ O arquivo do que falta entra como PRIMEIRO ARQUIVO do awk, e nao por
    # `-v`. MEDIDO: `awk -v var=valor` processa sequencias de escape no valor,
    # entao um caminho do Windows (C:\Users\...) perde as barras e o awk le um
    # arquivo que nao existe — devolvendo vazio, EM SILENCIO, como se nada
    # faltasse. Numa VPS Linux nao doeria; o teste pegou antes de virar aposta.
    recria="$(awk '
      NR == FNR { sub(/[ \t\r]+$/, "", $0); if ($0 != "") quero[$0] = 1; next }
      /create policy|drop policy if exists/ { buf = ""; coletando = 1 }
      coletando { buf = buf $0 "\n" }
      coletando && /;[ \t]*$/ {
        coletando = 0
        if (match(buf, /drop policy if exists "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/)) { k = substr(buf, RSTART, RLENGTH); acao = "drop" }
        else if (match(buf, /create policy "?[a-zA-Z0-9_]+"? on public\.[a-zA-Z0-9_]+/)) { k = substr(buf, RSTART, RLENGTH); acao = "create" }
        else next
        gsub(/.*policy (if exists )?"?/, "", k); gsub(/"? on public\./, "|", k)
        estado[k] = acao; if (acao == "create") texto[k] = buf
      }
      END { for (k in quero) if (estado[k] == "create") printf "%s", texto[k] }
    ' "$faltam_arq" supabase/baseline.sql)"

    if [ -n "$recria" ]; then
      printf '%s\n' "$recria" | docker run --rm -i postgres:17-alpine \
        psql "$(url_do_schema)" >> "$PROJECT_DIR/.deskcomm-banco.log" 2>&1 || true
    fi
    rm -f "$faltam_arq"

    existentes="$(docker run --rm -i postgres:17-alpine psql "$(url_do_schema)" -t -A -F'|' -c \
      "select p.polname, c.relname from pg_policy p join pg_class c on c.oid=p.polrelid
         join pg_namespace n on n.oid=c.relnamespace where n.nspname='public';" 2>/dev/null | sort -u)"
    faltando="$(comm -23 <(printf '%s\n' "$esperadas") <(printf '%s\n' "$existentes") || true)"
  fi

  if [ -n "$faltando" ]; then
    c_red "⛔ REGRAS DE ISOLAMENTO AUSENTES — NÃO use o sistema até resolver."
    c_red "   Sem elas o banco NEGA a leitura em silêncio: telas aparecem VAZIAS,"
    c_red "   sem erro nenhum, e isso é indistinguível de 'não há dados'."
    printf '%s\n' "$faltando" | sed 's/|/ na tabela /; s/^/   • /' | head -20
    c_ylw "   O log do banco está em .deskcomm-banco.log — mande-o para o suporte."
    c_ylw "   Para voltar ao estado anterior: bash restore.sh"
    # ⛔ E A ATUALIZAÇÃO PARA AQUI.
    #
    # Antes ela seguia: imprimia este bloco vermelho e ia para o passo 5, que
    # sobe o app com a imagem nova. O CRM voltava ao ar sem regra de isolamento,
    # mostrando tela vazia para todo mundo — e o vermelho já tinha rolado para
    # fora da tela. Foi assim que o dono da instalação descobriu pelo funil,
    # horas depois, e não pela atualização.
    #
    # O `trap` (logo acima do passo do banco) devolve as peças do Supabase e
    # deixa o CRM parado de propósito. Um CRM fora do ar é um problema visível
    # que alguém resolve; um CRM no ar sem isolamento, não.
    REGRAS_FALTANDO="$faltando"
    exit 1
  else
    c_grn "✓ regras de isolamento conferidas ($(printf '%s\n' "$esperadas" | grep -c . ) declaradas, todas no lugar)."
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei a parte do banco."
fi
[ -n "${DESKCOMM_AGENT_REPORT:-}" ] && eval "${DESKCOMM_AGENT_REPORT_CMD}" banco

# ── 4.5 E-mails de acesso, para quem já estava instalado ────────────────────
# Só COM o token no ambiente, e por isso duas coisas:
#
#  - é assim que um clone ANTIGO recebe os e-mails com a marca dele. O
#    `install.sh` dele nunca chamou este passo (ele não existia), e nenhuma
#    atualização toca em config de auth por conta própria;
#  - sem o token, o script imprimiria o passo manual — útil UMA vez, na
#    instalação, e ruído em toda atualização a partir daí. Atualização que
#    resmunga toda vez ensina a ignorar a saída dela.
#
# E sem o token, UMA vez na vida: quem instalou antes de a entrevista pedir o
# token tem o Site URL do projeto em `localhost:3000` — o link de "esqueci minha
# senha" leva a uma máquina que não existe fora do laptop de quem desenvolve.
# Esse parque não é alcançado por nada: o `install.sh` dele não perguntou o
# token, e o bloco acima só roda com token. Sem esta linha, a população
# REALMENTE quebrada hoje nunca fica sabendo.
#
# Uma vez, e nunca mais — o marcador em disco garante isso, que é o que separa
# um recado de um resmungo mensal. E o texto CONFERE, não acusa: quem já
# configurou à mão está certo, e ler "seus e-mails estão quebrados" numa
# atualização que correu bem seria alarme falso na cara de quem fez tudo certo.
AVISO_SITE_URL=""
MARCA_AVISO_SITE_URL="$PROJECT_DIR/.deskcomm-site-url-avisado"
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  bash "$KIT_DIR/marca-emails.sh" --projeto "$PROJECT_DIR" || true
  : > "$MARCA_AVISO_SITE_URL" 2>/dev/null || true   # o passo automático rodou
elif [ ! -e "$MARCA_AVISO_SITE_URL" ]; then
  AVISO_SITE_URL=1
fi

# ── 5. App novo ──────────────────────────────────────────────────────────────
step "Baixando a versão nova do app e reiniciando"
# Imagem da TAG publicada (não "latest" solto): garante que o código (checkout
# acima) e a imagem do container sejam sempre da mesma versão. Gravada no .env,
# não só exportada: o compose lê a imagem de lá, e um `up -d` rodado à mão
# depois voltaria pro ":latest" do install — desfazendo a atualização.
#
# As TRÊS imagens são gravadas juntas, na mesma versão. O worker e o scheduler
# passaram a ter imagem publicada porque, antes, eram `build:`-only no compose:
# `dc pull` os PULAVA ("Skipped - No image to be pulled") e o `dc up -d` abaixo
# recriava o contêiner sobre a imagem velha, sem `--build`. Resultado: o worker
# — que é o runtime do agente de IA — ficava congelado no código do dia da
# instalação e atravessava todas as atualizações. Esta é a linha que conserta
# isso para o parque já instalado, sem que ninguém precise editar arquivo.
#
# `gravar_imagens` também resolve o pull_policy pela mutabilidade da tag: como
# aqui o alvo é sempre uma tag de versão (imutável), sai `missing`. Isso além de
# tudo desfaz o "missing" que um rollback anterior deixava para trás — antes ele
# ficava no .env para sempre, e o `up -d` manual do dono nunca mais puxava nada.
# Lido ANTES de `gravar_imagens` corrigir — senão a informação some. Este é o
# estado que a execução ANTERIOR deixou, e o dono nunca soube: o `update.sh`
# antigo grava só `APP_IMAGE`, e o worker fica seguindo um canal móvel.
PIN_FALTANDO_ANTES="$(pin_incompleto .env)"

VERSAO_ALVO="${TARGET_TAG#v}"
export APP_IMAGE="${IMG_APP}:${VERSAO_ALVO}"
export WORKER_IMAGE="${IMG_WORKER}:${VERSAO_ALVO}"
export SCHEDULER_IMAGE="${IMG_SCHEDULER}:${VERSAO_ALVO}"
gravar_imagens .env "$VERSAO_ALVO"

# Os segredos da chamada de voz (spec 18), para quem instalou antes dela existir.
# LACUNA apenas — chave presente, mesmo vazia, é decisão de quem opera. Isto NÃO
# liga a feature: sem `voz` em COMPOSE_PROFILES o serviço nem é criado. O que
# isto compra é o dia em que o dono QUISER ligar não começar por inventar dois
# segredos num editor dentro da VPS, que é o passo manual que a doutrina de
# packaging proíbe.
VOZ_CRIADA="$(completar_segredos_da_voz .env)" || VOZ_CRIADA=""
[ -n "$VOZ_CRIADA" ] && c_ylw "  (preparei as credenciais da chamada de voz no .env — ela segue DESLIGADA)"

# `dc pull` falha se alguma das três imagens ainda não existir no registro — o
# que acontece numa instalação atualizando para a primeira versão publicada
# depois desta mudança, ou se um run de publicação quebrou. Nesse caso o compose
# ainda tem `build:` ao lado do `image:` do worker e do scheduler, então o
# `up -d` os constrói localmente: pior que puxar, melhor que não atualizar.
if ! dc pull; then
  # A mensagem distingue os dois casos porque a consequência é oposta, e uma
  # frase tranquilizadora sobre o caso errado é o pior desfecho possível: o
  # `worker` e o `scheduler` têm `build:` ao lado do `image:` e o `up -d` os
  # constrói; o `app` NÃO tem, então se for a imagem dele que falta, o `up -d`
  # morre logo abaixo — e dizer "sigo assim mesmo" teria sido mentira.
  if dc pull app >/dev/null 2>&1; then
    c_ylw "⚠ Não consegui puxar todas as imagens da versão ${VERSAO_ALVO}."
    c_ylw "  A do app veio; o que faltar é construído aqui (mais lento, mesmo resultado)."
  else
    c_ylw "⚠ Não consegui puxar a imagem do APP na versão ${VERSAO_ALVO}."
    c_ylw "  Causas comuns: a versão ainda está publicando, ou o pacote está privado no GHCR."
    c_ylw "  Vou tentar subir mesmo assim — se falhar, rode de novo em alguns minutos."
  fi
fi
# A rede do proxy externo é declarada como EXTERNA no compose: se ela sumiu
# (um `docker network prune`, ou o `down -v` que o próprio kit ensina como
# caminho de recomeço), o `up -d` abaixo morre em "network X declared as
# external, but could not be found" — e este script roda sozinho pelo agent.sh,
# então ninguém está lendo a tela para decifrar isso. Mesma função do install.sh.
garantir_rede_do_proxy
dc up -d

# O Caddyfile entra no container por bind mount de UM ARQUIVO, e bind mount de
# arquivo fica preso ao inode. O `git pull` não edita o arquivo: escreve outro e
# renomeia, gerando inode novo — o container continua lendo o antigo, para
# sempre. Medido nesta VPS: host inode 3283869, container 3271833, com o
# conteúdo velho lá dentro.
#
# Sem este force-recreate, TODA mudança de proxy enviada numa atualização
# (inclusive correção de segurança na borda) some em silêncio: o update diz
# "concluída" e a configuração antiga segue valendo.
#
# Com proxy externo não há Caddy para recriar — e não basta o profile inativo
# do override: nomear o serviço explicitamente (`up -d ... caddy`) ATIVA o
# profile dele no Compose e sobe o contêiner assim mesmo, indo bater de frente
# com o Traefik nas portas 80/443. O resultado era um "⚠ não consegui recriar o
# proxy" em TODA atualização de quem usa proxy externo: alarme falso, num
# momento em que o dono precisa confiar no que está lendo.
if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
  c_grn "✓ proxy externo (Traefik): o Caddy não é usado aqui — nada a recarregar"
else
  dc up -d --force-recreate --no-deps caddy >/dev/null 2>&1 \
    && c_grn "✓ proxy recarregado com a configuração desta versão" \
    || c_ylw "⚠ não consegui recriar o proxy — rode: docker compose $(dc_files) up -d --force-recreate caddy"
fi

# ── 6. O app voltou no ar? ───────────────────────────────────────────────────
step "Conferindo se o app voltou no ar"
ok=""
wait_app_healthy 20 3 >/dev/null && ok=1
if [ -n "$ok" ]; then
  c_grn "✓ Atualização concluída — app no ar e saudável."
  # Dito no fim, e não no início, porque é aqui que o dono lê. Se a execução
  # anterior deixou o pin pela metade, ele nunca soube — a tela dizia "concluída"
  # e o worker seguia um canal móvel. Agora ele sabe que existiu e que acabou.
  if [ -n "$PIN_FALTANDO_ANTES" ]; then
    c_ylw "  (de quebra: a versão de $PIN_FALTANDO_ANTES estava solta e foi fixada agora)"
  fi
  # Dito aqui pelo mesmo motivo do pin: é no fim que o dono lê.
  if [ -n "$AVISO_SITE_URL" ]; then
    DOM_AVISO="$(printf '%s' "${NEXT_PUBLIC_APP_URL:-https://SEU_DOMINIO}")"
    cat <<AVISO

$(c_ylw "  ─── CONFIRA UMA COISA, UMA VEZ SÓ ─────────────────────")

  Os e-mails de acesso (esqueci minha senha, confirmação de cadastro,
  aceite de convite) levam para o endereço que estiver em Authentication
  → URL Configuration, no painel do Supabase. Instalações feitas antes de
  o instalador perguntar o token do Supabase ficaram com o padrão de
  projeto novo, \`http://localhost:3000\`, que só existe na máquina de
  quem desenvolve — e aí ninguém consegue redefinir a própria senha.

  Vale conferir. Se já estiver com os valores abaixo, não há nada a fazer:

       Site URL:       ${DOM_AVISO}
       Redirect URLs:  ${DOM_AVISO%/}/auth/confirm

  Este aviso não se repete — para o instalador cuidar disso sozinho, rode
  o update com \`export SUPABASE_ACCESS_TOKEN=sbp_...\` no ambiente.
AVISO
    : > "$MARCA_AVISO_SITE_URL" 2>/dev/null || true
  fi
else
  c_ylw "⚠ Atualizei, mas o app não respondeu 'ok'. Veja os logs:"
  c_ylw "  docker compose $(dc_files) logs --tail=50 app"
  # Código de saída != 0: é o que o agent.sh usa pra saber que precisa voltar
  # pra imagem anterior (guardada por ele ANTES do pull). Sem isso, não existe
  # rede de proteção — o app novo, quebrado, ficaria no ar sem ninguém saber.
  exit 1
fi

# ── 7. Automações (cron do drain de eventos; o da tela já subiu no bloco 0) ──
step "Conferindo as automações"
ensure_encryption_key .env
setup_event_log_drain_cron
