# Runbook — Oracle Cloud Ampere (ARM) em híbrido com x86

> **Decisão registrada:** app na Ampere + WAHA no host x86, Caddy próprio,
> instalação nova apontando para o **mesmo Supabase** (o banco é externo e
> compartilhado — não há dump/restore entre VPS).
>
> **Por que híbrido:** a imagem `devlikeapro/waha` é amd64-only no upstream
> (medido via `docker manifest inspect`, inclusive `:latest`) e não sobe em
> ARM. As 3 imagens próprias (`app`, `worker`, `scheduler`) são multi-arch
> desde a mudança de `platforms:` em `publish-image.yml`.

---

## 0. Pré-requisitos (nesta máquina, antes de tocar na Oracle)

1. O código atual precisa estar publicado como imagem arm64:
   `commit → PR → merge na main → CI publica`. Conferir depois:
   ```bash
   docker manifest inspect ghcr.io/melgarafael/deskcommcrm:stable \
     | grep '"architecture"'
   # esperado: amd64 E arm64
   ```
2. Ter em mãos (só o dono tem — nunca colar segredo no chat):
   - `.env` atual (Supabase, IA, Resend, segredos — os MESMOS serão reusados)
   - IP público do host x86 (onde o WAHA fica)
   - Domínio que vai apontar para a Oracle (ex.: `crm.empresa.com.br`)

## 1. Instância Oracle

- Imagem: **Ubuntu 24.04 minimal (aarch64)**
- Shape: Ampere com **≥ 4 GB de RAM** (ex.: 2 OCPU / 12 GB). O instalador
  barra abaixo de ~3,5 GB (`RAM_MINIMA_KB`).
- VCN Security List da sub-rede: ingress `0.0.0.0/0` → **80, 443** (e 22
  restrito ao seu IP).
- DNS: registro **A** do domínio → IP público da instância.

## 2. Primeiro acesso (iptables da Oracle derruba tudo por padrão)

```bash
ssh -i <chave> ubuntu@<IP-ORACLE>
sudo iptables -L INPUT --line-numbers   # a imagem Oracle vem com REJECT
# liberar o essencial e persistir (ou remover as regras REJECT da Oracle):
sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent netfilter-persistent
sudo netfilter-persistent save
```

## 3. Código + instalador

```bash
git clone <repo> /var/www/crm && cd /var/www/crm
curl -fsSL https://get.docker.com | sh
bash hostgator-setup-kit/install.sh
```

- Responda os prompts com os **mesmos valores do .env atual**
  (Supabase, chaves de IA, email/senha do admin).
- **Falha ESPERADA no ARM:** o `up -d` final tenta puxar o WAHA (amd64) e
  morre. É o ponto de intervenção, não um erro — siga para o passo 4.
  Todo o resto (env, schema, bootstrap do admin) já terá rodado e é
  idempotente.

## 4. Pós-instalação Oracle (o que difere do HostGator)

```bash
cd /var/www/crm
# 1) Apontar para o WAHA remoto e para o próprio domínio público.
#    O install.sh grava http://waha:3000 e http://app:3000 chapados —
#    TROCAR pelas duas linhas abaixo (update.sh não reescreve o .env):
nano .env
#   WAHA_API_BASE_URL=http://<IP-OU-DNS-DO-X86>:3000
#   WAHA_WEBHOOK_BASE_URL=https://<DOMINIO-ORACLE>
#   (WAHA_API_KEY, WAHA_API_KEY_SHA512 e WAHA_HMAC_SECRET: IGUAIS nos 2 lados)

# 2) Subir TUDO MENOS o waha (docker-compose.oracle.yml tira a dependência):
docker compose -f docker-compose.prod.yml -f docker-compose.oracle.yml \
  --env-file .env up -d app worker scheduler redis srh caddy

# 3) Verificação (mesma régua do deploy.md — healthy NÃO basta):
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMINIO-ORACLE>/
# esperado: 307 (redireciona pro login)
```

## 5. Lado x86 (WAHA continua lá)

1. No `.env` do host x86, trocar:
   `WAHA_WEBHOOK_BASE_URL=https://<DOMINIO-ORACLE>` (era o domínio antigo
   ou `http://app:3000`).
2. Recriar só o waha: `docker compose -f docker-compose.prod.yml up -d --force-recreate waha`
3. Firewall do x86: liberar o **IP da Oracle → porta 3000** (é por ela que o
   app chama a API do WAHA). Sessões pareadas (`waha-data`) não são tocadas:
   sem QR novo.

## 6. Updates na Oracle (diferente do HostGator)

`update.sh` faz `up -d` nu e ressuscitaria o waha amd64. Na Oracle, atualizar é:

```bash
cd /var/www/crm
docker compose -f docker-compose.prod.yml -f docker-compose.oracle.yml --env-file .env pull app worker scheduler
docker compose -f docker-compose.prod.yml -f docker-compose.oracle.yml --env-file .env up -d app worker scheduler redis srh caddy
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMINIO>/
```

## 7. O que "migra do local", item por item

| Item local                   | Destino Oracle             | Como                                                      |
| ---------------------------- | -------------------------- | --------------------------------------------------------- |
| Banco (Supabase Cloud)       | reusado, nada se move      | mesmos `SUPABASE_*` no `.env`                             |
| Código + redesign            | via git → main → CI → GHCR | merge + `pull` na Oracle                                  |
| `.env` (segredos)            | copiado à mão pelo dono    | nunca via chat                                            |
| Sessões WA (`waha-data` dev) | descartadas                | sessões de dev/teste; produção segue no x86 sem re-parear |
| Certificados                 | reemitidos                 | Caddy + LE no primeiro boot                               |

## 8. Se algo falhar

- `307` não volta: `docker compose ... logs caddy` (LE precisa de 80/443
  alcançáveis + DNS propagado) e `getent hosts <DOMINIO>` vs IP da Oracle.
- App em crashloop: `logs app` → linha `[env] Falha de validação` diz a
  variável (mesmo diagnóstico do kit HostGator).
- `exec format error` em qualquer serviço: algo puxou imagem amd64 —
  confira `docker compose ... images` e o manifesto no GHCR.
- WhatsApp mudo após a troca: (1) hook do x86 aponta pra Oracle?
  (2) Oracle alcança `http://<X86>:3000`? (3) mesmos `WAHA_API_KEY*` e
  `HMAC` nos dois `.env`? 401 = chave divergente (ver `_common.sh`: duas
  árvores com `.env` diferentes).
