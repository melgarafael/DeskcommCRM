# Doutrina de Packaging e Distribuição

> Lei de arquitetura para tudo que roda no disco de quem instalou o SonghaiCRM: imagens,
> composes, tags e o kit de instalação. Complementa [`sistema-vivo.md`](./sistema-vivo.md) —
> não é aspiração, é critério de aceite. Amarrada ao item 15 do Definition of Done
> (`CLAUDE.md`).

Esta é a **lei**. O procedimento operacional de deploy vive em
[`../runbooks/deploy.md`](../runbooks/deploy.md); as decisões estruturais e o que foi
recusado, em [`../adr/0001-packaging-e-distribuicao.md`](../adr/0001-packaging-e-distribuicao.md).
Ao mudar um invariante aqui, atualize os dois na mesma sessão.

| Se você quer… | Vá para |
|---|---|
| saber se sua mudança precisa virar imagem publicada | §Os 7 invariantes, nº 1 |
| escolher a tag que uma instalação de cliente consome | §Política de canais |
| lançar uma versão | §Checklist de release |
| entender por que o namespace é `melgarafael` e não uma org | o ADR |

---

## O princípio-raiz

**O artefato que a pessoa instala é o produto. O repositório é a receita.**

A distinção não é filosófica — ela decide onde o custo cai. Toda peça do sistema ou é
**construída uma vez, por nós, no CI**, ou é **construída toda vez, por cada cliente, na VPS
dele**. A segunda opção transfere para o comprador um custo que é nosso: tempo de instalação,
RAM, risco de OOM no meio do primeiro contato com o produto — e, pior que tudo, a
possibilidade de que duas instalações "da mesma versão" estejam rodando código diferente.

Disso decorre a pergunta que classifica qualquer peça nova:

> *"Quando isto muda, quem paga o build?"*

Se a resposta for "o cliente", a peça está errada e vira imagem publicada.

### As duas famílias de artefato

| | **Nosso** | **Upstream** |
|---|---|---|
| Exemplos | `deskcommcrm`, `deskcomm-worker` | WAHA, Redis, Caddy, `serverless-redis-http`, `postgres` |
| Quem constrói | nosso CI, uma vez por versão | terceiro, fora do nosso controle |
| O que fazemos | publicamos com procedência e versão | **referenciamos com tag pinada** (ver ressalva) |
| O que **nunca** fazemos | publicar da máquina de um dev | republicar, embalar ou copiar |
| Se quebrar | é bug nosso, com forward-fix | é incidente de fornecedor, com pin de escape |

**Ressalva medida:** `redis:7-alpine` e `caddy:2-alpine` flutuam dentro do major — as duas
se moveram no Docker Hub em 2026. São dependências de infraestrutura sem estado de negócio, e
o custo de bumpá-las a cada release não se paga hoje; o item 4 do checklist manda revisitá-las.
`waha` e `srh` — que tocam WhatsApp e rate limit — estão pinadas de verdade (tag exata e
digest). O gate reprova tag ausente ou `:latest`, não o major flutuante.

**Nenhuma peça upstream vira imagem nossa.** Não por preguiça: WAHA Plus é licenciado, e
redistribuir o binário de terceiro dentro de uma imagem nossa é passivo jurídico numa
dependência crítica. Referência, nunca cópia — e a regra vale para todas, não só a licenciada,
porque a exceção é o que apaga a regra.

---

## Os 7 invariantes (verificáveis)

### 1. Nenhum serviço de produção constrói na máquina do cliente

Todo serviço de `docker-compose.prod.yml` declara `image:` apontando para uma imagem
publicada. `build:` pode existir **ao lado** — como caminho de escape para quem quer compilar
—, nunca sozinho.

```yaml
# ERRADO — o cliente paga o build, e o update nunca o alcança
worker:
  build: { context: ., dockerfile: Dockerfile.worker }

# CERTO — imagem publicada; o build fica ao lado, como escape
worker:
  image: ${WORKER_IMAGE:-ghcr.io/melgarafael/deskcomm-worker:stable}
  build: { context: ., dockerfile: Dockerfile.worker }
```

- **Por quê:** um serviço `build:`-only é invisível para `docker compose pull` ("Skipped — No
  image to be pulled") e imune a `up -d` sem `--build`. Ele não é apenas caro de instalar: ele
  **nunca é atualizado**. Congela no código do dia da instalação e atravessa todas as
  atualizações seguintes sem que ninguém perceba.
- **Anti-exemplo real (o defeito que originou esta doutrina):** o serviço `worker` — que é o
  runtime do agente de IA, e o único consumidor de `ai_agent.dispatch_requested`, já que
  `app/api/v1/cron/agent-dispatcher` é no-op permanente — não tinha `image:`. Toda instalação
  rodava `pnpm install --frozen-lockfile` de 82 pacotes na VPS do cliente, e nenhum
  `update.sh` jamais o reconstruiu. A feature-título do produto era a única peça que não
  recebia correção. Enquanto isso, `CLAUDE.md` afirmava *"o caminho normal não constrói nada
  na VPS"* — verdade para o app, falso para o produto.
- **Verificação:** `tests/unit/packaging-artefato-do-cliente.test.ts` reprova serviço de
  `docker-compose.prod.yml` com `build:` e sem `image:`.

### 2. Publicação é ato do CI, e carrega procedência

Imagem nossa só existe se saiu de `.github/workflows/publish-image.yml`. Ela carrega os labels
OCI — no mínimo `source`, `revision`, `version`, `licenses` — e é construída para `linux/amd64`.

- **Por quê:** duas razões distintas. **(a) Arquitetura:** um `docker build` num Mac ARM produz
  imagem que não roda na VPS amd64 do cliente, e a falha aparece só no `up -d` dele. **(b)
  Rastreabilidade:** sem `org.opencontainers.image.revision` não existe resposta para "que
  código está rodando neste cliente?", e o suporte vira adivinhação.
- **Verificação:** o job **`imagens-ok`** de `publish-image.yml` reprova quando qualquer uma
  das três imagens não constrói. Ele existe porque a matriz gera um nome de check por imagem,
  e exigir os três pelo nome faria uma quarta imagem, um dia, escapar do gate em silêncio.

  > **Ativado.** `imagens-ok` **é** required check da `main`. Medido em 2026-08-14:
  >
  > ```console
  > $ gh api repos/melgarafael/DeskcommCRM/branches/main/protection \
  >     --jq '.required_status_checks.contexts|join(", ")'
  > verify, build-and-size, invariants, e2e, imagens-ok
  > ```
  >
  > Este parágrafo já disse as duas coisas erradas, em ordem: primeiro afirmou no presente
  > que o check era obrigatório quando não era, depois — corrigido — afirmou que "ainda não
  > está" e **continuou afirmando isso depois da ativação**, que aconteceu no mesmo dia. O
  > segundo erro é o mais instrutivo: o texto foi escrito *sabendo* que a ativação era o
  > passo seguinte, e ninguém volta para trocar um "ainda não" por um "já". **Nota de
  > pendência é dívida com data de vencimento e sem cobrador.** Quem ler qualquer uma das
  > duas versões mede contra a régua errada — reconfira na fonte, com o comando acima.
  >
  > O roteiro da ativação, com as verificações de cada passo, está em
  > [`../runbooks/ativar-packaging.md`](../runbooks/ativar-packaging.md).

  O gate importa porque já falhou: em 2026-08-12 um bump de `next` passou pelos quatro
  obrigatórios e quebrou o build da imagem na `main`, porque o `next build` dentro do
  Dockerfile não enxerga `tests/` (`.dockerignore`) e o next 16.3 passou a typechecar os
  `*.test.ts` colocados. **O artefato que o self-hoster instala era o único sem gate.**

### 3. Instalação de cliente nunca aponta para tag móvel

`install.sh` e `update.sh` gravam no `.env` do cliente uma **tag de versão** (`1.2.1`), nunca
`latest`, `main` ou `stable`.

Duas exceções, ambas deliberadas e ambas com aviso na tela — porque falhar fechado aqui
seria recusar instalar por não conseguir resolver um número:

1. **Sem rede ou sem tag no remoto**, cai em `latest` e avisa. Trocar previsibilidade por
   disponibilidade é o negócio errado numa instalação que já começou.
2. **Quem preenche o `.env` à mão** a partir do template recebe `stable` — o piso seguro
   para quem não vai rodar a entrevista. `--yes` com o template preserva esse valor.

O que **nenhum** caminho faz é pinar numa versão sem antes conferir que as três imagens
existem lá: a tag do git nasce minutos antes das imagens, e `deskcomm-worker:1.2.1` nunca
vai existir porque a v1.2.1 é anterior à criação desse pacote.

- **Por quê:** três consequências de uma só causa. **(a)** A versão do cliente para de mudar
  por acidente — um `up -d` rodado à mão semanas depois não troca o app sob o banco. **(b)**
  Atualizar vira **ato deliberado e reversível**: voltar é reescrever uma linha do `.env`.
  **(c)** O suporte passa a ter resposta exata para "qual versão você está rodando?" — hoje,
  duas instalações "no latest" feitas em meses diferentes rodam código diferente, e a issue
  #184 chegou descrevendo o ambiente como *"latest do dia 06/08/2026"*, que é a admissão de
  que a versão não era nomeável.
- **A armadilha específica deste projeto:** `latest` aqui **não** significa "última release" —
  significa **topo da `main`**. Uma instalação fresca em `:latest` recebe código não-lançado.
  Isso inverte a expectativa que o nome cria, e é a razão de o canal `stable` existir
  (§Política de canais).

  A regra `enable={{is_default_branch}}` do `metadata-action`, sozinha, **não** entrega isso:
  ela é verdadeira também num push de tag, então toda release movia `latest` junto e o canal
  oscilava entre os dois significados. O workflow prende `latest` a `ref_type == 'branch'`.
- **Verificação:** duas, porque são dois caminhos distintos e o primeiro passou verde por
  meses sem nenhum. `self-host-kit/test-validators.sh` roda o `install.sh` de verdade
  contra um remoto local com tags conhecidas e cobra o `.env` pinado na maior delas (a ordem
  alfabética escolheria `v1.9.0` sobre `v1.10.0` — erro que só apareceria na décima release).
  `tests/shell/update-guard.test.sh` prova que o `update.sh` grava as **três** imagens na
  mesma versão, no `.env`, sem duplicar chave.

### 4. Tag de versão é imutável; canal é móvel

`vX.Y.Z` (e a imagem `X.Y.Z`) aponta para um digest **para sempre**. Republicar uma versão é
proibido — corrige-se com `X.Y.Z+1`. Só `latest`, `main`, `stable` e `X.Y` se movem.

- **Por quê:** a imutabilidade da tag é o que torna a pinagem do invariante 3 uma garantia em
  vez de uma esperança. Se `1.2.1` puder ser reescrita, todo cliente "pinado" continua exposto
  — só que agora com uma falsa sensação de controle, que é pior que nenhum controle.
- **Verificação:** o workflow publica `type=semver` apenas a partir de tag `v*`, e tag git não
  se reaponta. A dívida conhecida: o GHCR não impõe imutabilidade por configuração — a
  garantia é de processo, e por isso o checklist de release proíbe reuso de número.

### 5. `pull_policy` acompanha a mutabilidade da tag

Tag imutável → `missing`. Tag móvel → `always`.

- **Por quê:** medido, não deduzido. Com `pull_policy: always` e o registry indisponível
  **para aquela referência**, o `docker compose up -d` **falha e o contêiner não sobe** —
  mesmo com a imagem já presente no disco:

  ```console
  $ docker compose up -d      # pull_policy: always, imagem só local
   t Error failed to resolve reference "…:1.0.0": not found
  --> container rodando?           (vazio)

  $ docker compose up -d      # pull_policy: missing, mesma imagem
   Container polmissing-t-1  Started
  --> container rodando? running
  ```

  Com tag móvel, `always` é o que faz o canal significar alguma coisa. Com tag imutável, ele
  não protege de nada — só amarra a disponibilidade do CRM de um cliente pago à
  disponibilidade do GHCR, em todo `up -d`. O `update.sh` não depende disso: ele puxa
  explicitamente com `dc pull` antes de subir.
- **Verificação:** `tests/shell/update-guard.test.sh` prova que instalação pinada grava
  `APP_PULL_POLICY=missing`.

### 6. Bump de versão não exige edição manual de `.env`

Uma versão nova sobe sobre o `.env` que o cliente já tem. Variável nova nasce **opcional, com
default que preserva o comportamento anterior**; se ela precisa existir, quem a acrescenta é o
`update.sh`, não o usuário.

- **Por quê:** o operador da VPS é leigo por premissa do produto. "Edite o `.env` antes de
  atualizar" é uma instrução que metade do parque não executa e a outra metade executa errado
  — e o modo de falha é o app não subir depois de uma atualização que já mexeu no banco.
- **Anti-exemplo estrutural:** o compose de produção tem 7 variáveis sem fallback
  (`WAHA_API_KEY_SHA512`, `WAHA_WEBHOOK_BASE_URL`, `WAHA_HMAC_SECRET`, `SRH_TOKEN`,
  `INTERNAL_SECRET`, `DOMAIN`, `ACME_EMAIL`). Medido: o Compose **não** falha quando elas
  faltam — substitui por string vazia, avisa em `stderr` e sobe. `DOMAIN: ""` e
  `WAHA_API_KEY: "sha512:"` quebram em runtime, depois do `up -d`, silenciosamente. Falhar
  tarde e mudo é pior que falhar cedo.
- **Verificação:** toda variável nova entra em `.env.example` **e** em `lib/env.ts` com
  default seguro (já cobrado no DoD); mudança que exija chave nova no `.env` de instalação
  existente só entra com o `update.sh` sabendo acrescentá-la.

### 7. A versão que roda é observável de fora

`GET /api/v1/health` responde a versão real da imagem em execução.

> **Vale a partir da próxima release.** Nenhuma imagem já publicada carrega
> `APP_VERSION` — medido: `docker run --rm ghcr.io/melgarafael/deskcommcrm:1.2.1 node -e
> 'console.log(process.env.APP_VERSION)'` → `undefined`. Todo o parque instalado hoje
> responde `desconhecido`, que é a resposta honesta e o motivo de o fallback não ser mais
> um número plausível. O item 9 do checklist de release reprova contra a 1.2.1 de propósito.

- **Por quê:** é o fecho do laço dos invariantes 2 e 3. Procedência sem observabilidade só
  serve a quem tem acesso ao registry; o suporte precisa da resposta a partir da instalação.
- **Anti-exemplo real:** o campo já existia e **mentia**. `app/api/v1/health/route.ts` lia
  `process.env.npm_package_version ?? "0.1.0"`, e sob `CMD ["node","server.js"]` essa variável
  é `undefined` — ela só existe quando o processo nasce de um `npm`/`pnpm run`. Toda
  instalação do mundo reportava `0.1.0`. Um campo que responde com confiança o valor errado é
  pior que um campo ausente: ele desliga a pergunta.
- **Verificação:** `tests/unit/packaging-artefato-do-cliente.test.ts` prova que a versão vem
  de `APP_VERSION` (injetada no build via `ARG`) e reprova o retorno ao `npm_package_version`.
  Medido no app real: com `APP_VERSION=9.9.9-teste` o endpoint responde `9.9.9-teste`; sem ela,
  `desconhecido` — nunca um número plausível.

---

## Política de canais

| Tag | Quem consome | Move? | `pull_policy` | O que significa |
|---|---|---|---|---|
| `1.2.1` | **toda instalação de cliente** | **não** | `missing` | uma release, para sempre |
| `1.2` | ninguém instala | sim | — | conveniência de teste de patch |
| `stable` | implementador validando antes de atualizar clientes | sim | `always` | a **última release** publicada |
| `latest` | vitrine, avaliação, quem acompanha o projeto | sim | `always` | **topo da `main`** — código não lançado |
| `main` | mantenedor e CI | sim | `always` | idêntico a `latest`, nome explícito |

**A regra de ouro:** *instalação que alguém pagou aponta para número de versão. Ponto.*

Ela existe porque o modelo de receita é a venda da VPS com o sistema instalado — quem instala
para um cliente responde pelo que roda lá. Um canal móvel transfere a decisão de "quando
atualizar" para o acaso: um reboot, um `up -d` de manutenção, uma queda de energia. Nenhum
desses eventos é um momento em que alguém escolheu correr o risco de uma versão nova, e
nenhum deles avisa quando dá errado. Quem descobre é o cliente, por telefone.

**`latest` não é o canal estável, apesar do nome.** Essa é a pegadinha desta configuração: ele
segue a `main`. `stable` existe para dar nome ao que as pessoas *acham* que `latest` é. E
`latest` **não muda de significado** — mudá-lo faria clientes que hoje o consomem sofrerem um
downgrade silencioso no próximo `up -d`, com app antigo sobre banco já migrado.

---

## Retrocompatibilidade — o contrato com quem já instalou

Um bump de versão **pode** exigir do operador da VPS:

- rodar `update.sh` (ou clicar "Atualizar agora" na tela);
- que a VPS alcance o GHCR e o Supabase durante a atualização.

Um bump de versão **não pode** exigir:

- editar `.env`, compose ou qualquer arquivo à mão;
- reinstalar, recriar volume, ou recomeçar do zero;
- que o operador saiba o que é uma imagem, uma tag ou um registry;
- migração de namespace de imagem — o namespace está gravado no `.env` de todo cliente
  instalado; trocá-lo é breaking change e só cabe numa major, com o `update.sh` migrando
  sozinho e o namespace antigo publicando em paralelo durante a transição.

**Mudança que não couber nessas regras não entra: vira issue com plano de migração.**

---

## Checklist de release

Verificável, na ordem. Nenhum item é "conferir se está tudo bem".

A sonda do registry vem primeiro porque os itens 3 e 6 dependem dela — e porque `curl` cru no
GHCR responde **401**, que não contém a versão procurada e por isso seria lido como aprovação
pelo item 3. Um gate que aprova por erro de autenticação é pior que gate nenhum:

```bash
# Cole no shell antes de começar. Funciona anonimamente (o pacote é público).
ghcr_status() {   # $1=imagem  $2=tag  → 200 existe | 404 não existe | 403 pacote privado
  local t
  t=$(curl -s "https://ghcr.io/token?scope=repository:melgarafael/$1:pull&service=ghcr.io" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    "https://ghcr.io/v2/melgarafael/$1/manifests/$2"
}
```

**403 não é "não existe": é pacote PRIVADO.** Todo pacote recém-criado no GHCR nasce privado,
e repositório público não muda isso. Enquanto não for tornado público na mão (Package settings
→ visibility), o `docker compose pull` de **toda VPS** é negado — e, como o `pull` de um
serviço com `image:` falha a operação inteira, a atualização morre depois do `git checkout` e
do banco. É o passo que mais trava na estreia de uma imagem nova.

```
[ ] 1. CHANGELOG.md tem a seção da versão, com o que muda para quem já instalou
[ ] 2. Nenhuma variável nova é obrigatória sem default (grep no diff de .env.example)
[ ] 3. O número da versão NUNCA foi publicado antes:
       git tag --list 'vX.Y.Z'                     → vazio
       ghcr_status deskcommcrm X.Y.Z               → 404
[ ] 4. Os pins upstream foram revisitados: `waha`, `srh`, `redis`, `caddy`, `postgres`.
       Bumpar ou confirmar que ficam — congelar sem revisar é como o `srh` ficou
       três versões atrás sem ninguém decidir isso
[ ] 5. `git tag vX.Y.Z && git push origin vX.Y.Z` — a partir de um commit da `main`
[ ] 6. O run de publicação ficou verde:
       gh run list --workflow=publish-image.yml --limit 3
[ ] 7. As TRÊS imagens existem E são públicas nesta versão:
       for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
         echo "$i: $(ghcr_status $i X.Y.Z)"; done      → 200 nas três
       403 em alguma? Torne o pacote público ANTES de seguir
[ ] 8. A imagem reporta a versão certa:
       docker run --rm ghcr.io/melgarafael/deskcommcrm:X.Y.Z \
         node -e 'console.log(process.env.APP_VERSION)'   → X.Y.Z
[ ] 9. `gh release create vX.Y.Z` com as notas do CHANGELOG
[ ] 10. SÓ AGORA: `stable` e X.Y.Z são o MESMO digest, nas três imagens:
        for i in deskcommcrm deskcomm-worker deskcomm-scheduler; do
          for t in X.Y.Z stable; do
            echo -n "$i:$t "; docker buildx imagetools inspect \
              ghcr.io/melgarafael/$i:$t --format '{{.Manifest.Digest}}'; done; done
        → o par de cada imagem tem que bater
        Não bateu? Alguma coisa republicou depois do push da tag. NÃO siga:
        um canal apontando para build diferente da versão é o invariante 3
        quebrado dentro de casa.
[ ] 11. Apagar tags de branch dos três pacotes — `docs-doutrina-packaging` e
        qualquer outra que tenha nascido de um `workflow_dispatch` de ensaio.
        Tag de branch é artefato de trabalho: se ficar, vira canal órfão que
        alguém pina por engano achando que é release, e ela nunca mais se move.
        O registry já carrega uma dessas (`quebrada-teste`) como lembrete.

> **Por que a checagem de `stable` é o item 10 e não o 8.** Ela já foi o 8, antes do
> `gh release create` — e nessa ordem ela não provava nada. Medido na v1.3.0: o
> `release: published` estava ligado no workflow, `gh release create` disparou um
> segundo build do mesmo commit, e esse build **moveu `1.3.0` e `1.3`** sem mover
> `stable`. A conferência do item 8 tinha passado, verde e honesta, cinco minutos
> antes do ato que a invalidou. **Verificação que roda antes do passo que pode
> quebrá-la é verificação de nada.** O gatilho foi removido (guarda em
> `tests/unit/packaging-artefato-do-cliente.test.ts`), e a conferência foi para
> depois — cinto e suspensório, porque o próximo jeito de republicar uma tag ainda
> não foi inventado.

        EXIGE ESCOPO QUE O TOKEN PADRÃO DO `gh` NÃO TEM. Medido no corte da
        1.3.0: com `gist, read:org, repo, workflow` a API devolve 403 tanto para
        listar quanto para apagar versão de pacote. Antes de chegar aqui:
            gh auth refresh -h github.com -s read:packages,delete:packages
        Sem isso o item fica pendente e a tag de ensaio segue viva — foi o que
        aconteceu na 1.3.0. (Resolvido em 2026-08-14: as três versions foram
        apagadas e a tag responde 404 nos três pacotes. Apague a **version**, e
        só depois de conferir que ela não carrega OUTRA tag junto — no GHCR se
        apaga version, não tag, e uma version com `1.3.0` ao lado levaria a
        release embora.)
[ ] 12. Ensaio de atualização numa instalação real (não fresca): update.sh a partir da
        versão anterior, e o /api/v1/health responde X.Y.Z
```

O item 12 é o único que exige VPS. Ele não é opcional: a atualização é o caminho que **todo o
parque instalado** percorre, e é o único que a suíte de CI não exercita.

---

## Enforcement

| Camada | Artefato | Garante |
|---|---|---|
| CI (mecânico) | `imagens-ok` em `publish-image.yml` | imagem quebrada **reprova o merge** — é required check da `main`. Meça antes de confiar: `gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts'` |
| CI (mecânico) | `tests/unit/packaging-artefato-do-cliente.test.ts` | serviço `build:`-only, pin upstream solto, `pull_policy` trocado e versão que mente reprovam |
| CI (mecânico) | `tests/shell/update-guard.test.sh` | atualização que não pina as três imagens reprova |
| CI (mecânico) | `self-host-kit/test-validators.sh` | instalação que nasce em tag móvel reprova |
| Gate de sessão | item 15 do Definition of Done (`CLAUDE.md`) | nenhuma task de imagem/compose/kit fecha sem responder |
| Revisão | bloco de packaging em `CONTRIBUTING.md` | contribuidor externo sabe a régua antes do PR |
| Operação | `docs/runbooks/deploy.md` | o procedimento reflete a lei |

---

## Decisões registradas

**2026-08-13 — o namespace fica em `melgarafael`.** Uma consultoria externa recomendou criar
uma org `deskcommcrm` e migrar, sob a premissa de que o compose apontava para uma org
desvinculada do repo. A premissa era falsa: o compose sempre apontou para
`ghcr.io/melgarafael/deskcommcrm`, que é o que o CI publica e o que está gravado no `.env` de
todo cliente instalado. A string `deskcommcrm/deskcommcrm` existia num único lugar — uma URL
de `git clone` em `docs/deploy-selfhost/README.md`, que retornava 404. O conserto proporcional
ao defeito foi essa linha. Racional completo no ADR.

**2026-08-13 — a régua de RAM é de operação, não de build.** A mesma consultoria argumentou
que publicar a imagem derrubaria o requisito de 4 GB para 2 GB. Os 4 GB nunca foram custo de
build do app: a imagem é pré-buildada desde 2026-07-02. Eles saem de **operação** — 7
contêineres, `mem_limit` somando 2560m só entre app+worker+waha, e ~150 MB por número de
WhatsApp conectado.

> **Correção de 2026-08-14, e ela é sobre a nossa própria régua:** das três parcelas acima,
> duas são medidas (contêineres e `mem_limit`) e a terceira — os ~150 MB por número — é
> **herdada** de `docs/research/reference-synthesis.md` (síntese do curso WAHA), nunca medida
> neste projeto. Ela aparece em sete documentos que se citam entre si, o que a fazia parecer
> confirmada por repetição. O que **está** medido, na produção do projeto: o contêiner `waha`
> inteiro em **304,5 MiB com uma sessão pareada**, contra `mem_limit` de 1280 MiB. Isso não
> decompõe baseline e sessão, e não muda nada abaixo — a régua dos 4 GB é a soma da stack em
> operação, não o WAHA isolado. Detalhe em `docs/runbooks/deploy.md`.

Publicar o worker remove um `pnpm install` da VPS; **não muda o consumo de
quem opera**, e portanto não muda o tier recomendado. O ganho a comunicar é confiabilidade e
capacidade — a instalação deixa de poder falhar por memória no meio, e o agente de IA passa a
receber atualização —, nunca economia de plano.

**2026-08-13 — o limiar codificado continua em 3.500.000 KB.** `install.sh` avisa (amarelo,
não fatal) abaixo desse valor, e não em 4.000.000, porque `MemTotal` é o que sobra depois do
que o kernel reserva: uma VPS de 4 GiB reporta ~4.012.000 KB e uma de "4 GB" decimais reporta
~3.735.000 KB. Cortar em 4.000.000 acusaria justamente quem acabou de comprar o plano
recomendado, na pior hora possível. Coberto por `self-host-kit/test-validators.sh`.
