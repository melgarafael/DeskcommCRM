---
name: deskcomm-instalar
description: Guia de instalação e operação do DeskcommCRM numa VPS (HostGator ou qualquer servidor com Docker), para quem não é técnico ou instala para um cliente. Use SEMPRE que alguém quiser instalar, subir, configurar, atualizar, fazer backup ou restaurar o CRM, trocar domínio, cor ou e-mails, conectar o WhatsApp, ou quando aparecer erro de instalação — SSL/cadeado, DNS, Supabase (connection string, pooler, IPv6), chave de IA, Resend, proxy (Traefik, CloudPanel, Hostinger), "app reiniciando", "esqueci a senha", "perdi o autenticador" — mesmo que a pessoa não diga a palavra "instalar". Conduz passo a passo, roda os scripts do kit e explica em português simples.
metadata:
  publico: leigo, agência, operador de VPS
  fonte-de-verdade: hostgator-setup-kit/install.sh
---

# Instalar e operar o DeskcommCRM

Você está conduzindo uma pessoa que, quase sempre, **não programa** — ou que instala para um
cliente e quer acertar de primeira. O produto se vende como "um comando na VPS"; a experiência de
instalar **é** o produto. Seu trabalho é fazer dar certo, não explicar por que deu errado.

## Como você fala e age

1. **Como quem explica para um amigo esperto**, não para um engenheiro. "O servidor", "as chaves de
   acesso", "apontar o endereço do site" — nunca "container", "env var", "A-record" sem traduzir.
2. **Uma coisa de cada vez.** Peça uma informação, espere, siga. Nunca despeje dez perguntas.
3. **Você faz; a pessoa só entrega o que só ela tem** (chaves, senha que ela quer, domínio). Rode os
   comandos você mesmo. Se estiver num CLI sem terminal, dê **um** comando por vez, pronto para colar.
4. **Quando algo falhar, conserte.** Leia o erro, diga em uma frase o que houve, resolva. Traga o
   problema mastigado, não cru.
5. **Nunca ecoe segredos** (chaves, senhas, tokens) de volta no chat, nem os grave em arquivo que
   não seja o `.env` da instalação.

A fonte da verdade é o instalador, `hostgator-setup-kit/install.sh` — ele valida cada resposta na
hora (chave da Anthropic testada numa chamada real, connection string testada com uma conexão real).
Quando este guia e o instalador discordarem, o instalador está certo: leia o trecho dele e siga.

## Primeiro: descubra o cenário

Três perguntas, uma por vez, antes de qualquer comando:

| pergunta | por que importa |
|---|---|
| **Onde estamos rodando?** — dentro da VPS (por SSH), no computador da pessoa, ou no computador de uma agência que vai instalar na VPS de um cliente | O instalador roda **dentro da VPS**. Fora dela, você só prepara (domínio, Supabase, chaves) e monta o comando que ela vai colar no servidor |
| **Já tem servidor?** | Sem servidor: `bash hostgator-setup-kit/comecar.sh` no computador da pessoa nomeia o plano (2 vCPU / 4 GB, 80 GB, Ubuntu 22.04/24.04, datacenter em São Paulo — o de 1 vCPU / 2 GB **não** dá conta do WhatsApp) e abre o link de parceria |
| **É para você ou para um cliente?** | Para cliente, leia `references/agencia.md` antes de pedir qualquer chave: o token do Supabase é uma chave mestra da **conta**, e o plano grátis permite **2 projetos por usuário** |

## O caminho principal, na ordem

### 1. O servidor (dentro da VPS, por SSH)

```bash
uname -a; nproc; free -m; df -h /; docker --version; docker compose version
ss -tlnp | grep sshd     # a porta do SSH: alguns VPS usam uma que não é a 22
```

- Menos de ~3,3 GB de RAM livre? Sobe, mas opera no limite — crie swap de 2 GB antes.
- Sem Docker? O instalador pergunta e instala sozinho (pelo instalador oficial da Docker).
- Firewall: o instalador **não** configura. Se for ligar o `ufw`, libere **a porta do SSH que você
  está usando**, 80 e 443 — antes de `ufw enable`. Liberar só a 22 numa VPS com SSH em outra porta
  tranca a pessoa fora. Lembre também do firewall do **painel** da hospedagem.
- Já existe algo nas portas 80/443 (Traefik do Coolify/Dokploy, Nginx do CloudPanel, painel da
  Hostinger)? Leia `references/dominio-e-dns.md`, seção "proxy que já existe", **antes** de rodar.

### 2. Qual IA vai atender

O instalador pergunta isso **antes** das chaves, porque a resposta decide qual chave ele pede:

- **OpenRouter** — uma chave, centenas de modelos; o caminho mais simples para experimentar.
- **Anthropic** (Claude) — o que melhor segue instruções longas e usa as ferramentas do CRM. É o
  padrão do `Enter`.
- **OpenAI** (GPT).

Se a escolha não for OpenAI, o instalador pede a chave da OpenAI **à parte e opcional**: ela serve
para ouvir áudios e indexar a base de conhecimento. Dá para cadastrar depois em IA › Credenciais.
Dá para trocar de provedor depois pela tela, em Agente de IA › Provedores.

### 3. O banco (Supabase) — prefira o token

Peça **primeiro** o token de acesso pessoal do Supabase (supabase.com/dashboard/account/tokens).
Com ele, o instalador cria o projeto sozinho, descobre a connection string certa testando conexão
de verdade, **e configura os links dos e-mails** (recuperar senha, confirmar cadastro, aceitar
convite). O token não fica salvo em lugar nenhum: é usado uma vez e some.

Sem token: são 4 cópias do painel (Project URL, anon key, service_role key e a connection string
**Session pooler em modo URI** — nunca a "Direct connection", que é só IPv6 e não conecta de uma
VPS). E fica um passo manual que **importa**: Site URL e Redirect URLs, senão "esqueci minha senha"
chega com link quebrado. Detalhe, plano grátis e Supabase próprio: `references/supabase.md`.

### 4. O domínio

No painel onde a pessoa comprou o domínio: um registro **A** apontando o domínio (ou subdomínio,
ex.: `crm.empresa.com.br`) para o IP da VPS (`curl -s https://api.ipify.org`). Leva minutos para
valer; o instalador confere e **espera junto** (Enter reconsulta). Cloudflare: **nuvem cinza**
("DNS only") até o cadeado aparecer — com a laranja o instalador diz que o domínio não aponta para
cá. Registradores, passo a passo: `references/dominio-e-dns.md`.

### 5. Rodar o instalador — no modo interativo

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git deskcommcrm   # se ainda não clonou
cd deskcommcrm
bash hostgator-setup-kit/install.sh
```

Prefira o modo interativo e responda os prompts com o que a pessoa te deu. Ele valida cada campo
na hora, aceita `voltar`, guarda o que já foi respondido (interrompeu? rode de novo e ele retoma)
e mostra uma tela de conferência numerada antes de gravar. Tudo que ele pede, na ordem, com o que
acontece se pular cada opcional: `references/o-que-a-instalacao-pede.md`.

Se precisar do modo sem perguntas (`--yes` com `.env` pronto), duas armadilhas medidas:

- **não copie** as linhas `APP_IMAGE`, `WORKER_IMAGE`, `SCHEDULER_IMAGE` e `*_PULL_POLICY` do
  `.env.hostgator.example` — elas apontam para o canal móvel `stable`, e a instalação deve ficar
  presa a uma versão numerada. Deixe ausentes; o instalador põe a última versão publicada.
- escreva `SENTRY_DSN=off` se a pessoa **não** quer enviar relatórios de erro. Com o `.env` copiado
  do exemplo, a pergunta de telemetria não aparece e a instalação sai enviando (issue #668).

Também medido (issue #670): o instalador **exige** uma chave de IA válida, mesmo que a documentação
diga que dá para deixar vazia e cadastrar depois. Enquanto isso não muda, peça a chave antes.

### 6. Depois do "Instalação concluída!"

1. Abrir `https://<domínio>`. "Não seguro" nos primeiros 1-2 minutos é o certificado sendo emitido:
   espere e recarregue. `404` com tudo "healthy" numa VPS com proxy próprio é rota perdida — veja
   `references/problemas-e-armadilhas.md`.
2. Entrar com o e-mail e a senha do dono. **A verificação em duas etapas é opcional**: liga em
   Configurações › Segurança. (Instalações anteriores à próxima versão mostram um banner que a
   pede no primeiro acesso — era a regra antiga; o banner foi corrigido.)
3. Onboarding: nome da empresa, o que ela faz, fuso horário; depois o WhatsApp — deixe o app do
   celular **já aberto em Aparelhos conectados** antes de clicar, o QR vale só uns minutos.
4. Agendar backup diário (o Supabase grátis **não** faz backup sozinho):
   `crontab -e` → `0 3 * * *  cd /caminho/deskcommcrm && bash hostgator-setup-kit/backup.sh`.
   Os arquivos ficam **na mesma VPS**; copiar para fora é manual.
5. Atualizar é pela **tela** (menu → rodapé → "Nova versão" → "Atualizar agora"); o instalador já
   deixou o agente de atualização rodando. `bash hostgator-setup-kit/update.sh` é o caminho manual.

## Quando der problema

Abra `references/problemas-e-armadilhas.md` — é o catálogo do que já foi visto em instalações reais,
com o diagnóstico e o comando de cada um. Os mais frequentes:

| sintoma | causa mais comum | primeiro comando |
|---|---|---|
| site sem cadeado / não abre | DNS ainda não aponta, ou portas 80/443 fechadas | `getent ahosts <domínio>` vs `curl -s https://api.ipify.org` |
| app reiniciando em loop | falta uma chave no `.env` | `docker compose -f docker-compose.prod.yml logs app \| grep '\[env\]'` |
| "Network unreachable" no banco | connection string Direct (IPv6) | trocar pela **Session pooler** |
| "esqueci minha senha" com link para `localhost:3000` | Site URL do Supabase não configurado | `export SUPABASE_ACCESS_TOKEN=sbp_... && bash hostgator-setup-kit/marca-emails.sh` |
| "Conectar novo WhatsApp" nunca conclui (v1.17.0) | nome de sessão maior que o WAHA aceita (issue #667; corrigido na `main` em 10/set, PR #658) | conectar pelo onboarding, que usa nome curto — ou atualizar |
| esqueci a senha / perdi o autenticador | — | `bash hostgator-setup-kit/reset-password.sh <email>` / `reset-mfa.sh <email>` |
| "está tudo no ar?" | — | `bash hostgator-setup-kit/healthcheck.sh` |

Os scripts do kit, o que cada um faz e o que imprime: `references/scripts-do-kit.md`. Use-os em
vez de reimplementar: eles carregam correções de instalações reais.

## O que você nunca faz

- Não mostra chave, senha ou token no chat; não pede para a pessoa editar arquivo de configuração na
  mão — você edita.
- Não roda `docker compose down -v` (apaga certificados **e a sessão do WhatsApp**) nem `rm .env`
  para "recomeçar": rode `install.sh` de novo — ele retoma e corrige pelo número da conferência.
- Não troca `APP_IMAGE` para `latest` (aqui `latest` é o topo do desenvolvimento, não a última
  versão) nem edita constante de marca no código: nome, cor e logo vivem na tela Configurações ›
  Marca, e o `.env` é só a semente.
- Não desliga o Traefik/Nginx da hospedagem para "liberar as portas": o instalador publica o CRM
  através dele.
- Não afirma que um problema "já foi corrigido" sem conferir a versão instalada
  (`bash hostgator-setup-kit/healthcheck.sh` mostra) — as armadilhas deste guia foram medidas na
  v1.17.0 e envelhecem.
