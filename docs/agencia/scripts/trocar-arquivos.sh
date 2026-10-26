#!/bin/bash
# Troca arquivos da agência no TESTE e reconstrói só o app.
# Uso: nohup bash trocar-arquivos.sh <nome> > trocar-<nome>.log 2>&1 &
# Entradas em /root/agencia-deploy: <nome>.tgz (arquivos novos) e <nome>-md5.txt (o que o teste tem que ter antes).
# Rollback: restaurar antes-<nome>-<TS>.tgz e voltar a imagem para deskcomm-teste-app:antes-<nome>-<TS>.
set -uo pipefail
NOME="$1"; D=/root/agencia-deploy
cd /docker/deskcommcrm-teste || exit 1
TS=$(date +%Y%m%d-%H%M%S)
md5sum -c --quiet "$D/$NOME-md5.txt" || { echo "FALHOU: arquivo mudou no teste"; exit 3; }
tar -czf "$D/antes-$NOME-$TS.tgz" $(tar -tzf "$D/$NOME.tgz")
tar -xzf "$D/$NOME.tgz"
docker tag deskcomm-teste-app:local "deskcomm-teste-app:antes-$NOME-$TS"
while pgrep -f "[b]uildx bake" > /dev/null; do sleep 20; done
FILES="-f docker-compose.prod.yml -f docker-compose.single-server.yml -f docker-compose.build.yml -f docker-compose.traefik.yml"
docker compose $FILES --env-file .env build app > "$D/build-$NOME.log" 2>&1 || { echo "FALHOU: build"; exit 2; }
docker compose $FILES --env-file .env up -d --no-deps --force-recreate app 2>&1 | tail -1
sleep 30
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'teste-app-1'
for u in / /app; do curl -s -o /dev/null -w "teste$u %{http_code}\n" "https://teste.emmovimento.tech$u"; done
echo "PRONTO TS=$TS"
