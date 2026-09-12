# Problemas e armadilhas — o catálogo do que já aconteceu em instalações reais

Cada item traz o sintoma como a pessoa descreve, a causa, e o comando. Os que dizem "o código já
corrige" foram consertados em `hostgator-setup-kit/install.sh` ou no `docker-compose.prod.yml`;
se aparecerem mesmo assim, a instalação está numa versão antiga (`bash hostgator-setup-kit/healthcheck.sh`
mostra a versão) — atualize antes de caçar outra causa. As issues citadas foram medidas na v1.17.0.

Os comandos de `docker compose` abaixo assumem a pasta do clone. Numa VPS com proxy próprio
(`REVERSE_PROXY=traefik` no `.env`), acrescente `-f docker-compose.traefik.yml` a todos eles.

## Site e certificado

**"O site não abre" / "sem cadeado" / "não seguro".** O certificado só é emitido quando o domínio
aponta para a VPS **e** as portas 80/443 estão abertas. Confira os dois lados:

```bash
getent ahosts crm.exemplo.com.br | awk '{print $1}' | sort -u   # para onde o domínio aponta
curl -s https://api.ipify.org                                    # o IP desta VPS
ss -tlnp | grep -E ':80 |:443 '                                  # quem está nas portas
ufw status                                                       # firewall do sistema
```

Depois do DNS valer: `docker compose -f docker-compose.prod.yml restart caddy`. Lembre do firewall
do **painel** da hospedagem — ele barra antes do `ufw`.

**Cloudflare com a nuvem laranja.** O domínio resolve para IPs da Cloudflare, o instalador diz que
"não aponta pra cá" e o certificado não sai. Deixe a nuvem **cinza** ("DNS only") ao menos até o
cadeado aparecer (`docs/runbooks/waha-hostgator.md` e `docs/runbooks/cloudpanel.md` registram o mesmo).

**`404 page not found` com todos os contêineres "healthy"** (VPS com Traefik/Nginx próprio): o app
subiu sem as etiquetas de roteamento porque um `up -d` foi rodado só com o `docker-compose.prod.yml`.
Suba de novo com os **dois** arquivos (ver `scripts-do-kit.md`). Runbook: `docs/runbooks/deploy.md`.

## O app

**App reiniciando em loop.** Quase sempre falta uma chave no `.env`:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 app | grep -A3 '\[env\] Falha de validação'
```

A linha diz **qual** variável falta. Corrija o `.env` e `docker compose -f docker-compose.prod.yml up -d app`
— não recomece a instalação.

**"Quase lá — falta o app responder"** no fim da instalação: mesma coisa, corrija e suba; não rode
`down -v`.

**Automações e follow-ups nunca disparam.** O cron que puxa a fila não está instalado (instalação
muito antiga ou `crontab` removido). `crontab -l | grep event-log-drain` deve mostrar uma linha; se
não, `bash hostgator-setup-kit/update.sh` reinstala. Teste na mão:
`source .env && curl -s -H "Authorization: Bearer ${INTERNAL_SECRET}" "${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain"`
— esperado um JSON com `"scanned"`.

## Banco (Supabase)

**"Network unreachable" / "could not translate host" ao aplicar o schema.** A connection string é a
**Direct connection** (só IPv6; a VPS é IPv4). Troque pela **Session pooler** em modo URI — host
`aws-N-<região>.pooler.supabase.com`, usuário `postgres.<ref>`. O instalador reconhece a Direct
pelo host `db.<ref>.supabase.co` e recusa. (Supabase próprio, instalado por você: use a string do
seu pooler; o instalador testa a conexão de verdade, então o erro aparece na hora.)

**"type public.vector / citext does not exist".** Faltam extensões — o instalador já as cria
(`vector`, `citext`, `pg_trgm` no schema `public`). Rodando o schema à mão, crie antes.

**Muitos "already exists" / "multiple primary keys" ao atualizar.** Esperado e inofensivo: o
`baseline.sql` é re-aplicado inteiro e é idempotente; o `update.sh` filtra esse ruído e só alerta
erro de verdade.

**Seletor de modelo vazio ao criar agente de IA.** O seed de modelos não entrou (instalação antiga).
`bash hostgator-setup-kit/update.sh` re-aplica o baseline, que traz o insert.

## Acesso, senha, e-mails

**"Esqueci minha senha" com link para `localhost:3000`** (issues #431/#426): o Site URL do
projeto Supabase nunca foi configurado (instalação sem o token). Com o token:
`export SUPABASE_ACCESS_TOKEN=sbp_... && bash hostgator-setup-kit/marca-emails.sh`. Sem token: no
painel do Supabase, Authentication › URL Configuration → `Site URL = https://DOMÍNIO`,
`Redirect URLs = https://DOMÍNIO/auth/confirm`.

**E-mails em inglês, sem marca.** Mesmo conserto acima — o `marca-emails.sh` sobe os modelos com a
marca e a cor.

**Convite não chega por e-mail.** Sem `RESEND_*` o envio fica desligado e o link de aceite aparece
na própria tela do convite — copie e mande pela pessoa. Com Resend, o remetente precisa ser de
domínio **verificado** lá.

**Trancou fora / perdeu o autenticador.** `bash hostgator-setup-kit/reset-password.sh <email>` e
`bash hostgator-setup-kit/reset-mfa.sh <email>`.

**"usuário já existe" (422) ao criar o dono.** Normal numa segunda rodada: o instalador é
idempotente e acha o usuário pelo e-mail.

## WhatsApp

**QR não aparece / não conecta.** `docker compose -f docker-compose.prod.yml logs --tail=80 waha`.
Confira que o número não está logado em outro computador e deixe o app do celular já aberto em
Aparelhos conectados antes de clicar (o QR expira em minutos; há o botão "Gerar novo QR Code").

**"Conectar novo WhatsApp" em Conexões nunca conclui, card fica "Parado"** (issue #667, na
v1.17.0): o nome de sessão gerado passava de 54 caracteres, e o WAHA recusa com 400. O
**onboarding** usa um nome curto e funciona — conecte por ele. Corrigido na `main` em 10/set
(PR #658): vale para quem ainda está na v1.17.0 até atualizar para a versão seguinte.

**WAHA responde 401.** A chave do WAHA vai para o contêiner com prefixo `sha512:`; o compose já faz
isso. Se você editou `WAHA_API_KEY` à mão, rode o instalador de novo para regravar o par.

**A mesma pessoa vira vários chats / meu envio aparece como "Contato NNN".** Bug antigo de unificação;
o baseline de hoje deduplica sozinho ao atualizar (`update.sh`), depois reinicie o app.

## Instalação e atualização

**Instalador exige chave de IA "válida" e para** (issue #670): a documentação diz que dá para
deixar vazia e cadastrar depois, mas o instalador não aceita. Enquanto isso não muda, consiga a
chave antes (OpenRouter é o caminho mais rápido de criar).

**Telemetria ligada sem ninguém escolher** (issue #668): acontece quando o `.env` foi copiado do
exemplo. Para desligar: `SENTRY_DSN=off` no `.env` e `docker compose -f docker-compose.prod.yml up -d`.
Instalações anteriores à próxima versão mostram um banner que afirma "por padrão os erros são
enviados" — o padrão da pergunta é **não** enviar; o banner foi corrigido para dizer a escolha feita.

**`--yes` instalou no canal `stable` em vez de uma versão.** O `.env` copiado do exemplo trouxe
`APP_IMAGE=...:stable`. Confira `grep -E '^(APP|WORKER|SCHEDULER)_IMAGE=' .env`; para fixar uma
versão, `bash hostgator-setup-kit/update.sh --to v1.17.0 --force` (a tag publicada mais recente
aparece em github.com/melgarafael/DeskcommCRM/releases).

**`update.sh` recusou com código 3.** Ele não conseguiu confirmar o que é mais novo (clone raso
sem internet para o GitHub, ou a versão pedida é anterior à instalada). **Nada foi tocado.** Tente
de novo com internet; voltar no tempo é só com `--force`, de propósito.

**Instalação antiga sem o botão "Atualizar agora".** Rode `bash hostgator-setup-kit/update.sh`
**duas vezes**: a primeira ainda é o script antigo, a segunda instala o cron do agente.

**Windows: o schema falha no self-check (`md5`) logo no começo.** Clone feito com `core.autocrlf`
convertendo fim de linha. O repo já fixa `LF` para `.sql`; num clone antigo, `git config core.autocrlf false`
e clone de novo.

## Proxy que já existe na VPS (Hostinger, Coolify, Dokploy, CapRover, CloudPanel)

O instalador detecta um **Traefik** que publica as portas 80/443 e grava `REVERSE_PROXY=traefik`.
Em modo host (Hostinger) ele **pergunta** — responda `s`, ou ponha a variável no `.env` para o
`--yes`. Nginx/Apache do host (CloudPanel, cPanel) **não é detectado**: prepare o `.env` com
`REVERSE_PROXY=traefik` e a rede/entrypoints certos antes, seguindo `docs/runbooks/cloudpanel.md`.
Nunca desligue o proxy da hospedagem para "liberar as portas" — isso quebra as automações do painel.
