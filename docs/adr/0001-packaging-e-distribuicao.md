# ADR-0001 — Packaging e distribuição do SonghaiCRM

- **Status:** aceito
- **Data:** 2026-08-13
- **Contexto medido em:** `f9abedd0` (`main`)
- **Lei decorrente:** [`docs/doctrine/packaging.md`](../doctrine/packaging.md)

> **Nota de numeração.** Este é o primeiro ADR como arquivo próprio no repo. Já existe uma
> sequência `ADR-01`…`ADR-12` **dentro** de `docs/specs/09-spec-frontend-backend-integration.md`,
> restrita a decisões de frontend e citada por número em outras specs. Os arquivos de
> `docs/adr/` usam **quatro dígitos** (`ADR-0001`) justamente para não colidir com aquela
> numeração. Se um dia as duas sequências se unificarem, esta é a que se renumera.

---

## Contexto

O SonghaiCRM é distribuído como self-host: a monetização é a venda da VPS com o sistema
instalado, e a experiência de quem instala **é** o produto. Isso torna o artefato distribuído —
imagem, compose, kit — parte do contrato, não detalhe de infraestrutura.

Uma consultoria externa de packaging diagnosticou que "a arquitetura de packaging ainda não
existe". A investigação do repositório mostrou o contrário: ela existe desde 2026-07-02, com
258 execuções do workflow de publicação e 4 releases. O que faltava não era o pipeline — era a
**regra** que decide o que entra nele, e um gate que a exerça.

O diagnóstico externo também continha erros materiais, listados em §Erros corrigidos, e não
enxergou o defeito mais caro, que era o motivo real para escrever esta doutrina.

## Decisões

### D1 — O namespace é `ghcr.io/melgarafael/*`. Não migramos para uma org.

**Escolhido porque** é o namespace que o CI já publica (`IMAGE_NAME: ${{ github.repository }}`),
que o compose já consome, e — decisivo — que está **gravado no `.env` de cada cliente
instalado**, por `install.sh` e por `update.sh`, como string literal.

Migrar de namespace não é renomear um repositório: é invalidar o `APP_IMAGE` do parque. O
`update.sh` que já está no disco dessas VPS continuaria montando o namespace antigo
(a string do namespace está no script que já está no disco dela), e nenhuma receberia a
mudança que as consertaria — o clássico problema de atualizar o atualizador.

**Custo medido de uma migração futura:** o namespace vive numa constante única
(`IMG_NS` em `self-host-kit/_common.sh`), mais o default de cada serviço em
`docker-compose.prod.yml`, mais `.env.selfhost.example`, os testes que casam a string
(`tests/shell/update-guard.test.sh`, `self-host-kit/test-validators.sh`,
`tests/unit/packaging-artefato-do-cliente.test.ts`) e os docs — **mais** o `.env` de cada
instalação viva, que é a parte que nenhum commit alcança. Régua para reconferir antes de
citar este parágrafo: `grep -rln "ghcr.io/melgarafael" --exclude-dir=node_modules .`

**Reconsideraríamos se:** o projeto ganhar mantenedores com necessidade de publicar sem
credencial pessoal, ou o repositório mudar de dono. Nesse caso a migração é **aditiva**:
publicar nos dois namespaces por pelo menos uma minor, `update.sh` reescrevendo `APP_IMAGE`
sozinho, e o namespace antigo mantido até o parque ter migrado — nunca um corte seco.

### D2 — Os packages e a pergunta que cada um responde

| Package | Pergunta | Status |
|---|---|---|
| `deskcommcrm` | "o que a pessoa instala?" | existe desde 2026-07-02 |
| `deskcomm-worker` | "o que roda 24/7 fora do request?" | **criado aqui** |
| `deskcomm-scheduler` | "o que dispara os crons?" | **criado aqui** |

Os três passam no teste de fronteira: consumidor distinto (contêiner próprio), topologia de
execução própria (long-running, cron, request/response), e custo de build que hoje cai no
cliente. O ciclo de release é **acoplado** — os três sobem juntos, com a mesma tag —, porque
compartilham o mesmo repositório e a mesma migração de banco; versioná-los independentemente
criaria matriz de compatibilidade sem consumidor para ela.

### D3 — `deskcomm-worker` é publicado, não fundido na imagem do app

O worker roda TypeScript direto via `tsx` (`workers/agent-worker/main.ts`), enquanto a imagem
do app é um `.next/standalone` — que não contém `tsx` nem o fonte TS.

**Alternativa descartada:** fundir os dois numa imagem só, com `command:` diferente. Exigiria
compilar o worker (tsup/esbuild) e embutir o bundle no standalone — mudança de código real
num caminho crítico, para economizar uma imagem. **Publicar o que já existe é a menor mudança
que resolve**, e o `Dockerfile.worker` continua exatamente como está.

**Reconsideraríamos se:** o tamanho da imagem do worker virar problema operacional real
(hoje ela carrega devDeps porque `tsx` precisa), ou se aparecer um segundo worker — aí o
bundle compilado passa a se pagar.

### D4 — `stable` é criado; `latest` não muda de significado

`latest` neste projeto aponta para o **topo da `main`**, não para a última release. O nome cria
uma expectativa que a configuração não cumpre, e instalação fresca herdava isso.

A regra `enable={{is_default_branch}}` sozinha nem entregava isso: ela é verdadeira também num
push de tag, então toda release movia `latest` junto e o canal oscilava entre os dois
significados. O workflow passou a prendê-lo a `ref_type == 'branch'`.

**Alternativa descartada:** redefinir `latest` como a última release. Seria mais correto
semanticamente e **quebraria em produção**: quem hoje roda o topo da `main` sofreria um
downgrade silencioso no próximo `up -d`, com app antigo sobre banco já migrado. Preferimos um
nome imperfeito a um downgrade automático.

Então `stable` é criado para nomear a última release, e a instalação de cliente não usa
nenhum dos dois: usa o número da versão (invariante 3).

### D5 — `pull_policy` passa a acompanhar a mutabilidade da tag

Medido: com `always` e o registry sem responder para aquela referência, o `up -d` falha e o
contêiner **não sobe**, mesmo com a imagem no disco. Com `missing`, sobe.

Como a instalação passa a nascer pinada numa tag imutável, `always` deixa de proteger de
qualquer coisa e passa a acoplar a disponibilidade do CRM do cliente à disponibilidade do
GHCR. Instalação pinada grava `missing`; canal móvel continua `always`.

### D6 — O que foi deliberadamente recusado

| Recusado | Por quê | Reconsideraríamos se |
|---|---|---|
| **Republicar WAHA / WAHA Plus** | licenciado; redistribuir binário de terceiro numa imagem nossa é passivo jurídico sobre a dependência mais crítica do produto | nunca, enquanto a licença for essa |
| **Republicar Redis, Caddy, `srh`, `postgres`** | não agregam nada; upstream referenciado com tag fixa é estritamente melhor | se algum deles for abandonado e precisarmos manter um fork |
| **`deskcomm-base`** | o build pesado do Next não se resolve com imagem base — resolve-se com cache do buildx no CI, que já está ligado (`cache-from: type=gha`). O único candidato a compartilhar seria `ffmpeg`, e não paga a indireção | 3+ imagens nossas passarem a compartilhar as mesmas deps de sistema |
| **`deskcomm-migrate` one-shot** | a consultoria o propôs para substituir `supabase db push` na máquina do implementador — fluxo que **não existe** neste projeto. `install.sh` e `update.sh` já aplicam `supabase/baseline.sql` via `postgres:17-alpine` efêmero, dentro da VPS, sem CLI e sem participação humana. Seria um package resolvendo um problema que já está resolvido | o baseline deixar de ser aplicável por psql puro |
| **Migrar de namespace** | ver D1 | ver D1 |
| **Trocar `latest` de significado** | ver D4 | nunca sem uma major e um caminho de migração |

## Consequências

**Ganhamos:** o parque para de rodar código congelado no worker; a versão de cada instalação
vira nomeável e observável; e a atualização vira ato reversível por uma linha do `.env`.

**Ainda não ganhamos:** o gate da imagem só reprova merge depois que `imagens-ok` entrar na
branch protection — o que não pode acontecer antes deste trabalho estar na `main`, sob pena de
travar todos os PRs abertos. Enquanto isso, o job roda em PR e informa, mas não bloqueia.

**Pagamos:** três imagens para publicar em vez de uma (mesmo run do CI, sem custo de
processo); e uma regra a mais no DoD.

**Assumimos:** que a imutabilidade das tags de versão é garantia **de processo**, não de
configuração — o GHCR não a impõe. Se isso virar problema, o conserto é habilitar a proteção
no registry, não mudar a doutrina.

## Erros corrigidos no diagnóstico externo

Registrados porque a consultoria foi feita sem acesso a `.github/workflows/` e ao histórico, e
porque um diagnóstico errado que sobrevive vira premissa de decisões futuras.

| Alegação | O que a medição mostrou |
|---|---|
| "o `Packages` do repo está vazio" | 10 tags publicadas e públicas; `tags/list` anônimo responde, manifest de `latest` = 200. Provável causa do erro: `gh api users/…/packages` devolve **403** sem escopo `read:packages` — instrumento cego lido como ausência |
| "o compose aponta para `ghcr.io/deskcommcrm/deskcommcrm`" | aponta para `ghcr.io/melgarafael/deskcommcrm`. A org `deskcommcrm` não existe (404). A string aparecia num `git clone` de `docs/deploy-selfhost/README.md` — link quebrado, corrigido aqui |
| "não há workflow de publish" | existe desde 2026-07-02; 258 runs, 252 verdes |
| "falta `LABEL` OCI, o package fica órfão" | premissa certa, consequência errada: o `metadata-action` injeta os labels no push, e a imagem publicada traz `image.source` correto. O package está vinculado ao repo |
| "instalação exige 4 GB e 4–34 min de build" | o app não builda: `install.sh` faz `dc pull`. Os 4 GB são de operação. "4–34 min" não existe no repo |
| "`update` usa `supabase db push` com a CLI do implementador" | zero invocações do CLI Supabase no kit; o schema é aplicado por psql efêmero dentro da VPS |
| "`latest` + `always` troca versão num restart" | medido: `docker compose restart` preserva contêiner e image ID. O gatilho real é `up -d` — e o repo já documentava esse modo de falha em `_common.sh:294-299` |

**O que a consultoria não viu, e era o defeito mais caro:** o serviço `worker` não tinha
`image:`, só `build:`. Era construído na VPS de todo cliente e **nunca atualizado** por
nenhum `update.sh` — congelando o runtime do agente de IA no código do dia da instalação.
É o invariante 1 da doutrina.
