# Runbook — o worker congelado: diagnóstico e remediação

> ## Estado do ensaio: **U6-b EXECUTADO em 2026-08-13, com uma ressalva que muda o procedimento**
>
> O ensaio rodou numa VPS real, com estado legado **reproduzido** (não simulado): clone
> no commit `ee520110` de 2026-07-31 — o mesmo em que o worker era `build:`-only —,
> baseline daquela época aplicado, e a stack subida por `docker compose up -d`, que
> construiu o worker na máquina, como acontece na instalação de um cliente.
>
> **O que passou:** o worker migrou de imagem local (`2174fb4f`) para a publicada
> (`ghcr.io/…/deskcomm-worker`, `revision=31096584…`); as três imagens ficaram pinadas
> na mesma versão; o volume do WAHA, a customização do operador no `.env` e o banco
> sobreviveram (69 → 73 tabelas, a migração esperada).
>
> **A ressalva, e ela é o motivo de este aviso continuar aqui:** a **primeira** execução
> do `update.sh` NÃO consertou o worker. Quem executa a transição é o `update.sh` que
> está no disco do cliente — o antigo —, e ele só sabe gravar `APP_IMAGE`. O worker cai
> no default do compose novo, e enquanto o canal `stable` não existir no registry esse
> default não resolve. Só a **segunda** execução, já com o kit novo em disco, pinou as
> três e trocou a imagem. Ver §5.0.
>
> **Não coberto PELO ENSAIO** — e o escopo desta frase importa, porque ela já mentiu sem
> ele: nos **ensaios**, o app não subiu contra um Supabase real (usaram um Postgres em
> contêiner como `SUPABASE_DB_URL`), então auth, storage e PostgREST não foram exercitados,
> e a sessão do WhatsApp foi representada por um arquivo marcador no volume.
>
> **A execução real cobriu os dois** — está no §P4 deste mesmo documento, 340 linhas abaixo:
> a remediação rodou na produção do projeto, contra o Supabase de verdade
> (`/api/v1/health` → `1.3.0, healthy`, `supabase: ok`) e com a sessão pareada de verdade no
> volume (48.607 arquivos, `waha: ok`). Sem a palavra "ensaio", este aviso — que é a primeira
> coisa que qualquer leitor vê — declarava não provado exatamente o que o documento prova
> depois, e teria feito alguém repetir um trabalho já feito.

---

## 1. O que aconteceu

O serviço `worker` — o processo que faz o agente de IA atender 24/7 — não tinha `image:`
no `docker-compose.prod.yml`, só `build:`. Duas consequências do Docker Compose, ambas
medidas:

- `docker compose pull` **pula** serviço build-only (`"Skipped - No image to be pulled"`);
- `docker compose up -d` **sem `--build`** recria o contêiner sobre a imagem que já existe.

Resultado: o worker era compilado na VPS no dia da instalação e **nenhum `update.sh`
jamais o reconstruiu**. O app, o banco e todo o resto atualizavam normalmente; só o
agente ficava parado.

**Não é teoria.** Medido na instalação de produção do projeto em 2026-08-13:

| serviço | imagem | criada |
|---|---|---|
| app | `ghcr.io/melgarafael/deskcommcrm:1.2.1` (registry) | 2026-08-12 |
| worker | `deskcommcrm-worker` (local, sem labels OCI) | **2026-07-31** |

O contêiner do worker havia sido **reiniciado naquele mesmo dia** e continuava rodando a
imagem de 31/07 — restart não reconstrói.

## 2. Impacto — o que o cliente perdeu

Entre a data da imagem do worker e a versão instalada do app, **9 commits e 399 linhas**
em `workers/` nunca chegaram. Traduzido para o que se sente na operação:

| O que o cliente percebe | O que estava por trás | Corrigido em |
|---|---|---|
| **O agente responde duas vezes à mesma mensagem** | dois runtimes consumiam o mesmo evento de despacho | `#129`, 2026-08-06 |
| **Áudio e imagem que o cliente manda não viram conteúdo** — a IA responde como se nada tivesse chegado | a mídia só era derivada num dos canais | 2026-08-11 |
| **O agente vaza dado interno na conversa** (URL de sistema, ID, jargão de CRM) | não havia separação entre quem fala e quem executa | `#181`, 2026-08-07 — vazamento medido caiu de 3-em-10 para 1-em-10 turnos |
| **Sentimento classificado errado, sem erro visível** | a classificação falhava por truncamento e ficava em silêncio | 2026-08-01 |
| **Resposta atribuída ao canal errado no histórico** | `sent_via` inválido | `#126`, 2026-08-04 |

**O que NÃO aconteceu:** nenhum dado foi perdido ou corrompido. Conversas, contatos,
leads, mídia no storage e a sessão pareada do WhatsApp são estado do banco e dos volumes
— o worker congelado deixou de *melhorar*, não de funcionar. Uma instalação afetada
atendeu o tempo todo; atendeu com o agente de dois meses atrás.

## 3. Diagnóstico — antes de qualquer conserto

Read-only, seguro em produção, não precisa de clone:

```bash
curl -fsSL https://raw.githubusercontent.com/melgarafael/DeskcommCRM/main/self-host-kit/diagnostico.sh | bash
```

Ou, se o operador já tem o projeto no disco:

```bash
cd /caminho/do/projeto && bash self-host-kit/diagnostico.sh
```

Códigos de saída: `0` não afetada · `1` afetada · `2` inconclusivo (Docker parado, stack
no chão, instalação não encontrada).

**Por que não basta olhar o `/api/v1/health`:** até a versão que conserta isto, ele lê
`npm_package_version`, que é `undefined` sob `CMD ["node","server.js"]`. Toda instalação
responde `0.1.0` — afetada ou não. Foi medido na produção.

---

## 4. As duas rotas

### Rota A — Completa: `update.sh` (**recomendada**)

Leva a instalação para a versão nova inteira: app, worker e scheduler pinados na mesma
versão, `.env` com as chaves novas, `baseline.sql` re-aplicado, backup antes.

```bash
cd /caminho/do/projeto
bash self-host-kit/update.sh
```

### Rota B — Cirúrgica: só o worker passa a puxar imagem publicada

Blast radius mínimo — não toca no banco, não muda o app, não re-aplica o baseline.

```bash
cd /caminho/do/projeto
# 1. anote o estado atual, para poder voltar
docker compose -f docker-compose.prod.yml ps --format '{{.Service}}|{{.Image}}' > /root/estado-antes.txt
# 2. aponte SÓ o worker para a imagem publicada da versão que o app já roda
grep '^APP_IMAGE=' .env            # → confirme a versão, ex.: …deskcommcrm:1.2.1
printf 'WORKER_IMAGE=ghcr.io/melgarafael/deskcomm-worker:<a-mesma-versão>\n' >> .env
printf 'WORKER_PULL_POLICY=missing\n' >> .env
# 3. recrie apenas o worker
docker compose -f docker-compose.prod.yml up -d --no-deps worker
```

> Numa VPS com proxy reverso próprio, **todo** `docker compose` leva também
> `-f docker-compose.traefik.yml`. Omitir recria o contêiner sem as labels de roteamento
> e o domínio inteiro passa a responder 404, com o contêiner `healthy`.

### Qual usar, e por quê

**Recomendo a Rota A.** A B parece mais segura por mexer em menos, e essa aparência é
justamente o risco: ela deixa o worker numa versão nova e o **banco** na versão antiga.
O worker é o consumidor de `ai_agent.dispatch_requested` e escreve em tabelas que
migrations recentes alteraram — parear código novo com schema velho é a combinação que
nem o CI nem o ensaio cobrem, porque não é um estado que o produto produz sozinho.

A Rota A é mais longa e é o caminho que o `update.sh` já percorre em toda atualização:
backup do banco antes, `baseline.sql` idempotente, healthcheck no fim, e rollback
automático do app se ele não voltar.

**A B tem um uso legítimo:** quando o `update.sh` não pode rodar agora — janela de
manutenção fechada, ou o operador quer separar o conserto do agente da atualização geral.
Nesse caso, escolha a tag do worker **igual à do app** (`grep APP_IMAGE .env`), nunca a
mais nova. É o que mantém código e schema no mesmo par.

---

## 5. Passo a passo — Rota A

Cada passo traz o rollback ao lado. `[ENSAIADO]` foi executado no U6-b de 2026-08-13;
`[NÃO VERIFICADO]` continua sem prova.

### 5.0. Leia isto antes: **rode duas vezes, e a razão mudou**

Duas medições, em ensaios diferentes, e o desfecho não é o mesmo — por isso a instrução
vale nos dois casos, mas o motivo depende de haver ou não uma release publicada.

**U6-b (2026-08-13, antes de existir o canal `stable`).** A primeira execução **não trocou
o worker**. Quem conduz a transição é o `update.sh` que está no disco do cliente — o antigo —
e ele só sabe gravar `APP_IMAGE`; o worker cai no default do compose novo, `:stable`, que
naquele momento não resolvia:

```
dc pull → Error: ghcr.io/…/deskcomm-worker:stable: not found
worker  → antes 2174fb4f · depois 2174fb4f   (NÃO mudou)
```

**U6-c (2026-08-13, já com a v1.3.0 e o `stable` publicados).** A primeira execução **trocou
o worker**, e o digest bate com o da release:

```
worker → antes deskcomm-u6c-worker (local, 7f53521f)
         depois ghcr.io/…/deskcomm-worker:stable
         sha256:3fe292cad2bd…  revision=9bd59e93  version=1.3.0
```

**Mas ela deixou o worker SEM PIN**, e é isto que mantém a segunda execução obrigatória:

```
.env depois da 1ª execução:
  APP_IMAGE=ghcr.io/melgarafael/deskcommcrm:1.3.0     ← pinado
  WORKER_IMAGE                                        ← AUSENTE
```

O app fica numa versão e o worker fica **seguindo um canal móvel**. Na próxima release o
`stable` se move, e um `up -d` qualquer — com `pull_policy: always`, que é o default para tag
móvel — levaria o worker para a versão nova enquanto o app permanece na antiga. É uma mistura
de versões que acontece **sozinha**, e é exatamente o que o invariante 3 da doutrina existe
para impedir.

A segunda execução, já com o kit novo em disco, chama `gravar_imagens` e pina as três na
mesma versão. Medido: `APP_IMAGE`, `WORKER_IMAGE` e `SCHEDULER_IMAGE` em `1.3.0`, com
`pull_policy: missing`.

**Consequências práticas:**

1. **Rode `update.sh` duas vezes** numa instalação legada — sempre. Com release publicada, a
   primeira traz o worker e a segunda o pina; sem release, a primeira não traz nada e a
   segunda faz as duas coisas.
2. **A partir da PRÓXIMA release, o agente completa parte disso sozinho — em até 5 minutos.**
   O `agent.sh` (cron do host) é o único que roda depois da 1ª execução já com o kit novo em
   disco, e ele preenche a chave que faltou usando **a versão que o contêiner já está
   rodando** — congelamento puro, nada muda de comportamento agora.

   > **Não conte com isso hoje, e esta linha já mentiu.** Ela dizia *"desde a 1.3.0"*. O
   > `completar_pin_ausente` entrou em `81b3bd5d` (2026-08-14), **posterior** à v1.3.0
   > (2026-08-13), e a v1.3.0 continua sendo a tag mais recente:
   >
   > ```console
   > $ git show v1.3.0:self-host-kit/_common.sh | grep -c completar_pin_ausente
   > 0
   > ```
   >
   > Ou seja: **nenhuma instalação existente tem esse comportamento.** Quem atendesse um
   > cliente lendo a versão anterior desta linha diria "espere cinco minutos que se resolve",
   > e nada aconteceria — para sempre. O erro é o mesmo que este runbook documenta em outro
   > lugar: **provei presença na `main` e afirmei comportamento na versão publicada.** O kit
   > que roda na VPS é o da tag (`update.sh` faz `git checkout "$TARGET_TAG"`), não o da
   > `main`. Confira antes de prometer: `git show <tag>:self-host-kit/_common.sh`.

   **O que ele nunca faz:** sobrescrever valor que já existe no `.env`. Chave ausente é
   omissão do script antigo; chave presente é decisão de quem opera, inclusive a de seguir
   um canal móvel de propósito. Ensaiado com cron real numa VPS: um `.env` com `:stable`
   escrito à mão sai intacto do ciclo.

   Isso **não dispensa a segunda execução** — o agente congela o que está rodando; a
   segunda execução alinha as três imagens na versão da release.

3. **Confira com o `diagnostico.sh` entre uma e outra.** Ele responde a primeira pergunta
   ("o worker é publicado?") e, quando o `.env` não fixa a versão, diz isso na saída.
4. **A release precisa existir antes de o parque atualizar.** É a diferença entre os dois
   ensaios acima, e é o motivo de a ordem do [runbook de ativação](ativar-packaging.md)
   ser precondição, não burocracia.

### A1. Diagnosticar e registrar o antes `[ENSAIADO]`

```bash
cd /caminho/do/projeto
bash self-host-kit/diagnostico.sh | tee /root/antes-remediacao.txt
docker compose -f docker-compose.prod.yml ps --format '{{.Service}}|{{.Image}}' >> /root/antes-remediacao.txt
cp .env /root/.env.antes-remediacao        # o .env tem segredos: chmod 600
chmod 600 /root/.env.antes-remediacao
```

**Rollback:** nada a desfazer — só leitura e cópia.

### A2. Confirmar que há espaço em disco `[NÃO VERIFICADO]`

O update baixa três imagens novas sem apagar as antigas, e faz um dump do banco.

```bash
df -h / | tail -1
docker system df
```

**Se faltar espaço:** `docker image prune -a` remove imagens **sem contêiner usando**.
Não use `docker system prune --volumes` — ele apaga volumes, e é lá que mora a sessão
pareada do WhatsApp.

### A3. Rodar o update `[ENSAIADO — ver §5.0: pode exigir duas execuções]`

```bash
bash self-host-kit/update.sh
```

O que ele faz, na ordem (lido do script, não ensaiado ponta a ponta): instala o cron do
agente de atualização → **backup do banco** → `git checkout` da tag → re-aplica o
`baseline.sql` → grava as três imagens no `.env` → `dc pull` → `dc up -d` → espera o app
ficar saudável.

**Rollback:** se o app não voltar, o script sai com código 1 e **não** reverte sozinho
quando executado à mão (o rollback automático existe no `agent.sh`, o caminho do botão na
tela). Manual:

```bash
cp /root/.env.antes-remediacao .env
docker compose -f docker-compose.prod.yml up -d
```

O banco **não** volta com isso. Para voltá-lo, `bash self-host-kit/restore.sh` com o
dump que o A3 gerou — e ele pede confirmação digitada, de propósito.

### A4. Verificar que o worker mudou de verdade `[ENSAIADO]`

```bash
bash self-host-kit/diagnostico.sh          # esperado: exit 0, "NÃO está afetada"
curl -s localhost:3000/api/v1/health | grep -o '"version":"[^"]*"'
grep -E '^(APP|WORKER|SCHEDULER)_IMAGE=' .env    # as três na MESMA versão
```

### A5. Verificar que nada se perdeu `[ENSAIADO em parte — ver a tabela]`

O que precisa estar intacto, e o que responde por cada um:

| O quê | Como conferir | Onde mora |
|---|---|---|
| Sessão do WhatsApp pareada | a conexão continua `WORKING` na tela de Conexões, **sem pedir QR de novo** | volume `waha-data` |
| Mídia recebida | uma conversa antiga ainda abre áudio/imagem | Supabase Storage |
| Conversas, contatos, leads | contagens iguais às de antes | banco (Supabase) |
| Certificado HTTPS | o domínio responde 307 sem aviso de certificado | volume do Caddy |
| Customizações do operador no `.env` | `diff /root/.env.antes-remediacao .env` mostra **só** as chaves de imagem | `.env` |

O `update.sh` mexe em exatamente três chaves do `.env` (`APP_IMAGE`, `APP_PULL_POLICY` e
— desde esta versão — as do worker e do scheduler) e preserva o resto, inclusive o que o
operador acrescentou à mão. **O `diff` do A5 é o que prova isso, e é uma das coisas que o
U6-b precisa confirmar.**

---

## 6. Evidência do ensaio (U6-b, 2026-08-13)

**Ambiente.** VPS real, num diretório isolado (`deskcomm-ensaio`, projeto compose próprio,
sem publicar portas), lado a lado com uma instalação de produção que **não foi tocada** —
confirmado antes e depois: 7 contêineres, mesmo uptime, Caddy respondendo 308.

**Estado legado reproduzido, não simulado.** Clone no commit `ee520110` (2026-07-31), o
mesmo em que `docker-compose.prod.yml` tinha o worker `build:`-only; `baseline.sql`
daquela época aplicado (69 tabelas); `docker compose up -d` construiu o worker na
máquina — imagem `deskcomm-ensaio-worker` (`2174fb4f`), **sem labels OCI**, diferente da
imagem da produção, provando que foi construída ali e não reaproveitada.

**Sintoma confirmado antes de consertar:** `diagnostico.sh` → exit 1, "ESTÁ afetada".

| Verificação | Antes | Depois | |
|---|---|---|---|
| imagem do worker | `deskcomm-ensaio-worker` (`2174fb4f`, sem labels) | `ghcr.io/…/deskcomm-worker:docs-doutrina-packaging` (`2082c65e`, `revision=31096584…`) | ✅ |
| `.env` — as três imagens | só `APP_IMAGE` | as três na mesma versão, `pull_policy: missing` | ✅ |
| marcador no volume `waha-data` | presente | **presente** | ✅ |
| customização do operador no `.env` | presente | **presente** | ✅ |
| tabelas no banco | 69 | 73 (a migração esperada) | ✅ |
| `diagnostico.sh` | exit 1 (afetada) | **exit 0 (não afetada)** | ✅ |

**O que exigiu duas execuções:** ver §5.0. A primeira não trocou o worker.

### O rollback tem um efeito colateral, e ele foi medido

Restaurar o `.env` anterior (sem `WORKER_IMAGE`) e subir **não devolve o estado exato**.
O compose no disco já é o novo, então o worker volta ao default `:stable`; como `stable`
não existia, o Compose **construiu localmente e taggeou a imagem como
`ghcr.io/melgarafael/deskcomm-worker:stable`**.

O resultado é uma imagem local **com nome de registry** — que parece publicada e não é:

```
revision: []                                          ← vazio: não veio do CI
source:   [https://github.com/melgarafael/DeskcommCRM] ← veio do LABEL do Dockerfile
está no registry de verdade? NAO
```

O `diagnostico.sh` detectou corretamente (exit 1). Vale registrar por quê: esse é
exatamente o caso que uma sabotagem do detector tinha inventado — imagem local
retagueada — e que a primeira versão dele, decidindo pelo **nome** da imagem, deixava
passar. O caso apareceu sozinho, na vida real, produzido pelo próprio rollback.

**Portanto:** depois de um rollback, rode o `diagnostico.sh`. Voltar o `.env` desfaz a
pinagem, não o estado da imagem.

### U6-c — o reensaio, com a v1.3.0 publicada (2026-08-13)

Mesmo desenho isolado, mesmo commit legado (`ee520110`), estado produzido pelo `up -d`. A
diferença: o canal `stable` passou a existir. **Uma única execução** do `update.sh` antigo:

| Pergunta | Resposta medida |
|---|---|
| O worker trocou numa execução só? | **Sim.** `deskcomm-u6c-worker` (local, `7f53521f`) → `ghcr.io/…/deskcomm-worker:stable`, `sha256:3fe292cad2bd…`, `revision=9bd59e93`, `version=1.3.0` — o digest bate com o da release |
| O `.env` ficou pinado? | **Não.** `APP_IMAGE=…:1.3.0`, e `WORKER_IMAGE` **ausente** — o worker segue o canal móvel |
| `diagnostico.sh` | **exit 0** (não afetada), com a nota de que o `.env` ainda não fixa a versão |
| O rollback produz imagem local disfarçada de registry? | **Não.** Com `stable` existindo, o Compose puxa em vez de construir — o efeito colateral do U6-b desapareceu |
| Nada se perdeu? | marcador do volume WAHA, customização do `.env` e banco (96 → 102 tabelas) intactos |

**O achado:** a remediação em uma execução **viola o invariante 3** — deixa o worker numa tag
móvel. Ver §5.0.

**Uma correção de método que o U6-c exigiu:** a primeira tentativa deste ensaio foi
invalidada por defeito do ambiente, não do produto. O baseline exige os schemas `auth`,
`storage` e `extensions`, que um Postgres puro não tem, e o `update.sh` abortava neles. O
ensaio passou a usar o mesmo *prelude* de stubs que `scripts/test-db.sh` aplica no job
`invariants` — com ele, o baseline da época aplica com `ON_ERROR_STOP=1` e **zero erros**
(96 tabelas). Sem essa correção, o ensaio estaria medindo o próprio ambiente.

### P4 — a execução real, na produção do projeto (2026-08-13)

Primeira aplicação em instalação de verdade, com dados de verdade. **A produção reproduziu o
U6-c com exatidão** — o ensaio previu o campo, que é o que dá valor ao ensaio.

| | antes | depois da 1ª | depois da 2ª |
|---|---|---|---|
| worker | `deskcommcrm-worker` local, `fb42e47c`, de **31/07** | `deskcomm-worker:stable` `3fe292cad2bd` `version=1.3.0` | `deskcomm-worker:1.3.0` |
| `.env` | sem `WORKER_IMAGE` | ainda **sem pin** (como o U6-c previu) | as três em `1.3.0`, `pull_policy: missing` |
| `/api/v1/health` | `0.1.0` | — | **`1.3.0`, healthy** |
| detector | exit 1 | exit 0 + aviso de tag móvel | **exit 0, sem ressalva** |

**Nada se perdeu, medido item a item:** volume WAHA com **48.607 arquivos** antes e depois,
sessão `noweb` presente, 4 volumes intactos, **nenhuma** chave do `.env` sumiu (39 → 43: as 4
novas são as de imagem). De fora da VPS: `HTTP 307`, e o health com `supabase: ok`,
`redis: ok`, `waha: ok`.

**O código chegou** — prova por hash, não por data. Os arquivos que os 9 commits tocaram, na
imagem que a produção roda, têm SHA-256 idêntico ao da tag `v1.3.0`:

```
ai-response-worker.ts    0c097cc60fd98196   (tag e imagem)
ai-sentiment-worker.ts   824e7e276a1369f6
media-derive-worker.ts   3b84df05e71847e1
agent-worker/main.ts     255c9934f84cddaa
```

O backup precedeu tudo e foi verificado antes de qualquer escrita: dump de 11 MB, `gunzip -t`
íntegro, 69.523 linhas, 145 `CREATE TABLE`, mais o `.tgz` das sessões do WhatsApp.

#### O que a execução real ensinou, e o ensaio não tinha mostrado

**O pin do WAHA não alcança instalação legada.** O `.env` do parque tem
`WAHA_IMAGE='devlikeapro/waha'` — sem tag, gravado pelo install antigo —, e o `.env` vence o
default do compose. O `update.sh` não reescreve essa chave, então a remediação deixa o WAHA
seguindo `:latest`:

```
compose (default): ${WAHA_IMAGE:-devlikeapro/waha:latest-2026.7.2}
.env do cliente:   WAHA_IMAGE='devlikeapro/waha'
em uso:            devlikeapro/waha          ← sem tag
```

É o mesmo padrão do defeito que o `install.sh` já teve — o `.env` vencendo o compose — só que
agora do lado de quem já instalou. Consequência: a cada `dc pull` a instalação recebe qualquer
versão que o upstream tiver publicado, sem ninguém ter testado, o que o invariante 4 proíbe.

**Ainda não consertado — mas a razão que escrevi aqui estava errada, e a medição a derrubou.**

A versão anterior deste parágrafo dizia que reescrever `WAHA_IMAGE` num `.env` alheio *"troca a
versão do WhatsApp de uma instalação em produção"*. **Não troca.** Medido em 2026-08-14, direto
no registry:

```
devlikeapro/waha:latest          → sha256:65e593e30bb702f891550b9da5d65e9e0eff8a926f5451fac6a582db84d3a323
devlikeapro/waha:latest-2026.7.2 → sha256:65e593e30bb702f891550b9da5d65e9e0eff8a926f5451fac6a582db84d3a323
```

As duas tags apontam para a **mesma imagem**. Aplicar o pin hoje não muda um byte do que roda —
e é por isso que o `dc pull` das duas execuções da remediação não trocou nada: o upstream não
moveu o `latest` desde 2026-07-29. Foi **sorte de calendário, não desenho**. No dia em que o
devlikeapro publicar, o próximo `update.sh` de qualquer instalação legada troca a versão do
WhatsApp sem ninguém pedir — porque `dc pull` sem argumento inclui o `waha`.

O custo real de aplicar o pin é outro, e também está medido: mudar a **string** da imagem muda
o `config-hash` do serviço, então o `up -d` **recria o contêiner** mesmo com digest idêntico.

```console
$ WAHA_IMAGE=devlikeapro/waha            docker compose -f docker-compose.prod.yml config --hash=waha
waha dfdaf2554bc01862779862967927d5701fbcdf3642529e9dd46269cd336b1e0d
$ WAHA_IMAGE=devlikeapro/waha:latest-2026.7.2 docker compose … --hash=waha
waha d81a5132fc863c838147bbebddc9d7166aac570285ef6197dc35ef8c51cc3349
```

Um restart do WhatsApp, não uma troca de versão. **NÃO MEDIDO:** se uma sessão pareada volta
`WORKING` depois desse restart — o volume sobrevive (provado aqui), a sessão não foi exercitada.

Segue não consertado porque a decisão é de quem opera e a janela ainda está aberta; o
enquadramento e as opções estão na issue do resíduo.

### O que estes ensaios NÃO cobriram

- **Supabase real.** O `SUPABASE_DB_URL` apontou para um Postgres em contêiner
  (`pgvector/pgvector:pg17`, o mesmo do CI). O `baseline.sql` foi exercitado de verdade;
  auth, storage e PostgREST não.
- **Sessão de WhatsApp pareada de verdade.** Foi representada por um arquivo marcador
  dentro do volume `waha-data`. Prova que o volume sobrevive ao ciclo; não prova que uma
  sessão pareada continua `WORKING`.
- **`install.sh` da época de ponta a ponta.** Ele exige um projeto Supabase (bootstrap do
  owner pela Admin API). O estado legado foi produzido pelo `docker compose up -d` — que
  é literalmente a linha que o passo 9 do `install.sh` executa, e é a que produz o worker
  construído localmente.
- **Uma release de verdade.** O ensaio usou uma tag local (`vdocs-doutrina-packaging`)
  apontando para as imagens já publicadas da branch. Foi o artifício que permitiu ensaiar
  o caminho completo antes de haver release — e é por isso que o cenário do `stable`
  inexistente apareceu.

## 7. Decisão do operador — sempre

Nada aqui roda sozinho. Não existe atualização automática nem compulsória: o agente de
atualização da tela só age quando alguém clica em "Atualizar agora", e o `update.sh` só
roda quando alguém o executa.

Uma instalação afetada **está funcionando** — atende, responde, registra. O que ela não
tem são as correções dos últimos dois meses no agente. Quem escolhe o momento de fechar
essa distância é quem opera o servidor.
