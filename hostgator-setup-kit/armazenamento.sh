#!/usr/bin/env bash
# Espaço em disco, retenção de backup e poda de imagens (#4837).
#
# É BIBLIOTECA: o _common.sh faz `source` deste arquivo e nada roda ao carregar.
# O incidente que originou isto foi medido numa instalação self-hosted: 73,62 GB
# em imagens Docker, 12 GB de backups, 14 cópias de 1,6 GB mantidas só porque a
# retenção olhava a QUANTIDADE. O disco encheu no meio de um pull, o app ficou em
# `Created` e a volta automática falhou seis vezes seguidas.
#
# As três guardas daqui respondem a isso sem tocar em volume, banco ou na última
# cópia de nada:
#   - `checar_espaco_para_atualizacao` recusa ANTES do pull, quando a conta não
#     fecha — o update.sh chama `refuse` (RC 3: a atualização nunca começou);
#   - `podar_backups` mantém N por tipo (BACKUP_KEEP, padrão 14), apaga do mais
#     antigo para o mais novo e NUNCA o mais recente;
#   - `podar_imagens_nao_usadas` poda conservadora: `docker image prune` SEM
#     `-a` (só camadas soltas com mais de uma semana) e, uma a uma, as versões
#     antigas das NOSSAS imagens. Falha aqui é aviso, nunca aborto.
#
# O que é do OPERADOR continua sendo do operador, e o kit diz isso na mensagem:
# apagar backup antigo de verdade, decidir retenção por tamanho e mover cópia
# para fora da VPS continuam decisão de quem administra o servidor. O que o kit
# passou a garantir é não começar uma atualização que não cabe no disco.

# ── Espaço em disco ─────────────────────────────────────────────────────────

espaco_livre_kb() {  # espaco_livre_kb <diretório> → KB livres (rc 1 se não mediu)
  local dir="${1:-.}" kb
  # `-P` é POSIX: sem quebrar a linha em nomes longos de sistema de arquivos, que
  # é o que faz o `awk NR==2` ler a linha errada e devolver lixo. `-k` fixa a
  # unidade em KB — a conta daqui é toda em KB, sem parsear "1,2G".
  kb="$(df -Pk -- "$dir" 2>/dev/null | awk 'NR==2 { print $4 }')"
  case "$kb" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$kb"
}

kb_em_gb() {  # kb_em_gb <KB> → "12,3 GB" (texto para o operador)
  awk -v kb="${1:-0}" 'BEGIN { printf "%.1f GB", kb / 1048576 }'
}

tamanho_do_ultimo_backup_kb() {  # tamanho_do_ultimo_backup_kb <dir> → KB
  # O backup desta atualização é do tamanho do último que deu certo; medir o
  # mais recente de cada tipo é a estimativa mais barata e mais fiel que existe.
  local dir="${1:-}" glob f total=0
  [ -n "$dir" ] || { printf '0'; return 0; }
  for glob in 'db-*.sql.gz' 'waha-*.tgz' 'storage-*.tgz'; do
    # SC2086 é proposital: o glob tem de ser expandido pelo shell.
    # shellcheck disable=SC2086
    f="$(ls -1t -- "$dir"/$glob 2>/dev/null | head -n 1)"
    [ -n "$f" ] || continue
    total=$(( total + $(stat -c %s -- "$f" 2>/dev/null || printf 0) / 1024 ))
  done
  printf '%s' "$total"
}

tamanho_das_imagens_em_uso_kb() {  # soma o tamanho das imagens desta instalação
  local img bytes soma=0
  for img in "${APP_IMAGE:-}" "${WORKER_IMAGE:-}" "${SCHEDULER_IMAGE:-}" "${VOICE_AGENT_IMAGE:-}"; do
    [ -n "$img" ] || continue
    bytes="$(docker image inspect --format '{{.Size}}' "$img" 2>/dev/null | head -n 1)"
    case "$bytes" in ''|*[!0-9]*) continue ;; esac
    soma=$(( soma + bytes / 1024 ))
  done
  printf '%s' "$soma"
}

espaco_necessario_kb() {  # → KB que a atualização precisa ter livres
  # O piso é o chamado de última hora: quando `docker image inspect` não
  # responde (daemon parado, imagem ainda não baixada), não há o que medir, e
  # 1 GB é o mínimo para um pull não deixar o disco zerado no meio. Com medição,
  # a conta das imagens + backup domina o piso em toda instalação real.
  local piso_mb="${DESKCOMM_ESPACO_MINIMO_MB:-1024}" imagens backups medido
  case "$piso_mb" in ''|*[!0-9]*) piso_mb=1024 ;; esac
  imagens="$(tamanho_das_imagens_em_uso_kb)"
  backups="$(tamanho_do_ultimo_backup_kb "${BACKUP_DIR:-${PROJECT_DIR:-.}/backups}")"
  # O pull grava as camadas novas ANTES de as antigas perderem a referência, e o
  # backup desta atualização ocupa o mesmo que o anterior. Os 20% de folga
  # cobrem a diferença de compressão e o diretório temporário do Docker.
  medido=$(( (${imagens:-0} + ${backups:-0}) * 12 / 10 ))
  if [ "$medido" -gt $(( piso_mb * 1024 )) ]; then
    printf '%s' "$medido"
  else
    printf '%s' $(( piso_mb * 1024 ))
  fi
}

# Preenchidas por `checar_espaco_para_atualizacao` — o chamador formata a
# mensagem com os dois números, em vez de raparsar texto.
ESPACO_LIVRE_KB=""
ESPACO_NECESSARIO_KB=""

checar_espaco_para_atualizacao() {  # 0 = pode seguir; 1 = falta espaço
  local livre necessario
  ESPACO_LIVRE_KB=""; ESPACO_NECESSARIO_KB=""
  if ! livre="$(espaco_livre_kb "${PROJECT_DIR:-.}")"; then
    # Não conseguir medir NÃO é motivo para impedir a atualização: numa VPS com
    # `df` quebrado, recusar trocaria um risco por uma parada garantida — e o
    # pior caso da guarda é justamente virar ela mesma a falha.
    c_ylw "⚠ não consegui medir o espaço livre em disco (df falhou) — sigo sem a checagem de espaço."
    return 0
  fi
  necessario="$(espaco_necessario_kb)"
  ESPACO_LIVRE_KB="$livre"; ESPACO_NECESSARIO_KB="$necessario"
  [ "$livre" -ge "$necessario" ] || return 1
  return 0
}

mensagem_de_espaco_curto() {  # texto pronto para o `refuse` do update.sh
  local piso_mb="${DESKCOMM_ESPACO_MINIMO_MB:-1024}"
  case "$piso_mb" in ''|*[!0-9]*) piso_mb=1024 ;; esac
  cat <<EOF
Atualização NÃO começou — nada foi parado, nada foi baixado, e a versão atual segue no ar.
  Falta espaço em disco: há $(kb_em_gb "$ESPACO_LIVRE_KB") livres e esta atualização precisa de $(kb_em_gb "$ESPACO_NECESSARIO_KB").
  A conta é o maior entre o piso de ${piso_mb} MB (DESKCOMM_ESPACO_MINIMO_MB, no .env) e o tamanho das imagens em uso mais o do último backup, com 20% de folga.
  O que libera espaço sem apagar dado nenhum:
    docker system df                                  # quem está ocupando o disco
    docker image prune -f --filter "until=168h"       # só camadas sem tag, mais velhas que 7 dias
    bash hostgator-setup-kit/backup.sh --podar        # aplica a retenção dos backups agora
  NUNCA use "docker system prune --volumes": os volumes guardam o pareamento do WhatsApp e o banco.
  Aumentar o disco da VPS também resolve — a atualização continua exatamente daqui.
EOF
}

# ── Retenção de backup ──────────────────────────────────────────────────────

podar_backups() {  # podar_backups <diretório> <manter por tipo>
  local dir="${1:-}" manter="${2:-14}" glob total apagados=0 i
  local -a lista
  [ -n "$dir" ] || return 0
  case "$manter" in
    ''|*[!0-9]*) c_ylw "⚠ BACKUP_KEEP inválido ('$manter'): uso 14."; manter=14 ;;
  esac
  # ZERO não é política de retenção: apagaria o backup que a atualização acabou
  # de fazer, que é o único que importa se o banco quebrar agora. O piso é 1.
  [ "$manter" -ge 1 ] || manter=1
  for glob in 'db-*.sql.gz' 'waha-*.tgz' 'storage-*.tgz'; do
    lista=()
    mapfile -t lista < <(ls -1t -- "$dir"/$glob 2>/dev/null || true)
    total=${#lista[@]}
    [ "$total" -gt "$manter" ] || continue
    # `ls -1t` já vem do mais novo para o mais antigo: o que passa do limite é
    # o mais ANTIGO, e é ele que sai primeiro.
    for (( i = manter; i < total; i++ )); do
      if rm -f -- "${lista[$i]}"; then
        apagados=$(( apagados + 1 ))
        c_dim "  apagado: ${lista[$i]##*/}"
      else
        c_ylw "⚠ não consegui apagar ${lista[$i]##*} — ele segue no disco"
      fi
    done
  done
  if [ "$apagados" -gt 0 ]; then
    c_grn "✓ backups antigos: $apagados apagado(s); mantendo os $manter mais recentes de cada tipo"
  fi
  return 0
}

# ── Poda de imagens ─────────────────────────────────────────────────────────

podar_imagens_nao_usadas() {  # nunca aborta: a atualização já deu certo quando roda
  if [ "${DESKCOMM_PODA_IMAGENS:-1}" != "1" ]; then
    c_dim "  (poda de imagens desligada: DESKCOMM_PODA_IMAGENS=0 no .env)"
    return 0
  fi
  # 1) Camadas soltas. `docker image prune` SEM `-a`: só o que já perdeu a tag.
  #    `until=168h` poupa o que uma atualização em voo acabou de baixar, e
  #    `dangling=true` explícito deixa registrado na saída o que foi alvo.
  #    NUNCA `prune -a`: ele leva embora a imagem da versão anterior, que é
  #    justamente para onde a volta automática precisa ir.
  if ! docker image prune -f --filter "dangling=true" --filter "until=168h" >/dev/null 2>&1; then
    c_ylw "⚠ a poda de camadas soltas não rodou (Docker ocupado?) — a atualização está concluída, siga com ela."
  fi
  podar_versoes_antigas_das_nossas_imagens || true
  return 0
}

podar_versoes_antigas_das_nossas_imagens() {
  # As imagens de terceiros (WAHA, Redis, Caddy, Supabase) NÃO entram: outra
  # pilha Docker na mesma VPS usa as mesmas tags, e o kit não é dono delas.
  local atual="${APP_IMAGE##*:}" anterior="" refs img usadas tag
  if [ -f "${PROJECT_DIR:-.}/.deskcomm-env-antes-do-update" ]; then
    # Lido pelo `load_env` do kit, não por `sed`: o snapshot vem no encoding de
    # `envq` (aspas, escapes), e cortar por `sed` deixava a aspa de fecho dentro
    # do nome da tag — o resultado era a versão da volta ser apagada.
    anterior="$(
      load_env "${PROJECT_DIR:-.}/.deskcomm-env-antes-do-update" >/dev/null 2>&1
      printf '%s' "${APP_IMAGE:-}"
    )"
    anterior="${anterior##*:}"
  fi
  # Contêiner parado também conta: `docker image rm` se recusaria a apagar (e
  # recusar é o certo — não se usa --force aqui de jeito nenhum). A lista evita
  # a tentativa e o aviso inútil no meio da saída da atualização.
  usadas="$(docker ps -a --format '{{.Image}}' 2>/dev/null || true)"
  for refs in "${IMG_APP:-}" "${IMG_WORKER:-}" "${IMG_SCHEDULER:-}" "${IMG_VOICE_AGENT:-}"; do
    [ -n "$refs" ] || continue
    docker image ls --format '{{.Repository}}:{{.Tag}}' "$refs" 2>/dev/null | while IFS= read -r img; do
      [ -n "$img" ] || continue
      tag="${img##*:}"
      # Só tag de versão (vX.Y.Z). `stable`, `latest`, `local` e `<none>` são
      # canais móveis ou lixo de build: mexer neles muda o que o compose sobe.
      case "$tag" in
        v[0-9]*) ;;
        *) continue ;;
      esac
      if [ "$tag" = "$atual" ] || [ "$tag" = "$anterior" ]; then continue; fi
      case " $usadas " in *" $img "*) continue ;; esac
      if docker image rm "$img" >/dev/null 2>&1; then
        c_dim "  imagem antiga removida: $img"
      fi
    done
  done
  return 0
}
