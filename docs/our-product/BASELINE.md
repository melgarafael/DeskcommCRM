# Linha de base de testes

Retrato desta máquina, antes de qualquer feature nossa. Serve para separar falha herdada ou de ambiente de regressão que a gente introduzir depois.

Medido em 2026-10-02, no commit `efed1d5745f87dfeaf3adbe8bc6165bc684a7a75` (`Merge pull request #2071`, 2026-10-01). Esse commit é o `main` do upstream no momento do fork. `origin/develop` foi publicada a partir dele, ainda sem mudança de produto.

## Ambiente em que a bateria rodou

| Item | Valor |
|---|---|
| Sistema | Windows 10, host. Não é a VM Ubuntu da apostila. |
| Node | v24.14.0. O `.nvmrc` pede 22. `engines` aceita `>=22`. O CI do upstream usa Node 22. |
| pnpm | 9.15.9, via `corepack pnpm`, porque o shim global não pôde ser instalado |
| Bash | Git Bash 5.2.37 (MSYS). WSL não está utilizável nesta máquina. |
| Docker | Desktop 29.6.2, engine Linux. Na primeira passagem o daemon estava parado. Na segunda, em 2026-10-02 de manhã, estava no ar. |
| App / health | Não subiu. Sem túnel e sem `GET /api/v1/health`. |

Nada disto é o verde do CI. A VM Ubuntu com Node 22 continua sendo o lugar para repetir `test:db`, `test:shell` e o health antes de tratar número daqui como defeito do upstream.

## Comandos

| Comando | Código | Tempo | Leitura |
|---|---|---|---|
| `pnpm typecheck` | 0 | 131 s | passou |
| `pnpm lint` | 0 | 136 s | passou |
| `pnpm lint:channels` | 0 | 2 s | passou |
| `pnpm test:unit` | 1 | 600 s | 62 falhas, 17436 passaram, 1 falha esperada, 16 pulados, 1695 arquivos |
| `pnpm test:shell` | 1 | 114 s | Git Bash caiu com `cygheap read copy failed`. Não é veredito do kit. |
| `pnpm test:db` | 0 na repetição | 2125 s | ver a seção abaixo. A primeira tentativa, com o daemon parado, saiu 1 em 3 s. |
| `pnpm build` | 0 | 325 s | concluiu. O log tem `TypeError: fetch failed` em chamada externa, sem derrubar o build. |
| `pnpm test:e2e` | não executado | — | falta Docker, app e `.env.e2e` |

`pnpm install --frozen-lockfile` concluiu em 2 min 24 s, com 924 pacotes.

## Falhas de `test:unit` neste Windows

25 arquivos falharam. Vários batem com suposição POSIX desta máquina (barra invertida no caminho, Git sem o layout do runner, arquivo temporário que o teste espera em outro lugar). Os docs desta pasta ainda não estavam no commit medido como produto; a árvore de código do upstream não foi editada. Não marcar estas falhas como bug do upstream até repetir em Node 22 no Linux.

Arquivos:

- `lib/theme.test.tsx`
- `tests/unit/confianca-do-handoff-nao-e-similaridade.test.ts`
- `tests/unit/e2e-parte-4-fala-com-os-servicos-do-runner.test.ts`
- `tests/unit/e2e-supabase-start-tenta-de-novo.test.ts`
- `tests/unit/executor-proprio-so-roda-o-que-e-nosso.test.ts`
- `tests/unit/faixa-de-conexao-caida-vem-do-seam.test.tsx`
- `tests/unit/followups-de-demonstracao-sao-possiveis.test.ts`
- `tests/unit/guarda-da-release-confere-identidade.test.ts`
- `tests/unit/guarda-da-release-reconhece-o-corte.test.ts`
- `tests/unit/hidratacao-useState-nao-le-o-navegador.test.ts`
- `tests/unit/hooks-nao-acusam-o-merge-da-main.test.ts`
- `tests/unit/imagens-ok-so-aceita-pulo-declarado.test.ts`
- `tests/unit/knobs-da-versao-publicada-sao-aplicados.test.ts`
- `tests/unit/layout-app-suspensao-antes-do-onboarding.test.tsx`
- `tests/unit/lgpd-pdf-campos-personalizados.test.ts`
- `tests/unit/lgpd-pdf-meet.test.ts`
- `tests/unit/lgpd-pdf-propostas.test.ts`
- `tests/unit/lgpd-pdf-replies.test.ts`
- `tests/unit/namespace-das-imagens.test.ts`
- `tests/unit/painel-nao-promete-o-que-nao-cumpre.test.ts`
- `tests/unit/performed-at-um-relogio-so.test.ts`
- `tests/unit/populacao-do-proximo-nnnn.test.ts`
- `tests/unit/rascunho-superado-nao-e-regravado.test.ts`
- `tests/unit/release-chega-na-lp.test.ts`
- `tests/unit/telas-sem-dado-de-mentira.test.ts`

Sinais vistos no log, todos de ambiente:

- caminho `lib\followup\...` onde o teste espera `lib/followup/...`
- `cygheap read copy failed` no Git Bash
- `No such file or directory` em caminho `/caminho/que/nao/existe/...` e em log temporário do Supabase
- Docker: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`

## Repetição do `test:db` com o Docker no ar

2026-10-02, mesmo commit de código do upstream (`efed1d574`), docs desta pasta já commitados em `4ee0342a8`. Imagem `pgvector/pgvector:pg15`.

A descoberta automática da última release falhou neste shell (`FATAL: não consegui saber qual é a última release publicada`). A release publicada no upstream nesse dia era `v1.69.0`. A segunda passagem usou `CONFERENCIA_KIT_RELEASE=v1.69.0`, que é o botão previsto em `scripts/conferir-isolamento-do-kit.sh`.

Resultado:

- baseline em modo install: ok
- baseline em modo update, de novo com `ON_ERROR_STOP=1`: ok
- invariantes: 344 arquivos passaram, 2795 testes passaram, 1 falha esperada, 1 pulado
- código de saída: 0
- duração: 2125 s, dos quais 2083 s foram o Vitest

O container `deskcomm-test-db-*` foi removido no teardown.

## O que esta linha de base não prova

Não prova health da aplicação, instalação self-host nem E2E. O `test:db` desta segunda passagem cobre o baseline e os invariantes, inclusive o isolamento que essa suíte já mede. `gov:verify` do upstream continua sem cobrir `test:db` nem `test:e2e`.
