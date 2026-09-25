# Ref curto para a UTM da landing page

Data: 2026-09-20
Status: TODAS as fatias em PR e com CI VERDE — mecanismo em melgarafael/DeskcommCRM#1405 (19/19), tela em #1409 (19/19, empilhado).
Antecessor: `2026-09-18-trackeamento-de-campanha-conjunto-anuncio.md`

## Diário de execução

O que JÁ foi feito, e no que a execução se afastou do que está escrito acima.
Desvio sem registro vira plano que mente.

### Placar

| Fatia | Estado |
|-------|--------|
| F1 migration + invariantes de RLS | **feito** — migration `0381`, PR melgarafael/DeskcommCRM#1405 |
| F2 captura e casamento | **feito** — no mesmo PR #1405, com a regra de desempate declarada |
| F3 rota pública | **feito** — no mesmo PR #1405 |
| F4 tela de configuração | **feito** — PR #1409, empilhado no #1405 |
| F5 convivência com o `[dk1:]` | **feito** — a tela oferece o endereço como recomendado e mantém o `[dk1:]` documentado |

### Desvio 1 — F2 foi codificada SEM a resposta do mantenedor, por decisão do dono

Conferido em 2026-09-20: a issue #1400 estava `OPEN` com zero comentários, e a
ordem original era esperar. O dono decidiu seguir, desde que a regra escolhida
fosse a certa para o problema. A regra: **cada lado procura na PRÓPRIA tabela**,
e o padrão do marcador vira um só, em
`lib/plataformas-de-anuncio/captura-de-clique.ts`.

O que foi PESADO e descartado: conferir a tabela irmã a cada clique (guarda
contra o mesmo ref nascer nos dois eixos). Chegou a ser escrita e saiu — custa
uma consulta no caminho de quem clicou num anúncio pago para cobrir um risco de
1 em 1 bilhão por organização cujo pior desfecho é escolher entre duas origens
que são ambas de anúncio. É a mesma régua que a 0306 já aceita para a colisão
interna. A decisão está no comentário da #1400 e no corpo do PR, e é uma função
que muda se o mantenedor preferir prefixo por eixo ou tabela única.

O consumo entrou em `guardarOrigemDaPagina` (`lib/channels/pos-entrada.ts`),
junto do `[dk1:]`, e não num caminho novo: os dois transportam a mesma coisa, e
tudo depois do marcador é idêntico. Duas ordens que o código declara — o
`[dk1:]` é tentado primeiro (resolve no texto, sem consulta), e o ref NÃO é
lido antes da guarda de primeira mensagem, porque ler é consumir.

### Desvio 2 — a migration criou DUAS tabelas, não uma

F1 nomeava só `meta_ads_click_refs`. Sem `meta_ads_landing_pages`, a rota de F3
não tem para onde redirecionar: o par "número de WhatsApp + texto
pré-preenchido" precisa existir no servidor antes de qualquer clique. É
exatamente o par que a 0306 criou para o Google, e ele entrou espelhado.

### Desvio 3 — três peças subiram um degrau em vez de virar cópia

F2 previa `lib/plataformas-de-anuncio/meta/captura-de-clique.ts` "espelhando o
do Google". Medido no código, o que seria espelhado é idêntico nos dois eixos:
o gerador de token com retentativa em colisão, a leitura da configuração da
landing e as peças de navegador da rota (IP do cliente, link do `wa.me`, página
de saída). Os três saíram de `google/` para `lib/plataformas-de-anuncio/`, com
a tabela como parâmetro de tipo fechado. Custo: o diff toca quatro arquivos que
já estavam no ar (a rota do Google, a captura do Google, a configuração da
landing e `origem-do-site.ts`, que passou a exportar o normalizador de UTM).
Ganho: não existe um segundo laço de retentativa para divergir do primeiro.

### Desvio 4 — um defeito achado no caminho, e consertado nas duas rotas

O caminho sem token montava a mensagem com `replace("{token}", "")`, o que
deixava `[ref:]` no texto que o lead manda — colchete órfão que a ingestão não
casa e que quem recebe lê como link quebrado. O teste da rota nova pegou. Como
a função virou compartilhada (`textoSemRef`), o conserto alcança também a rota
do Google Ads, que tinha o mesmo defeito desde a 0306.

### Desvio 5 — o invariante de server-side foi generalizado, não duplicado

F1 admitia "irmão próprio". O que foi feito: `google-ads-captura-e-server-side`
virou `captura-de-clique-e-server-side` e o `describe.each` dele passou a medir
as QUATRO tabelas. Duas cópias da mesma régua divergiriam; as duas entradas
novas em `rls-completude-varredura` citam o arquivo novo.

### Desvio 6 — dois casos de F3 não podem devolver o WhatsApp, e isso é o certo

F3 pedia teste com organização inexistente, sem UTM e sem configuração, "os
três devolvendo o caminho do WhatsApp". Só o caso SEM UTM pode: nos outros dois
não existe número de WhatsApp para onde mandar (é o que a configuração ausente
significa). Eles devolvem a página neutra da rota do Google, que também não
diz "esta organização não existe" a tráfego de terceiro. Os sete casos da rota
estão em `tests/unit/meta-ads-captura-de-utm.test.ts`.

### A corrida de numeração, de novo — e desta vez sem perder

`pnpm checar:colisao-de-migration` rodou com o commit pronto e contra
`upstream/main` (a `origin` é o fork: medir contra ela é medir uma main que
pode estar atrás). Duas colisões apareceram ANTES do push, não depois:

- `0376` já estava no PR aberto **#1392** → subiu para `0381`;
- o timestamp `20260921070000` já estava nos PRs **#1387 e #1389**, que são os
  desta mesma linha de trabalho — o timestamp é a PK de
  `schema_migrations`, então ele mudou para `20260921080000`.

O PR foi aberto na sequência imediata da medição. Próximo livre no momento da
abertura: `0382`.

### Desvio 7 — a tela recusa número sem código do país, e isso não estava no plano

F4 dizia "escolher o número (o CRM já conhece os conectados)". Medido ao
escrever a validação: `11 99999-9999` tem dez dígitos e, com um `+` colado na
frente, vira um número dos Estados Unidos que EXISTE. O tráfego pago iria para
lá e nada quebraria — o dono descobriria pelo telefone que parou de tocar.
Então a action corrige a falta do `+`, mas RECUSA a falta do código do país,
com motivo que a tela mostra. Os números conectados entram como sugestão
(`datalist`) e não como lista fechada, porque o número da landing page não
precisa ser um canal do CRM.

Também fora do plano, pela mesma medição: a URL mostrada vem da ORIGEM DA
PÁGINA e não de `NEXT_PUBLIC_APP_URL` — a variável é embutida no build e, num
self-host em Docker, fica congelada no marcador do Dockerfile. A URL copiada
apontaria para o lugar errado, e o defeito só apareceria no primeiro clique
real.

### O que `pnpm test:db` disse, e o que não é deste trabalho

Suíte inteira: `3 failed | 251 passed` (254 arquivos), `1 failed | 2103 passed`.
Os TRÊS arquivos vermelhos caem no mesmo import — `Cannot find package
'nodemailer' imported from lib/email/smtp.ts` (`webhooks-inbound`,
`eco-do-proprio-envio-nao-cria-segunda-mensagem` e `triagem194-defeitos-alegados`).
O pacote está no `package.json` (`nodemailer 10.0.10`) e NÃO está no
`node_modules` desta máquina: é ambiente, não diff. Somam-se aos cinco arquivos
de `test:unit` que o plano antecessor já registrou como anteriores a este
trabalho.

Depois de `pnpm install --frozen-lockfile` (o `nodemailer` do lock simplesmente
não estava no `node_modules` desta máquina), os TRÊS voltaram a passar: 46
testes verdes, 1 pulado. Nenhum deles tinha relação com este diff.

Os dois arquivos que ESTE trabalho toca rodaram sozinhos depois, no mesmo
container: `captura-de-clique-e-server-side` e `rls-completude-varredura`,
**116 testes verdes**, com o baseline aplicado em install E update.

### O que o CI cobrou, e que a máquina local não pegava

Três vermelhos, e nenhum deles apareceria aqui sem o CI:

1. **`TS2322` em `updateCapturaDeUtm.ts`** — `audit()` só aceita ação do
   catálogo de `lib/audit/actions.ts`, e `captura_de_utm.updated` não estava
   lá. Derrubou `verify`, `build-and-size` e a imagem do app. **A saída para o
   OOM:** um `tsconfig` de escopo que estende o do repo e inclui só os arquivos
   do diff cabe na memória desta máquina e apontou a linha exata. Vale para
   todo PR daqui em diante.

2. **`e2e-parte (3)` reprovando pelo RELÓGIO.** `trunk-sip-config.spec.ts`
   varre o corpo inteiro da tela procurando chave de tradução crua, e o corpo
   inclui o bloco de configuração que a tela manda colar. O host de teste é
   montado com o timestamp em base36: quando ele sai só com letras, o host
   ganha três segmentos minúsculos pontuados e casa com o padrão. Medido nas
   duas pontas, na MESMA base: verde às 23:20 (#1405), vermelho às 23:45 e
   00:13 (#1409). Consertado em commit próprio, tirando o bloco da varredura —
   a guarda é sobre a CÓPIA da tela, e arquivo de configuração tem token
   pontuado por construção.

3. **`imagens-de-fundo-sobem` sem token do Docker Hub** — `failed to fetch
   oauth token`. Rede, não diff. Sem direito de `gh run rerun` no upstream, o
   jeito de repetir é `git commit --amend` + `push --force-with-lease`: mesmo
   conteúdo, SHA novo, CI novo.

E o desvio de método que vale registrar: a primeira leitura do vermelho 2 foi
"sorteio de semente", escrita num comentário do PR antes de medir. A medição
nas duas pontas desmentiu, e o comentário foi corrigido no mesmo fio.
Diagnóstico por hipótese plausível custa a confiança de quem revisa.

### Pergunta aberta para F4, levantada pelo código

A rota só recebe UTM se quem aponta para ela carregar as UTMs na URL. São dois
casos: o anúncio aponta DIRETO para o endereço do CRM (com as macros nos
parâmetros — é o que o Google Ads faz com `{gclid}`), ou a landing page aponta
o botão para cá **repassando a própria query string**. Um botão de `href` fixo
não repassa nada, e nesse caso a captura acontece sem UTM nenhuma. A instrução
de F4 precisa dizer qual dos dois o usuário está montando, senão a tela entrega
uma URL que "funciona" e não atribui nada.

## O problema

Das três fontes de tráfego que chegam ao WhatsApp, **duas já rastreiam sozinhas** e
uma não:

| Fonte | Como a origem chega | Estado |
|-------|---------------------|--------|
| Campanha de conversão para WhatsApp | `referral` nativo no webhook (`ctwa_clid`, `source_id`) — sem link, sem texto | pronto (#1387/#1389 traduzem o id em nome) |
| Formulário na página | POST direto ao webhook; `lib/webhooks/inbound.ts:78` aceita qualquer chave `utm_*` | funciona hoje |
| **Página com botão de WhatsApp** | só o TEXTO da mensagem atravessa | **é este plano** |

O terceiro caso é o único que precisa de mecanismo, e por uma razão física: o link
`wa.me` **não fala com o CRM**. Ele abre o aplicativo no aparelho da pessoa; o
servidor nunca vê aquele clique. A única coisa que chega depois é o texto da
mensagem — por isso a origem tem de viajar dentro dele.

Hoje esse caso é atendido pelo código `[dk1:<base64url>]` (`lib/leads/origem-do-site.ts`),
e ele funciona — medido em produção em 2026-09-20, contato real, quatro níveis na
ficha. Dois problemas de USO, não de correção:

1. **O lead vê ~200 caracteres de base64** no meio da própria mensagem:
   `Olá! Vim pelo site. [dk1:eyJ1dG1fYWQiOiJ2aWRlby1kZXBvaW1lbnRvLXYzIiwi…]`
2. **Quem monta a página precisa escrever código.** O marcador tem de ser gerado
   por visitante (dois visitantes vindos de campanhas diferentes não podem sair com
   o mesmo marcador), e um link estático não gera nada. Hoje isso significa colar um
   script na landing page — trabalho manual, por instalação, que a maioria dos
   usuários não vai fazer.

## O que este plano entrega

Um endereço do próprio CRM que a pessoa cola no botão da landing page, no lugar do
`wa.me`. Ele guarda as UTMs do lado do servidor, gera um ref de 6 caracteres e
redireciona para o WhatsApp.

```
Olá! Vim pelo site. [ref:K7M2P9]
```

Onze caracteres na mensagem, em vez de duzentos. Nenhum script na página.

**Não é desenho novo.** O produto já faz exatamente isto para o Google Ads:
`lib/plataformas-de-anuncio/google/captura-de-clique.ts` (token de 6 caracteres,
alfabeto sem `0/O/1/I/L`), a tabela `google_ads_click_refs` (migration 0306) e a
rota pública `app/api/v1/anuncios/google/[org]/route.ts`. Este plano espelha esse
mecanismo para as UTMs da Meta.

## Por que o ref precisa passar pelo servidor

A pergunta natural é "por que não deixar o ref pronto dentro do link". Porque ele
tem de ser diferente por visitante:

```
João  clica (Black Friday)  → precisa de um ref, ligado a Black Friday
Maria clica (Dia das Mães)  → precisa de OUTRO ref, ligado a Dia das Mães
```

Um link é texto parado: entrega o mesmo valor a todo mundo. Para o ref nascer no
clique, alguma coisa tem de executar naquele instante — ou um script na página (o
que existe hoje, e é o trabalho manual que este plano remove) ou um redirecionamento
pelo servidor (o que o Google Ads já faz aqui).

## Fatias

### F1 — Migration: o par ref ↔ UTM

Tabela `meta_ads_click_refs`, espelhando `google_ads_click_refs`:

```
(organization_id, token, utm jsonb, created_at, matched_at, contact_id)
```

- Único em `(organization_id, token)`, como a do Google.
- `utm` é jsonb e guarda as chaves de `CHAVES_DE_UTM` já normalizadas — as MESMAS
  dez do `[dk1:]`, sem vocabulário novo.
- Server-side only, o desenho das cinco irmãs do eixo: RLS ligada, ZERO policies,
  grants de `anon`/`authenticated` revogados. Entra em `TABELAS` de
  `tests/invariants/google-ads-captura-e-server-side.test.ts` (ou irmão próprio) e
  como exceção nomeada em `rls-completude-varredura.test.ts`, **no mesmo commit**.
- Numeração: rodar `pnpm checar:colisao-de-migration` no momento de nomear, nunca
  antes. Ver o registro do plano antecessor — duas colisões em 40 minutos.

- Verificar: `pnpm test:db` (o deny-all da tabela nova, sob `set role`).

### F2 — Captura e casamento

Novo `lib/plataformas-de-anuncio/meta/captura-de-clique.ts`, espelhando o do Google:
`criarClickRef` (gera token, grava UTM) e `casarClickRef` (consome no primeiro toque).

O padrão do marcador `[ref:XXXXXX]` **já existe** em
`lib/plataformas-de-anuncio/google/atribuicao.ts` (`PADRAO_DO_TOKEN`). Os dois
caminhos passam a disputar o mesmo formato de marcador no texto, e é aqui que mora
o risco desta fatia: **um token de Meta não pode ser procurado na tabela do Google e
vice-versa.** Decidir e escrever a regra de desempate antes de codificar — a mais
simples é procurar nas duas tabelas por organização e aceitar a que casar, já que os
alfabetos e o tamanho são idênticos e a colisão entre as duas é do mesmo nível do
risco de colisão interna (32^6 por organização).

- Verificar: teste de unidade do par criar/casar, incluindo token que não existe,
  token de outra organização, e token já consumido (`matched_at` não nulo).

### F3 — Rota pública de redirecionamento

`app/api/v1/anuncios/meta/[org]/route.ts`, espelhando a do Google, inclusive nas
decisões que aquele arquivo já documenta e que NÃO se reinventa aqui:

- retorno de NAVEGADOR, nunca JSON — não usa `ok`/`fail`;
- rate limit por IP (rota pública e sem autenticação, cria linha no banco a cada hit);
- **falha nunca vira tela de erro**: todo caminho ruim devolve uma página curta com
  um botão "Abrir WhatsApp", sem o ref se for o caso. Clique de anúncio é dinheiro
  gasto; perder a atribuição é aceitável, perder o lead não.

- Verificar: teste de rota com organização inexistente, sem UTM nenhuma na query, e
  com configuração ausente — os três devolvendo o caminho do WhatsApp.

### F4 — Tela de configuração e instrução

Na tela de Conversões, onde já vive a seção "Quem chegou pelo site":

- escolher o número (o CRM já conhece os conectados) e o texto padrão da mensagem;
- **mostrar a URL pronta para colar no botão da landing page** — é a entrega para
  quem opera: ele copia um endereço, não escreve código;
- instrução curta do que colocar no anúncio (as macros de campanha, conjunto,
  anúncio e posicionamento nos parâmetros de URL).

Esta fatia é o que faz o plano valer para todos os usuários, e não só para quem sabe
colar script. Sem ela, F1–F3 são mecanismo sem porta.

- Verificar: `pnpm gov:verify`; toda string nova com espanhol no dicionário.

### F5 — Convivência com o `[dk1:]`

O código atual **continua funcionando**, sem depreciação nesta entrega. Quem já montou
link com ele não pode quebrar. A tela passa a oferecer o ref como o caminho
recomendado, e o `[dk1:]` permanece documentado como alternativa sem servidor.

## Ordem, e o que cada fatia trava

```
F1 (migration) → F2 (captura) → F3 (rota) → F4 (tela) → F5 (convivência)
```

F4 é a única que o usuário vê. F1–F3 sem F4 não entregam nada a ninguém.

## Estimativa

| Fatia | Tempo |
|-------|-------|
| F1 migration + invariantes de RLS | 2h |
| F2 captura e casamento + testes | 3h |
| F3 rota pública + testes | 2h |
| F4 tela, URL pronta e i18n | 3h |
| F5 convivência e revisão | 1h |
| **Total** | **~11h, ou 1,5 dia** |

Em PRs: um por fatia, ou F1+F2+F3 num PR de mecanismo e F4+F5 num PR de tela. A
segunda forma dá dois PRs revisáveis em vez de cinco.

## Riscos declarados

1. **Colisão de numeração de migration.** O repositório anda centenas de commits por
   dia; o plano antecessor perdeu a corrida duas vezes. Rodar
   `pnpm checar:colisao-de-migration` imediatamente antes de nomear, e abrir o PR na
   sequência.
2. **O formato `[ref:]` passa a ter dois donos.** É o ponto de F2 e precisa de decisão
   escrita antes do código, não durante.
3. **Rota pública nova é superfície de abuso.** O rate limit não é opcional; a do
   Google já trata isso e a razão está escrita no cabeçalho dela.
4. **Trabalhar em `DeskcommCRM-contrib`.** Nunca na instalação de produção
   (`DeskcommCRM-crm-advanx`) — ver o incidente registrado no plano antecessor.

## Fora do escopo

- Depreciar o `[dk1:]`.
- Ref para o caminho do formulário (não precisa: o POST fala com o CRM).
- Ref para o clique-para-WhatsApp (não precisa: a Meta manda o `referral`).
- Encurtador de URL próprio, domínio próprio de redirecionamento, QR code.
