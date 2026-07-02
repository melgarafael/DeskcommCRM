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

## Suporte

Problemas comuns e como resolver estão no `CLAUDE.md` (seção "Quando der problema").
