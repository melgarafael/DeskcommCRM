# DeskcommCRM — Kit de Instalação (HostGator)

Este kit sobe o **DeskcommCRM** no seu servidor VPS da HostGator. Você tem dois caminhos:

> **Ainda nem tem servidor?** Comece por `comecar.sh` — ele roda **no seu computador**, antes
> de existir VPS, e responde a pergunta que trava todo mundo no início: *o que eu preciso
> contratar?* Ele nomeia o plano (VPS Turing, 2 vCPU / 4 GB — o Cartesius não dá conta do
> WhatsApp), abre a página se você quiser, e devolve o comando exato do seu caso. Depois que
> a VPS existir, o caminho é o `install.sh` daqui de baixo.
>
> ```bash
> bash comecar.sh
> ```

> **Outra hospedagem?** O kit é feito para a HostGator (é a parceria do projeto e o caminho
> testado de ponta a ponta), mas roda em qualquer VPS com Docker. Se a sua já vem com um
> **proxy reverso próprio** ocupando as portas 80/443 — caso de Hostinger, Coolify, Dokploy
> e CapRover —, o instalador **detecta isso sozinho** e publica o CRM através dele, em vez
> de tentar subir um Caddy que não caberia. Ver
> [VPS que já vem com proxy próprio](#vps-que-já-vem-com-proxy-próprio-hostinger-coolify-dokploy).

## 🤖 Caminho fácil: deixe o Claude Code fazer

1. Contrate um **VPS na HostGator** e acesse-o por SSH.
2. Jogue esta pasta (ou o `.zip`) no chat do **Claude Code** rodando dentro do VPS.
3. Diga: *"instala o DeskcommCRM pra mim"*. Ele lê o `CLAUDE.md` e conduz tudo —
   cria o banco, gera as senhas, sobe o CRM e te ajuda a conectar o WhatsApp.

## ⚙️ Caminho manual: um comando

Dentro do VPS:

```bash
bash install.sh
```

> **VPS sem Docker?** O instalador resolve. Se não encontrar o Docker, ele **pergunta**
> antes e instala pelo `get.docker.com` — o instalador oficial da Docker, que roda como
> root, como manda a documentação deles. Com `--yes` ele segue sem perguntar, que é o
> contrato desse modo. Se preferir instalar por conta própria, responda `n` e rode
> `curl -fsSL https://get.docker.com | sh` antes.

O instalador pergunta o que precisa (domínio, chaves do Supabase e da Anthropic,
e-mail/senha do admin), gera o resto e sobe tudo.

> Modo não-interativo: copie `.env.hostgator.example` (do repositório) para `.env`,
> preencha, e rode `bash install.sh --yes`.

## Criar o Supabase automaticamente (opcional)

Criar o projeto no navegador e copiar as 4 credenciais é o passo mais demorado da
instalação — e o mais fácil de errar (copiar a *Direct connection*, que é IPv6-only e
não conecta de um VPS IPv4, é a armadilha mais comum). Dá para pular tudo isso:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...        # supabase.com/dashboard/account/tokens
bash install.sh                             # cria o projeto e segue a instalação
```

O `install.sh` chama o provisionamento sozinho quando encontra o token e as
credenciais ainda vazias — as 4 variáveis entram no fluxo sem copiar e colar.
Para criar só o projeto, sem instalar, o script também roda sozinho:

```bash
bash supabase-provision.sh "Nome do Projeto" sa-east-1 >> .env
```

O script cria o projeto, **espera o banco ficar `ACTIVE_HEALTHY`** (projeto novo não
nasce pronto), busca as chaves e **descobre o host do pooler testando conexão real** em
vez de adivinhar. Imprime as 4 linhas prontas para colar no `.env`.

⚠️ **O token é uma chave mestra** — dá acesso a todos os projetos da conta. Ele é lido do
ambiente e nunca gravado em disco. Instalando para terceiros, use o token DO CLIENTE, ou
rode o script na sua máquina e leve só as 4 credenciais para o servidor dele.

⚠️ **Plano grátis: 2 projetos por usuário**, contados em todas as organizações onde ele é
Owner/Admin. Não dá para hospedar vários clientes numa conta só.

## O que você precisa antes

| Item | Onde conseguir |
|---|---|
| VPS (Docker) | HostGator — VPS com Docker (n8n/OpenClaw/GatorClaw). Outras hospedagens com Docker também servem — se a sua já tiver proxy próprio nas portas 80/443, [veja aqui](#vps-que-já-vem-com-proxy-próprio-hostinger-coolify-dokploy) |
| Domínio | Registro de domínio (aponte um A-record pro IP do VPS) |
| Banco de dados | Conta grátis no [supabase.com](https://supabase.com) (3 chaves + connection string) |
| IA | Chave da [Anthropic](https://console.anthropic.com) |
| WhatsApp | Seu número — conectado por QR code no onboarding |

## Requisitos do VPS

- **4 GB RAM recomendados.** A imagem é pré-buildada, então o servidor não compila nada e a
  stack SOBE com 2 GB — mas operar é outra coisa: são 7 contêineres, e o WAHA consome
  ~150 MB por sessão de WhatsApp além de ~300 MB de overhead do Node. Com 2 GB você roda
  no limite e vai precisar de swap. Ver `docs/runbooks/waha-hostgator.md`.
- Portas **80** e **443** abertas (`ufw allow 80,443,22/tcp`).
- Docker + Docker Compose v2 — o `install.sh` instala o Docker sozinho se faltar (ver acima).

### VPS que já vem com proxy próprio (Hostinger, Coolify, Dokploy…)

Algumas hospedagens entregam a VPS com um **Traefik** já ocupando as portas 80/443 — é ele
que dá HTTPS automático ao que o painel instala. O Caddy do kit quer as mesmas portas e não
sobe. O instalador **detecta isso sozinho** e grava `REVERSE_PROXY=traefik` no `.env`; a
partir daí os scripts do kit incluem o override que desliga o Caddy e publica o app pelo
Traefik da hospedagem. Rodando compose na mão nessas instalações, use os dois arquivos:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d
```

Não desligue o Traefik da hospedagem para liberar as portas — isso quebra as automações do
painel dela. Se o seu Traefik usa nomes diferentes de `websecure`/`letsencrypt`, ajuste
`TRAEFIK_ENTRYPOINT` e `TRAEFIK_CERTRESOLVER` no `.env`.

Há um caso em que o instalador **pergunta em vez de decidir**: quando o Traefik da
hospedagem roda em `--network host` (a Hostinger faz assim), o Docker não mostra porta
publicada em contêiner nenhum, e então não dá para provar que é ele quem atende o seu
domínio — poderia ser um nginx instalado direto no servidor. Como publicar o CRM atrás do
proxy errado deixa o site no ar sem responder, o instalador mostra o que encontrou e pede
confirmação. Em `bash install.sh --yes` não há a quem perguntar: ele para e pede que você
declare `REVERSE_PROXY=traefik` no `.env` — aí a escolha é sua e ele segue sem perguntar.

## Scripts do kit

| Script | Função |
|---|---|
| `install.sh` | Instala tudo (idempotente) |
| `update.sh` | Atualiza pra versão nova |
| `backup.sh` | Backup do banco + sessões WhatsApp |
| `restore.sh` | Restaura um backup |
| `reset-password.sh` | Redefine senha de um usuário |
| `reset-mfa.sh` | Remove o MFA de um usuário travado |
| `healthcheck.sh` | Diagnóstico dos serviços |

## Automações e webhooks

O `install.sh` (e o `update.sh`, a cada atualização) já ativa sozinho um cron que roda todo minuto e "puxa" a fila de eventos pendentes (`/api/v1/cron/event-log-drain`) — é isso que faz uma automação disparar de verdade no seu servidor (ex.: enviar uma mensagem de WhatsApp quando um pedido muda de status). **Sem esse cron, as automações ficam paradas na fila e nunca rodam** — é um requisito, não um extra.

Rodar de novo o `install.sh`/`update.sh` não duplica a linha do cron (ele mesmo substitui a antiga). Na 1ª vez que o cron é ativado numa instalação que já existia há um tempo, o script também limpa eventos pendentes com mais de 7 dias (marcando como concluídos, sem apagar histórico) — assim o primeiro drain não sai disparando efeitos atrasados de semanas atrás.

Pra testar na mão, rode no próprio VPS (usa o `INTERNAL_SECRET` do seu `.env`):

```bash
source .env && curl -s -H "Authorization: Bearer ${INTERNAL_SECRET}" "${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain"
```

Resposta esperada: `{"data":{"scanned":N,...}}` (N pode ser 0 se não houver eventos na fila — o importante é receber esse formato, não um erro de autenticação ou de conexão).

## Suporte

Problemas comuns e como resolver estão no `CLAUDE.md` (seção "Quando der problema").
