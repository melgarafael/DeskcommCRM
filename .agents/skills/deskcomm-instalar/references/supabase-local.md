# Supabase no próprio servidor (single-server)

O kit sobe o Supabase oficial self-hosted na mesma VPS do CRM: banco Postgres, login, REST, tempo
real e arquivos. A fonte da verdade é `hostgator-setup-kit/install-single-server.sh`; a versão do
Supabase é a fixada em `SUPABASE_REF` (`hostgator-setup-kit/_common.sh`). Leia o trecho do
instalador quando este guia e ele discordarem.

## Antes de instalar

```bash
uname -m; nproc; free -m; df -h /
command -v docker jq curl openssl
ss -tlnp | grep -E ':(80|443|8000) '
```

- **Memória:** o instalador recusa abaixo de ~4 GB e recomenda 8 GB. Entre 4 e 8 GB, crie swap.
- **Disco:** uns 40 GB livres (as imagens do Supabase são grandes, da ordem de 9 GB; depois de
  instalar, `docker system df` mostra o real; mais banco, arquivos e backups). Na
  maioria das hospedagens o disco cresce com o servidor ligado: aumente o volume no painel e, na
  VPS, faça o sistema enxergar o espaço (`growpart` + `resize2fs`, conferindo antes com
  `sudo sfdisk -l` que a partição raiz é a última do disco).
- **ARM64** funciona: o instalador confere antes se as imagens do CRM, da WAHA e do Supabase existem
  para a arquitetura, e para sem criar nada se faltar alguma.
- **Porta 8000 ocupada** (o Coolify usa para o painel)? Exporte `API_GW_HTTP_PORT=8001` (ou outra)
  antes de instalar. Essa porta fica só em `127.0.0.1` — não abra no firewall.
- **Proxy da hospedagem nas 80/443** (Traefik do Coolify/Dokploy): exporte `REVERSE_PROXY=traefik`
  e, se ele roda em rede bridge, `TRAEFIK_NETWORK=<rede>` antes de instalar.
- **Cloudflare Tunnel** (`REVERSE_PROXY=cloudflared`) não combina com o single-server: o instalador
  recusa, porque quem publica as APIs do Supabase é o Caddy.
- **O domínio** aponta para a VPS como no caminho normal (`references/dominio-e-dns.md`). Não há
  subdomínio para o Supabase: o mesmo domínio serve o CRM e os prefixos `/auth/v1`, `/rest/v1`,
  `/realtime/v1`, `/storage/v1`, `/functions/v1` e `/graphql/v1` (`Caddyfile.single-server`).

## O dono da conta

Sem preparo, o instalador cria o dono como `admin@<domínio>` com senha aleatória e mostra as duas no
fim. Para o dono nascer com o e-mail da pessoa, crie antes o arquivo que o instalador lê
(`.runtime/admin-credentials`, modo 600):

```bash
mkdir -p .runtime && chmod 700 .runtime
( umask 077; printf 'OWNER_EMAIL=%s\nOWNER_PASSWORD=%s\n' "email@dapessoa.com" "$(openssl rand -base64 18)" > .runtime/admin-credentials )
```

## Instalar

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git deskcommcrm   # se ainda não clonou
cd deskcommcrm
bash hostgator-setup-kit/install-single-server.sh --domain crm.empresa.com.br
```

O que ele faz, na ordem: confere as imagens; baixa o `setup.sh` oficial do Supabase na ref fixada
e **confere o SHA-256**; gera todos os segredos em `.runtime/supabase/.env` (a saída completa, com
as chaves, fica em `.runtime/supabase-setup.log` — não compartilhe); sobe os serviços do Supabase
numa rede privada da instalação (`<projeto>_supabase`); grava `SINGLE_SERVER=1` e as chaves locais
no `.env` do CRM; e roda `install.sh --yes`, que aplica o schema, cria o dono e sobe app, worker,
scheduler, WAHA, Redis e Caddy. O tempo depende sobretudo de baixar as imagens; uma
instalação do zero ainda não foi cronometrada. Interrompeu?
Rode de novo: com `.runtime/supabase/.env` presente ele não gera segredos novos.

**Rodando por um agente, sem terminal interativo:** um `nohup … &` comum morre junto com a sessão
SSH. Use `setsid nohup bash hostgator-setup-kit/install-single-server.sh --domain … </dev/null > install.log 2>&1 &`
e acompanhe o log. Ao mandar um script para a VPS, use `scp` e compare o `sha256sum` dos dois
lados — `ssh host 'cat > arquivo' < arquivo` já entregou arquivo vazio sem erro.

## Depois de instalar

1. A IA nasce **desligada**: cadastre a chave em **IA › Credenciais**.
2. **E-mails de acesso** ("esqueci a senha", confirmar cadastro) saem pelo SMTP do CRM. Configure em
   `/admin/email` e rode `bash hostgator-setup-kit/update.sh` (roda mesmo sem versão nova) — é ele
   que leva o SMTP ao serviço de login.
3. **Cadastro:** confira o que está aberto com
   `curl -s https://<domínio>/auth/v1/settings -H "apikey: <anon key>"` (`disable_signup`,
   `external`). Para um CRM de uma empresa só, recomende o modo **só convite** e rode `update.sh`,
   que leva a escolha ao Supabase (`DISABLE_SIGNUP`).
4. **Backup diário** no cron (`backup.sh`): no single-server ele salva banco, sessão do WhatsApp e os
   **arquivos anexados**. Combine uma cópia fora do servidor.
5. **Atualizar** é pela tela ou `update.sh`; no single-server ele também leva o Supabase local até a
   versão fixada pelo kit.

## Onde fica cada coisa

| o quê | onde |
|---|---|
| Supabase (compose oficial + `docker-compose.deskcomm.yml` do kit) | `.runtime/supabase/` (dentro de `.runtime`, que o instalador fecha em 700) |
| segredos do Supabase | `.runtime/supabase/.env` (600) — nunca mostrar |
| dados do banco | `.runtime/supabase/volumes/db/data` — **apagar = perder o banco** |
| arquivos anexados | `.runtime/supabase/volumes/storage` |
| apelidos na rede privada | `supabase-db` (Postgres) e `supabase-envoy` (gateway) |
| no `.env` do CRM | `SINGLE_SERVER=1`, `SINGLE_SERVER_NETWORK`, `PSQL_DOCKER_NETWORK`, `SUPABASE_INTERNAL_URL`, `NEXT_PUBLIC_SUPABASE_URL=https://<domínio>`, chaves locais, `SUPABASE_DB_URL` para `supabase-db` |

Comandos de operação, de dentro do clone:

```bash
source hostgator-setup-kit/_common.sh; PROJECT_DIR=$PWD; load_env .env
dc ps                               # o CRM, já com o docker-compose.single-server.yml
dc_supabase ps                      # os serviços do Supabase
dc_supabase up -d --no-deps auth    # recria só o login depois de mudar .runtime/supabase/.env
bash hostgator-setup-kit/healthcheck.sh   # inclui a latência do banco local
```

`docker compose` à mão no CRM leva **os dois arquivos**:
`-f docker-compose.prod.yml -f docker-compose.single-server.yml`. Sem o segundo, o app perde a rede
do Supabase e o Caddy volta ao `Caddyfile` sem as rotas do login — o site abre e ninguém entra.

## Problemas típicos

| sintoma | causa mais comum | primeiro comando |
|---|---|---|
| login não funciona, `/auth/v1` dá 404 | CRM subido sem o overlay single-server, ou serviço do Supabase parado | `healthcheck.sh`; `dc_supabase ps` |
| instalador para na porta 8000 | outro serviço usa a porta | `API_GW_HTTP_PORT=8001 bash hostgator-setup-kit/install-single-server.sh --domain …` |
| "esqueci a senha" não chega | SMTP do CRM não levado ao login | configurar `/admin/email` e rodar `update.sh` |
| servidor lento depois de instalar | pouca memória (abaixo de 8 GB, sem swap) | `free -m`; `docker stats --no-stream` |

## Migrar uma instalação que já usa o Supabase da nuvem

Não use o `install-single-server.sh` por cima de uma instalação com dados: ele grava um dono novo e
roda o `install.sh`, e o banco local nasceria vazio. A migração (subir o Supabase local isolado,
restaurar o backup, copiar os arquivos anexados, trocar as chaves do `.env` e religar o CRM com o
overlay) tem passos que o `restore.sh` não cobre hoje — **peça ajuda antes** (mesma orientação de
`references/supabase.md`, seção "Trocar de projeto ou restaurar").
