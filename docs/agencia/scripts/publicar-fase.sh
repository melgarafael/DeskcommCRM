#!/bin/bash
# Publica uma fase da agência no TESTE: confere que ninguém mexeu nos arquivos da
# agência desde a fase anterior, aplica o patch dos arquivos compartilhados, extrai
# os arquivos da agência, acrescenta o apêndice da migration ao baseline (antes da
# varredura de anon), aplica o SQL no banco do teste, marca tags de rollback e
# reconstrói app e worker — esperando qualquer build que já esteja rodando na VPS
# (ex.: o da central) terminar antes.
#
# Uso: nohup bash publicar-fase.sh <N> <arquivo-da-migration> "<título do bloco>" "<compartilhados>" > publicar-fN.log 2>&1 &
# Entradas em /root/agencia-deploy: fN-proprios.tgz, fN-compartilhados.patch, fN-md5-antes.txt
# Rollback: restaurar antes-fN-<TS>.tgz, apagar os arquivos de fN-novos.txt e voltar
# as imagens para deskcomm-teste-{app,worker}:antes-fN-<TS>.
set -uo pipefail
N="$1"; MIG="$2"; TITULO="$3"; COMP="$4"
D=/root/agencia-deploy
cd /docker/deskcommcrm-teste || exit 1
TS=$(date +%Y%m%d-%H%M%S)
falha() { echo "FALHOU: $*"; exit 2; }

echo "== 0. conferência ($TS)"
md5sum -c --quiet "$D/f$N-md5-antes.txt" || falha "arquivo da agência mudou no teste"
patch -p1 --dry-run < "$D/f$N-compartilhados.patch" > /dev/null || falha "patch dos compartilhados não encaixa"

echo "== 1. cópia de segurança"
EXISTENTES=""
for f in $(tar -tzf "$D/f$N-proprios.tgz"); do [ -e "$f" ] && EXISTENTES="$EXISTENTES $f"; done
tar -czf "$D/antes-f$N-$TS.tgz" $COMP supabase/baseline.sql $EXISTENTES
: > "$D/f$N-novos.txt"
for f in $(tar -tzf "$D/f$N-proprios.tgz"); do [ -e "$f" ] || echo "$f" >> "$D/f$N-novos.txt"; done

echo "== 2. arquivos"
patch -p1 < "$D/f$N-compartilhados.patch" || falha "patch"
tar -xzf "$D/f$N-proprios.tgz" || falha "tar"

echo "== 3. apêndice no baseline"
python3 - "$MIG" "$TITULO" <<"PY"
import sys, re
f = "supabase/baseline.sql"; s = open(f, encoding="utf-8").read()
mig, titulo = sys.argv[1], sys.argv[2]
num = re.search(r"_(9\d{3})_", mig).group(1)
if f"(migration {num}) ----" in s:
    print("já existe")
else:
    corpo = "\n".join(l for l in open(mig, encoding="utf-8").read().splitlines() if not l.startswith("-- manifest:")).strip()
    anc = "-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----"
    j = s.index(anc)
    s = s[:j] + f"-- ---- {titulo} (migration {num}) ----\n" + corpo + "\n\n" + s[j:]
    open(f, "w", encoding="utf-8").write(s); print("inserido")
PY

echo "== 4. SQL no banco do teste"
docker exec -i deskcommcrm-teste-supabase-db-1 psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$MIG" || falha "SQL"

echo "== 5. tags de rollback"
docker tag deskcomm-teste-app:local "deskcomm-teste-app:antes-f$N-$TS"
docker tag deskcomm-teste-worker:local "deskcomm-teste-worker:antes-f$N-$TS" 2>/dev/null || true

echo "== 6. esperando outros builds na VPS"
while pgrep -f "[b]uildx bake" > /dev/null; do sleep 20; done

FILES="-f docker-compose.prod.yml -f docker-compose.single-server.yml -f docker-compose.build.yml -f docker-compose.traefik.yml"
echo "== 7. build do app $(date -u +%T)"
docker compose $FILES --env-file .env build app > "$D/build-f$N-app.log" 2>&1 || falha "build do app (ver build-f$N-app.log)"
docker compose $FILES --env-file .env up -d --no-deps --force-recreate app 2>&1 | tail -1
echo "== 8. build do worker $(date -u +%T)"
bash /docker/build_worker.sh /docker/deskcommcrm-teste deskcomm-teste-worker:local > "$D/build-f$N-worker.log" 2>&1 || falha "build do worker"
sleep 30
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'teste-(app|worker)-1'
for u in / /app /agencia; do curl -s -o /dev/null -w "teste$u %{http_code}\n" "https://teste.emmovimento.tech$u"; done
echo "PRONTO TS=$TS $(date -u +%T)"
