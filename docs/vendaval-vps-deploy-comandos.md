# Plano de comandos — deploy isolado na VPS (PARA REVISÃO DO MAESTRO)

> Terminal B, 2026-07-18. NADA daqui roda antes da aprovação. Recon read-only já
> feito: portas-alvo 18080/13030/15440/18787 LIVRES (ss -tlnp), 173G disco,
> 5.3G RAM disponível, git 2.52, Docker 29.5.1 + compose v5.3.1. Sem psql nativo
> (uso docker exec). Swarm ativo (Easypanel) — compose clássico convive sem tocar.

## ⚠️ DECISÃO PRÉVIA NECESSÁRIA — o banco (tensão no plano original)

O plano pede "Postgres PRÓPRIO no compose" E "configurar agente na tela". Os dois
juntos não fecham: o LOGIN da tela usa Supabase Auth (GoTrue) — com PG puro +
stubs, a tela não autentica (gap já documentado da prova local). Opções:

- **(A) RECOMENDADA — projeto Supabase NOVO dedicado** ("deskcomm-fusion-vps",
  sa-east-1, criado via Management API na org do dono): é literalmente o caminho
  do README; a tela funciona; isolamento total do dev (banco zerado próprio).
  ⚠️ CUSTO: se a org do Supabase é Pro, projeto adicional pode custar ~US$10/mês
  (apagável após a prova — custo de dias). GATE DE GASTO: só com ok do dono.
- **(B) sem custo — PG próprio no compose da VPS** (pgvector:pg17, porta
  127.0.0.1:15440): isolamento máximo, MAS a tela não loga → o agente teria de
  ser publicado por SQL (a prova "configura na tela" degrada para "config por
  ponteiro verificada no banco"). Honesto, porém prova menos.

O plano abaixo assume (A); com (B), trocam-se os passos A1–A3 pelo serviço
postgres no override e o prelude+baseline via docker exec.

## FASE A — preparação (local; só toca Supabase, nada na VPS)

```bash
# A1. criar o projeto (Management API, org pzaxvazodcffkfkpyqtl), aguardar ACTIVE_HEALTHY
POST https://api.supabase.com/v1/projects
  {"name":"deskcomm-fusion-vps","organization_id":"pzaxvazodcffkfkpyqtl",
   "region":"sa-east-1","db_pass":"<gerada openssl rand>"}

# A2. schema no projeto NOVO (Supabase real: SEM prelude — README §2)
psql "$NEW_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql

# A3. role dedicada do worker (README §2) + org/usuário admin de teste
create role agent_worker login password '<gerada>' bypassrls; + grants do README
# usuário via Auth Admin API (email deskcomm-vps-admin@..., senha gerada) +
# organizations + user_organizations (admin) via SQL
```

## FASE B — VPS (cada comando abaixo é o que rodarei via ssh; NADA além disso)

```bash
# B1. transporte do código SEM push ao GitHub (git bundle — zero efeito externo)
git bundle create /tmp/fusion.bundle vendaval-fusion                  # local
scp -P 22022 -i ~/.ssh/fusion_testvps_ed25519 /tmp/fusion.bundle root@129.121.45.100:/opt/
ssh ... 'mkdir -p /opt/deskcomm-fusion && git clone -b vendaval-fusion /opt/fusion.bundle /opt/deskcomm-fusion/app'

# B2. .env montado LOCALMENTE (segredos openssl gerados na hora + keys do Supabase
#     novo + ANTHROPIC_API_KEY que o Maestro fornecer) e enviado com chmod 600:
scp -P 22022 -i ~/.ssh/... /tmp/fusion-vps.env root@...:/opt/deskcomm-fusion/app/.env
ssh ... 'chmod 600 /opt/deskcomm-fusion/app/.env && rm -f /opt/fusion.bundle'
#     Valores-chave: NEXT_PUBLIC_APP_URL=http://129.121.45.100:18080
#     WAHA_WEBHOOK_BASE_URL=http://app:3000  (webhook interno pela rede do compose)
#     AGENT_DISPATCH_CONSUMER=engine · WAHA key + sha512 · APP_IMAGE=deskcomm-app:vps

# B3. override de portas/isolamento (arquivo docker-compose.vps.yml enviado por scp):
services:
  app:    { ports: ["18080:3000"] }
  worker: { ports: ["127.0.0.1:18787:8787"], environment: { WAHA_API_BASE_URL: "http://waha:3000" } }
  waha:   { ports: ["127.0.0.1:13030:3000"] }   # QR servido via túnel/página do Maestro
  caddy:  { profiles: ["disabled"] }             # HTTP direto (decisão do dono)
# rede/volumes: os default do project-name deskcomm-fusion (nada da easypanel)

# B4. build local na VPS (~10-20 min; 4 cores é ok)
ssh ... 'cd /opt/deskcomm-fusion/app && docker compose -p deskcomm-fusion \
  -f docker-compose.prod.yml -f docker-compose.build.yml -f docker-compose.vps.yml build app worker'

# B5. subir (SÓ os serviços da fusão, project-name próprio)
ssh ... '... up -d app worker waha redis srh scheduler'

# B6. verificações (read-only)
curl http://129.121.45.100:18080/            # app 200
ssh ... 'curl -s http://127.0.0.1:18787/healthz'   # worker ok contra o banco novo
ssh ... 'docker compose -p deskcomm-fusion ... ps'  # tudo healthy; ss -tlnp → só as novas portas
```

## FASE C — prova final (gates humanos)
1. Sessão WAHA: eu crio via API (127.0.0.1:13030 por túnel ssh) → QR ao dono
   (Maestro serve a página, como na Fase 1).
2. Dono loga na tela (http://129.121.45.100:18080/app, credencial do usuário de
   teste criado em A3) → cria/publica o agente.
3. Mensagem real de outro número → resposta do agente → verificação no banco NOVO
   (job_queue/messages/before_send_traces) + Playwright da tela.

## Firewall (checagem antes do C2)
Se firewalld bloquear 18080 externamente: proponho `firewall-cmd --add-port=18080/tcp`
(temporário, sem --permanent) — SÓ com aprovação explícita; alternativa sem
mudança: túnel ssh -L pro dono.

## O que eu NÃO farei (fronteira)
Sem parar/reiniciar/prune de QUALQUER container existente; sem portas ocupadas;
sem rede easypanel; sem Traefik/Coolify/Swarm; sem push ao GitHub; sem --permanent
no firewall; rollback = `docker compose -p deskcomm-fusion down` (só a nossa stack).
