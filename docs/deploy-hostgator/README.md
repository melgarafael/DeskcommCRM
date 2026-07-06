# Como subir o seu DeskcommCRM na HostGator (passo a passo, sem enrolação)

Este guia leva você do zero — sem servidor, sem nada — até o seu CRM no ar, com
WhatsApp conectado e IA respondendo. **Não precisa saber programar.** Se travar em
algum passo, o assistente do Claude Code faz por você (veja o [Caminho fácil](#caminho-fácil-o-claude-code-faz-por-você)).

> ⏱️ Tempo estimado: **20 a 40 minutos**, a maior parte esperando o domínio "propagar".
> 💰 Custo: o software é **grátis**. Você paga só a hospedagem (VPS) e, se quiser, a IA por uso.

---

## Visão geral (o que vamos montar)

```
Seu domínio  →  Servidor VPS (HostGator)  →  DeskcommCRM rodando
                        │
                        ├─ o CRM (site + painel)
                        ├─ o WhatsApp (conectado por QR)
                        └─ os robôs de IA
Banco de dados: Supabase (grátis)   ·   IA: Anthropic (paga por uso)
```

---

## Antes de começar, você vai precisar de 3 contas

| O quê | Onde | Custo |
|---|---|---|
| **Servidor VPS** | HostGator (links abaixo) | pago (mensal) |
| **Banco de dados** | [supabase.com](https://supabase.com) | grátis |
| **IA** | [console.anthropic.com](https://console.anthropic.com) | pago por uso |

Crie a conta do Supabase e da Anthropic agora (leva 2 min cada). O VPS a gente
contrata no passo 1.

---

## Passo 1 — Contrate o servidor (VPS) na HostGator

O DeskcommCRM roda num **VPS com Docker**. A opção mais fácil é um VPS que **já vem
com Docker instalado**:

- 👉 **[VPS com GatorClaw](https://www.hostgator.com.br/52708-142-3-53.html)** — recomendado, Docker pronto
- 👉 **[VPS com OpenClaw](https://www.hostgator.com.br/52708-141-3-52.html)** — Docker pronto
- 👉 **[VPS com n8n](https://www.hostgator.com.br/52708-137-3-46.html)** — Docker pronto
- 👉 **[VPS padrão](https://www.hostgator.com.br/52708-13-3-12.html)** — funciona também (a gente instala o Docker)
- 👉 **[Servidor Dedicado](https://www.hostgator.com.br/52708-2-3-11.html)** — só se você atende MUITO volume

**Plano recomendado:** a partir de **2 GB de RAM** já roda (não precisa dos planos
grandes — o CRM vem "pré-montado", o servidor não fica compilando nada).

Ao contratar, a HostGator te envia por e-mail o **IP do servidor**, um **usuário**
(geralmente `root`) e uma **senha**. Guarde isso.

> Não tem domínio ainda? Você pode registrar um junto com a HostGator na contratação.

---

## Passo 2 — Entre no servidor

No seu computador, abra o **Terminal** (no Windows: "PowerShell"; no Mac: "Terminal")
e digite, trocando pelo IP que a HostGator te mandou:

```bash
ssh root@SEU-IP-AQUI
```

Ele vai pedir a senha (ao digitar, não aparece nada na tela — é normal). Deu certo?
Você está "dentro" do servidor.

> Se aparecer "Docker não encontrado" mais pra frente, instale com:
> `curl -fsSL https://get.docker.com | sh`

**Agora libere as portas do site** (sem isso o cadeado de segurança/SSL não funciona).

⚠️ **Antes de ativar o firewall, confira em que porta você está conectado por SSH.** Se
for a padrão (**22**), use o comando abaixo como está. Se a HostGator te deu uma porta
diferente (ex.: `2222`, `22022`), **troque o `22` pela sua porta** — senão o firewall te
**tranca pra fora do servidor**.

```bash
ufw allow 22,80,443/tcp && ufw --force enable
```

> Se a HostGator tiver um **firewall no painel** dela, libere as portas **80** e **443**
> lá também. Este é o motivo nº 1 de o site não abrir depois de instalar.

---

## Passo 3 — Crie o banco de dados (Supabase, grátis)

1. Entre em [supabase.com](https://supabase.com) → **New project**.
2. Escolha a região **South America (São Paulo)** e uma senha forte para o banco (guarde).
3. Espere o projeto ficar pronto (~2 min).
4. No menu **Settings → API**, copie e guarde 3 coisas:
   - **Project URL** (algo como `https://xxxx.supabase.co`)
   - **anon public** key
   - **service_role** key (secreta!)
5. Em **Settings → Database**, na seção **Connection string**, clique em **Session pooler**
   (⚠️ **NÃO** use a "Direct connection") e copie a URL no modo **URI**.

> **Por que Session pooler, e não a conexão direta?** A conexão "direct" do Supabase é
> **só IPv6** — e quase todo VPS (incluindo os da HostGator) tem só IPv4, então ela
> **não conecta** e a instalação trava. O **Session pooler** aceita IPv4 e é **grátis**
> (você **não** precisa do add-on pago "IPv4 dedicado"). A URL correta se parece com:
> `postgresql://postgres.SEUPROJETO:SUASENHA@aws-1-<região>.pooler.supabase.com:5432/postgres`
>
> Se a senha do banco tiver caracteres especiais (`@`, `#`, etc.), o Supabase mostra um
> aviso pra "percent-encode" — o instalador já lida com isso; copie a URL como o painel mostra.

Pronto — você tem as 4 informações do banco.

---

## Passo 4 — Aponte seu domínio para o servidor

> ⏳ **Faça este passo primeiro, de preferência 1 dia antes.** O domínio leva de
> minutos a horas pra "propagar", e o SSL só é emitido depois que ele apontar pra cá.
> Deixar isso pra última hora é o que mais atrasa a instalação.

No painel onde você comprou o domínio (HostGator ou outro), crie um registro **A**:

| Campo | Valor |
|---|---|
| Tipo | A |
| Nome/Host | `crm` (ou `@` pra usar o domínio raiz) |
| Aponta para | o **IP do servidor** (passo 1) |

Isso faz `crm.seudominio.com.br` levar ao seu servidor. Pode levar de alguns minutos
a algumas horas pra "valer" (propagar) — o instalador confere isso e te avisa.

---

## Passo 5 — Instale o CRM

Agora escolha um dos dois caminhos:

### Caminho fácil: o Claude Code faz por você

1. Conecte no servidor por SSH e **abra o Claude Code lá dentro** (na VPS, não no seu PC).
2. Escreva pra ele exatamente isto:

   > *"Clone https://github.com/melgarafael/DeskcommCRM e me instale o DeskcommCRM
   > seguindo o `hostgator-setup-kit/install.sh`. Me pergunte as chaves uma por uma e
   > resolva os erros você mesmo."*

3. Ele **baixa o projeto sozinho**, lê as instruções de instalação e conduz tudo —
   pedindo o domínio, as chaves do Supabase e da Anthropic, e o e-mail/senha do admin
   **uma de cada vez**, e resolvendo qualquer tropeço.

> Não precisa baixar nem enviar nenhum arquivo `.zip`: o projeto é público e o Claude
> Code baixa direto do GitHub, sempre na versão mais recente.

### Caminho manual: um comando

No servidor, baixe o projeto e rode o instalador:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM
bash hostgator-setup-kit/install.sh
```

O instalador pergunta o que precisa e monta tudo: gera as senhas técnicas, cria o
banco, cria o seu usuário admin, sobe o CRM e confere se ficou no ar.

---

## Passo 6 — Primeiro acesso

1. Abra **`https://crm.seudominio.com.br`** no navegador. O **cadeado de segurança**
   (SSL) leva cerca de 1 minuto pra aparecer no primeiro acesso — se der erro de
   segurança, espere um pouco e recarregue.
2. Entre com o **e-mail e senha** que você definiu na instalação.
3. **Segurança em 2 etapas (MFA):** no primeiro login o CRM pede pra configurar um
   código de 6 dígitos. Tenha o app **Google Authenticator** ou **Authy** no celular,
   escaneie o QR e digite o código. (Isso protege a conta de admin.)

---

## Passo 7 — Conecte o WhatsApp

No onboarding, o CRM mostra um **QR code**. No celular:

1. Abra o WhatsApp → **Aparelhos conectados** → **Conectar um aparelho**.
2. Aponte a câmera pro QR na tela.

Pronto — as mensagens do seu número começam a cair no CRM.

> Use o número que você quer atender pelo CRM. Recomendamos um número dedicado ao
> atendimento (não o seu pessoal).

---

## Passo 8 — Coloque a IA pra trabalhar (opcional)

Na área de **Agentes de IA**, cole a sua **chave da Anthropic** e configure o robô
(nome, tom de voz, base de conhecimento). A IA passa a sugerir e responder dentro das
regras que você definir.

---

## Deu tudo certo? Cuide do seu CRM

| Quero... | Comando (no servidor, dentro da pasta do projeto) |
|---|---|
| Ver se está tudo no ar | `bash hostgator-setup-kit/healthcheck.sh` |
| Atualizar pra versão nova | `bash hostgator-setup-kit/update.sh` |
| Fazer backup (faça sempre!) | `bash hostgator-setup-kit/backup.sh` |
| Esqueci a senha | `bash hostgator-setup-kit/reset-password.sh seu@email.com` |
| Perdi o app do autenticador | `bash hostgator-setup-kit/reset-mfa.sh seu@email.com` |

> **Backup é sério:** o plano grátis do Supabase **não faz backup sozinho**. Rode o
> `backup.sh` de vez em quando (ou agende no servidor pra rodar todo dia).

---

## Travou? Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Site não abre / erro de segurança | O domínio ainda não apontou pro servidor, ou faltou liberar as portas. Rode `ufw allow 80,443,22/tcp` e espere o domínio propagar. |
| A página fica recarregando/erro | Faltou alguma chave. Rode `docker compose -f docker-compose.prod.yml logs app` e procure a linha que diz qual variável falta. |
| WhatsApp não conecta | Veja `docker compose -f docker-compose.prod.yml logs waha`. Confirme que o número não está conectado em outro computador. |

Em qualquer travamento, você pode voltar ao **Claude Code** e pedir ajuda — ele lê os
erros do servidor e resolve.

---

## Por que HostGator?

O DeskcommCRM foi desenhado pra rodar redondo na infraestrutura da HostGator. Além do
VPS, você pode centralizar aí:

- **[Registro de domínio](https://www.hostgator.com.br/52708-77-3-32.html)** para o seu CRM;
- **[Servidor Dedicado](https://www.hostgator.com.br/52708-2-3-11.html)** quando o volume crescer.

Todos os links deste guia são oficiais da HostGator.
