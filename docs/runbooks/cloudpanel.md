# Runbook — escreve.ai em VPS com CloudPanel (Nginx)

> Cenário: VPS com **CloudPanel** já instalado, com o Nginx dele ocupando as
> portas 80 e 443. O instalador do CRM sobe um Caddy nessas mesmas portas, então
> os dois não cabem — este runbook põe o CRM **atrás do Nginx do CloudPanel**.
>
> Testado em: Ubuntu 22.04, CloudPanel v2, Docker 27, 8 GB RAM.

---

## Pré-requisitos

| Item | Detalhe |
|---|---|
| VPS | Ubuntu 20.04+ com CloudPanel v2 instalado |
| Docker | Instalado (`docker compose version` ≥ 2.x) |
| Domínio | DNS apontando para o IP da VPS (registro A, proxy da Cloudflare **desligado**) |
| Supabase | Projeto criado em supabase.com (free tier serve) |
| IA | Chave OpenRouter (gratuita) ou Anthropic/OpenAI |

---

## O que muda quando já existe um proxy na frente

O kit tem um modo para exatamente isto — chame-o de **proxy externo**. Ele é
ligado por uma linha no `.env`:

```dotenv
REVERSE_PROXY=traefik
```

O nome da variável diz `traefik` porque foi o primeiro caso que apareceu
(Hostinger, Coolify, Dokploy), mas o que ela liga não tem nada de específico:
todo `docker compose` do kit passa pela função `dc()`
(`hostgator-setup-kit/_common.sh`), e com essa linha ela **deixa de subir o
Caddy** e publica o app numa rede Docker que o proxy de fora alcança. Um Nginx
de host é um proxy de fora como qualquer outro.

**Ligue a linha ANTES de rodar o instalador.** Sem ela, o instalador varre as
portas 80/443, encontra o Nginx do CloudPanel e **para ali** — e "ali" é cedo:

| Ordem real do `install.sh` | |
|---|---|
| §766 | varredura das portas 80/443 ← **para aqui sem a linha** |
| §1168 | gera os segredos |
| §1188 | escreve o `.env` |
| §1532 | aplica o schema no Supabase |
| §1617 | cria o primeiro admin |
| §1675 | sobe os containers |

Ou seja: parar na varredura não deixa "quase pronto" — deixa sem segredo, sem
schema e sem conta para entrar. Subir os containers à mão depois disso produz um
CRM que abre a tela de login e não deixa ninguém entrar.

---

## Passo 1 — Clonar e preparar o `.env`

```bash
cd /var/www
git clone https://github.com/melgarafael/DeskcommCRM.git DeskcommCRM
cd /var/www/DeskcommCRM
cp .env.hostgator.example .env
nano .env
```

Preencha os campos obrigatórios:

```dotenv
DOMAIN=cloud.seudominio.com.br
ACME_EMAIL=voce@seudominio.com.br
NEXT_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=postgresql://postgres...
NEXT_PUBLIC_APP_URL=https://cloud.seudominio.com.br
NEXT_PUBLIC_ADMIN_URL=https://cloud.seudominio.com.br
OPENROUTER_API_KEY=sk-or-v1-...
OWNER_EMAIL=voce@seudominio.com.br
OWNER_PASSWORD=senha-forte-aqui
```

E **descomente estas duas** (elas já vêm no arquivo de exemplo, comentadas):

```dotenv
REVERSE_PROXY=traefik
TRAEFIK_NETWORK=deskcommcrm_proxy
```

`deskcommcrm_proxy` não é um nome livre: é `<nome do projeto compose>_proxy`, e
o nome do projeto é o da pasta em minúsculas. Clonando em `/var/www/DeskcommCRM`
como acima, é `deskcommcrm` — logo, `deskcommcrm_proxy`. Clonou em outra pasta?
Rode `basename "$PWD" | tr '[:upper:]' '[:lower:]'` e acrescente `_proxy`.

> **Por que a segunda linha é obrigatória.** Com `REVERSE_PROXY=traefik` o
> instalador tenta descobrir a rede sozinho procurando um contêiner Traefik. Aqui
> não há nenhum — ele não acha, e para pedindo justamente esta variável. Dizer o
> nome de antemão evita a viagem: `deskcommcrm_proxy` é o nome que o próprio kit
> reserva para este projeto, e ele **cria a rede** quando ela não existe.

---

## Passo 2 — Rodar o instalador (até o fim, sem Ctrl+C)

```bash
cd /var/www/DeskcommCRM
bash hostgator-setup-kit/install.sh --yes
```

Com a linha do proxy externo no lugar, o instalador vai até o fim: gera os
segredos, escreve o `.env`, cria a rede `deskcommcrm_proxy`, aplica o schema,
cria o primeiro admin e sobe os containers — **sem** Caddy e **sem** tocar nas
portas 80/443.

Duas coisas normais que assustam:

- **"o A-record ainda não aponta pra cá"** — em `--yes` isso é só um aviso; o
  certificado quem emite aqui é o CloudPanel, no passo 5.
- **o schema demora 3–5 minutos sem nada na tela** — é latência com o Supabase.
  Se quiser conferir que está andando, abra o dashboard do Supabase e veja as
  tabelas aparecendo. Não cancele.

No fim, confira que a stack subiu (o `caddy` **não** deve aparecer):

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml \
  --env-file .env ps
```

---

## Passo 3 — Dar ao Nginx um endereço fixo para o app

O Nginx do CloudPanel roda no host, e o host não fala o DNS do Docker: ele não
consegue resolver `app`. Sobra o IP do contêiner — que **muda** toda vez que o
contêiner é recriado, o que acontece em toda atualização. Um `proxy_pass` com IP
fixo no vhost derruba o site na próxima `update.sh`, sem erro nenhum na tela.

A saída é uma ponte de 4 MB que fica escutando num endereço estável do host e
repassa para o contêiner **resolvendo o nome a cada conexão**:

```bash
docker run -d --name deskcomm-nginx-bridge --restart unless-stopped \
  --network deskcommcrm_proxy -p 127.0.0.1:3000:3000 \
  alpine/socat tcp-listen:3000,fork,reuseaddr tcp-connect:app:3000
```

Confirme que o app responde pelo endereço fixo:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/v1/health
```

`200` (ou `503`, se algum serviço opcional ainda não foi configurado) significa
que a ponte está de pé. `000` significa que ela não subiu — veja
`docker logs deskcomm-nginx-bridge`.

> **Medido** (Docker 28.3.2): com o contêiner do app recriado e recebendo um IP
> diferente (`172.21.0.2` → `172.21.0.4`), a resposta pelo mesmo
> `127.0.0.1:3000` continuou chegando, sem tocar em nada. É por isso que o
> `proxy_pass` abaixo aponta para o loopback e não para um IP de contêiner.

A ponte publica **só em `127.0.0.1`**: quem está fora da VPS não alcança essa
porta, e o único caminho de entrada continua sendo o Nginx com HTTPS.

---

## Passo 4 — Criar o site no CloudPanel e emitir o SSL

1. Acesse `https://SEU-IP:8443`
2. **Sites → Add Site** → Domain: `cloud.seudominio.com.br`
3. **SSL/TLS → Actions → New Let's Encrypt Certificate** → **Create and Install**

Emitir o certificado antes de trocar o vhost é de propósito: a validação do
Let's Encrypt usa o vhost padrão do CloudPanel, que já está pronto para ela.

---

## Passo 5 — Apontar o vhost para o app

Em **Sites → cloud.seudominio.com.br → Vhost**, substitua o conteúdo por:

```nginx
server {
  listen 80;
  listen [::]:80;
  listen 443 quic;
  listen 443 ssl;
  listen [::]:443 quic;
  listen [::]:443 ssl;
  http2 on;
  http3 off;
  {{ssl_certificate_key}}
  {{ssl_certificate}}
  server_name cloud.seudominio.com.br;
  {{root}}
  {{nginx_access_log}}
  {{nginx_error_log}}
  if ($scheme != "https") {
    rewrite ^ https://$host$request_uri permanent;
  }
  location ~ /.well-known {
    auth_basic off;
    allow all;
  }
  {{settings}}
  include /etc/nginx/global_settings;
  index index.html;

  # O webhook GLOBAL do WAHA não pode ser alcançável da internet.
  #
  # Nesta topologia o WAHA fala com o app pela rede do Docker
  # (WAHA_WEBHOOK_BASE_URL=http://app:3000), então essa rota nunca precisa
  # atender de fora. Aberta, ela deixa qualquer pessoa que saiba o endereço
  # injetar mensagem falsa no CRM, escolher o remetente e fazer o WhatsApp do
  # dono responder para um número arbitrário — queimando o orçamento de IA e
  # arriscando o banimento do número.
  #
  # Os dois proxies que o kit já suporta bloqueiam esta rota: o Caddy com
  # `respond @waha_global 403` (Caddyfile) e o Traefik com o router
  # `deskcomm-waha-block` (docker-compose.traefik.yml). Aqui é o mesmo bloqueio.
  # Quem roda o WAHA em OUTRO servidor usa a rota por tenant,
  # /api/v1/webhooks/waha/<token>, que leva um token imprevisível na URL e
  # continua pública — ela NÃO é afetada por este bloco, que é de rota exata.
  location = /api/v1/webhooks/waha {
    return 403;
  }

  location / {
    proxy_pass http://127.0.0.1:3000/;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Server $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_pass_request_headers on;
    proxy_max_temp_file_size 0;
    # O runner de agente de IA pode levar até ~5 min numa requisição. Abaixo de
    # 320s o Nginx corta a resposta no meio e o atendimento morre calado.
    proxy_connect_timeout 900;
    proxy_send_timeout 900;
    proxy_read_timeout 900;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
    proxy_temp_file_write_size 256k;
  }
}
```

> Mantenha as variáveis `{{ssl_certificate_key}}`, `{{ssl_certificate}}`,
> `{{root}}`, `{{nginx_access_log}}`, `{{nginx_error_log}}` e `{{settings}}` —
> são templates do CloudPanel.

---

## Verificação final

Estas três respostas, nesta ordem, são o que prova que a instalação está de pé.
São comandos e não capturas de tela de propósito: a forma da resposta do
`/api/v1/health` já mudou uma vez, e um exemplo colado envelhece calado.

```bash
# 1. o domínio chega ao app (esperado: 200; 503 = serviço opcional faltando)
curl -s -o /dev/null -w 'health: %{http_code}\n' \
  https://cloud.seudominio.com.br/api/v1/health

# 2. o estado que o próprio app declara (esperado: healthy ou degraded)
curl -s https://cloud.seudominio.com.br/api/v1/health \
  | python3 -c 'import json,sys; print("status:", json.load(sys.stdin)["data"]["status"])'

# 3. o webhook global está fechado para a internet (esperado: 403)
curl -s -o /dev/null -w 'webhook global: %{http_code}\n' \
  -X POST https://cloud.seudominio.com.br/api/v1/webhooks/waha
```

`degraded` no item 2 é normal enquanto o WhatsApp não estiver pareado — abra
**Configurações → WhatsApp** e conecte o número.

---

## Atualizações futuras

```bash
cd /var/www/DeskcommCRM
bash hostgator-setup-kit/update.sh
```

Funciona sem nenhum passo extra **porque o `.env` tem `REVERSE_PROXY=traefik`**:
o `update.sh` lê essa linha e não tenta recriar o Caddy. E como o `proxy_pass`
aponta para `127.0.0.1:3000`, o IP novo do contêiner recriado não quebra nada.

> Não edite `docker-compose.prod.yml` nem os outros arquivos versionados. O
> `update.sh` troca de versão com `git checkout`, e uma alteração local nesses
> arquivos faz o comando recusar: *"Não consegui trocar para a versão … parece
> haver mudanças locais"*. Tudo o que este runbook pede fica **fora** do
> versionado: o `.env`, o vhost do CloudPanel e o contêiner-ponte.

---

## Troubleshooting

| Sintoma | Causa | O que fazer |
|---|---|---|
| Instalador para na varredura de portas | falta `REVERSE_PROXY=traefik` no `.env` | Passo 1 — e rode o instalador de novo do zero |
| *"Não consegui descobrir a rede Docker do seu Traefik"* | `REVERSE_PROXY=traefik` sem `TRAEFIK_NETWORK` | acrescente `TRAEFIK_NETWORK=deskcommcrm_proxy` |
| *"network deskcommcrm_proxy declared as external, but could not be found"* | a rede sumiu (`docker network prune`) | `docker network create deskcommcrm_proxy` |
| Schema trava sem output por minutos | latência com o Supabase | aguarde 5 min; confira as tabelas no dashboard |
| Let's Encrypt falha na validação | DNS ainda não propagou | aguarde 1–2 min e tente de novo |
| `502` no navegador | a ponte caiu | `docker start deskcomm-nginx-bridge` e veja `docker logs` |
| `status: degraded` no health | WhatsApp sem sessão pareada | normal — conecte em Configurações → WhatsApp |
| `curl` do item 3 devolve algo ≠ 403 | o `location = ...` não entrou no vhost | reveja o Passo 5; é bloco de rota **exata** (`=`) |
