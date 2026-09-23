# Trackeamento de campanha, conjunto, anúncio e posicionamento

Data: 2026-09-18
Revisão: 2026-09-18 (referências conferidas contra o código; 9 correções)
Status: CAMINHO DO SITE NO AR — 3 PRs merged e rodando em produção (v1.41.0).
Dois PRs verdes aguardando revisão fecham o caminho do anúncio.

## Placar de entrega

| # | Passo | Estado |
|---|-------|--------|
| 1 | PRs #1211, #1212, #1221 merged | **feito** |
| 2 | VPS atualizada para a versão que os contém | **feito 2026-09-20 — v1.41.0 no ar** |
| 3 | Revisar e mergear **#1387** (leitor + cache, migration 0375) | aguarda mantenedor |
| 4 | Revisar e mergear **#1389** (a ficha resolve ao abrir) | aguarda #1387 |
| 5 | Nova release + `bash hostgator-setup-kit/update.sh` | depois de 3 e 4 |
| 6 | Macros dinâmicas nas URLs dos anúncios na Meta (passo A3) | **pode ser feito JÁ** |
| 7 | Credencial `ads_read` conectada | **já estava** — `/app/settings/meta-ads` conectada |

**O passo 7 não era trabalho novo, e a pergunta de quem opera foi a certa.**
`ad_insights_connections` e a tela `/app/settings/meta-ads` já existiam na
`v1.35.1`, anteriores a este plano: são da migration 0214 (04/09/2026), e é a
conexão que o painel `/app/ads/meta` usa. Não há credencial a criar. O token do
System User pode ser o MESMO das outras conexões desde que tenha `ads_read` — o
que a 0214 separa é a LINHA (escopo de leitura × escopo de escrita no dataset de
conversões), não o usuário da Meta. Confirmado com o dono em 2026-09-20: a tela
está conectada.

**O passo 6 tem DUAS metades, e só a primeira é na Meta.** A macro põe o nome na
URL da landing page; quem leva aquilo para dentro do CRM é o botão de WhatsApp da
própria página, que precisa embutir o código `[dk1:...]` no texto da mensagem
(contrato em `lib/leads/origem-do-site.ts`, instruções na tela
`/app/settings/conversoes`, seção "Quem chegou pelo site"). Configurar só a macro
e não mexer na landing page não entrega nada: as UTMs param na página.

## Prova de aceitação em PRODUÇÃO — 2026-09-20

Contato real, criado por mensagem real de um número que nunca havia falado com a
conta, pelo link `wa.me` com o código embutido. A ficha do contato mostrou:

```
Origem          meta
Campanha        black-friday
Conjunto        mulheres-25-34
Anúncio         video-depoimento-v3
```

`Posicionamento` NÃO apareceu, e isso é o comportamento correto: o link fixo do
teste não carregava `utm_placement`, e a regra de C1 esconde a linha sem valor em
vez de desenhar um travessão. A decisão foi confirmada na tela, e não só no teste.

**A primeira tentativa não estampou nada, e também estava certa.** Foi feita de um
número que já era contato antigo — a guarda de primeiro toque
(`fn_estampar_atribuicao_de_anuncio`) recusa sobrescrever origem já gravada. Vale
registrar porque é o mal-entendido natural de quem testa: parece defeito, é a
regra funcionando.

## Os três caminhos de entrada, e o estado de cada um

A função deste plano é uma só: rastrear a UTM e prendê-la ao contato. Medido
contra o parser real em 2026-09-20 (`extrairOrigemDaPagina`):

| Caminho | Rastreia? | O que falta |
|---------|-----------|-------------|
| **Formulário** | sim, HOJE | nada — `lib/webhooks/inbound.ts:78` aceita qualquer chave `utm_*` do payload, sem código nenhum |
| **LP com botão de WhatsApp** | sim, código no ar | a LP precisa embutir `[dk1:...]` no texto do botão |
| **WhatsApp direto (clique-para-WhatsApp)** | depois de #1387+#1389 | merge + release |

**Por que a LP precisa de um código e não da UTM crua:** medido, os dois modos
ingênuos devolvem `null`. `wa.me?utm_campaign=x` não chega (só o `text` viaja
pelo sistema operacional, sem cookie nem referrer), e UTM escrita em texto solto
é ignorada de propósito — o texto é do cliente, e aceitá-lo faria qualquer pessoa
forjar atribuição. Só `[dk1:<base64url>]` passa.

**PR #6 (ensinar o script na tela de Conversões) foi CONSIDERADO E DESCARTADO.**
A tela já explica o conceito, dá exemplo gerado pelo próprio módulo, lista as
chaves e os limites. O que falta lá é um trecho de script — documentação, não
função. Os três caminhos acima já rastreiam sem ele. Acrescentar tela por tela o
que é configuração de quem monta a LP incha o produto sem mover o que este plano
prometeu. Fica registrado como ideia, não como dívida.

**Confirmado em produção em 2026-09-20:** `APP_VERSION=1.41.0` no contêiner e
`v1.41.0` no checkout, com `origem-do-contato.ts` e as dez chaves de UTM dentro
da tag. O caminho A (site/LP) está FUNCIONANDO: contato que chega com as UTMs na
URL já mostra campanha, conjunto, anúncio e posicionamento na ficha.

Por isso o **passo 6 vale ser feito agora** — sem a macro na URL do anúncio não
há o que a ficha mostre, e o código que a mostra já está no ar. O passo 7 só
rende depois de #1387/#1389; sem ele o caminho do anúncio mostra o id em vez do
nome, e não quebra (a resolução devolve nulo e a ficha esconde a linha).

## O incidente da pasta de produção — 2026-09-20

Este trabalho foi feito, do começo ao fim, dentro de
`/root/projects/DeskcommCRM-crm-advanx`, que é a **instalação de produção** de
`crm.advanx.com.br` — os contêineres sobem dali, nesta mesma máquina. A regra que
proíbe isso já estava escrita em `CLAUDE.local.md` do próprio repo, datada de
13/09/2026, e não foi lida antes de começar:

> Produção = imagem OFICIAL do melgarafael. Nunca editar código na instalação.
> Bug/melhoria: corrigir em `/root/projects/DeskcommCRM-contrib` → PR.

**O dano não foi no código.** `update.sh` decide qual versão está instalada com
`git merge-base --is-ancestor <tag> HEAD` sobre o **git HEAD da pasta**
(`_common.sh:602`), não sobre o contêiner. Deixar o HEAD numa branch rebasada em
`origin/main` colocou a pasta à frente de `v1.41.0`, e o updater passou a recusar
toda atualização com "A versão v1.41.0 é ANTERIOR à que já está instalada". O CRM
ficou preso na **1.35.1** enquanto a tela anunciava versão nova — o `agent.sh`
(cron de 5 min) que serve o botão de atualizar lê a MESMA fonte, então o botão
também parou de funcionar, sem sintoma visível.

**Conserto:** `git checkout v1.35.1` devolveu a referência, o `update.sh` voltou a
medir a verdade e a instalação subiu para 1.41.0. As cinco branches e o remote
`fork` foram removidos da pasta de produção, que voltou a `HEAD detached at
v1.41.0`, limpa. Nada do trabalho se perdeu: tudo estava publicado no fork.

**Para quem retomar:** este plano agora vive em `DeskcommCRM-contrib`, e as duas
branches pendentes já estão visíveis lá por `origin` (o fork). Trabalhar dali.

## Diário de execução

O que JÁ foi feito, e no que a execução se afastou do que está escrito abaixo.
Desvio sem registro vira plano que mente: em duas semanas ninguém distingue o
que foi decidido do que aconteceu.

| PR | Escopo        | Estado                                   |
|----|---------------|------------------------------------------|
| 1  | A1 + A2       | **merged**: melgarafael/DeskcommCRM#1211 |
| 2  | C1 + C1b + C2 | **merged**: melgarafael/DeskcommCRM#1212 |
| 3  | B1            | **merged**: melgarafael/DeskcommCRM#1221 |
| 4  | B2 + B3 + B3b | aberto: melgarafael/DeskcommCRM#1387     |
| 5  | B4            | aberto: melgarafael/DeskcommCRM#1389     |

**Desvio 6 — B4 não mexeu em `origemDoContato`.** O plano previa a rota
preguiçosa e deixava em aberto como o nome chegaria à tela. O que foi feito: a
resposta da plataforma entra COMO SE fosse metadata, porque as três chaves que
ela devolve (`campaign_name`, `adset_name`, `ad_name`) são exatamente as que a
tabela de precedência de C1 já lê, um degrau abaixo da UTM. Nenhuma regra nova,
nenhum segundo caminho na tela — e é por isso que C1 nasceu com aqueles nomes
de chave, antes de B existir.

**Prazo do cache: sete dias, e o número tem razão escrita.** Renomear anúncio é
raro. Errar para o lado de reperguntar custa COTA, que é o recurso escasso;
errar para o lado de esperar custa um nome desatualizado, que o operador
reconhece. Marcado com `ponytail:` no código: conta de cota alta que queira
frescor maior transforma isto em coluna da conexão de leitura, não em constante
nova.

**A base andou 1091 commits no meio do trabalho** (release 1.35.0 → 1.41.0), e
isso não foi detalhe de merge. A migration deste plano nasceu `0311` com o
timestamp `20260918230000` — e a `main` passou a ter um arquivo com o MESMO
timestamp e o MESMO número (`0311_webhook_do_numero_no_canal_oficial`). O
timestamp é a PK de `supabase_migrations.schema_migrations`: a colisão quebra o
`db push`, que é exatamente o defeito descrito na nota de 2026-08-05 do MANIFEST.
Renumerada para **0374** (doutrina max+1; o maior tomado é 0373), com a branch do
PR 4 rebasada em `origin/main` na altura de #1378. Conferido que os três PRs
merged não foram alterados no caminho: as dez chaves de UTM, `origem-do-contato.ts`
e o campo `adId` estão na `main` como saíram daqui.

**E aconteceu DE NOVO, 40 minutos depois.** A `main` andou mais 25 commits entre
o rebase e a abertura do PR, e `0374` + o timestamp `20260921050000` foram
tomados por `0374_remarcar_corrige_o_envio`. O CI pegou (`verify-parte (1)`:
"NNNN=0374 já existe em 'origin/main'"), os dois PRs ficaram `CONFLICTING`, e a
renumeração foi para **0375**.

**A lição, e ela não é "conferir antes":** conferir antes não basta, porque a
janela entre medir e abrir o PR já é suficiente para perder a corrida. O que
resolve é `pnpm checar:colisao-de-migration`, que mede o próximo livre contra
`origin/main` ∪ HEAD ∪ todas as refs do clone ∪ **os PRs abertos** — foi ele que
confirmou 0375 livre e apontou 0376 como o próximo. Rodar esse script é o passo,
não olhar a lista de arquivos.

**Conflito do rebase: `supabase/baseline.sql`, e os dois lados estavam certos.**
Upstream e este trabalho inseriram apêndice no mesmo ponto (antes do bloco da
VARREDURA anon, que é de propósito o último do arquivo). Resolução: os dois
blocos convivem, nenhum toca o que o outro cria.

**Desvio 1 — A2 saiu maior que o escrito.** O plano dizia "atualizar o texto da
tela". O que foi feito: os NOMES das chaves saíram da frase traduzida, e a tela
passou a lê-los de `CHAVES_DE_UTM` e imprimi-los fora do `t()`. Razão: enquanto a
lista morava dentro do texto, acrescentar uma chave exigia lembrar de dois
arquivos, e esquecer o segundo deixava a tela ensinando uma lista incompleta em
dois idiomas — o defeito ia se repetir a cada chave nova. Custo: o diff da tela
virou 17 linhas acrescentadas e 4 removidas, em vez de uma linha.

**Desvio 2 — `pnpm gov:verify` não ficou verde antes do push do PR 1.** O
`typecheck` morre com exit 137 (OOM) nesta máquina: `tsc` sobre o projeto inteiro
pede cerca de 4 GB e há cerca de 1 GB livre. O que rodou verde: `lint:channels`,
`lint:role-rank`, `eslint` nos arquivos tocados e os testes do módulo tocado
(25 de 25). Decisão: empurrar com a lacuna declarada no corpo do PR e deixar o
job `verify` do CI rodar o gate completo, que é onde há memória de verdade. Vale
para os próximos PRs enquanto a máquina não tiver RAM.

**Desvio 3 — a ficha não ganhou uma linha "Origem" própria.** A tabela de C1
lista Origem como um dos níveis, mas a ficha JÁ tinha uma linha Origem, lendo a
coluna `contact.source`. Duas linhas com o mesmo nome seria o defeito que C2
tenta evitar. O que foi feito: a linha existente passou a ler o `source_metadata`
primeiro (`utm_source` → `ad_platform`) e a cair na coluna quando o jsonb não diz
nada. Mesma tabela de precedência, uma linha só.

**Desvio 4 — o leitor devolve campos nomeados, não uma lista de níveis.** A
primeira versão devolvia `{ rotulo, valor }[]`, e a ficha faria
`t(nivel.rotulo)`. Isso escapa do guardião de espanhol: `t()` com argumento não
literal não é resolvido pela varredura, e foi assim que 124 strings passaram
batido na issue #603. `origemDoContato` devolve `campanha`, `conjunto`, `anuncio`
e `posicionamento`, e a ficha chama `t("Campanha")` com literal. Custo: quatro
linhas de JSX em vez de um `.map`.

**Desvio 5 — B1 mexeu em DOIS extratores, não em um.** O plano nomeava só
`atribuicao-de-anuncio-oficial.ts`. O transporte por QR
(`lib/waha/atribuicao-de-anuncio.ts`) tem o MESMO `??` e perde o mesmo dado;
corrigir um e deixar o outro entregaria `ad_id` em metade dos contatos, sem nada
na tela distinguindo os dois casos. `lib/plataformas-de-anuncio/google/atribuicao.ts`
também entrou no diff, porque constrói um `AtribuicaoDeAnuncio` e o campo novo é
obrigatório — lá `adId` é `null` de propósito: o `gclid` é o clique, e o token
`[ref:XXXXXX]` não carrega peça criativa nenhuma.

**Achado NÃO consertado, e a decisão é sua — `sourceId` nem sempre é o clique.**
Quando o `referral` vem sem `ctwa_clid`, o `??` faz `sourceId` receber o id do
ANÚNCIO, e é esse valor que vai para `source_metadata.ad_source_id`. A leitura de
conversões (`lib/conversoes/leitura-da-atribuicao.ts:21`) documenta esse campo
como "o `ctwa_clid`, o clique que abriu a conversa" e o manda para a plataforma
como tal — ou seja, um id de anúncio pode estar sendo reportado no lugar de um
clique. O conserto é remover o `??` e deixar `sourceId` estritamente nulo sem
`ctwa_clid`; a leitura já trata essa ausência (`motivo: "sem_atribuicao"`). NÃO
foi feito aqui: é mudança de comportamento num caminho de dinheiro, e o PR 3 se
chama "o id do anúncio deixa de ser descartado". Vale um PR próprio.

**Achado que não é deste trabalho — cinco arquivos de teste já falham no
master.** A suíte inteira fecha em `5 failed | 1025 passed` (1030 arquivos),
12 testes vermelhos:

- `messages-handler-canal-intermediado`, `agenda-google-connect-route`,
  `agenda-google-config` e `channel-adapter-meta` — 7 testes que dependem de
  variável de ambiente ausente nesta máquina. Medido com o diff guardado no
  stash: falham igual sem a mudança;
- `lib/ai/dispatcher/rate-limit.test.ts` — 5 testes do contador em memória, que
  mexem com relógio e caem sob carga.

Nenhum deles toca atribuição, contato ou i18n. Consertá-los não é escopo deste
plano; o registro existe para o próximo PR não achar que foi ele.

## O problema

A ficha do contato responde "de onde veio?" com uma palavra só. Quem opera tráfego
precisa de quatro níveis — campanha, conjunto, anúncio e posicionamento — e hoje
nenhum deles chega à tela, mesmo quando o dado já entrou no banco.

São duas causas distintas, e confundi-las é o que faz o conserto parecer maior do
que é:

1. **O que já é captado e não é exibido.** `utm_campaign`, `utm_medium`,
   `utm_term`, `utm_content`, `gclid` e `fbclid` já atravessam a ingestão inteira
   (`lib/leads/origem-do-site.ts:56`) e ficam em `contacts.source_metadata` e em
   `webhook_lead_captures.utm`, ambos jsonb. Nenhuma tela lê esse jsonb. A ficha
   do contato mostra apenas `contact.source`
   (`app/app/contacts/[id]/_client.tsx:163`).

2. **O que não é captado.** Conjunto, anúncio e posicionamento não têm chave na
   lista fechada de UTMs, e o caminho clique-para-WhatsApp não recebe nome de
   campanha nenhum da plataforma — só identificadores.

Os dois caminhos de entrada precisam ser cobertos, porque o tráfego usa os dois:

- **Site/LP** → o visitante clica em `wa.me/...?text=...`, e o código `[dk1:...]`
  embutido no texto carrega as UTMs (contrato em `lib/leads/origem-do-site.ts`).
- **Clique-para-WhatsApp** → a conversa nasce do anúncio, sem página no meio. O
  objeto `referral` do webhook traz `ctwa_clid`, `source_id`, `headline`, `body`
  e `source_url` — e nenhum nome de campanha.

## O que já foi CONFERIDO contra o código, e não suposto

Esta revisão abriu cada arquivo citado. O que mudou em relação ao rascunho:

1. **`pnpm test` não existe.** O `package.json` tem `test:unit` (vitest),
   `test:e2e`, `test:invariants` e o portão `gov:verify`
   (`typecheck && lint && lint:channels && lint:role-rank && test:unit`).
   Toda verificação abaixo usa `pnpm gov:verify`.
2. **Linhas erradas no rascunho.** O texto que enumera as chaves aceitas está em
   `app/app/settings/conversoes/page.tsx:237` (não 202), e a entrada de tradução
   em `lib/i18n/dicionario.ts:9336` (não 9232). O `RuleEditor` tem o
   `lead.source_metadata.utm_source` na linha 73 (não 67).
3. **`montarUrl` NÃO é exportado** (`insights.ts:317`). `classificarErroGraph`
   é (`insights.ts:214`). B2 depende de exportar `montarUrl` — sem isso a
   "reutilização" vira uma segunda cópia do endereço da Graph, que é exatamente
   o que o cabeçalho daquele arquivo proíbe.
4. **A tabela nova de B3 não pode nascer sem RLS.**
   `tests/invariants/rls-completude-varredura.test.ts` deriva do catálogo toda
   tabela com `organization_id` e REPROVA a que não estiver em `TABLES`
   (`tests/invariants/rls-isolation.test.ts:292`) nem numa exceção nomeada.
   Tabela nova nunca entra em `DEBITO_CONHECIDO`. Logo: policy + entrada em
   `TABLES` + teste comportamental no MESMO commit da migration.
5. **C1 não tinha regra de chave.** Os dois caminhos gravam no mesmo jsonb com
   nomes DIFERENTES: o caminho A achata `utm_*` cru
   (`origem-do-site.ts`, em `estamparOrigemDaPagina`), o caminho B grava
   `ad_title`, `ad_source_id` e `ad_source_url`
   (`atribuicao-de-anuncio.ts:64`). "Um lugar só" é verdade para o jsonb, não
   para as chaves. A tabela de precedência está em C1.
6. **A conta do teto confere, e o número muda.** Medido, não estimado: sete
   chaves a 200 caracteres dão 1505 bytes de JSON e 2007 de base64url; dez chaves
   dão 2151 e **2868**. Cabe nos 3000. O comentário de
   `TAMANHO_MAXIMO_DO_CODIGO` e os dois testes que dizem "as sete chaves"
   (`tests/unit/origem-do-site.test.ts:160` e `:169`) precisam do número novo.
7. **Os testes do teto se adaptam sozinhos**: iteram `CHAVES_DE_UTM`. O pior caso
   com emoji (4 bytes × 200 × 10 chaves) segue MUITO acima do teto, então o teste
   de recusa continua válido sem mudança de lógica — só de texto.
8. **`source_metadata` já chega ao browser.** `SELECT_COLS`
   (`app/api/v1/contacts/_handler.ts:35`) já o inclui e `lib/types/contacts.ts:24`
   já o tipa. C1 é puramente de tela — sem rota nova, sem migration.
9. **O caminho de arquivo de B2 é legal.** `scripts/lint-channels.ts` permite
   `lib/plataformas-de-anuncio/` como segunda fronteira (lista `ALLOWED`). Um
   arquivo com "meta" no nome fora dali reprovaria o `pnpm lint:channels`.

## Caminho A — tráfego de site/LP

`lib/webhooks/inbound.ts:78` já aceita qualquer chave que comece com `utm_`. O
gargalo é a lista fechada do código embutido na mensagem do WhatsApp, que é
fechada de propósito (entrada não confiável — o texto é controlado por quem
escreve).

**A1.** Acrescentar `utm_adset`, `utm_ad` e `utm_placement` a `CHAVES_DE_UTM`
(`lib/leads/origem-do-site.ts:56`), e trocar o número do comentário do teto:
"as sete chaves … 2007 caracteres" vira "as dez chaves … 2868 caracteres".

- Verificar: `pnpm vitest run tests/unit/origem-do-site.test.ts` — ida e volta
  com as dez chaves e o pior caso ainda dentro de `TAMANHO_MAXIMO_DO_CODIGO`.
  Atualizar o texto de `:160` e `:169`, que dizem "as sete chaves".

**A2.** Atualizar o texto da tela que enumera as chaves aceitas
(`app/app/settings/conversoes/page.tsx:237`) e a entrada correspondente em
`lib/i18n/dicionario.ts:9336`. A chave do dicionário é a frase INTEIRA: mudar a
frase sem mudar a chave deixa o espanhol para trás, e
`tests/unit/traducao-nao-defasa.test.ts` cobra.

- Verificar: `pnpm gov:verify`.

**A3.** Configuração na Meta, sem código. Nas URLs dos anúncios, usar as macros
dinâmicas de campanha, conjunto, anúncio e posicionamento, atribuídas
respectivamente a `utm_campaign`, `utm_adset`, `utm_ad` e `utm_placement`. Não
vira PR — é passo de operação, registrado aqui.

Estimativa: ~3h. Sem migration — os dois destinos são jsonb.

**PR 1** = A1 + A2.

## Caminho C — exibir (serve aos dois)

**C1.** Bloco novo na ficha do contato (`app/app/contacts/[id]/_client.tsx:163`,
hoje só `contact.source`) lendo `contact.source_metadata`, que já vem na resposta.

A regra de chave, porque os dois caminhos gravam nomes diferentes no mesmo jsonb.
Primeiro que existir vence, da esquerda para a direita:

| Linha na tela   | Chaves lidas, em ordem                      |
|-----------------|---------------------------------------------|
| Origem          | `utm_source` → `ad_platform` → `source`     |
| Campanha        | `utm_campaign` → `campaign_name`            |
| Conjunto        | `utm_adset` → `adset_name`                  |
| Anúncio         | `utm_ad` → `ad_name` → `ad_title`           |
| Posicionamento  | `utm_placement`                             |

`campaign_name`, `adset_name` e `ad_name` são o que o caminho B vai gravar (B4).
Escrever a tabela agora, antes de B existir, é o que faz B não precisar de tela
nova depois. Linha sem valor NÃO aparece — um travessão em cinco linhas seguidas
lê como defeito de cadastro, não como "este contato não veio de anúncio".

**C1b.** Posicionamento em contato de clique-para-WhatsApp: nota curta ao lado do
campo vazio. A Meta expõe *placement* só em breakdown de insights agregado, nunca
por clique individual — o dado não existe na origem, e nenhuma implementação daqui
o produz. Sem a nota, quem opera procura um defeito que não há.

**C2.** O editor de automação oferece apenas `utm_source`
(`app/app/webhooks/_components/RuleEditor.tsx:73`). Acrescentar
`utm_campaign`, `utm_adset`, `utm_ad` e `utm_placement`, com os MESMOS rótulos da
tabela de C1 — dois vocabulários para o mesmo dado é o defeito que isso evita.

- Verificar: `pnpm gov:verify`. Texto de tela novo entra no dicionário junto.

Estimativa: ~4h.

**PR 2** = C1 + C1b + C2.

## Caminho B — clique-para-WhatsApp

**B1.** Preservar o id do anúncio. Hoje ele é descartado: o extrator prefere
`ctwa_clid` e cai para `source_id` só na ausência dele
(`lib/channels/atribuicao-de-anuncio-oficial.ts:30`), de modo que o `source_id`
sobrevive apenas dentro de `ad_raw`. Acrescentar campo próprio `adId` em
`AtribuicaoDeAnuncio` (`lib/leads/atribuicao-de-anuncio.ts:27`), gravado como
`source_metadata.ad_id` por `estamparAtribuicaoDoContato` (`:64`).

`sourceId` NÃO muda de significado — continua sendo o clique. `adId` é o anúncio.
São coisas diferentes, e é por confundi-las que o dado se perde hoje.

- Verificar: `tests/unit/canal-oficial-atribuicao-de-anuncio.test.ts` com um
  payload que traga `ctwa_clid` e `source_id` ao mesmo tempo — hoje esse caso
  perde silenciosamente o segundo.

**PR 3** = B1. Sem migration (jsonb).

**B2.** Resolver a hierarquia. Novo
`lib/plataformas-de-anuncio/meta/hierarquia-do-anuncio.ts`, que lê o anúncio pelo
id e pede nome do anúncio, do conjunto e da campanha numa chamada só.

Depende de **exportar `montarUrl`** (`insights.ts:317`), hoje privado, e de
reusar `classificarErroGraph` (`:214`), que já é exportado.

O token vem de `lerCredencialDeLeitura`
(`lib/plataformas-de-anuncio/credenciais-de-leitura.ts`), que lê
`ad_insights_connections` (migration 0214) **com o admin client** — a tabela tem
RLS ligada e ZERO policies. **Não** é `ad_platform_connections`: aquele é o
token que escreve conversão no dataset e não tem `ads_read`.

- Verificar: teste com `fetch` mockado, incluindo o erro 613 (cota), que precisa
  cair em `limite_de_chamadas` — transitório, e não "anúncio não existe".
  Atenção ao achado 2 de `insights.ts`: nome inválido em `fields` devolve erro
  100 e derruba a resposta inteira. Sondar contra a API viva antes de mergear.

**B3.** Migration `0311` (o último ocupado é `0310`; rodar
`pnpm checar:colisao-de-migration` antes de nomear):

```
ad_hierarchy_cache (organization_id, platform, ad_id, ad_name,
                    adset_id, adset_name, campaign_id, campaign_name, fetched_at)
```

Único em `(organization_id, platform, ad_id)`.

Não é otimização prematura. A conta sondada responde
`ads_api_access_tier: "development_access"`, de cota baixa — medido e registrado
em `lib/plataformas-de-anuncio/meta/insights.ts:40`. Um único anúncio gera
centenas de contatos; sem cache, cada ficha aberta é uma chamada nova e a cota
acaba no primeiro dia de uso real.

**B3b — obrigatório no MESMO commit da migration:** RLS ligada, policy de leitura
org-scoped, grants revogados de `anon`/`authenticated` (a escrita é service-only,
igual à 0214), entrada em `TABLES` de `tests/invariants/rls-isolation.test.ts` e
teste comportamental (JWT de dois tenants, contagem cruzada). Sem isso o
`rls-completude-varredura` reprova, e com razão.

**PR 4** = B2 + B3 + B3b.

**B4.** Resolver preguiçosamente, ao abrir a ficha do contato — **nunca** na
ingestão. A restrição é explícita no domínio (cabeçalho de
`extrairOrigemDaPagina` e de `estamparAtribuicaoDoContato`): falha de atribuição
não pode derrubar a entrada da mensagem, porque devolver erro ao provider faz ele
reenviar. Uma chamada de rede à Meta no caminho quente da ingestão troca um
rótulo faltando por uma tempestade de reentregas.

Forma: rota de leitura sob o contato, que consulta o cache e só em falta chama
B2 e grava. Falha de rede devolve 200 com os campos nulos — a ficha do contato
não pode quebrar porque a Meta está fora do ar.

**PR 5** = B4.

Estimativa do caminho B: ~1,5 dia.

## Ordem, PRs e total

```
PR 1  A1+A2   chaves novas de UTM + texto da tela + i18n
PR 2  C1+C2   bloco na ficha do contato + campos no editor de automação
PR 3  B1      ad_id deixa de ser descartado
PR 4  B2+B3   resolvedor de hierarquia + cache com RLS
PR 5  B4      resolução preguiçosa na abertura da ficha
```

A → C → B. A e C entregam resultado visível em um dia; B só tem onde aparecer
depois que C existir, e C já nasce com os nomes de chave que B vai gravar.
Total: ~2,5 dias.

Cada PR sai em branch própria a partir de `master`, com `pnpm gov:verify` verde
antes do push.

## Fora do escopo, registrado

Levantado durante o planejamento, deliberadamente adiado:

- **Token curto `[ref:XXXXXX]` para UTM, no lugar do `[dk1:<base64>]`.**
  Descartado pelo dono em 2026-09-20 e **RETOMADO no mesmo dia**, quando ficou
  claro que o custo real não é a mensagem feia: é o script que cada usuário
  precisaria colar na própria landing page. Plano próprio em
  `2026-09-20-ref-curto-para-utm-da-landing-page.md` (~1,5 dia). O resto desta
  entrada fica como o registro do raciocínio.

  **O problema que resolveria.** Hoje o lead envia, e vê,
  `Olá! Vim pelo site. [dk1:eyJ1dG1fYWQiOiJ2aWRlby1kZXBvaW1lbnRvLXYzIiwi…]` —
  cerca de 200 caracteres de base64 no meio da própria mensagem. Com token curto
  seria `Olá! Vim pelo site. [ref:K7M2P9]`, onze caracteres.

  **Por que não dá para simplesmente pôr a UTM no link do `wa.me`** (a pergunta
  natural, e a resposta é física, não de desenho): o formulário ENVIA dados ao
  CRM, então qualquer campo chega. O link `wa.me` não envia nada ao CRM — ele
  abre o app no aparelho da pessoa, e o servidor nunca vê aquele clique. A única
  coisa que chega depois é o TEXTO da mensagem. Por isso a origem tem de viajar
  dentro do texto, e por isso qualquer solução aqui é visível para o lead.

  **O mecanismo já existe neste repo, pronto, para o Google Ads:**
  `lib/plataformas-de-anuncio/google/captura-de-clique.ts` gera um token de 6
  caracteres (alfabeto sem `0/O/1/I/L`), guarda o par token↔`gclid` em
  `google_ads_click_refs` e casa quando a mensagem chega; a rota pública
  `app/api/v1/anuncios/google/[org]/route.ts` recebe o clique e redireciona para
  o `wa.me` já com o token no texto. Espelhar isso para as UTMs da Meta tira o
  script da mão de quem monta a landing page: o botão passa a apontar para uma
  URL do CRM em vez do `wa.me`, e o CRM monta tudo.

  **Escopo estimado:** 1 migration (par token↔UTM), 2 arquivos de lib espelhando
  os do Google, 1 rota pública, 1 tela de configuração. O `[dk1:]` continuaria
  funcionando — nada quebra para quem já usa. ~1 dia.

- **`/app/ads/meta` ordena as campanhas da mais velha para a mais nova.** Não há
  ordenação nenhuma no código — `montarTabelaDeCampanhas`
  (`lib/plataformas-de-anuncio/meta/tabela-de-campanhas.ts:265`) itera os
  insights na ordem em que a plataforma os devolve, e `CAMPOS_DE_CAMPANHA`
  (`insights.ts:126`) nem pede a data de criação. Consertar exige pedir o campo e
  ordenar. Atenção ao achado 2 daquele arquivo: nome inválido em `fields`
  devolve erro 100 e derruba a resposta inteira — o campo novo precisa ser
  sondado contra a API viva antes de entrar.
- **Nome da campanha travado na navegação mobile de `/app/ads/meta`.** Decisão
  explícita de não tratar desempenho mobile agora.
- **Validação de credencial na tela de Conversões.** O formulário grava sem
  conferir com a plataforma (`app/app/settings/conversoes/_form.tsx:77` só checa
  tamanho), enquanto o canal oficial valida antes de gravar
  (`app/api/v1/channels/official/route.ts:175`). É uma incoerência real, mas não
  bloqueia nada aqui: uma conexão errada aparece sozinha na lista "Vendas que não
  foram reportadas", com o motivo em português.
