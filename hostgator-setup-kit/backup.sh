#!/usr/bin/env bash
# Backup: dump do banco (Supabase) + snapshot das sessões do WhatsApp.
# Supabase free NÃO tem backup automático — rode isto num cron diário.
#
#   crontab -e →  0 3 * * *  cd /caminho/deskcommcrm && bash hostgator-setup-kit/backup.sh
source "$(dirname "$0")/_common.sh"
enter_project

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
# Backup é o banco inteiro, a sessão do WhatsApp (quem a lê fala pelo número da
# empresa) e os anexos dos clientes: só o dono lê. Todo arquivo de backup nasce
# no HOST, deste umask e com dono = quem chamou: os `tar` dos contêineres mandam
# o snapshot pela saída padrão em vez de gravar numa montagem — gravado lá
# dentro, ele nasceria do umask da imagem (022) e do root do contêiner, ilegível
# para quem roda o backup pelo grupo docker. O `chmod` fecha a pasta que um
# backup antigo deixou 755; onde o sistema de arquivos o recusa (CIFS/NFS), o
# backup segue — os arquivos já nascem 600 — em vez de derrubar o update.sh.
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null \
  || c_ylw "⚠ não consegui fechar a pasta $BACKUP_DIR (chmod 700): os arquivos deste backup saem legíveis só pelo dono, mas a pasta ficou como estava."
# ── Exclusão mútua entre execuções ───────────────────────────────────────────
# Dois caminhos chamam este script no MESMO host: o cron diário (topo deste
# arquivo) e o backup de segurança do update.sh (passo "Backup de segurança",
# update.sh:303-305). No mesmo segundo os dois abriam o MESMO `.parcial`; como o
# `mv` preserva o inode, o arquivo já publicado continuava sendo escrito pelo
# perdedor da corrida — um dump que podia deixar de passar no `gzip -t` DEPOIS
# de aprovado. O `flock` abaixo serializa as duas execuções.
#
# POLÍTICA: ESPERAR CURTO (BACKUP_LOCK_WAIT, 300 s por padrão) e, se o outro não
# terminar nesse prazo, RECUSAR com mensagem — rc≠0 e nada tocado. O cron cede a
# vez ao update.sh e vice-versa; um backup travado não vira fila infinita
# segurando a atualização. Quem espera vê "⏳ outro backup está rodando"; quem
# desiste vê "✖ outro backup ainda está rodando".
#
# O lock fica FORA da pasta de dumps (não entra na retenção dos 14 nem na
# listagem de quem vai restaurar): em $TMPDIR, com uid e hash do destino no
# nome — duas instalações no mesmo host não se bloqueiam. O descritor 9 fica
# aberto até o processo sair, então o kernel solta a trava em QUALQUER saída
# (inclusive SIGKILL): lock preso não existe; o trap abaixo só fecha o fd.
lock_dir="${TMPDIR:-/tmp}"
lock_key="$(printf '%s' "$BACKUP_DIR" | cksum | cut -d' ' -f1)"
LOCK_FILE="${BACKUP_LOCK_FILE:-$lock_dir/deskcomm-backup-$(id -u)-$lock_key.lock}"
exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  c_ylw "⏳ outro backup está rodando nesta pasta ($LOCK_FILE) — esperando até ${BACKUP_LOCK_WAIT:-300}s por ele."
  if ! flock -w "${BACKUP_LOCK_WAIT:-300}" 9; then
    die "outro backup ainda está rodando ($LOCK_FILE): este saiu sem tocar em nenhum arquivo. Rode de novo quando o primeiro terminar."
  fi
fi

# Timestamp vem do host (não do script) pra manter determinismo do kit.
ts="$(date +%Y%m%d-%H%M%S)"

# O temporário é ÚNICO por execução: `mktemp` na PRÓPRIA pasta de destino, para
# o `mv` continuar atômico (mesmo sistema de arquivos). Nome fixo — o `.parcial`
# de antes — era justamente o que deixava as duas execuções escreverem no mesmo
# inode. O trap apaga o temporário em qualquer saída: falha no meio não deixa
# lixo e o dump anterior NÃO é tocado — ele só perde o nome no `mv` final,
# depois de passar no `gzip -t`.
parcial_db=""
parcial=""
parcial_st=""
limpar_temporarios() {
  local f
  for f in "$parcial_db" "$parcial" "$parcial_st"; do
    [ -n "$f" ] && rm -f "$f"
  done
  return 0
}
trap 'limpar_temporarios; exec 9>&-' EXIT

step "Dump do banco → $BACKUP_DIR/db-$ts.sql.gz"
# Pela conexão de SCHEMA (url_do_schema), não pela do app: `pg_dump` só despeja
# o que a role enxerga, e com uma role menor — a que recomendamos no `.env` de
# quem usa Supabase próprio — o backup sai PARCIAL e sai verde. Falha silenciosa
# de backup é a pior das falhas: só aparece na hora de restaurar.
# O dump só recebe o nome definitivo depois de conferido — temporário único por
# execução + `mv` atômico (o snapshot do WhatsApp logo abaixo segue o mesmo
# padrão). Duas guardas, dois casos:
#   1. uma etapa do pipe falha (`gzip` morre com disco cheio, `pg_dump` sai ≠0):
#      o `if !` pega o exit e apaga o arquivo cortado — sem ele, o `set -e`
#      abortava ali mesmo e o `db-*.sql.gz` cortado ficava na pasta, dentro da
#      retenção e ao alcance do restore;
#   2. o pipe sai com zero mas o arquivo não se lê: `gzip -t` percorre o arquivo
#      inteiro e confere o CRC. BACKUP QUE NINGUÉM CONSEGUE LER NÃO É BACKUP.
parcial_db="$(mktemp "$BACKUP_DIR/.db-$ts.sql.gz.XXXXXX")"
if ! pg_container postgres:17-alpine pg_dump "$(url_do_schema)" --no-owner --no-privileges \
     | gzip > "$parcial_db"; then
  rm -f "$parcial_db"
  die "o dump do banco falhou no meio (disco cheio? pg_dump interrompido?) — removi o arquivo incompleto. Sem backup válido, não siga com atualização."
fi
if ! gzip -t "$parcial_db" 2>/dev/null; then
  rm -f "$parcial_db"
  die "o dump do banco saiu corrompido (gzip -t reprovou) — removi o arquivo para ninguém confiar nele. Sem backup válido, não siga com atualização."
fi
mv "$parcial_db" "$BACKUP_DIR/db-$ts.sql.gz"
c_grn "✓ banco: $(du -h "$BACKUP_DIR/db-$ts.sql.gz" | awk '{print $1}') (conferido)"

step "Snapshot das sessões do WhatsApp → $BACKUP_DIR/waha-$ts.tgz"
vol="$(volume_waha_data)"
# O arquivo só recebe o nome definitivo depois de PROVADO que tem sessão dentro.
# Volume errado (ou vazio) renderia um .tgz de ~87 bytes cujo `tar` sai com zero:
# o passo virava "✓ sessões WhatsApp salvas", o arquivo sem valor entrava na
# retenção dos 14 e o pareamento do WhatsApp — o que este snapshot existe para
# poupar — só se dava por perdido no dia do restore.
parcial="$(mktemp "$BACKUP_DIR/.waha-$ts.tgz.XXXXXX")"
if ! docker run --rm -v "${vol}:/data:ro" alpine:3.20 tar czf - -C /data . 2>/dev/null > "$parcial"; then
  rm -f "$parcial"
  c_ylw "⚠ não consegui ler o volume das sessões ('$vol'): o backup do banco está feito, mas o pareamento do WhatsApp NÃO entrou nele."
elif ! tar_tem_sessao "$parcial"; then
  rm -f "$parcial"
  c_ylw "⚠ o snapshot das sessões saiu VAZIO — a montagem /app/.sessions do contêiner waha resolveu para '$vol' e não tem sessão gravada. Este backup NÃO salva o pareamento do WhatsApp (o restore vai pedir o QR code de novo). Confira a montagem antes de considerar o backup completo."
else
  mv "$parcial" "$BACKUP_DIR/waha-$ts.tgz"
  c_grn "✓ sessões WhatsApp salvas ($(du -h "$BACKUP_DIR/waha-$ts.tgz" | awk '{print $1}'))"
fi

# Single-server: os ANEXOS (fotos, documentos) moram no disco desta VPS, no
# Storage do Supabase (STORAGE_BACKEND=file) — o dump acima leva só as linhas
# que apontam para eles. Sem este passo o backup dizia "concluído" e a
# restauração devolvia anexos quebrados. Por isso aqui falha é FALHA.
if [ "${SINGLE_SERVER:-0}" = "1" ]; then
  step "Arquivos anexados (Storage) → $BACKUP_DIR/storage-$ts.tgz"
  parcial_st="$(mktemp "$BACKUP_DIR/.storage-$ts.tgz.XXXXXX")"
  if ! docker run --rm -v "$(dir_do_supabase)/volumes/storage:/data:ro" alpine:3.20 \
       tar czf - -C /data . > "$parcial_st"; then
    rm -f "$parcial_st"
    die "Não consegui salvar os arquivos anexados: este backup NÃO está completo."
  fi
  mv "$parcial_st" "$BACKUP_DIR/storage-$ts.tgz"
  c_grn "✓ anexos: $(du -h "$BACKUP_DIR/storage-$ts.tgz" | awk '{print $1}')"
fi

# Retenção: mantém os 14 mais recentes de cada tipo.
step "Limpando backups antigos (mantém 14)"
(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
(ls -1t "$BACKUP_DIR"/waha-*.tgz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
(ls -1t "$BACKUP_DIR"/storage-*.tgz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
c_grn "✓ backup concluído em $BACKUP_DIR"
