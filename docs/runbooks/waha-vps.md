---
title: Runbook — WAHA em produção (VPS Hostgator)
status: canônico
last_review: 2026-05-04
owner: Rafael Melgaço
---

# Runbook — WAHA em produção (VPS Hostgator)

> Guia passo-a-passo pra subir, operar e recuperar a instância WAHA Plus em produção sobre VPS Hostgator. Hostgator é parceiro comercial; este runbook substitui qualquer doc histórico que mencionasse Hetzner.

---

## 1. Especificações alvo

| Item | Valor recomendado | Notas |
|---|---|---|
| Plano Hostgator | **VPS Turing** (ou superior) | Cartesius (1 vCPU/2GB) é insuficiente — puppeteer/baileys + 5+ sessões saturam. |
| OS | Ubuntu 22.04 LTS ou 24.04 LTS | NOWEB engine testado em ambos. CentOS funciona mas docs do compose pressupõem Debian-family. |
| CPU/RAM | mín. 2 vCPU / 4 GB RAM | NOWEB usa ~150 MB por sessão; +overhead Node ~300 MB. |
| Disco | mín. 80 GB SSD | Mídia inline mínima (vai pro Supabase Storage), mas `.sessions` cresce com histórico WhatsApp Web. |
| Datacenter | São Paulo (default Hostgator BR) | Latência <30ms pro Meta SP — relevante pra anti-banimento e UX de QR. |
| IP público | Estático (incluso no plano) | Necessário pra DNS A record + egress allowlist. |

> **Sem parceria com Hostgator?** Substitua por Hetzner CX22 (~$5/mês, datacenter EU) ou DigitalOcean Droplet 4GB (~$24/mês). Tudo neste runbook funciona idêntico — só não terá a vantagem de latência BR.

---

## 2. Pré-requisitos

1. Acesso SSH ao VPS (Hostgator entrega via cPanel ou root SSH; preferir SSH-only).
2. Domínio com DNS gerenciado em Cloudflare (ou outro provider) — ex.: `waha.deskcomm.com.br`.
3. Conta Backblaze B2 com bucket `deskcomm-waha-backup` (R$0,06/GB/mês ≈ $0.005/GB).
4. Licença ativa **WAHA Plus** (`https://waha.devlike.pro` — ~$30/mês).
5. Vercel project com env vars `WAHA_API_BASE_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_BASE_URL`, `WAHA_HMAC_SECRET` configurados (ainda apontando pra dev — atualizamos no fim).

---

## 3. Bootstrap inicial do VPS

### 3.1 Acessar e endurecer SSH

```bash
ssh root@<IP_DO_VPS>

# usuário não-root
adduser deskcomm
usermod -aG sudo deskcomm
mkdir -p /home/deskcomm/.ssh
cp ~/.ssh/authorized_keys /home/deskcomm/.ssh/
chown -R deskcomm:deskcomm /home/deskcomm/.ssh
chmod 700 /home/deskcomm/.ssh && chmod 600 /home/deskcomm/.ssh/authorized_keys

# desabilitar password auth + root login
sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload sshd
```

A partir daqui: `ssh deskcomm@<IP>` + `sudo` para tudo.

### 3.2 Instalar dependências

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y \
  docker.io docker-compose-plugin \
  nginx certbot python3-certbot-nginx \
  ufw fail2ban restic curl jq

sudo usermod -aG docker deskcomm
# logout + login pra grupo aplicar
```

### 3.3 Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp     # certbot challenge
sudo ufw allow 443/tcp
sudo ufw enable
```

### 3.4 Fail2ban (SSH + Nginx 401)

```bash
sudo tee /etc/fail2ban/jail.d/deskcomm.conf > /dev/null <<'EOF'
[sshd]
enabled = true
maxretry = 3
bantime = 1h

[nginx-http-auth]
enabled = true
maxretry = 5
bantime = 1h
EOF
sudo systemctl restart fail2ban
```

---

## 4. DNS + TLS

No Cloudflare (ou seu DNS provider):

- `waha.deskcomm.com.br` → A record → IP do VPS Hostgator
- Proxy = **DNS only** (cinza). Cloudflare Proxy (laranja) interfere em SSE/WebSocket que o WAHA usa.

```bash
sudo certbot --nginx -d waha.deskcomm.com.br \
  --non-interactive --agree-tos -m ops@deskcomm.com.br
```

Certbot já injeta SSL no `/etc/nginx/sites-available/default`.

---

## 5. Deploy do WAHA

### 5.1 Estrutura

```bash
sudo mkdir -p /opt/deskcomm-waha
sudo chown deskcomm:deskcomm /opt/deskcomm-waha
cd /opt/deskcomm-waha
```

Copiar (via `scp` ou `git clone`) o `docker-compose.yml` do repo (raiz do DeskcommCRM). Ajustes obrigatórios pra prod:

```yaml
services:
  waha:
    image: devlikeapro/waha-plus@sha256:<DIGEST_PINADO>   # NÃO usar :latest
    ports:
      - "127.0.0.1:3000:3000"                             # bind localhost; Nginx termina TLS
    environment:
      WAHA_API_KEY: ${WAHA_API_KEY}                       # plaintext rotacionado
      WHATSAPP_HOOK_URL: ${WAHA_WEBHOOK_BASE_URL}/api/v1/webhooks/waha
      WHATSAPP_HOOK_HMAC: ${WAHA_HMAC_SECRET}
      WAHA_DEFAULT_ENGINE: NOWEB
      WAHA_DASHBOARD_ENABLED: "false"                     # sem dashboard em prod
```

> **Pin de digest**: rode `docker pull devlikeapro/waha-plus:latest && docker inspect ... | jq -r '.[0].RepoDigests[0]'` e cole. Cada upgrade vira PR explícito (a gente já comeu uma migração silenciosa de env var nesse repo).

### 5.2 .env de produção

`/opt/deskcomm-waha/.env` (chmod 600):

```bash
WAHA_API_KEY=<plaintext gerado novo, 64 chars hex>
WAHA_WEBHOOK_BASE_URL=https://app.deskcomm.com.br
WAHA_HMAC_SECRET=<32 bytes random distinto da api key>
```

```bash
chmod 600 /opt/deskcomm-waha/.env
```

### 5.3 Subir

```bash
cd /opt/deskcomm-waha
docker compose up -d
docker compose logs -f waha       # confere "Nest application successfully started"
```

Healthcheck:

```bash
PLAIN=$(grep WAHA_API_KEY .env | cut -d= -f2-)
curl -s -H "X-Api-Key: $PLAIN" http://127.0.0.1:3000/api/sessions
# → [] (array vazio inicial)
```

---

## 6. Nginx reverse proxy

`/etc/nginx/sites-available/waha`:

```nginx
server {
    listen 443 ssl http2;
    server_name waha.deskcomm.com.br;

    ssl_certificate     /etc/letsencrypt/live/waha.deskcomm.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/waha.deskcomm.com.br/privkey.pem;

    # Egress allowlist — só Vercel pode chamar.
    include /etc/nginx/conf.d/vercel-egress-allowlist.conf;
    deny all;

    proxy_buffering off;        # SSE / streaming WAHA
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 50M;   # uploads de mídia

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name waha.deskcomm.com.br;
    return 301 https://$host$request_uri;
}
```

`/etc/nginx/conf.d/vercel-egress-allowlist.conf` — atualizado por cron diário:

```bash
sudo tee /usr/local/bin/refresh-vercel-cidrs.sh > /dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
TMP=$(mktemp)
curl -s https://api.vercel.com/v1/edge/cidrs | jq -r '.cidrs[]' | sed 's/^/allow /;s/$/;/' > "$TMP"
sudo mv "$TMP" /etc/nginx/conf.d/vercel-egress-allowlist.conf
sudo nginx -t && sudo systemctl reload nginx
EOF
sudo chmod +x /usr/local/bin/refresh-vercel-cidrs.sh
sudo /usr/local/bin/refresh-vercel-cidrs.sh
echo "0 4 * * * deskcomm /usr/local/bin/refresh-vercel-cidrs.sh" | sudo tee /etc/cron.d/vercel-cidrs
```

> Endpoint da Vercel pode mudar. Se a API responder 404, fallback é colar manualmente os ranges de https://vercel.com/docs/limits e revisar trimestralmente.

```bash
sudo ln -s /etc/nginx/sites-available/waha /etc/nginx/sites-enabled/waha
sudo nginx -t && sudo systemctl reload nginx
curl -I https://waha.deskcomm.com.br/api/health    # 401 esperado sem header
```

---

## 7. Backup com restic + Backblaze B2

### 7.1 Setup

```bash
sudo tee /opt/deskcomm-waha/backup.env > /dev/null <<EOF
B2_ACCOUNT_ID=<key id>
B2_ACCOUNT_KEY=<key>
RESTIC_REPOSITORY=b2:deskcomm-waha-backup:/waha
RESTIC_PASSWORD=<senha forte armazenada no 1Password>
EOF
sudo chmod 600 /opt/deskcomm-waha/backup.env

source /opt/deskcomm-waha/backup.env
restic init    # uma vez só
```

### 7.2 Cron diário (3am)

`/etc/cron.d/waha-backup`:

```cron
0 3 * * * deskcomm . /opt/deskcomm-waha/backup.env && restic backup /var/lib/docker/volumes/deskcomm-waha_waha-data --tag daily && restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
```

### 7.3 Restore drill (rodar mensal)

```bash
# em VPS de teste:
docker compose down
sudo rm -rf /var/lib/docker/volumes/deskcomm-waha_waha-data/*
. /opt/deskcomm-waha/backup.env
restic restore latest --target /
docker compose up -d
# verificar que sessões voltaram sem precisar re-parear
```

Nunca confie em backup que você não testou restaurando.

---

## 8. Monitoramento

### 8.1 Healthcheck externo

UptimeRobot (free tier, 5min) apontando pra `https://waha.deskcomm.com.br/ping` (rota pública sem auth). Alerta → email + WhatsApp via webhook do próprio app.

### 8.2 Watchdog local

```bash
sudo tee /usr/local/bin/waha-watchdog.sh > /dev/null <<'EOF'
#!/bin/bash
FAILS=$(cat /tmp/waha-fails 2>/dev/null || echo 0)
if curl -s -f http://127.0.0.1:3000/ping > /dev/null; then
  echo 0 > /tmp/waha-fails
else
  FAILS=$((FAILS+1))
  echo $FAILS > /tmp/waha-fails
  if [ "$FAILS" -ge 3 ]; then
    cd /opt/deskcomm-waha && docker compose restart waha
    curl -s -X POST "https://hooks.sentry.io/..." -d "WAHA restarted após $FAILS falhas"
    echo 0 > /tmp/waha-fails
  fi
fi
EOF
sudo chmod +x /usr/local/bin/waha-watchdog.sh
echo "*/1 * * * * deskcomm /usr/local/bin/waha-watchdog.sh" | sudo tee /etc/cron.d/waha-watchdog
```

### 8.3 Log shipping (opcional Fase 2)

Better Stack ou Datadog Agent → `docker logs deskcomm-waha`. Sem isso, logs ficam só locais e somem em rotação.

---

## 9. Atualizar Vercel envs

No painel Vercel → Project Settings → Environment Variables (escopo: **Production** apenas):

```
WAHA_API_BASE_URL=https://waha.deskcomm.com.br
WAHA_API_KEY=<mesmo plaintext do .env do VPS>
WAHA_WEBHOOK_BASE_URL=https://app.deskcomm.com.br
WAHA_HMAC_SECRET=<mesmo do VPS>
```

Redeploy da branch `main` aplica.

---

## 10. Checklist final pré-go-live

- [ ] Digest pinado em `docker-compose.yml` (zero `:latest`)
- [ ] `WAHA_DASHBOARD_ENABLED=false`
- [ ] UFW ativo, só 22/80/443
- [ ] SSH password disabled, root login disabled
- [ ] fail2ban com jails de SSH + nginx-http-auth
- [ ] Egress allowlist Nginx atualizando via cron
- [ ] TLS válido (testar `https://www.ssllabs.com/ssltest/` ≥ A)
- [ ] Backup `restic` rodando + restore drill executado uma vez
- [ ] UptimeRobot configurado
- [ ] Watchdog cron de 1min ativo
- [ ] Sentry release tagging do app capturando erros do `lib/waha/client`
- [ ] Vercel envs apontando pro domínio público
- [ ] Webhook entrante funcionando (mensagem de teste WhatsApp → aparece na Inbox)
- [ ] API key WAHA documentada em 1Password com data de rotação +90d

---

## 11. Diferenças operacionais Hostgator vs cloud-native (Hetzner/DO)

| Aspecto | Hostgator | Hetzner / DO |
|---|---|---|
| Volume snapshots nativos | ❌ não tem | ✅ tem |
| Latência pro Meta BR | ✅ <30ms (SP) | ⚠️ 150-200ms (EU) ou 80ms (NYC) |
| Custo (mín. 2 vCPU/4GB) | R$140/mês (~$28) | $5-10/mês |
| Painel | cPanel/WHM (web GUI) | Console + API |
| Provisionamento via API | ❌ limitado | ✅ Terraform-friendly |
| Suporte 24x7 PT-BR | ✅ incluso | ⚠️ EN-only, ticket lento |

**Conclusão**: Hostgator paga prêmio pela parceria + suporte BR + datacenter SP. Pra MVP/scale-out até ~50 tenants é OK; acima disso, considerar diversificação (instância secundária Hetzner como DR cross-region).

---

## 12. Troubleshooting rápido

| Sintoma | Diagnóstico | Fix |
|---|---|---|
| App recebe 401 do WAHA | Env var `WAHA_API_KEY` desalinhada (Vercel vs VPS) | Confirmar plaintext idêntico nos dois lados |
| WAHA cria session mas não inicia | `start: true` ignorado em algumas versões | Chamar `POST /api/sessions/:name/start` explicitamente |
| Webhook não chega | Nginx allowlist bloqueando, ou Cloudflare Proxy ON | `tail -f /var/log/nginx/access.log` + desligar proxy CF |
| QR expira sempre | RTT alto, ou clock drift no VPS | `timedatectl set-ntp true`, conferir RTT pro `web.whatsapp.com` |
| Container OOMKilled | Sessões demais pro plano | Upgrade Hostgator pra plano superior, ou particionar tenants em VPS secundário |
| Session WORKING mas mensagens não saem | Daily limit atingido, ou janela horária | Conferir `channel_sessions.daily_message_limit` + `lib/waha/throttle` |

---

## 13. Histórico de decisão

- **2026-05-04** — Trocamos referências Hetzner→Hostgator nos docs por parceria comercial existente. Custo subiu (~$5 → ~$28) mas latência BR melhora pareamento e suporte ticketing fica em PT-BR. Hetzner mantido como plano B documentado em §1.
