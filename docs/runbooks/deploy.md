# Runbook — Deploy em produção (VPS)

O caminho normal de deploy **não constrói nada na VPS**: o CI publica a imagem no
GHCR e a VPS só puxa. Construir localmente é exceção de emergência, e tem custo —
está documentado no fim.

---

## 1. O comando

```bash
cd /var/www/crm
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

### Os DOIS `-f` são obrigatórios. Sempre.

Esta é a pegadinha que já derrubou o site inteiro em produção (2026-08-05).

A VPS (Hostinger) vem com um **Traefik próprio** ocupando as portas 80/443.
`docker-compose.traefik.yml` é o ÚNICO lugar que:

- coloca no contêiner `app` as labels de roteamento
  (`traefik.http.routers.deskcomm.rule=Host(...)`);
- associa o contêiner à rede que o Traefik enxerga (`TRAEFIK_DOCKER_NETWORK`);
- desliga o `caddy` do compose base por profile (senão dois processos brigam
  pela mesma porta).

Rodar só com `-f docker-compose.prod.yml` recria o contêiner **sem labels
nenhuma**. O Traefik deixa de enxergá-lo e o domínio inteiro passa a responder
`404 page not found` — não é erro do Next, é o 404 genérico do Traefik. A app
está no ar, saudável, e inalcançável.

---

## 2. Verificação pós-deploy (não pule)

`healthy` no `docker ps` **não prova que o site está acessível** — o healthcheck
é um probe TCP interno e passa mesmo com o roteamento quebrado. Verifique as
duas coisas:

```bash
# 1) as labels do Traefik existem?
#    O nome do contêiner é <pasta-do-projeto>-app-1, então pergunte ao compose
#    em vez de chutar. Aqui um -f só basta: o `ps -q` resolve pelo nome do
#    projeto + serviço, não pelo conteúdo do arquivo (medido: com um -f ou com
#    os dois, devolve o MESMO contêiner). Quem precisa dos dois é o `up -d`.
docker inspect "$(docker compose -f docker-compose.prod.yml ps -q app)" \
  --format '{{.Config.Labels}}' | grep -o 'traefik.enable:[^ ]*'
# esperado: traefik.enable:true   (vazio = roteamento quebrado)

# 2) o domínio responde?
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMAIN>/
# esperado: 307 (redireciona pro login)
# 404      = labels perdidas, refaça o deploy com os dois -f
```

---

## 3. Fluxo completo (do código à produção)

```
commit → push → PR → merge na main → CI publica imagem → VPS puxa
```

1. **Commit + push** numa branch de feature. Trabalho que fica só no disco da
   VPS não existe: o CI não o vê, some se a VPS for reconstruída, e é invisível
   pra qualquer outra pessoa.
2. **PR e merge na `main`.** `publish-image.yml` dispara em push na `main` (ou
   tag `v*`) e publica **quatro** imagens — `deskcommcrm`, `deskcomm-worker`,
   `deskcomm-scheduler` e `deskcomm-voice-agent` — sempre na mesma versão. O build pesado roda nos
   runners do GitHub, nunca na VPS do usuário.
3. **Deploy na VPS.** Numa instalação real isto é `bash hostgator-setup-kit/update.sh`,
   não um `up -d` na mão: ele puxa a tag publicada, re-aplica o `baseline.sql`,
   faz backup antes e grava as quatro imagens no `.env`.

Para uma instalação nova em Oracle Ampere A1/Ubuntu (`linux/arm64`), siga
[`oracle-arm64.md`](oracle-arm64.md). O workflow publica os índices AMD64/ARM64;
numa VPS ARM64 o `install.sh` e o `update.sh` conferem a plataforma da release
numérica e a WAHA efetiva **antes** dos efeitos persistentes (em AMD64 o caminho
segue o de antes). O modo single-server também
verifica cada imagem da ref fixada do Supabase. Push na branch ou atualização
do GitHub **não atualiza a VPS automaticamente**: a atualização é explícita.

### Primeiro upgrade de uma instalação com kit antigo (ARM64)

Um `update.sh` antigo pode sincronizar o Supabase e gravar cron **antes** de
baixar o kit novo. Para a primeira transição, faça a sonda somente-leitura a
partir de um clone separado da **mesma origem/fork** e da **mesma versão
numérica** que será instalada. Substitua `vX.Y.Z` pela release publicada e
`/var/www/crm` pela pasta real da instalação; não use `stable` ou `latest`:

```bash
CHECK_DIR="$(mktemp -d)"
git clone --depth 1 --branch vX.Y.Z https://github.com/melgarafael/DeskcommCRM.git "$CHECK_DIR"
bash "$CHECK_DIR/hostgator-setup-kit/preflight-upgrade.sh" \
  --installation /var/www/crm --to vX.Y.Z
cd /var/www/crm
bash hostgator-setup-kit/update.sh --to vX.Y.Z
```

Se a sonda falhar, **não rode** o updater antigo. Ela confere as quatro imagens
do CRM e a `WAHA_IMAGE` efetiva para a arquitetura da VPS sem alterar `.env`,
volumes, contêineres ou banco. Uma WAHA personalizada/Plus incompatível precisa
de uma imagem apropriada escolhida pelo operador; o kit não a substitui. Depois
da primeira transição, o `update.sh` novo faz esse pré-voo antes de backup,
checkout e da atualização do Supabase (o cron do agente e o modo de cadastro do
GoTrue seguem antes da decisão de versão, como sempre). O backup do updater continua necessário;
uma sonda verde não equivale a backup nem garante rollback automático do banco.

> **`latest` não é a última release.** Ele é publicado a partir da branch default, então
> segue o **topo da `main`** — código ainda não lançado. Quem quer a última release usa
> `stable`; quem opera um cliente usa o número da versão. Ver
> [`../doctrine/packaging.md`](../doctrine/packaging.md).

---

## 4. Exceção: imagem construída na VPS

Só quando é preciso validar algo em produção **antes** de a imagem oficial
existir (ex.: CI ainda rodando e um bug bloqueando o usuário).

```bash
APP_IMAGE=deskcomm-app:local docker compose \
  -f docker-compose.prod.yml -f docker-compose.build.yml --env-file .env build app

APP_IMAGE=deskcomm-app:local APP_PULL_POLICY=never docker compose \
  -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

O `docker-compose.build.yml` também cobre `worker` e `scheduler` — troque
`app` pelo serviço que você precisa construir. Eles têm `build:` no próprio
compose de produção (é o escape que faz a instalação sobreviver a um registry
fora do ar), mas é o override que traz o `pull_policy: never`; sem ele o
`up -d` volta a buscar a imagem publicada.

**Isto é dívida, não um caminho paralelo.** A imagem existe só no disco daquela
VPS: não está no registry, não está no git, e qualquer `docker compose up -d`
sem `APP_PULL_POLICY=never` a substitui pela do GHCR — silenciosamente, sem erro
nenhum, revertendo o que você acabou de subir.

Requisitos: >= 4 GB de RAM **ou** swap (medido: ~4min num VPS de 3.8 GB com 4 GB
de swap) — e isto é o requisito **deste caminho de exceção**, não da operação
normal. A régua de operação é outra, e não mudou. Ela tem três parcelas, e **duas
são medidas e uma é herdada** — a distinção importa porque a herdada é a que
costuma ser citada como se fosse nossa:

| parcela | estado | como conferir |
|---|---|---|
| 7 contêineres | **medido** | `docker compose -f docker-compose.prod.yml config --services \| wc -l` |
| `mem_limit` somando 2560m (app 768 + worker 512 + waha 1280) | **medido** | `grep -n 'mem_limit' docker-compose.prod.yml` |
| ~150 MB por número de WhatsApp | **herdado do upstream WAHA**, nunca medido neste projeto | `docker stats --no-stream` na sua VPS |

O terceiro número vem de `docs/research/reference-synthesis.md` (síntese do curso
WAHA, 2026-05), não de uma medição nossa — e circula em sete documentos que se
citam entre si. Uma medição pontual na produção do projeto (2026-08-14, **uma**
sessão pareada, VPS compartilhada com outras stacks) deu **304,5 MiB no contêiner
`waha` inteiro**, contra o `mem_limit` de 1280 MiB. Um ponto não decompõe baseline
e sessão: para isso seriam necessários dois números pareados, e não é ensaio que
se faça numa instalação viva.

**Nada disso mexe no tier recomendado.** A régua que sustenta os 4 GB é a soma da
stack em operação, não o WAHA isolado — e a folga existe justamente porque a
parcela por sessão não é conhecida com precisão.

Ao terminar, feche o ciclo — merge na `main` e volte a VPS pra imagem oficial.
