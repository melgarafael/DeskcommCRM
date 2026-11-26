# Ânima Hub — fork Ânima do DeskcommCRM

> Documentação de operação do fork. As regras para agentes de código estão em
> [`AGENTS.anima.md`](../../AGENTS.anima.md). As divergências em relação ao upstream estão em
> [`PATCHES.md`](PATCHES.md).
>
> **Legenda de estado:** ✅ existe e foi verificado · 🚧 planejado, ainda não existe no repositório ·
> ❓ decisão pendente.

## 1. Visão geral

O Ânima Hub é o [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) com a identidade visual
da Ânima. O fork vive em `Anima-Solutions/anima-hub` e recebe o upstream por tags de release
(seção 6).

**Nível de customização atual: Nível 1 (tokens do design system).** Muda apenas a pele:

| Muda | Não muda |
|---|---|
| Paleta clara e escura do DS mapeada nos tokens de `app/globals.css` | Componentes de `components/ui/` |
| Tema escuro como padrão | Layout, telas, fluxos, textos e rotas |
| Tipografia Inter (local) | Backend, API, banco e migrations |
| Ícones Phosphor em peso bold | Worker, scheduler e integrações |
| Raios e sombras do DS | |
| Logo e nome Ânima Hub (pelo `/admin/marca`, no banco) | |

**Estado em 2026-11-26:** só existe a documentação. Nenhum token foi trocado ainda.

**Ponto de partida do fork:** um commit da `main` do upstream posterior à **v1.125.0** e anterior à
**v1.126.0** (`7ef344257`). O primeiro sync recomendado é para a `v1.126.0`.

**Futuro:** está previsto um front próprio (Nível 4) sobre a API `/api/v1`. Por isso, o mapeamento
de tokens é mantido como uma camada isolada e reaproveitável.

## 2. Pré-requisitos

| Item | Versão / origem | Estado |
|---|---|---|
| Node | `22` (arquivo `.nvmrc`; use `nvm use`) | ✅ |
| pnpm | `9.15.9` (`packageManager` do `package.json`; `corepack enable`) | ✅ |
| Docker + Compose v2 | para o stack local e o servidor | ✅ |
| Acesso ao pacote do DS | `@anima-solutions/design-system` no **GitHub Packages** (`npm.pkg.github.com`) | ✅ verificado: `2026.11.2` |
| `NPM_TOKEN` | token do GitHub com `read:packages` na org `Anima-Solutions` | ✅ |
| MCP do Storybook | servidor `anima-ds` → `https://designsystem.animahub.ai/mcp` | ✅ |
| `ANIMA_DS_MCP_TOKEN` | Bearer do MCP. **Não** serve para o pacote npm | ✅ |

> ⚠️ São dois tokens diferentes. Com o `ANIMA_DS_MCP_TOKEN`, o GitHub Packages responde `401`. O
> pacote só aceita token do GitHub (`NPM_TOKEN`).

## 3. Instalação local

```bash
git clone git@github.com:Anima-Solutions/anima-hub.git
cd anima-hub
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream --tags

export NPM_TOKEN=ghp_...            # read:packages; nunca commite
nvm use && corepack enable
cp .env.example .env.local          # preencha (ver README.md do upstream)
make install                        # 🚧 hoje: pnpm install
make dev                            # 🚧 hoje: docker compose up -d && pnpm dev
```

Para o stack local completo (Supabase local, app, worker, scheduler, WAHA e Redis), rode uma vez
`./ubuntu-local-installer.sh` e depois use `pnpm local:up | local:down | local:status | local:logs`.

O `.npmrc` do projeto (🚧, entra junto com a dependência do DS) terá somente:

```ini
@anima-solutions:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

## 4. Instalação em servidor

O ponto de partida é o kit do upstream (`hostgator-setup-kit/`), com três diferenças:

1. **Imagem do app:** usa a imagem Ânima em vez de `ghcr.io/melgarafael/deskcommcrm`. ❓ O
   registro e o nome da imagem ainda não foram decididos. A sugestão é
   `ghcr.io/anima-solutions/anima-hub:<versão>`.
2. **Worker e scheduler continuam com as imagens oficiais** do upstream, na mesma tag de versão.
   O Nível 1 não altera nada que eles executam. ❓ Confirmar essa decisão quando o workflow de
   imagem for escrito.
3. **Proxy e pastas:** o Caddy do projeto não sobe. Na frente fica o **Nginx Proxy Manager**, na
   rede `anima_proxymanager_shared_network`, e os dados vão para `/srv/...` (seção 11).

Comando de subida (encapsulado pelo `make up`, 🚧):

```bash
docker compose -p deskcomm \
  -f docker-compose.prod.yml -f docker-compose.npm.yml -f docker-compose.anima.yml \
  --env-file .env up -d
```

O `docker-compose.npm.yml` do upstream lê `PROXY_NETWORK_NAME` e `PROXY_NETWORK_APP_IP`. No `.env`:

```ini
PROXY_NETWORK_NAME=anima_proxymanager_shared_network
PROXY_NETWORK_APP_IP=<IP fixo que o Proxy Host do NPM aponta>
```

Fluxo previsto (🚧): `make setup` → editar `.env` → `make deploy TAG=<versão>` → criar o Proxy Host
no NPM apontando para `PROXY_NETWORK_APP_IP:3000` → `make health`.

**Verificação depois de qualquer deploy:** `/` responde `200` e `/app` responde `307` (redireciona
para o login). Um `200` sozinho não prova que quem respondeu foi o app.

❓ **Supabase:** Cloud ou self-hosted no mesmo servidor? Se for self-hosted, o Postgres vai em
`/srv/appdata/deskcomm/supabase-db/` e o storage em `/srv/storage/deskcomm/`.

❓ **Recursos mínimos:** serão medidos no stack real antes do primeiro deploy.

## 5. Atualização (update)

> ⚠️ **Não rode `hostgator-setup-kit/update.sh` do upstream numa instalação Ânima.** Ele monta as
> imagens a partir de `IMG_NS="ghcr.io/melgarafael"` (`hostgator-setup-kit/_common.sh`) e regrava
> `APP_IMAGE`, `WORKER_IMAGE`, `SCHEDULER_IMAGE` e `VOICE_AGENT_IMAGE` no `.env`. A instalação
> voltaria para a imagem oficial, sem a identidade Ânima.

Fluxo Ânima (🚧 `make update TAG=<versão>`):

1. Backup do banco, dos volumes e do `.env` em `/srv/backups/deskcomm/`.
2. Registrar a imagem em uso (para o rollback).
3. Gravar no `.env` a imagem Ânima nova (`APP_IMAGE`) e as oficiais do worker e do scheduler na
   mesma versão.
4. Aplicar as migrations da versão nova (ver ⚠️ abaixo).
5. `pull` e `up -d` com os três compose files.
6. Healthcheck (`/` = 200, `/app` = 307). Se falhar, rollback automático para a imagem registrada.

Rollback manual: `make rollback` (🚧). Ele pede confirmação, a menos que `YES=1`.

⚠️ O `update.sh` do upstream também aplica o apêndice do `supabase/baseline.sql` e faz outras
checagens. O alvo `make update` precisa reproduzir essas etapas, ou chamar as funções do kit com o
namespace Ânima. Isso será decidido ao escrever o `Makefile`.

## 6. Sync com o upstream

Cadência **mensal**, sempre para uma **tag de release** (`vX.Y.Z`), nunca para a `main`.

1. Ler no `CHANGELOG.md` as seções **"⚠️ Requer atenção"** de todas as versões do intervalo.
2. `make sync-upstream TAG=vX.Y.Z` (🚧). Hoje, à mão:
   ```bash
   git fetch upstream --tags
   git switch main && git pull
   git switch -c sync/vX.Y.Z
   git merge vX.Y.Z
   ```
3. Resolver os conflitos preservando a camada Ânima. Conferir cada linha do [`PATCHES.md`](PATCHES.md).
4. Rodar os gates (`make check`, `make e2e`), capturar as telas principais nos dois temas e listar
   as cores cruas (`bg-red-500`…) e os controles crus (`<button>`, `<input>`, `<select>`) que
   entraram no intervalo:
   ```bash
   git diff <tag-anterior>..vX.Y.Z -- app components | grep -E '^\+.*(bg|text|border)-(red|blue|green|gray|slate|zinc)-[0-9]'
   git diff <tag-anterior>..vX.Y.Z -- app components | grep -E '^\+.*<(button|input|select)[ >]'
   ```
5. Abrir um PR com: versão de/para, itens "Requer atenção", conflitos resolvidos e vazamentos
   visuais encontrados.

Se o intervalo trouxer mudança estrutural (Tailwind, Next, React ou reestruturação do
`globals.css`), **pare e consulte o responsável** antes de seguir.

## 7. Design system

- **Pacote:** `@anima-solutions/design-system`, versão em uso: **2026.11.2** (🚧 ainda não é
  dependência do projeto).
- **Atualizar:** `make ds-update` (🚧), que instala a última versão e roda `make check`. Uma versão
  major pede aprovação antes.
- **Mapeamento de tokens:** em `app/globals.css`, os blocos `:root`, `[data-theme="light"]` e
  `[data-theme="dark"]` passam a apontar para as variáveis do pacote (`--color-bg: var(<token do DS>)`).
  Os valores não são copiados, então uma versão nova do DS repinta o app sozinha. Um hex copiado só
  é aceito quando o pacote não exporta a variável, e cada caso fica registrado no `PATCHES.md`.
- **Contraste:** os testes `lib/branding/contraste.ts`, `lib/channels/marca-do-canal.test.ts` e
  `lib/aparencia/aparencia.test.ts` medem os tokens contra a WCAG. Se falharem, o token está
  errado; o teste não se altera.
- **MCP do Storybook (`anima-ds`):** use `docs-list` para descobrir os componentes e tokens e
  `docs-show` para ver as propriedades. Nunca use nome de token ou propriedade que não esteja
  documentado.
- **O DS não tem algo de que precisamos?** Não crie token local. Registre o que falta e leve à
  governança do DS.

## 8. Marca

A marca mora **no banco**, não na imagem. O `.env` é só a semente:

- **Instalação:** `/admin/marca` (nome "Ânima Hub", logo e cor de destaque). Grava em
  `platform_branding`.
- **Organização:** Configurações › Marca (`/app/settings/marca`). Grava em
  `organizations.settings.branding`.
- **Semente no `.env`:** `APP_NAME`, `APP_LOGO_URL` e `APP_ACCENT_HEX`. Valem só até alguém salvar
  pela tela, e servem de piso no rollback.
- **E-mails de acesso** (criar conta e recuperar senha) são renderizados pelo Supabase Auth, fora
  do app. Para aplicar a marca a eles: `make brand-emails` (🚧), que chama
  `hostgator-setup-kit/marca-emails.sh` e lê o `.env`.
- ⚠️ A tela **Aparência** (`/app/settings/aparencia`, `lib/aparencia`) permite que cada
  organização troque a fonte e o template. Ela pode sobrepor os tokens Ânima. O alcance disso será
  mapeado antes do mapeamento de tokens.

## 9. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `401 Unauthorized` no `pnpm install` (npm.pkg.github.com) | `NPM_TOKEN` ausente, ou é o token do MCP | Exportar um token do GitHub com `read:packages` |
| `404` para `@anima-solutions/design-system` | O escopo não está apontando para o GitHub Packages | Conferir o `.npmrc` (seção 3) |
| Build da imagem falha ao instalar o DS | Secret do token não passado ao build | 🚧 Será documentado junto com o `Dockerfile` (secret mount) |
| Tela ilegível depois de um CSS personalizado | CSS do administrador sobrescrevendo tokens | Abrir a página com `?sem_css=1` para desligá-lo e corrigir em `/admin/marca` |
| `network anima_proxymanager_shared_network declared as external, but could not be found` | O stack do NPM não criou a rede, ou ela tem outro nome | `docker network ls`; ajustar `PROXY_NETWORK_NAME` |
| Domínio responde `502` depois de um deploy | `PROXY_NETWORK_APP_IP` diferente do IP do Proxy Host | Alinhar o `.env` com o Proxy Host do NPM |
| Serviços não sobem com bind em `/srv/...` | Pasta ausente ou dono errado | `make setup` (🚧); conferir `ls -ld /srv/appdata/deskcomm/*` |
| Depois de um update o app perdeu a cara Ânima | Rodaram o `update.sh` do upstream | `make update TAG=<versão>` ou `make rollback` (seção 5) |

## 10. Registro de divergências

Todo arquivo do upstream alterado fora da superfície permitida (`AGENTS.anima.md` §3) é registrado
em [`PATCHES.md`](PATCHES.md), com o motivo e a forma de reaplicar depois de um sync.

## 11. Estrutura no servidor

Nome do app = `COMPOSE_PROJECT_NAME` = **`deskcomm`**. Todos os caminhos vêm do `.env`, com padrão
no `.env.anima.example` (🚧).

| Pasta | Conteúdo |
|---|---|
| `/srv/stacks/deskcomm/` | Compose files, `Makefile`, `.env`, configs (Caddyfile, asterisk) |
| `/srv/storage/deskcomm/` | Arquivos (mídias e uploads fora do Supabase Storage) |
| `/srv/appdata/deskcomm/<serviço>/` | Dados de cada serviço |
| `/srv/backups/deskcomm/` | Backups (banco, volumes, `.env`) |

Mapa de volumes (🚧 `docker-compose.anima.yml`, bind via `driver_opts`). Os volumes nomeados vêm do
`docker-compose.prod.yml` do upstream:

| Volume nomeado | Destino |
|---|---|
| `waha-data`, `waha-media` | `/srv/appdata/deskcomm/waha/{data,media}` |
| volume do `redis` | `/srv/appdata/deskcomm/redis/` |
| `wacalls-data` | `/srv/appdata/deskcomm/wacalls/` |
| `asterisk-data`, `asterisk-logs` | `/srv/appdata/deskcomm/asterisk/{data,logs}` |
| `caddy-data`, `caddy-config` | não usados (o Caddy não sobe com o NPM) |

Containers: `container_name: ${COMPOSE_PROJECT_NAME}-<serviço>` (`deskcomm-app`, `deskcomm-worker`,
`deskcomm-waha`…).

## 12. Comandos rápidos

Interface única do fork (🚧 o `Makefile` ainda será criado). Os alvos destrutivos pedem
confirmação, a menos que `YES=1`.

| Alvo | O que faz |
|---|---|
| `make help` | Lista os alvos (padrão) |
| `make setup` | Cria as pastas `/srv/...`, confere a rede do NPM e copia `.env.anima.example` → `.env` |
| `make install` | `pnpm install` com o `.npmrc` do DS |
| `make dev` | Ambiente local de desenvolvimento |
| `make check` | `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` |
| `make e2e` | `pnpm test:e2e` |
| `make build TAG=…` | Imagem Docker Ânima (DS via secret) |
| `make push TAG=…` | Publica a imagem |
| `make up` / `down` / `restart` | Stack com os três compose files |
| `make ps` / `logs [SERVICE=…]` | Estado e logs |
| `make deploy TAG=…` | Backup → pull → `up -d` → healthcheck → rollback se falhar |
| `make update TAG=…` | Igual ao deploy, registrando a versão anterior |
| `make rollback` | Volta para a imagem anterior registrada |
| `make backup` / `restore` | Em `/srv/backups/deskcomm/` |
| `make health` | Healthcheck do app e dos serviços |
| `make brand-emails` | Reaplica a marca nos e-mails de acesso |
| `make sync-upstream TAG=vX.Y.Z` | Cria `sync/vX.Y.Z` e faz o merge da tag |
| `make ds-update` | Atualiza o DS e roda `check` |
| `make shell [SERVICE=app]` | Shell no container |
