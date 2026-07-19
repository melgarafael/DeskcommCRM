# DeskcommCRM — Kit de Instalação (HostGator)

Este kit sobe o **DeskcommCRM** no seu servidor VPS da HostGator. Você tem dois caminhos:

## 🤖 Caminho fácil: deixe o Claude Code fazer

1. Contrate um **VPS na HostGator** e acesse-o por SSH.
2. Jogue esta pasta (ou o `.zip`) no chat do **Claude Code** rodando dentro do VPS.
3. Diga: *"instala o DeskcommCRM pra mim"*. Ele lê o `CLAUDE.md` e conduz tudo —
   cria o banco, gera as senhas, sobe o CRM e te ajuda a conectar o WhatsApp.

## ⚙️ Caminho manual: um comando

Dentro do VPS, com Docker instalado:

```bash
bash install.sh
```

O instalador pergunta o que precisa (domínio, chaves do Supabase e da Anthropic,
e-mail/senha do admin), gera o resto e sobe tudo.

> Modo não-interativo: copie `.env.hostgator.example` (do repositório) para `.env`,
> preencha, e rode `bash install.sh --yes`.

## O que você precisa antes

| Item | Onde conseguir |
|---|---|
| VPS (Docker) | HostGator — VPS com Docker (n8n/OpenClaw/GatorClaw) |
| Domínio | Registro de domínio (aponte um A-record pro IP do VPS) |
| Banco de dados | Conta grátis no [supabase.com](https://supabase.com) (3 chaves + connection string) |
| IA | Chave da [Anthropic](https://console.anthropic.com) |
| WhatsApp | Seu número — conectado por QR code no onboarding |

## Requisitos do VPS

- **2 GB RAM** bastam (a imagem é pré-buildada — o servidor não compila nada).
- Portas **80** e **443** abertas (`ufw allow 80,443,22/tcp`).
- Docker + Docker Compose v2.

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
