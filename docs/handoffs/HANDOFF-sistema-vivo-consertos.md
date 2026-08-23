# HANDOFF — Consertos sob a doutrina do Sistema Vivo

> Documento **vivo**. Toda afirmação declara o SHA de onde foi medida. Número sem SHA não compara.
>
> Base: `origin/main` = **`b9f2ca51`** · branch `fix/sistema-vivo-operador` · worktree `DeskcommCRM-sv`
> Origem: auditoria do PR #181 ("os três papéis do agente", squash `9249e6f2`) contra
> [`docs/doctrine/sistema-vivo.md`](docs/doctrine/sistema-vivo.md) — 13 agentes, 86 achados,
> **79 sobreviveram** ao cético, mais 8 do crítico de completude.

---

## Por que a base é a main e não a branch da sessão

A sessão começou em `feat/indice-de-atrito`, **111 commits atrás** da main. Consertar ali seria
consertar contra alvo em movimento — e a main já continha o PR #181. Worktree dedicado, criado da
main, com `node_modules` real.

**Havia outra sessão viva na máquina** (`397eb824`, rodando vitest e `test:db`). Nenhum processo dela
foi tocado, e as suítes daqui foram sequenciadas: máquina saturada forja falha, e falha forjada custa
mais caro que a que ela esconde.

---

## Linha de base, medida antes de tocar em nada (`b9f2ca51`)

| medida | valor |
|---|---|
| `pnpm test:unit` | **310 arquivos / 3209 testes** verdes |
| `pnpm lint` | 0 erros, 188 warnings |
| `pnpm typecheck` | limpo |
| `pnpm test:e2e` (39 specs) | **111 passed / 4 failed**, 14m1s |
| specs em `tests/e2e/` × listadas no CI | **39 × 36** |

---

## Estado final, medido (`8e5dcdac`)

| medida | valor | contra o baseline |
|---|---|---|
| `pnpm test:unit` | **332 arquivos / 3502 testes** verdes | +22 arquivos, +293 casos (55 commits da main + os meus) |
| `pnpm lint` | 0 erros, 235 warnings | **0 nos meus arquivos** — um import morto que eu deixei foi medido e removido |
| `pnpm typecheck` | **exit 0** (medido sem pipe) | igual |
| `pnpm test:db` | Operador **10/10** · chave do turno **4/4** · camadas **8/8** | os de camadas rodam com o baseline em install E update |
| specs × listadas | 39 × **38 rodam + 1 declarada fora** | soma conferida por gate |

> **Sobre "typecheck limpo" no meio da sessão:** eu afirmei isso medindo com `| tail`, que mascara o
> exit code. Medido sem pipe, estava **quebrado** — num arquivo meu, já commitado. Consertado em
> `639f0894`. A lição não é nova neste repo e eu a repeti.

---

## O que foi consertado

### 1 · A migration 0129 derrubou três avisos da Central · `2b75d51e`

`agent_inbox_items_kind_check` é derrubada e reconstruída a cada kind novo — sete vezes até aqui — e o
contrato implícito é que cada reconstrução repita a lista inteira. A 0129 reconstruiu a partir de uma
lista anterior à 0111 e perdeu **`promise_unfulfilled`** (o aviso do papel Operador),
`contact_proposal_expired` e `other`.

- **Medido:** a cadeia termina em **15** valores; o `baseline.sql` tem **18**. O kit self-host nunca
  foi atingido — quem quebra é o clone que aplica migrations pelo Supabase CLI, o caminho versionado.
- **Modo de falha:** `insertInboxItem` bate 23514, quem chama captura e emite `log.warn` de propósito,
  e a Central **para de receber** o sinal. Ninguém vê erro; alguém deixa de ver aviso.
- **Prova de comportamento** (Postgres real, não leitura de arquivo):

  | estado | valores | aceita `promise_unfulfilled`? |
  |---|---|---|
  | após 0124 | 17 | sim |
  | após 0129 | 15 | **não** — `violates check constraint` |
  | após 0131 | 18 | sim — `INSERT 0 1` |

- **Gate da classe:** `tests/unit/migrations-nao-encolhem-vocabulario.test.ts`, duas asserções que
  medem coisas diferentes — monotonicidade (o evento, com allowlist justificada) e
  cadeia-igual-ao-baseline (a consequência, sem allowlist). Sabotagem: tirar a 0131 → **1**; migration
  nova que encolhe → **2**. Previsões 1 e 2.
- **De brinde:** o gate achou a **primeira** instância da classe, que eu não procurava — a 0062, de
  22/07, perdeu `followup_dead` e foi reparada um dia depois pela 0065 (`reconcile_inbox_kind_check`).
  A 0129 reincidiu *citando no próprio comentário* a lição que violava: aquela era sobre **blocos**, o
  mecanismo é sobre **listas**.

### 2 · A suíte e2e não rodava num worktree limpo · `fdcf7e80`

`pnpm e2e:build && pnpm test:e2e` — o caminho documentado — morria antes do primeiro teste. As duas
proteções se anulavam: `envDoE2E()` injetava o ambiente só no `webServer`, e `env-de-teste.ts` caía no
`.env.local`, que **não existe de propósito** no worktree isolado. O CI não notava porque contorna por
dois caminhos, um deles `cp .env.e2e .env.local` — recriando o arquivo cuja ausência é a proteção.

Prova com uma variável mudada, shell sem credenciais (impresso antes de rodar): antes
`Sem credenciais do Supabase`; depois **7 passed (24,1s)**.

### 3 · O alarme de destino mentia no estado misto · `4c8cd222`

`anunciarDestino` decidia o rótulo só por `c.url`. Mas `dbUrl` cai no `.env.local` sozinha, então com
`.env.e2e` exportado e um `.env.local` de trabalho no disco a API vai para o local e o **Postgres para
a produção** — e são 15 arquivos que abrem `pg.Pool` com esse valor. A função criada para tornar
visível a escrita acidental não cobria o canal que o fallback põe em risco. 10 testes; sabotagens 2 e
1, previstas 2 e 1; a senha do Postgres nunca vai ao log, com teste próprio.

### 4 · O Operador escrevia no CRM depois de o humano assumir · `ec9a6faa`

**O pior achado da auditoria.** `isLeadInHandoff` guardava três dos quatro handlers de turno e **zero**
vezes o `operator-turn`. Não foi linha esquecida: a guarda foi posta na *função* de turno, e o Operador
é um job separado que ela enfileira. E o instante importa — o handoff nasce durante o turno (tool
`request_human_handoff`) ou depois (o "assumir eu" da tela), então só o início da **execução** lê o
estado que vale.

- Formato igual ao dos irmãos (registrar o motivo e sair) de propósito: `followup-turn.ts:432` faz
  exatamente isso. Persistir o desfecho é trabalho separado e vale para os quatro do mesmo jeito.
- **Prova:** `tests/invariants/operador-nao-pisa-no-humano.test.ts`, 4 casos contra Postgres real
  (baseline install + update), rodando o **handler**, não afirmando que a linha existe. Os dois braços
  do `or` têm caso próprio, mais o caso do silêncio **vencido** (na direção oposta: uma guarda que
  lesse `is not null` silenciaria o papel para sempre). O primeiro caso é a **guarda de vacuidade**.
- Sabotagem: apagar a guarda → **2 failed | 2 passed**, previsão 2. Os dois casos de handoff caem, o
  controle e o do silêncio vencido seguem verdes.

### 5 · A cobertura do e2e deixa de ser prosa digitada · `ac026651` + `c42b6553`

39 arquivos no disco, 36 nas listas, e o passo que existia para declarar a lacuna afirmava "32 de 33".
As ausentes eram as novas — entre elas `agente-papeis-operador.spec.ts`, a prova de tela do épico dos
três papéis, apresentada como 7/7 e que **nunca rodou em job nenhum**.

Agora há uma fonte por lista, o summary **conta**, e `tests/unit/e2e-cobertura-completa.test.ts` guarda
três propriedades com três modos de falha: completude, vigência (filtro que não casa nada deixa o job
verde) e **consumo** (declarar não é executar). Sabotagens: 1 + 1 + 1, cada uma num teste diferente.

> **Correção da minha própria decisão** (`c42b6553`): eu vi um caso da `prova-painel-provedores` passar
> e concluí que o arquivo estava verde. Errado — 2 de 6 falhavam, e o caso F3 não podia passar no CI:
> exige >50 modelos da OpenRouter e o catálogo chegava lá com 2 linhas. A spec passava onde o dado por
> acaso existe, e ela foi para `FORA_DO_CI` com o motivo medido.
>
> **E depois voltou** (`12e32806`): a main criou `scripts/seed-e2e-catalogo-openrouter.ts` e o job
> passou a semeá-lo — o docstring do seed diz exatamente o que eu tinha medido ("a spec media a SORTE
> do ambiente"). A condição que a excluía deixou de existir. Hoje `FORA_DO_CI` tem um item só,
> `vps-fresh-onboarding`, que é a P0 da doutrina de QA Visual e depende de infra externa.

### 6 · Duas mutações perdiam a auditoria em silêncio · `639f0894`

Achado nos **logs** da corrida, não em leitura de código: `invalid input syntax for type uuid:
"stage_classifier"` em `ai.purpose_binding_updated`. `resource_id` é uuid, `purpose` é chave natural em
text; audit é fire-and-forget por doutrina, então a gravação seguia, a tela dizia "salvo" e a trilha
não tinha a linha.

Procurando a **classe**, a varredura achou uma segunda ocorrência que ninguém tinha visto:
`ai.skill_uninstalled` mandava o NOME da skill (`skill_pointers` é chaveada por `(organization_id,
name)`). Um DELETE perdendo a própria auditoria.

Gate: `tests/unit/audit-resource-id-e-uuid.test.ts` varre as 149 chamadas e exige que todo `resourceId`
termine em id/Id/_id ou seja `null` — **allowlist, não denylist**, com as 7 exceções legítimas
declaradas e um teste cobrando que exceção órfã seja removida.

### 7 · Três defeitos que só apareceram ao RODAR a suíte · `3ebb6ba5`

- **`escalacao-ciclo` morria em 0ms** porque o re-seed de credenciais (disparado por rotação de TOTP de
  outra sessão) apaga o bloco `escalacao` do `.e2e-creds.json`. A spec passa a semear a própria
  precondição. Prova: apaguei o bloco e o teste avançou da linha 124 para a 152.
- **A mesma spec disparava `tsx --env-file=.env.local`** — o arquivo cuja ausência é a proteção. Única
  ocorrência **executável** no repo; o gate não a pegava porque sua regex procura `readFileSync`.
- **A suíte destruía a evidência versionada.** `qa-agente-usa-as-maos.spec.ts` grava em
  `evidence/ia-360-w4/medicao-vazamento/turnos/`, que é fixture de `projecao-conversador.test.ts`. Sem
  chave de IA, os 10 cenários voltaram HTTP 400 e o carimbo `rodou: false` cobriu os turnos reais — a
  medição histórica do vazamento de 30%. Três testes de unidade ficaram vermelhos e o **controle
  positivo deles** disse por quê. A falha agora vai para `__falhou.json`, ao lado.
- **O gate passa a medir código, não prosa:** documentar o item acima *dentro* da spec reprovou o gate,
  porque o comentário citava os dois literais que a regex procura. Comentário não executa. Controle
  positivo depois de afrouxar: violação real injetada → **2** reprovações (previ 1; são 2 porque o
  arquivo está nas duas baterias).

---

### 8 · O desfecho do Operador passa a existir, e o aviso apura antes de afirmar · `9f5a7ee7`

O **P1-C3**, com C1 e C4 junto (a mesma linha de código). O retorno de `runModelCall` era
descartado, e disso saíam três defeitos: o desfecho não tinha o que persistir (virou `log.info` no
stdout de um contêiner que o próprio arquivo declara não ser superfície), o aviso da Central usou um
PROXY — a contagem de promessas **declaradas**, que é fato sobre o Conversador —, e afirmava
"o sistema ainda não registrou o cumprimento", veredito que nenhuma linha apurava.

Agora `apuraDonoDaPromessa` responde o que o sistema consegue saber: **alguém ficou responsável?**
(ferramenta chamada neste turno, ou retorno vivo — reusando a MESMA regra que o Radar usa para dizer
"em voo"). Não responde "foi cumprida?", e nenhuma frase do produto diz que sim.

Regra de emissão, com a razão de cada linha: `event_log` **sempre** (mata o `return` mudo e dá
denominador às três medidas da spec §7); timeline `promise_unowned` **só** quando há promessa sem
dono (disciplina do `diffCheckpoint` — turno em que o papel agiu já gera as atividades das
ferramentas dele); Central pelo mesmo critério **menos** o handoff (quem assumiu está com a conversa
na frente). `insertInboxItem` ganhou dedup por `kind + ref_id`.

Sabotagens: previ 2/1/1/1 e vieram **2/1/2/1** — a terceira reprovou mais que o previsto porque
minha sabotagem devolvia lista vazia e derrubava dois casos, não um. Errei a previsão, não o
mecanismo.

### 9 · O terceiro papel existe na tela · `da6c250e`

O **P5-C6a**. A cadeia de dez conferências rodava e o dono do negócio não sabia — os gates só
apareciam num `<details>` fechado dentro do resultado de um teste. Agora há a aba
**"Confere antes de enviar"**, com as dez na ordem em que rodam, o que cada uma protege, e
**nenhum interruptor**: nove não se desligam e a tela diz por quê em uma linha cada; as duas que
custam uma consulta ao modelo dizem o custo e que a decisão mora no servidor — em vez de um switch
que a tela grava e o motor ignora.

A lista de apresentação é duplicada por necessidade (o módulo da cadeia arrasta `pg` e o adaptador
de canal para o bundle), e o que impede a duplicata de mentir é um teste que importa
`BEFORE_SEND_GATES` e reprova nos dois sentidos.

**Corrigi uma justificativa falsa do plano** em vez de herdá-la: ele mandava usar service role
porque `before_send_traces` "não tem policy para authenticated" — tem, e o controle positivo é
`llm_calls`, no mesmo loop do baseline, lido com client de sessão em produção. A agregação de vetos
fica para a próxima rodada, e virá com client de sessão.

**A sabotagem achou um teste meu que prometia demais:** o caso "mostra todas as conferências da
cadeia" é auto-referente (renderiza da lista, compara com a lista) e seguiu verde quando removi uma
conferência. Renomeado para o que ele de fato mede.

### 10 · As duas camadas que custam dinheiro viram escolha da organização · `d41e5133`

O **P5-C6b**, que ontem ficou de fora por não ser honesto sozinho. A ordem foi o ponto: o motor
passou a ler a escolha **primeiro**, nos TRÊS pontos de consumo (dois no turno do Conversador, um na
re-entrada determinística — que passa pela mesma cadeia e tinha de honrar a mesma preferência), e só
então o interruptor entrou na tela.

**Três estados, não dois.** Sem linha vale o ambiente: aplicar a migration não muda o comportamento
de quem já decidiu no `.env`. Colapsar num booleano com default `false` desligaria as duas camadas de
toda instalação que as tinha ligadas, no dia do deploy, em silêncio.

Tripla completa (0142 + apêndice antes da varredura anon + MANIFEST), `layer` sem CHECK na exceção de
vocabulário aberto, rota com client de sessão deixando a RLS fazer a tenancy.

### 11 · As três medidas da spec §7 existem, e estão na tela · `d41e5133`

Saem do `event_log` que o C3 passou a gravar — o payload foi escolhido para que cada uma seja uma
contagem, não uma varredura. **"Quitadas" virou "assumidas"**, porque o sistema não sabe se a promessa
foi cumprida; publicar "quitadas" seria o mesmo defeito do aviso antigo, em forma de número.

### 12 · O gate da FIAÇÃO — a lacuna que a sabotagem achou · `2cbe84f5`

Desfiz a leitura da escolha no motor e rodei a rede inteira: **13 testes, nenhum vermelho**. O teste
puro guardava a regra, o invariante o schema, o componente e o e2e a tela — e ninguém guardava o que
liga uma coisa na outra. Sem esse gate, o interruptor podia voltar a ser decorativo num refactor, que
é precisamente o defeito que 6b existe para não cometer.

### 13 · A chave do turno, o enfileiramento condicional e o silêncio da falha · `01069858`

O **P2**, quatro dos sete consertos. A leitura do Operador era "o mais recente do lead": entre o fim
do turno N e o claim do job do Operador N cabe o turno N+1 inteiro (a fila ordena por `run_after`, o
job do Operador nasce com `now()` e o inbound com `now() + 8s`), então ele acordava lendo a declaração
N+1 — mesma promessa executada duas vezes. A chave sempre viajou no payload e era usada só como campo
de log: classe **"chave presente, chave não usada"**.

Também: enfileirar passou a ser decisão (era implícita em "sempre", e custava um job, um slot de
concorrência e a vaga do lead no claim por turno, mesmo com o papel desligado — o default); a falha ao
enfileirar virou aviso na Central em vez de linha de log; e as duas frases que o repo afirmava e o
código negava saíram.

**Consertei a fixture da rede vizinha**, sem o que ela passaria a medir nada: o checkpoint tinha
`job_id = null` e a leitura por chave não o acharia.

Sabotagens: previ 1 e 2, vieram **1 e 3** — o caso do turno órfão também depende da chave, e eu não
contei com ele.

### 14 · O segundo turno entra no mapa, e o gate perde o ponto cego · `8e5dcdac`

O **P4**. O mapa dizia "cadeia de 7 gates" (são 10) e uma chamada de modelo por mensagem (são 2), e
não conhecia o segundo turno. 21→24 nós, 26→33 arestas, 10→13 faixas, cada aresta com evidência em
arquivo:linha. O gate filtrava `.architecture.json` e por isso **não olhava o mapa do turno** — foi
por essa fresta que as frases envelheceram.

Duas coisas que a sabotagem ensinou: o artefato pronto **reproduzia** a frase "incondicional" que o C4
tinha acabado de corrigir (o defeito da P4 dentro da própria P4), e a primeira versão do meu gate
fazia `includes` no JSON inteiro — passava com o nó do Operador apagado, porque o nome do kind aparece
na prosa de um card. Aceitar menção em vez de peça é medir o proxy.

## Triagem completa das 4 falhas do e2e

| spec | causa | ação |
|---|---|---|
| `degradacao-silenciosa:84` | **falha esperada** — `test.fail()`, a catraca da lacuna declarada. Aparece com ✘ e não conta como falha | nenhuma; a catraca está funcionando |
| `escalacao-ciclo:128` | fixture apagada pelo re-seed + `--env-file=.env.local` | consertado (`3ebb6ba5`) |
| `prova-painel-provedores:77,139` | F3 exige catálogo de modelos que o CI não semeia | declarada em `FORA_DO_CI` com motivo (`c42b6553`) |
| `vps-fresh-onboarding:111` | WAHA + Redis + Resend + Nuvemshop | segue fora, declarada — é a P0 da doutrina de QA Visual |
| `olhar-telas-do-epico:110` | **429 em todas as 7 telas** — não era limitador nenhum deste app: era o SDK do Sentry mandando 2 sessões de release health por navegação para o DSN da comunidade, cuja organização estava suspensa por cota (`x-sentry-rate-limits: 60::organization:suspended`, categoria vazia = todas) | consertado (`77b4a486`) — ver a seção abaixo |

---

## O 429 que não era limitador — e as três hipóteses que caíram

Vale como registro porque o custo esteve todo no **instrumento**, não no defeito.

> **Convergência independente, registrada porque o git não a registra.** Enquanto esta
> frente media, outra sessão chegou à MESMA causa raiz e mergeou na `main` o
> `a60cae2d` (PR #220): `SENTRY_DSN: "off"` no workflow do e2e e no `perf.yml`. O merge
> da `main` para dentro desta branch **não deu conflito** — as duas correções tocam
> regiões diferentes do mesmo arquivo —, então a duplicação passaria calada. Os dois
> consertos são complementares: o dele desliga a telemetria **no ambiente do CI**; o
> daqui conserta **o produto**, que mandava sessão de toda instalação self-host. Nenhum
> torna o outro dispensável, e o meu run verde não pegou carona no dele (a branch não
> tinha as linhas dele; o verde veio do gerador do `.env.e2e`).

A spec cobra "a tela não cospe erro no console". Reprovava com 429 nas 7 telas, e a
mensagem que o browser dá para requisição barrada é `Failed to load resource: the
server responded with a status of 429` — que **não diz quem respondeu**. A spec
descartava `m.location()`, o relatório do CI não guarda trace, e assim a única cópia
do endereço morria no listener. Três runs foram gastos adivinhando o dono de um 429
cuja URL o próprio teste tinha em mãos.

Hipóteses derrubadas por medição, na ordem:

1. *"a parte 2 está sobrecarregada"* — caiu de 69 para 53 testes, falha byte-idêntica.
2. *"as specs anteriores exaurem o contador"* — posta em primeiro lugar, contador
   limpo, mesmas 7 telas em 429, inclusive a primeira. (E `workers: 1`, então a spec
   rodou isolada de fato.)
3. *"é o fallback em memória do limitador"* — foi a pista que eu deixei escrita no
   workflow. **Medido no job real: 120 quedas para memória, 103 no bucket
   `auth:login:ip`, contra teto de 1000.** O limitador não barrou nada; o fallback é
   por chave e por janela, e estava correto.

Com a URL capturada, o dono apareceu na primeira medição: `/monitoring`, o túnel do
Sentry. Percurso de 7 telas: 19 requisições, 17 respostas, **todas 429**, e o corpo de
cada envelope era `{"type":"session"}` com `errors: 0`.

**A causa raiz é uma política declarada que não estava em vigor.** `isCommunityDsn`
diz "no Sentry da comunidade, só erro", e duas torneiras foram fechadas
(`tracesSampleRate`, `replaysSessionSampleRate`). A terceira ficou fora da conta:
`browserSessionIntegration` é **default** do `@sentry/browser`, com
`lifecycle: "route"` — cada navegação fecha uma sessão e abre outra. Passou porque
`integrations: [x]` **soma** aos defaults do SDK; só a forma de função os substitui, e
essa diferença não aparece em tipo, em lint, nem em teste que não abra um browser.

Consertado em `77b4a486`: `integracoesDoCliente` tira a `BrowserSession` quando o DSN
é o da comunidade (e mantém tudo para quem aponta o próprio Sentry — mesma assimetria
das amostragens); o `init` passa a função; o gerador do `.env.e2e` escreve
`SENTRY_DSN=off`, porque a suíte não pode mandar dado ao Sentry de produção do projeto
nem depender do estado de cobrança de um terceiro. **Consequência aceita e declarada:**
com `off` a suíte deixa de exercitar a política, então quem a guarda é
`tests/unit/sentry-comunidade-so-erro.test.ts` (9 casos; sabotagem prevista 2/2/1/1 e
medida 2/2/1/1).

Prova de comportamento, mesmo percurso e com o DSN da comunidade ainda ativo: **0
requisições ao túnel** (eram 19) e spec verde em 44s.

**O que isto deixa em aberto, e não é pequeno:** enquanto a organização do Sentry
estiver suspensa, a telemetria de comunidade que justifica o DSN default **não entrega
nada** — erro real de instalação real é descartado no ingest. Isso é decisão de conta,
fora do código.

---

## Medido e NÃO consertado (declarado, não escondido)

| # | o quê | por que ficou |
|---|---|---|
| 1 | **`followup.scheduled` perde auditoria** — `api_audit_log_actor_api_token_id_fkey`, 2× na corrida | Investiguei e a hipótese óbvia está **errada**: `revokeEphemeralToken` faz `update revoked_at`, não delete, e o FK é `ON DELETE SET NULL`; nenhum código do repo apaga de `api_tokens` (sonda com controle positivo: 11 arquivos usam a tabela). É um token id que nunca existiu, e não consegui estabelecer a causa. Fica com a evidência, sem história por cima |
| ~~2~~ | ~~O desfecho do Operador não é persistido~~ | ✅ `9f5a7ee7` |
| ~~3~~ | ~~O aviso de promessa afirma sem apurar, e sem dedup~~ | ✅ `9f5a7ee7` |
| ~~4~~ | ~~O terceiro papel não existe como papel~~ | ✅ `da6c250e` (6a) + `d41e5133` (6b, com o motor lendo a escolha) |
| ~~5~~ | ~~O mapa vivo não recebeu o Operador~~ | ✅ `8e5dcdac` |
| 6 | **A projeção nunca arma num agente real** — `turnoProjeta` exige zero ferramenta de catálogo; o pacote "atender" tem 18 e 17 sobrevivem ao passo 6 | **P2-C5, e o cético REPROVOU o plano de execução** (o teste proposto era auto-referente; o conserto muda o prompt de todo agente empacotado e exige prova por turno real, DoD 12). Refazer com as 4 amarras dele antes de aplicar — não é conserto para véspera de PR |
| 9 | Identificador cru no prompt: índice de notas por uuid (P2-C6) e o `case_id` anunciado na prosa (P2-C7) | planejados e revisados; C7 é aplicável sozinho, C6 muda formato que agentes publicados já aprenderam (a tolerância aos dois formatos é parte do conserto) |
| ~~7~~ | ~~As três métricas da spec §7~~ | ✅ `d41e5133` — no painel do próprio papel |
| 8 | Nenhum turno de produção observado com worker real | não houve chave de IA nesta máquina |

---

## O que executar em seguida, na ordem

Cinco planos completos, cada um já passado por um cético (causa raiz, edição, teste, sabotagem com
contagem prevista e copy em pt-BR). **Ordem entre partições importa** porque P5 e P3 consomem dados que
P1 e P2 criam.

**P1 — o handler do Operador** (`operator-turn.ts`, `repository.ts`, `agent-inbox-copy.ts` + tripla)
1. `insertInboxItem` ganha chave de dedup opcional — chave certa é `kind + ref_id + status='open'`, não `kind` org-wide (essa engoliria a promessa de outra conversa)
2. ~~guarda de handoff~~ ✅ `ec9a6faa`
3. o desfecho passa a existir e o aviso passa a **apurar** antes de afirmar — capturar o retorno de `runModelCall`, ler as tool calls por `steps` (nunca `result.toolCalls`, que é só o último step)
4. `sem_agente` deixa de pular antes de apurar (é o caminho da instalação fresca)
5. a falha de capacidade do Operador ganha kind e voz próprios — **atômico**: migration (agora **0132**, a 0131 é minha) + apêndice no bloco único do baseline + MANIFEST + union TS

**P2 — o disparo, a chave e o identificador no prompt**
1. o Operador lê o checkpoint **do seu turno**, pela chave que já viaja (`origin_job_id`, hoje usada só em log)
2. com o papel desligado, o turno não enfileira nada (hoje toda instalação paga +1 job por turno, ocupando a *lane* do lead)
3. falha ao enfileirar vira aviso na Central
4. as duas afirmações falsas saem do repo
5. a projeção deixa de ser interruptor de turno e passa a ser allowlist de identificador
6. o índice de notas cita a nota por apelido, não por uuid
7. o teste passa a medir o **prompt montado**, não a função pura

**P3 — enforcement** (1 e 2 ✅ feitos; restam 3 a 6: amplitude do gate de mapas, gate de guarda de
handoff em todo handler, gate de membro morto, gate de dedup na Central)

**P4 — o mapa vivo** (4 itens) · **P5 — o papel aparece na tela** (8 itens, sendo C6 o painel de Segurança)

---

## Regras desta frente

1. **Commitar antes de sabotar.** Eu perdi dois consertos para um `git checkout` de sabotagem nesta
   sessão — a lição já estava escrita e eu a repeti.
2. **Prever a contagem de reprovações antes de rodar.** Reprovar menos que o previsto denuncia
   mecanismo redundante; reprovar mais denuncia que você não entendeu o que ligou.
3. **Exit code sem pipe.** `cmd | tail` devolve o exit do `tail`.
4. **Afrouxar gate exige controle positivo** provando que ele ainda morde.
5. **Sonda de ausência precisa de controle positivo.** `grep` por um nome chutado devolve 0 e é
   indistinguível de "não existe" — aconteceu duas vezes aqui (o glob que o zsh comeu, o regex
   `\bid\b` que não casa `leadId`).
