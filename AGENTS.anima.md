# AGENTS.anima.md — Fork Ânima do DeskcommCRM

> Instruções para qualquer agente de código (Claude Code, Codex, Cursor, Copilot) trabalhando no
> **fork Ânima** do [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM).
> Este arquivo **complementa** o `AGENTS.md` e o `CLAUDE.md` do upstream; não os substitui.

## 0. Como este arquivo se encaixa no repo

- O `AGENTS.md` e o `CLAUDE.md` da raiz são do **upstream**: continuam valendo para toda convenção
  de código, testes, migrations, segurança e LGPD. **Não os reescreva.** Testes do upstream leem
  esses arquivos (`tests/unit/agents-md-versoes.test.ts`,
  `tests/unit/documentacao-aponta-para-o-que-existe.test.ts`), e qualquer mudança neles vira
  conflito em todo sync.
- A única alteração permitida neles é **uma linha no topo** apontando para este arquivo:
  - `AGENTS.md`: `> Fork Ânima: leia também [AGENTS.anima.md](AGENTS.anima.md) antes de qualquer tarefa.`
  - `CLAUDE.md`: `@AGENTS.anima.md` (import do Claude Code).
- **Precedência:** em escopo do fork, marca, design system e sync, vale **este arquivo**. Em todo o
  resto (arquitetura, testes, banco, segurança), vale a doutrina do upstream.

## 1. Objetivo atual: Nível 1 de customização (tokens do DS)

Vestir o DeskcommCRM com a identidade visual Ânima **trocando apenas a camada de tokens**:

| Entra no Nível 1 | Fica fora do Nível 1 |
|---|---|
| Paleta clara e escura do DS mapeada nas variáveis do `app/globals.css` | Trocar componentes de `components/ui/` (é o Nível 2) |
| **Tema escuro como padrão** (é o tema principal do DS), com o claro disponível | Redesenhar casca, sidebar, top bar ou telas (Níveis 3 e 4) |
| Tipografia **Inter**, servida localmente | Alterar layout, fluxo, textos ou rotas |
| Ícones **Phosphor em peso bold** via `lib/ui/icons.ts` | Qualquer mudança em backend, API, banco ou migrations |
| Raios e sombras do DS nos tokens `--radius-*` e `--shadow-*` | Corrigir "vazamentos" visuais tela a tela |
| Logo Ânima Hub e marca pelo `/admin/marca` | |

**Critério de pronto:** todas as telas usam o tema Ânima nos modos escuro e claro, os gates do
upstream passam (seção 6), e nenhum arquivo fora da superfície permitida (seção 3) foi alterado.

**Futuro (não implementar agora):** o caminho previsto é migrar para um front próprio (Nível 4)
sobre a API `/api/v1`, tela a tela. Por isso: não acople nada novo ao front do upstream e mantenha
o mapeamento de tokens como uma camada reaproveitável.

## 2. Design System Ânima

### Fontes da verdade

- **Pacote npm:** `@anima-solutions/design-system` (privado). Versão de referência: `2026.11.2`.
  Use sempre a versão mais recente publicada. **O DS não usa mais azul como cor primária**: qualquer
  material com azul como primária (incluindo a cópia antiga do DS em HeroUI) está desatualizado e
  não deve ser usado como referência.
- **MCP do Storybook do DS:** `anima-ds-sb-mcp`
  <!-- TODO: confirmar o nome exato do servidor MCP registrado no .mcp.json do projeto. -->
  Acesso autenticado por OAuth.

### Regra de ouro dos tokens

**Cores, fontes, raios e sombras vêm do pacote, nunca copiados à mão.** O `globals.css` deve mapear
as variáveis do DeskcommCRM para as variáveis exportadas pelo pacote (por exemplo,
`--color-bg: var(<token do DS>)`), de modo que uma nova versão do DS repinte o app sozinha.
Copiar valores hex só é aceitável se o pacote não exportar a variável; nesse caso, registre o
motivo em `docs/anima/PATCHES.md`.

Valores de referência da 2026.11.2, **só para conferência visual** (a fonte é o pacote/MCP):

| Papel | Escuro (padrão) | Claro |
|---|---|---|
| Fundo | `#11141b` | `#eceff5` |
| Card | `#171b23` | `#f7faff` |
| Superfície | `#1d222b` | `#f1f4fa` |
| Texto | `#f7faff` | `#11141b` |
| Texto secundário | `#9aa1af` | `#5f6675` |
| Primária / texto sobre ela | `#c5fe59` / `#11141b` | `#6d8e2e` / `#f7faff` |
| Secundária | `#8f7df8` | `#8f7df8` |

Decisões de identidade já aprovadas: tema escuro como padrão; botões com raio de 12px e cards com
28px; Phosphor bold; texto comum **nunca** sobre o verde-limão sólido (ilegível), use a tinta
suave da primária ou superfície neutra.

### Uso do MCP do Storybook (obrigatório)

When working on UI components, always use the `anima-ds-sb-mcp` MCP tools to access Storybook's
component and documentation knowledge before answering or taking any action.

- **CRITICAL: Never hallucinate component properties!** Before using ANY property on a component
  from a design system (including common-sounding ones like `shadow`, etc.), you MUST use the MCP
  tools to check if the property is actually documented for that component.
- Query `docs-list` to get a list of documented components
- Query `docs-show` for that component to see all available properties and examples
- Only use properties that are explicitly documented or shown in example stories
- If a property isn't documented, do not assume properties based on naming conventions or common
  patterns from other libraries. Check back with the user in these cases.
- Use the `get-storybook-story-instructions` tool to fetch the latest instructions for creating or
  updating stories. This will ensure you follow current conventions and recommendations.
- Check your work by running `test-run`.

Remember: A story name might not reflect the property name correctly, so always verify properties
through documentation or example stories before using them.

**No Nível 1, isso se aplica a tokens também:** antes de mapear uma variável, confirme pelo MCP
(ou pelos arquivos do pacote) o nome exato do token. Não invente nomes de token.

### Faltou algo no DS?

Não crie token, cor ou componente local para "tapar o buraco". Pare, descreva o que falta e
pergunte ao usuário: a governança do DS decide se entra no pacote. O fork só consome o DS.

## 3. Superfície permitida do fork (Nível 1)

Cada arquivo do upstream alterado é um conflito em potencial a cada sync. Toque **somente** em:

- `app/globals.css` — apenas os blocos de tokens (`:root` e `[data-theme="dark"]`) e o mapeamento
  para o DS. Não mexa nas regras de `@theme`, `@source` ou `@custom-variant` sem necessidade.
- `app/layout.tsx` e `app/fontes-da-aparencia.ts` — fonte Inter local e tema padrão.
- `app/providers.tsx` — tema escuro como padrão, se for aqui que o tema é definido.
- `lib/ui/icons.ts` — peso bold dos ícones Phosphor (sem trocar a biblioteca).
- `package.json` / `pnpm-lock.yaml` — dependência `@anima-solutions/design-system`.
- `.npmrc` — registro do escopo privado, com token **via variável de ambiente** (`${NPM_TOKEN}`).
  Nunca commite token.
- `Dockerfile` e o workflow de imagem própria — build com o pacote privado (secret mount) e
  publicação da imagem Ânima.
- `docs/anima/**`, `AGENTS.anima.md` e o banner de uma linha no topo do `README.md`.
- **Arquivos novos da Ânima** (não existem no upstream, então não geram conflito): `Makefile`,
  `docker-compose.anima.yml` e `.env.anima.example` (seções 8 e 9).

Qualquer arquivo fora dessa lista exige **aprovação do usuário antes** e um registro em
`docs/anima/PATCHES.md` (arquivo, motivo, data, como reaplicar se o sync sobrescrever).

**Não altere testes do upstream para fazê-los passar.** Testes de contraste
(`lib/branding/contraste.ts`, `lib/channels/marca-do-canal.test.ts`, `lib/aparencia/aparencia.test.ts`)
medem os tokens contra a WCAG: se falharem, o token está errado, não o teste.

## 4. Documentação inicial (requisito da primeira entrega)

Antes de qualquer customização visual, crie a documentação do fork em `docs/anima/README.md` e um
banner de uma linha no topo do `README.md` do upstream apontando para ela. Conteúdo mínimo:

1. **Visão geral** — o que é o fork, nível de customização atual (Nível 1) e o que não muda.
2. **Pré-requisitos** — Node (versão do `.nvmrc`), pnpm (versão do `packageManager`), Docker,
   acesso ao registro privado do DS (`NPM_TOKEN`) e ao MCP do Storybook.
3. **Instalação local** — clonar, configurar `.npmrc` e `.env`, instalar dependências, subir o
   stack local e abrir o app.
4. **Instalação em servidor** — como instalar a imagem Ânima numa VPS, partindo do kit do upstream
   (`hostgator-setup-kit/`) e indicando exatamente o que muda (imagem própria em vez da oficial).
5. **Atualização (update)** — procedimento de update da instalação Ânima. **Atenção:** o
   `hostgator-setup-kit/update.sh` do upstream regrava o `APP_IMAGE` do `.env` com a imagem oficial;
   documente o fluxo que mantém a imagem Ânima (e rollback).
6. **Sync com o upstream** — passo a passo da seção 5.
7. **Design system** — pacote, versão em uso, como atualizar o DS, como funciona o mapeamento de
   tokens e como usar o MCP do Storybook.
8. **Marca** — como configurar logo Ânima Hub, nome e cor no `/admin/marca` e os e-mails de acesso
   (`marca-emails.sh` lê o `.env`).
9. **Solução de problemas** — erros comuns (token do registro, build da imagem, CSS personalizado
   com `?sem_css=1`, rede do proxy ausente, permissões em `/srv`).
10. **Registro de divergências** — link para `docs/anima/PATCHES.md`.
11. **Estrutura no servidor** — as pastas da seção 8, o que vive em cada uma e o mapa de volumes.
12. **Comandos rápidos** — tabela com todos os alvos do `Makefile` (seção 9); a documentação deve
    usar `make <alvo>` nos passos de instalação, deploy, update e sync, em vez de comandos longos.

Mantenha a documentação atualizada a cada mudança de superfície, de versão do DS ou de sync.

## 5. Sync com o upstream

- Remoto `upstream` = `https://github.com/melgarafael/DeskcommCRM.git`.
- Cadência: **mensal**, sempre para uma **tag de release** (`vX.Y.Z`), nunca para a `main`.
- Fluxo:
  1. Ler no `CHANGELOG.md` as seções "⚠️ Requer atenção" de todas as versões do intervalo.
  2. Criar a branch `sync/vX.Y.Z` a partir da `main` do fork e fazer merge da tag.
  3. Resolver conflitos preservando a camada Ânima; conferir `docs/anima/PATCHES.md`.
  4. Rodar os gates da seção 6, gerar screenshots das telas principais nos dois temas e listar
     novos usos de cor crua (`bg-red-500` etc.) e controles crus (`<button>`, `<input>`,
     `<select>`) que entraram no intervalo.
  5. Abrir PR com: versão de/para, itens "Requer atenção", conflitos resolvidos e vazamentos
     visuais encontrados.
- Se o intervalo trouxer mudança estrutural (Tailwind, Next, React, ou reestruturação do
  `globals.css`), pare e avise o usuário antes de continuar.

## 6. Gates antes de qualquer PR

Os mesmos do upstream (detalhes no `CLAUDE.md`), no mínimo:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:e2e      # mudança visual: obrigatório (gov:verify não cobre UI)
```

Mais a checagem visual: telas principais (Inbox, Kanban, Contatos, Configurações, login) nos temas
escuro e claro, sem texto ilegível e sem azul remanescente como cor primária.

## 8. Estrutura no servidor (padrão Ânima)

Os servidores da Ânima seguem uma convenção única para stacks Docker. O DeskcommCRM usa o nome de
app **`deskcomm`** (= `COMPOSE_PROJECT_NAME`):

| Pasta | Conteúdo |
|---|---|
| `/srv/stacks/deskcomm/` | Pasta principal: `docker-compose.*.yml`, `Makefile`, `.env`, configs (Caddyfile, asterisk) |
| `/srv/storage/deskcomm/` | Arquivos (mídias e uploads que não ficam no Supabase Storage) |
| `/srv/appdata/deskcomm/<serviço>/` | Dados que não são arquivos, um diretório por serviço (`waha`, `redis`, `wacalls`, `asterisk`…) |
| `/srv/backups/deskcomm/` | Backups (banco, volumes e `.env`) |

Regras:

- **Proxy:** o servidor usa **Nginx Proxy Manager** (com SSL) na frente de tudo, na rede Docker
  compartilhada **`anima_proxymanager_shared_network`**. Use o override que o upstream já fornece
  (`docker-compose.npm.yml`) com `PROXY_NETWORK_NAME=anima_proxymanager_shared_network` e um
  `PROXY_NETWORK_APP_IP` fixo; o Caddy do projeto **não** sobe nesse cenário.
- **Volumes:** o `docker-compose.prod.yml` do upstream usa volumes nomeados. Não o edite: crie o
  override `docker-compose.anima.yml` que redireciona cada volume para a pasta correspondente em
  `/srv/appdata/deskcomm/<serviço>/` (volume local com `driver_opts` de bind) e define o mapeamento
  de `/srv/storage` e `/srv/backups`.
- **Nomes de container:** no override, `container_name: '${COMPOSE_PROJECT_NAME}-<serviço>'`
  (ex.: `deskcomm-app`, `deskcomm-worker`, `deskcomm-waha`).
- **Comando de subida padrão:**
  `docker compose -p deskcomm -f docker-compose.prod.yml -f docker-compose.npm.yml -f docker-compose.anima.yml --env-file .env up -d`
  (o Makefile encapsula isso; ninguém deve precisar digitar).
- **E-mail:** SMTP via **Resend** (`RESEND_API_KEY`, `RESEND_FROM_EMAIL` de domínio verificado).
- **Supabase:** documente a escolha (Supabase Cloud ou self-hosted no mesmo servidor). Se for
  self-hosted, os dados do Postgres vão em `/srv/appdata/deskcomm/supabase-db/` e o storage em
  `/srv/storage/deskcomm/`.
- **Recursos:** meça o consumo real do stack (app, worker, WAHA, Redis, scheduler e opcionais) e
  documente o mínimo recomendado em `docs/anima/README.md` antes do primeiro deploy.
- Todo caminho, rede ou nome acima vem de variáveis no `.env` (com padrão em `.env.anima.example`),
  nunca cravado em script.

## 9. Makefile (comandos rápidos)

Crie um `Makefile` na raiz como **interface única** para desenvolvimento, deploy e operação. Todo
procedimento documentado deve ter um alvo; ninguém deve precisar decorar comando de Docker.

Requisitos:

- `make help` é o alvo padrão e lista todos os alvos com uma linha de descrição cada.
- Variáveis lidas do `.env` com padrões sensatos: `APP=deskcomm`, `STACK_DIR=/srv/stacks/$(APP)`,
  `APPDATA_DIR=/srv/appdata/$(APP)`, `STORAGE_DIR=/srv/storage/$(APP)`,
  `BACKUP_DIR=/srv/backups/$(APP)`, `IMAGE` (imagem Ânima), `TAG`.
- Alvos destrutivos (`down-v`, `restore`, `rollback`) pedem confirmação, a menos que `YES=1`.
- `deploy` e `update` fazem **backup antes**, verificam saúde depois e fazem rollback automático
  se o healthcheck falhar.
- Reaproveite os scripts do kit do upstream (`hostgator-setup-kit/backup.sh`, `restore.sh`,
  `healthcheck.sh`, `marca-emails.sh`) onde servirem; **nunca** chame o `update.sh` do upstream
  sem garantir que o `APP_IMAGE` continua apontando para a imagem Ânima.
- Não crie alvos que dupliquem `pnpm` scripts já existentes: chame-os (`pnpm typecheck`, etc.).

Alvos mínimos:

| Alvo | O que faz |
|---|---|
| `help` | Lista os alvos |
| `setup` | Cria as pastas de `/srv/...`, confere a rede `anima_proxymanager_shared_network`, copia `.env.anima.example` → `.env` se não existir |
| `install` | Instala dependências locais (`pnpm install`, com o `.npmrc` do DS) |
| `dev` | Sobe o ambiente local de desenvolvimento |
| `check` | Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` |
| `e2e` | `pnpm test:e2e` |
| `build` | Gera a imagem Docker Ânima (com o pacote privado via secret) com a tag `TAG` |
| `push` | Publica a imagem no registro |
| `up` / `down` / `restart` | Sobe, para e reinicia o stack com os três compose files |
| `ps` / `logs` | Estado dos containers e logs (`SERVICE=` opcional) |
| `deploy` | Backup → pull da imagem `TAG` → `up -d` → healthcheck → rollback se falhar |
| `update` | Mesmo fluxo do `deploy` para uma nova versão do fork, registrando a versão anterior |
| `rollback` | Volta para a imagem anterior registrada |
| `backup` / `restore` | Backup e restauração em `/srv/backups/deskcomm/` |
| `health` | Healthcheck do app e dos serviços |
| `brand-emails` | Reaplica a marca nos e-mails de acesso (`marca-emails.sh`) |
| `sync-upstream` | `TAG=vX.Y.Z`: busca o upstream, cria `sync/vX.Y.Z` e faz o merge da tag (seção 5) |
| `ds-update` | Atualiza `@anima-solutions/design-system` para a última versão e roda `check` |
| `shell` | Abre um shell no container (`SERVICE=app` por padrão) |

## 10. Regras de trabalho

- Pergunte antes de: alterar arquivo fora da seção 3, atualizar a versão major do DS, mudar algo
  que afete instalações existentes (imagem, `.env`, scripts do kit) ou fazer o merge final de um
  sync.
- Commits pequenos e descritivos, em português, no padrão do upstream.
- Nunca commite segredos (`NPM_TOKEN`, `.env`, chaves do Supabase).
- Ao concluir uma tarefa, atualize `docs/anima/README.md` e, se houve divergência do upstream,
  `docs/anima/PATCHES.md`.
