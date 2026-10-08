# Supabase — o banco de dados

O CRM guarda tudo num projeto Supabase (Postgres gerenciado). O plano **grátis** serve para
começar; o instalador precisa de quatro coisas dele — ou de um token que faz as quatro sozinho.

## Caminho 1 (recomendado): o token de acesso

1. A pessoa cria a conta em supabase.com (login com GitHub ou e-mail).
2. Em supabase.com/dashboard/account/tokens → *Generate new token* → dá um nome → copia.
3. Na VPS: `export SUPABASE_ACCESS_TOKEN=sbp_...` e `bash hostgator-setup-kit/install.sh`.

O instalador cria o projeto (região `sa-east-1`, São Paulo), espera o banco ficar saudável (projeto
novo não nasce pronto), pega as chaves, **descobre a connection string testando conexão de
verdade**, e configura Site URL e Redirect URLs — o que faz "esqueci minha senha", confirmação de
cadastro e aceite de convite chegarem com o link certo.

O token **é uma chave mestra da conta** (cria e apaga projetos). Ele não é gravado em lugar nenhum
— é lido do ambiente e some com o processo. Instalando para um cliente, use o token **do cliente**
(ver `agencia.md`).

## Caminho 2: criar o projeto à mão e copiar quatro campos

1. supabase.com → *New project* → nome, senha do banco (**guarde**), região South America (São
   Paulo).
2. *Settings › API*: **Project URL**, **anon key**, **service_role key** (secreta — nunca no chat).
3. *Settings › Database › Connection string*: escolha **Session pooler**, modo **URI**, e troque
   `[YOUR-PASSWORD]` pela senha do passo 1.

⚠️ **Sempre o Session pooler.** A "Direct connection" (host `db.<ref>.supabase.co`) é só IPv6 e
não conecta de uma VPS IPv4 — o instalador reconhece e recusa. O pooler tem host
`aws-N-<região>.pooler.supabase.com` e usuário `postgres.<ref>`.

4. Depois de instalar, fica **um passo manual que importa**: *Authentication › URL Configuration*
   → `Site URL = https://SEU_DOMÍNIO`, `Redirect URLs = https://SEU_DOMÍNIO/auth/confirm`. Sem isso
   os e-mails de acesso saem com link para `localhost:3000` (issues #431/#426). O instalador
   imprime essa pendência no fim; `hostgator-setup-kit/marca-emails.sh` resolve depois, com o token.

## O que o plano grátis limita (e como explicar)

- **2 projetos por usuário**, contando todas as organizações em que ele é dono/admin — uma agência
  não hospeda vários clientes numa conta só.
- Storage de **1 GB** dividido entre mídias do WhatsApp e arquivos da base de conhecimento; banco
  de **500 MB**. O CRM poda audit log e fila com retenção configurável, mas mídia acumula — o plano
  pago é a saída quando estourar.
- **Sem backup automático.** `bash hostgator-setup-kit/backup.sh` num cron diário (ver o guia).
- Projeto grátis parado por muito tempo pode ser **pausado** pela Supabase; o CRM em uso não para.
- Cota de saída de rede: o worker do CRM é econômico por padrão; um pico vem de mídia, não de
  consultas.

## Supabase próprio (instalado pela pessoa, com Docker)

Funciona: o CRM só precisa da URL da API, das duas chaves e de uma connection string que aceite
conexão da VPS. Aponte `SUPABASE_DB_URL` para o pooler ou para o Postgres da sua pilha; o instalador
**testa a conexão de verdade** e reprova na hora se não alcançar. Os e-mails de acesso dependem do
GoTrue da sua pilha (SMTP configurado lá); `marca-emails.sh` usa a Management API da Supabase e
**não** se aplica a uma pilha própria — configure Site URL e modelos na sua instalação.

## Trocar de projeto ou restaurar

O `restore.sh` só restaura num banco **vazio**: num banco que já tem as tabelas do sistema ele para
antes, sem alterar nada (#2120). Por isso ele **não** volta um backup por cima da instalação em uso,
e a ordem **não** é instalar e depois restaurar — o instalador aplica o schema, e aí o restore recusa.

Restaurar um backup em outro projeto: crie o projeto Supabase novo, **não** rode o instalador nele,
troque no `.env` a conexão e as chaves do Supabase pelas do projeto novo, rode
`bash hostgator-setup-kit/restore.sh backups/db-<data>.sql.gz` e reinicie o app. O restore num
Supabase recém-criado foi medido (`rc=0`, 110 tabelas); a troca do `.env` não foi. Na dúvida, ou
num Supabase que roda no próprio servidor (single-server), peça ajuda antes.
O WhatsApp é pareado de novo por QR se o volume do WAHA não foi restaurado.
