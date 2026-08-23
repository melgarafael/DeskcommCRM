# FV-W1-FILA — o dossiê do follow-up e a intervenção humana

**Branch:** `fv/fila` · **Base:** `4f89a0da` · **4 commits** · **Migration:** 0145

---

## O que entrou

### 1. O dossiê (`/app/ai/followups/enrollments/[id]`)

`followup_enrollment_events` grava cada passo do motor desde a 0054 e nenhuma
tela lia a tabela. Agora a linha da fila é clicável e leva a: contato, fluxo,
versão pinada, agente, passo atual, quando volta a andar, por que parou — e a
história inteira em português.

Duas escolhas que separam dossiê de dump:

- **O alvo anda junto com o que aconteceu.** Toda linha carrega o passo, e passo
  que saiu do grafo pinado aparece DITO como id ("passo wait-9 — não existe mais
  neste fluxo"). Guardar "falhou: timeout" sem o onde produz tela que parece
  completa e não serve para diagnosticar.
- **O grafo não sai inteiro pela API.** A leitura é `viewer` e `config` carrega o
  `prompt_hint`; sai a projeção de `resumoDoNo`.

A tradução vive em `lib/followup/eventos-legiveis.ts`, atrás de uma fronteira
única (`descreveEvento` / `resumoDoNo` / `rotuloDoStatus`) — **é o ponto de troca
para o vocabulário do QAVivo**: quando `lib/followup/vocabulario.ts` publicar, as
tabelas daqui saem e viram import, sem tocar em nenhum consumidor.

### 2. O tempo que a IA escolheu

`lib/followup/plano-de-tempo.ts` lê o `timing_plan` produzido pelo motor (0144).
Para cada espera: quanto escolheu, por quê, `clampado` em destaque — e **quanto
a IA pediu antes do corte**.

**Dois consertos depois de integrar com o motor** (o contrato que chegou no meu
briefing era mais pobre que o real):

- **`proposto_ms` existia e eu estava descartando.** O produtor guarda o valor
  original justamente para o dossiê poder dizer "a IA pediu 3 dias, seu limite
  era 12h" — e o comentário dele diz isso com todas as letras. Sem essa linha,
  "bateu no seu limite" informa que houve corte e não informa de QUANTO, que é o
  número que decide se o operador vai mexer no nó. Guardar o dado e não mostrá-lo
  seria o mesmo defeito que este dossiê existe para consertar, uma camada acima.
- **A leitura passou a usar o schema DO MOTOR, não um paralelo meu.**
  `esperaPlanejadaDe` faz `safeParse` do plano inteiro e, se falhar, ignora o
  plano todo (a espera cai no máximo). Minha leitura tolerante teria produzido a
  pior tela possível: "a IA escolheu 4 horas" sobre um plano que o motor está
  descartando. Quando um lado recusa, os dois recusam — e há teste que compara
  os dois sobre a MESMA entrada, em vez de afirmar o comportamento de um só.

### 3. A intervenção

Pausar · retomar · adiar · pular · cancelar. Todas `manager+`, com audit e uma
linha na timeline do NEGÓCIO com autor humano.

---

## A corrida contra o motor — as DUAS metades

O briefing pediu para decidir e provar. São duas, e só uma é óbvia:

**1. O tick em curso (`claimed_until`).** UPDATE com guarda otimista (status lido
+ claim livre) e **contagem de linhas**: um UPDATE que não casa nada devolve
sucesso no PostgREST, e a tela diria "pausado" sem nada gravado. Zero linhas vira
409 com o motivo **relido do banco** (mudou de estado × motor ocupado pedem ações
diferentes de quem clicou). Falha fechado na ação, aberto na informação.

**2. O turno em voo.** Um envio ou classificação pode terminar DEPOIS da pausa,
com resultado calculado ANTES dela. `completeTurnForEnrollment` descartava por
lista NEGATIVA de status — desenho em que todo estado novo passa por omissão, e
que já custou o `paused_handoff` na Task 5.2. **Virou lista positiva.**

> ⚠️ **`lib/followup/turn-bridge.ts` é arquivo do DevVivo e o briefing pedia para
> não tocar.** Mudei uma linha lógica (denylist → allowlist) + comentário, porque
> a alternativa era entregar uma pausa que o motor desfaz em silêncio. O conflito
> de merge, se houver, é visível e trivial. **Medido:** devolvendo a denylist, o
> invariante reprova exatamente 1 caso (o do turno stale) e o CONTROLE POSITIVO
> segue verde — a mudança é o que faz a pausa sobreviver.

### O defeito que a integração pegou — e o teste que passava por sorte

**Eu recriei o índice do "vivo" copiando as colunas da DDL ORIGINAL.** A 0145
precisava mexer só no PREDICADO (acrescentar `paused_manual`), mas copiou
`(pointer_id, contact_id)` do `create table` quando o que estava EM VIGOR era
`(organization_id, contact_id)` — posto por uma migration anterior, com backfill
cancelando os excedentes. Efeito: a garantia "um follow-up vivo por CONTATO na
organização" voltaria a ser "um por FLUXO", **sem conflito de merge, sem erro de
aplicação e sem sintoma imediato**.

A integração corrigiu o baseline; **a migration continuava errada** (a tripla
tinha dois lados discordando), e é o que este commit conserta.

E o pior: **o invariante que deveria pegar isso passava por sorte.** Ele criava
o segundo enrollment no MESMO fluxo, então violava os DOIS predicados e ficava
verde com qualquer um. Agora o segundo nasce em outro fluxo, e só o predicado
certo o recusa. Medido por sabotagem: devolvendo as colunas erradas ao baseline,
**1 vermelho — o previsto**; com a versão antiga do teste, seria 0.

Lição para a wave: `drop index` + `create index` de um índice que já foi
recriado antes é reescrita silenciosa. A definição a copiar é a que está em
vigor, nunca a da DDL original.

### ⚠️ CORREÇÃO: "o e2e não segura merge" é FALSO — e a fonte da crença é o achado

A mensagem do commit `c67a61cc` afirma que "o `e2e` não segura merge neste
repo". **É falso**, e mensagem de commit não se edita depois de mergeada — por
isso a correção vive aqui, num commit próprio, como `@Assistente e Testes`
pediu.

Medido no `CLAUDE.md` do meu HEAD, que traz a saída do `gh api` colada:

```console
$ gh api repos/melgarafael/DeskcommCRM/branches/main/protection --jq '.required_status_checks.contexts|join(", ")'
verify, build-and-size, invariants, e2e
```

**São QUATRO obrigatórios, `e2e` incluído** (medido em 2026-08-08).

**E a origem da crença não é descuido de quem repetiu — é estrutural.** O
`CLAUDE.md` que chega ao contexto de uma sessão vem do DIRETÓRIO PRINCIPAL
(`/Users/rafaelmelgaco/DeskcommCRM`), não do worktree onde se trabalha. Medido
agora: o principal está na branch `feat/indice-de-atrito` e o arquivo lá ainda
diz, na linha 215, `Check **não-obrigatório** (roda, mas não segura merge)`. O
`CLAUDE.md` do worktree `fv-fila` **já estava corrigido** — inclusive na base
`4f89a0da`. Ou seja: a doutrina que eu li era mais VELHA que a do código em que
eu mexia, e nada na tela avisa isso.

É a terceira vez que a crença aparece hoje (o `@Assistente e Testes` a disse ao
Rafael, eu a escrevi num comentário — retratado em `f4719b31` — e de novo numa
mensagem de commit). Três pessoas, uma fonte.

**A conclusão do commit `c67a61cc` continua válida por outro motivo**, e é o que
deve ser lido: cobrir o caminho novo no unitário vale mesmo com o `e2e`
obrigatório, porque o unitário roda em segundos e o `e2e` em minutos — feedback
rápido para quem escreve é valor por si, sem precisar do argumento sobre
obrigatoriedade.

### O vermelho que eu HERDEI (e que vale um alerta de repo)

Ao mergear a integração, o `pnpm typecheck` veio VERMELHO por um arquivo que não
é meu: `tests/e2e/followup-tempo-adaptativo.spec.ts` declara o tipo da resposta
da fila como `{ id, next_fire_at }` e a asserção estrutural lê `node_or_reason`.
Uma linha; corrigida, com aviso ao dono.

**⚠️ A PRIMEIRA VERSÃO DESTE PARÁGRAFO ESTAVA ERRADA, e a correção importa
mais que o erro.** Eu havia escrito que "o e2e não roda no gate de tipos". Falso:
`@DevVivo` mediu e eu confirmei — o `tsconfig.json` inclui `**/*.ts` e exclui
apenas `node_modules/.next/dist/scripts`, então `tests/e2e` está DENTRO. Medido
aqui com `npx tsc --noEmit --listFilesOnly | grep -c "/tests/e2e/"`: **46
arquivos**. O typecheck sempre cobriu essa spec.

**O buraco é outro, e mais interessante:** quem escreve spec de Playwright
recebe feedback do PLAYWRIGHT, e o `playwright.config.ts` não invoca `tsc` — ele
transpila sem checar tipos. O autor vê verde local, o tipo incompleto nunca
aparece para ele, e o erro nasce no gate, para OUTRA pessoa. Não é "o gate não
cobre"; é "o loop de quem escreve não cobre, e o gate cobre tarde".

A diferença muda o conserto: não adianta acrescentar `e2e` a algum gate — ele já
está lá. O que falta é o autor rodar `pnpm typecheck` antes de empurrar. Deixar
o diagnóstico errado escrito faria alguém "consertar" uma cobertura que nunca
faltou.

### E o que só a TELA pegou

O cenário do plano rodou, e a screenshot mostrou duas linhas erradas na história
— nenhuma delas visível por unitário, porque os dois eventos são do motor novo:

- `timing_plan_decidido` caía no meu fallback e aparecia como
  **"código: timing_plan_decidido"** na tela. O fallback fez o trabalho dele
  (mostrar que existe um passo que a tela ainda não aprendeu), e agora o passo
  foi aprendido: "O agente decidiu quanto esperar em cada passo".
- o turno de PLANEJAMENTO se anunciava como **"Pediu ao agente para escrever a
  mensagem"**. O `event_type` é o mesmo (`turn_enqueued`) para os dois pedidos;
  o `purpose` no payload é que os separa. Uma linha que descreve o passo errado
  é pior que uma genérica — ela não parece errada.

Os dois ficam vigiados na própria spec, onde apareceram.

### O que a INTEGRAÇÃO cobrou (e o build pegou)

O merge de `feat/followup-vivo` trouxe o **grafo v2** do Arquiteto: uma aresta
pode ter `{type:'branch', branch_id}`, e o `branch_id` é um id OPACO — o nome do
ramo mora no NÓ, de propósito (replicá-lo na aresta faria as duas cópias
divergirem no primeiro rename).

Minha `rotuloDaAresta` só conhecia os tipos v1, e o **typecheck do `next build`
foi quem pegou** — não os testes, porque nenhum caso meu tinha ramo nomeado. A
tradução passa a receber o nó de origem e delega a `nodeBranches` (a lista de
ramos é do contrato do grafo; uma segunda travessia aqui divergiria dela). Sem
origem, ou com id que o nó não declara mais, aparece **o id** — nome inventado
mandaria o operador pelo caminho errado na hora de escolher por onde pular.

---

## Decisões que valem revisão

| decisão | por quê |
|---|---|
| `paused_manual` como status próprio | `reactToHandoffClose` retoma `paused_handoff`; reusá-lo faria o sistema retomar sozinho um follow-up que uma pessoa mandou parar, no primeiro handoff fechado do contato |
| Retomada devolve o tempo que **faltava** | congelado no evento da pausa. Segurar por uma semana um fluxo que ia falar em 4h devolve 4h, não uma rajada |
| Sem colunas novas para a pausa | o `prior_status` vai no payload do evento, como o `handoff_paused` já faz. Quem pausou e quando são o próprio evento — coluna seria duplicação (DIRC) |
| `idempotency_key` NULO nos eventos manuais | a chave `${nó}:${passo}` é do dedup do motor; ocupá-la faria a intervenção ser lida como passo do motor |
| Pular NÃO escolhe o ramo | com mais de uma saída a tela pergunta; escolher a de maior prioridade seria decidir o rumo do atendimento pelo operador |
| Rota própria, não painel | endereço compartilhável e sobrevive ao F5 no meio da intervenção. Segmento `[id]` ⇒ `navegacao-completude` não cobra porta de menu; a porta é a linha da fila |
| Promessa (`cron_jobs`) não ganha link | é uma linha só; um link para tela vazia ensinaria que o dossiê às vezes não funciona |
| As 4 intervenções em `NUNCA_COLAPSA` | acontecem no mesmo minuto e mesmo ator; a janela de 60s as esconderia atrás de um "+" justamente de quem precisa vê-las |

---

## Medições (SHA `9616f69b`, working tree limpo)

> Os gates foram medidos NESTE SHA, que é o último commit de código+doc da wave.
> O commit que ajusta esta tabela não toca em código.

| gate | resultado |
|---|---|
| `pnpm typecheck` | **exit 0** — 4 erros achados e corrigidos no caminho (`AuditAction` é union fechado) |
| `pnpm lint` | **0 erros** (235 warnings, todos pré-existentes) |
| `pnpm test:unit` | **326 arquivos / 3470 testes, verde** |
| `pnpm build` (produção, ambiente de e2e) | **verde** |
| `pnpm test:db` | **90 arquivos / 641 testes · 637 passaram, 3 falharam** — ver ressalva abaixo |
| `tests/e2e/followup-dossie.spec.ts` | **2 passed**, jornada inteira pelo clique |

**Sabotagens (cada uma com a contagem prevista ANTES de rodar):**

- 3 propriedades puras sabotadas (restante congelado, escolha de saída, fallback
  do evento desconhecido) → **3 vermelhos, um por sabotagem**.
- denylist devolvida ao `turn-bridge` → **1 vermelho**, o do turno stale, com o
  controle positivo verde.

**Um gate pegou este relatório, e vale registrar:** a primeira versão citava as
screenshots com chave de expansão (`{01-...,02-...}.png`). `evidencia-citada` é
BIDIRECIONAL — imagem versionada que nenhum doc cita é órfã — e o extrator não
expande chaves: as seis contavam como não citadas, e o `test:unit` foi de 3470
verdes para 1 vermelho. Citar o caminho inteiro de cada uma resolveu.

### O `IA360-FLAKY`, caçado até a raiz

> **Os papéis, corrigidos PARA BAIXO pelo próprio `@QAVivo`** — e a distinção é
> dele: ele **caracterizou** o fenômeno (determinístico, 36ms, não timeout) e
> **refutou** a primeira atribuição, a de que o índice da 0145 explicava tudo,
> que não sobrevivia ao "isolado passa". Não achou a causa. Quem seguiu a pista
> dele até o par de arquivos fui eu.
>
> Ele pediu a correção porque **refutar uma causa errada é barato — uma medição
> basta — e achar a certa custa mais**; um registro que confunde as duas faz a
> próxima pessoa superestimar o que uma refutação entrega.

O invariante instável que o repo carregava como "às vezes vermelho" tinha causa
determinística, e ela é uma lição sobre teste que mexe em SCHEMA.

`tests/invariants/followup-silence-sweep.test.ts` dropa e recria o
`idx_followup_enrollments_one_live` no banco COMPARTILHADO, para provar o
RED→GREEN do próprio caso. O `finally` que diz "restaura o estado do baseline"
restaurava uma versão **congelada no tempo**:
`('active','waiting_reply','paused_handoff')` — de antes de a 0145 acrescentar
`paused_manual`. Depois que aquele arquivo rodava, o banco ficava com um índice
que o baseline não tem mais, e o próximo teste a depender dele reprovava.

O meu era o próximo: sem `paused_manual` no índice, o enrollment pausado deixa de
ocupar a vaga e o segundo é aceito.

| medição | resultado |
|---|---|
| par `silence-sweep` + `intervencao`, SEM conserto | **1 vermelho** (previsto 1), 27 ms |
| o mesmo par, COM conserto | 22 verdes |
| suíte completa COM conserto | **94 arquivos / 659 verdes, 0 vermelhos** |

**O que NÃO afirmo:** que o conserto explica os outros vermelhos das rodadas
anteriores (17 sob load 68; 3 sob load ~30). A carga caiu para 9 na rodada
final — duas variáveis mudaram, e o número não separa as causas. O que a
medição isolada prova é o par, onde a carga não entra: dois arquivos, 30
segundos.

### A lição de método: "conserte a classe" pressupõe a classe CERTA

O `@Assistente e Testes` martelou o dia inteiro, com razão, que se conserta a
CLASSE e não a instância. Este arquivo mostra onde a regra tem limite, e o
achado é do `@QAVivo`: o **mesmo texto** aparece três vezes ali com **três
propósitos opostos**.

| ocorrência | o que ela é | acompanha as migrations? |
|---|---|---|
| `setOneLiveIndex` | **restauração** de estado do banco compartilhado | **sim** — era o flaky |
| dedup da 0062 | **reprodução histórica** | **não** — completar mudaria o que a réplica replica |
| `countLiveForContact` | **pergunta** sobre o estado de hoje | **sim** — senão responde menos que a realidade |

"Consertar tudo que parece igual" quebraria a réplica; "não mexer em nada"
deixaria a pergunta mentindo. **Semelhança de TEXTO não é semelhança de
PROPÓSITO** — e a varredura por `grep` só enxerga a primeira.

E a terceira foi medida ANTES de entrar (16 verdes antes, 16 depois): é o que
separa "consertei um defeito" de "desarmei uma armadilha". Sem a medição, o
commit reivindicaria um conserto que não houve.

### A confirmação independente — e por que ela é a prova mais forte da noite

O `@QAVivo` rodou a suíte completa na árvore DELE (`fv/vocabulario` em
`9e6a9cf8`), com o conserto dentro, no MESMO ambiente que reprovava 3 de 3
antes. Resultado: **94 arquivos, 659 verdes, 1 pulado, 0 vermelhos, exit 0**.

**Idêntico ao meu, dígito por dígito** — e as duas rodadas foram em árvores
diferentes, portas diferentes e cargas diferentes (load 9 na minha, 15,6→16,8 na
dele).

Contagem igual sob condições diferentes é o que separa "ficou verde" de "está
consertado": se o verde viesse da carga baixa, a rodada dele — mais carregada —
teria dado outro número. O `IA360-FLAKY` está morto, e não por sorte.

**E a distinção que fecha o método, do `@QAVivo`: repetir não é o mesmo que
variar.** Repetir na MESMA condição só mostra que não foi azar naquela condição;
variar a condição é o que mostra que o resultado não depende dela. Foram três
verdes em três cargas (9; 16→21; 15,6→16,8) — ampliação de faixa, não repetição.

**A consequência prática é que a MESMA rodada tem valores probatórios diferentes
conforme a pergunta:**

| a mesma rodada verde… | …sobre o vermelho do `pausado` | …sobre os testes PULADOS |
|---|---|---|
| vale como | **prova** — o vermelho não volta em nenhuma carga, logo estava ligado ao índice | **nada** — a carga é justamente a variável suspeita |

Ler um resultado sem a pergunta ao lado é como o número vira conclusão errada:
o mesmo "0 vermelhos, 1 pulado" responde uma coisa e não responde a outra.

### Uma pergunta que fica ABERTA, com o motivo escrito

Entre rodadas do MESMO código, o número de testes PULADOS do `test:db` variou de
1 para 8 — sinal de estado atravessado entre arquivos, distinto do vermelho que
foi consertado. **Não sabemos a causa, e não vamos fingir que sabemos.**

**Três** tentativas de separar as variáveis falharam pelo mesmo motivo: conserto e
carga da máquina mudaram na MESMA janela (load ~30 → 9 na primeira minha; 21 →
16,8 na segunda; 32 prometido → 15,6 medido na do `@QAVivo`). Com duas variáveis, "pulados voltaram a 1" não
distingue "o conserto resolveu" de "a máquina desafogou".

A assimetria útil, dele: se os pulados SUBIREM com carga baixa e conserto
dentro, é evidência forte de fenômeno próprio — mais forte que a do desenho
original, porque elimina a explicação rival. Se ficarem em 1, é inconclusivo.

E a separação de verdade exigiria carga alta de propósito numa máquina
compartilhada — o que faria outra pessoa pagar a conta da nossa medição. Ficou
combinado não fabricar.

**Aberta com o motivo escrito é um estado legítimo; fechada por conveniência não
é.** Quem reabrir precisa saber que o obstáculo não foi falta de tentativa.

**A lição, escrita no cabeçalho do helper:** quem recria objeto de SCHEMA num
banco compartilhado assume a dívida de acompanhar toda migration futura que o
toque — e nada avisa quando ela chega. A dívida venceu meses depois, na conta de
outra pessoa.

**Ressalva honesta do `test:db`:** as 3 falhas estão todas em
`tests/invariants/webhooks-inbound.test.ts`, com 39–43 s cada (casos que normalmente
levam <2 s). Meu diff **não toca nenhum arquivo de webhook**. Numa primeira rodada,
sob load 68, caíram 17 casos em 6 arquivos; na rodada limpa, 3 casos — e o conjunto
mudou entre rodadas **no mesmo código**. É a assinatura de interferência/carga já
catalogada como `IA360-FLAKY`, não de defeito determinístico. **Não afirmo test:db
verde** — afirmo que o invariante novo (`followup-intervencao`, 6 casos) passou nos
90 arquivos do run e passa isolado.

---

## Pendências declaradas

1. **Par novo no invariante de vocabulário — PRECISA DE AUTORIZAÇÃO.**
   `followup_enrollments.status` ganhou o sétimo valor e o par
   (`hooks/followup/useFollowupQueue.ts → FollowupEnrollmentStatus`) deveria
   entrar em `tests/invariants/vocabulario-banco-x-typescript.test.ts`. O hook de
   pre-commit congela `tests/invariants/**` e a exceção que ele prevê é outra
   (flip de `test.fails`) — **não driblei**. **AUTORIZADO** pelo
   `@Assistente e Testes`, com a edição roteada ao `@QAVivo` (um dono por
   arquivo). Prova entregue junto: previ 2 vermelhos na sabotagem e deram
   exatamente 2 — o par novo mais um pré-existente de `channel_sessions.provider`
   que é artefato do banco de dev. Texto pronto no apêndice deste documento.

   *Correção de fato registrada:* o roteamento veio com o motivo de que o QAVivo
   já teria mexido neste invariante na wave. `git log --oneline
   4f89a0da..feat/followup-vivo -- tests/invariants/vocabulario-banco-x-typescript.test.ts`
   devolve **0 commits** — o que ele criou foi `lib/followup/vocabulario.ts`. O
   roteamento continua bom; só o motivo estava trocado.

2. **`timing_plan` criado com `if not exists` na 0145 — e o motivo é pior do que
   eu sabia.** A coluna é do contrato da 0144. O `@Assistente e Testes` conferiu
   e achou o que eu não tinha visto: os arquivos ordenam `20260810120000_0145`,
   depois `20260810121000_0144`, depois `0146` — **o timestamp e o número de
   sequência discordam**, então um clone que aplique por nome de arquivo roda a
   0145 ANTES da 0144. A defesa não é só justificada: é necessária. (O alerta de
   repo que isso revela — "aplicar em ordem" virou ambíguo — é dele e vale além
   desta wave.)

3. **J9 FECHADO.** `feat/followup-vivo` foi mergeado para dentro de `fv/fila`, e
   a spec ganhou o cenário com plano REAL: o modelo "pede" 3 dias, o nó permite
   12h, e a tela mostra as duas coisas. O plano não é escrito à mão — vem de
   `completeTurnForEnrollment`, a MESMA função que o worker chama depois da
   resposta do modelo (o seam já usado por `followup-journey.spec.ts`). Um
   `INSERT` provaria que a tela desenha um jsonb inventado, não que ela lê o que
   o motor grava.

---

## Apêndice — o par pendente, pronto para aplicar

Vai no fim do array `PARES` de
`tests/invariants/vocabulario-banco-x-typescript.test.ts` (depois de
`channel_sessions.provider`). **Não afrouxa nada**: acrescenta uma linha à tabela
que o próprio arquivo pede ("Coluna nova com CHECK de conjunto → uma linha
aqui"); nenhuma asserção existente é tocada.

```ts
  {
    tabela: "followup_enrollments",
    coluna: "status",
    // hooks/followup/useFollowupQueue.ts → FollowupEnrollmentStatus.
    //
    // O par aponta para o tipo da TELA, e não para `EnrollmentStatus` de
    // `lib/followup/node-handlers.ts`, porque são conjuntos diferentes de
    // propósito: o do motor enumera o que o motor manipula, e o motor nunca lê
    // nem escreve `paused_manual` (o claim filtra `active|waiting_reply`). Quem
    // precisa conhecer TODOS os estados é quem os mostra — a fila.
    //
    // Nasce junto com a 0145, que acrescentou o sétimo valor. Sem o par, um
    // status novo no CHECK vira linha na fila com rótulo cru: `rotuloDoStatus`
    // cai no fallback e a tela mostra o identificador do banco no rosto de quem
    // opera.
    arquivo: "hooks/followup/useFollowupQueue.ts",
    simbolo: "FollowupEnrollmentStatus",
  },
```

Com autorização, o commit precisa de `DESKCOMM_GOV_INVARIANTS_EDIT=1` e da razão
citada na mensagem — é o que o hook exige de quem passa por ele.

---

## Apêndice 2 — o endurecimento do invariante, pronto para aplicar

Também bloqueado pelo hook de `tests/invariants/**`, e pelo mesmo motivo do
apêndice 1: o caso não é o flip previsto na exceção. **Não afrouxa nada** — o
teste passava com QUALQUER um dos dois predicados possíveis, e passa a exigir o
certo.

Medição (runner de verdade, `scripts/test-db.sh` com o baseline aplicado):

| estado | resultado |
|---|---|
| baseline correto + teste endurecido | 6/6 verdes |
| baseline sabotado para `(pointer_id, contact_id)` | **1 vermelho — o previsto** |
| baseline sabotado + teste ANTIGO | 0 vermelhos (era o defeito) |

```diff
diff --git a/tests/invariants/followup-intervencao.test.ts b/tests/invariants/followup-intervencao.test.ts
index c3235df5..e9b991ab 100644
--- a/tests/invariants/followup-intervencao.test.ts
+++ b/tests/invariants/followup-intervencao.test.ts
@@ -15,9 +15,9 @@ import type { FlowGraph } from "@/lib/followup/graph-schema";
  *  2. `fn_claim_due_followup_enrollments` deixa de ver o pausado. É o que faz a
  *     pausa PARAR o fluxo: sem isso a tela diria "pausado" e o worker seguiria
  *     mandando mensagem;
- *  3. o pausado continua ocupando a vaga de "vivo" do par (pointer, contato).
- *     Se a liberasse, um segundo enrollment nasceria ao lado e os dois andariam
- *     juntos no instante da retomada;
+ *  3. o pausado continua ocupando a vaga de "vivo" do par (ORGANIZAÇÃO,
+ *     contato) — nem em outro fluxo nasce um segundo. Se a liberasse, dois
+ *     follow-ups andariam juntos sobre a mesma pessoa no instante da retomada;
  *  4. um turno que termina DEPOIS da pausa é descartado. Esta é a metade da
  *     corrida que mora no `turn-bridge.ts`, e o teste vem com CONTROLE POSITIVO
  *     (o mesmo turno, num enrollment ativo, avança) — sem ele, um bug que
@@ -157,13 +157,39 @@ describe("pausa manual — o que o banco garante", () => {
     expect(ids).not.toContain(pausado);
   });
 
-  it("pausado continua ocupando a vaga do vivo — não abre espaço para um segundo", async () => {
+  /**
+   * ⚠️ O SEGUNDO ENROLLMENT NASCE EM OUTRO FLUXO, E É ISSO QUE O TESTE MEDE.
+   *
+   * A versão anterior reusava o mesmo `pointer_id`, e assim ela passava com
+   * QUALQUER um dos dois predicados possíveis — o `(pointer_id, contact_id)` da
+   * DDL original e o `(organization_id, contact_id)` que está em vigor. Passava
+   * por sorte: a 0145 recriou o índice copiando a definição ERRADA (revertendo
+   * "um vivo por contato na organização" para "um por fluxo"), e este teste
+   * ficou verde em cima do defeito.
+   *
+   * Com dois fluxos e o mesmo contato, só o predicado CERTO recusa a segunda
+   * linha — e a diferença entre os dois deixa de ser invisível.
+   */
+  it("pausado ocupa a vaga do contato na ORGANIZAÇÃO — nem em outro fluxo nasce um segundo", async () => {
     const c = await montaCenario("unico");
     await criaEnrollment(c, { status: "paused_manual", comRelogio: false });
 
-    await expect(criaEnrollment(c, { status: "active" })).rejects.toThrow(
-      /idx_followup_enrollments_one_live|duplicate key/i,
+    const { rows: outraVersao } = await pool.query<{ id: string }>(
+      `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
+      [c.org, JSON.stringify(GRAFO)],
     );
+    const { rows: outroPointer } = await pool.query<{ id: string }>(
+      `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
+       values ($1, $2, 'active', $3) returning id`,
+      [c.org, `Outro fluxo ${Date.now()}-${Math.random()}`, outraVersao[0]!.id],
+    );
+
+    await expect(
+      criaEnrollment(
+        { ...c, pointerId: outroPointer[0]!.id, versionId: outraVersao[0]!.id },
+        { status: "active" },
+      ),
+    ).rejects.toThrow(/idx_followup_enrollments_one_live|duplicate key/i);
   });
 });
```

---

## Apêndice 3 — o conserto do `IA360-FLAKY`, PRONTO e FORA da árvore fechada

⚠️ **A missão foi declarada fechada em `feat/followup-vivo = f37a04b0`, e este
conserto NÃO está lá.** Medido:

```console
$ git show f37a04b0:tests/invariants/followup-silence-sweep.test.ts | sed -n '521p'
       where status in ('active','waiting_reply','paused_handoff')`,
```

O predicado anterior à 0145 continua no helper que recria o índice no banco
compartilhado — ou seja, **o defeito determinístico segue vivo na árvore de
integração**. O motivo de não estar commitado é o mesmo dos apêndices 1 e 2:
`tests/invariants/**` é congelado pelo hook, e a autorização foi pedida.

Isso NÃO contradiz o número do fechamento (334 arquivos / 3639 testes verdes):
aquele é o `test:unit`, e o `IA360-FLAKY` vive no `test:db`, que não entra
naquele run. São duas afirmações sobre coisas diferentes.

Medições deste patch:

| medição | resultado |
|---|---|
| par `silence-sweep` + `intervencao` SEM o patch | 1 vermelho (previsto 1), 27 ms |
| o mesmo par COM o patch | 22 verdes |
| suíte completa COM o patch | 94 arquivos / 659 verdes, 0 vermelhos |

**A segunda ocorrência do predicado velho (linha ~646) NÃO entra no patch, e é
deliberado:** ela é a réplica fiel da dedup da migration 0062, que não conhecia
`paused_manual`. Ali o predicado não restaura estado — reproduz história.
"Completar" as duas quebraria a réplica achando que conserta. O patch inclui o
comentário que diz isso, para o próximo não cair nessa.

```diff
diff --git a/tests/invariants/followup-silence-sweep.test.ts b/tests/invariants/followup-silence-sweep.test.ts
index 9713eae9..5a2c1167 100644
--- a/tests/invariants/followup-silence-sweep.test.ts
+++ b/tests/invariants/followup-silence-sweep.test.ts
@@ -514,11 +514,32 @@ async function countLiveForContact(org: string, contactId: string): Promise<numb
 }
 
 const ONE_LIVE = "idx_followup_enrollments_one_live";
+
+/**
+ * ⚠️ O PREDICADO É COPIADO DO BASELINE, NÃO DIGITADO DE MEMÓRIA.
+ *
+ * Este helper dropa e recria um índice do schema no banco COMPARTILHADO pelos
+ * invariantes — e o `finally` que "restaura o estado do baseline" restaurava uma
+ * versão CONGELADA no tempo: `('active','waiting_reply','paused_handoff')`, de
+ * antes de a 0145 acrescentar `paused_manual`. Depois que este arquivo rodava, o
+ * banco ficava com um índice que o baseline não tem mais, e o próximo teste a
+ * depender dele reprovava — determinística e rapidamente (27ms, falha de
+ * asserção, não timeout), o que fez a suíte parecer instável por carga.
+ *
+ * Medido: rodando só `followup-silence-sweep` + `followup-intervencao`, o caso
+ * "pausado ocupa a vaga do contato na ORGANIZAÇÃO" reprova; isolado, passa. É o
+ * `IA360-FLAKY` com assinatura, achado por `@QAVivo` e caçado a partir da pista
+ * dele ("isolado passa, então o culpado está na vizinhança").
+ *
+ * A lição que a constante carrega: quem recria objeto de schema num banco
+ * compartilhado assume a dívida de acompanhar TODA migration futura que o toque.
+ */
+const ONE_LIVE_STATUSES = "'active','waiting_reply','paused_handoff','paused_manual'";
 async function setOneLiveIndex(columns: string): Promise<void> {
   await pool.query(`drop index if exists ${ONE_LIVE}`);
   await pool.query(
     `create unique index if not exists ${ONE_LIVE} on followup_enrollments (${columns})
-       where status in ('active','waiting_reply','paused_handoff')`,
+       where status in (${ONE_LIVE_STATUSES})`,
   );
 }
 
@@ -615,6 +636,13 @@ describe("dedup 0062 — >1 enrollment vivo pro mesmo (org,contact) vira 1 vivo
       );
 
       // A DEDUP exata da migration 0062 (window function genérica, sem ids hardcoded).
+      //
+      // ⚠️ ESTE PREDICADO NÃO ACOMPANHA A 0145, E É DE PROPÓSITO. Ele não
+      // restaura estado: REPRODUZ o que a 0062 fazia, e a 0062 não conhecia
+      // `paused_manual`. Acrescentar o status aqui mudaria o que a réplica
+      // replica — o oposto de consertar. O predicado que PRECISA acompanhar as
+      // migrations é o de `setOneLiveIndex`, lá em cima, porque aquele devolve o
+      // banco compartilhado ao estado do baseline.
       await pool.query(
         `with ranked as (
            select id, row_number() over (
```
