# HANDOFF — A conversa vira lead (spec 17)

> Branch `feat/conversa-vira-lead`, empilhada sobre `feat/tres-papeis-do-agente` (spec 16, PR #181).
> Worktree `/Users/rafaelmelgaco/DeskcommCRM-tres-papeis`. Spec:
> [`docs/specs/17-spec-conversa-vira-lead.md`](docs/specs/17-spec-conversa-vira-lead.md).
> Antecessor: [`HANDOFF-tres-papeis.md`](HANDOFF-tres-papeis.md) — as regras de trabalho ao final
> daquele arquivo continuam valendo aqui.

---

## Estado por passo

| # | passo | estado |
|---|---|---|
| 1 | **conversa vira lead** | ✅ **completo** — código, invariantes, prova de tela e 5 sabotagens |
| 2 | contato deixa de ser anônimo | ✅ **completo** — 3 bugs vivos, telefone do @lid, rótulo único, título do card e a fila de confirmação ponta a ponta |
| 3 | escopo por pipeline | ✅ schema, gate, tela, aviso na Central e prova de tela |
| 4 | tradução de etapas com superfície | ✅ a lacuna aparece ao lado da marcação, e só onde custa |
| 5 | o laço (desfazer vira sinal) | ✅ detectado, registrado na timeline e agregado por etapa |

---

## Passo 1 — o que entrou (`ab36fe88`)

| arquivo | papel |
|---|---|
| `lib/leads/nascimento-do-lead.ts` | a regra: onde o lead nasce e quando **não** nasce |
| `lib/waha/ingest.ts` | a ligação, entre o STOP e o dispatch |
| `lib/leads/activity-vocabulary.ts` | `lead_created` → "Entrou pelo WhatsApp" |
| `tests/pg-como-supabase.ts` | adaptador que permite rodar código-Supabase contra o Postgres do `test:db` |
| `tests/invariants/nascimento-do-lead.test.ts` | 12 casos |
| `tests/invariants/pg-como-supabase.test.ts` | 6 casos — **o instrumento medido antes de medir** |

### A posição no ingest é a regra, não detalhe

`ingest.ts` → `markConversation` → **STOP** (grava `is_blocked`) → audit → **nascimento** → dispatch.

- **Depois do STOP:** quem acabou de pedir para sair não vira oportunidade. A função relê o contato,
  então a ordem é o que garante isso.
- **Antes do dispatch:** o turno do agente resolve o lead ativo do contato. Criar depois faria o
  primeiro turno rodar sem lead — o buraco que esta peça existe para fechar.
- **Grupo (`@g.us`)** nem chega aqui: `ingest.ts:374` já retorna antes.

---

## O que foi medido

### O defeito, na produção (2026-08-06)

| medida | valor |
|---|---:|
| conversas × leads | 32 × 15 |
| leads **sem contato vinculado** | 13 / 15 · 87% |
| código que insere em `crm_leads` a partir de conversa | **nenhum** |

### A suíte

`pnpm test:db` — **73 arquivos / 495 testes verdes** (os 2 arquivos novos são +18 casos).
`pnpm typecheck` e `pnpm lint` zerados (185 warnings pré-existentes, 0 erros).

### As sabotagens — predição declarada ANTES de rodar

| # | o que foi quebrado | previsto | medido | quais |
|---|---|---:|---:|---|
| S1 | filtro `status='open'` do lead existente | 1 | **1** | "depois de FECHADO … abre demanda nova" |
| S2 | filtros `is_won`/`is_lost` da escolha de etapa | 2 | **2** | "sem_etapa" e "'Ganho' na posição 0" |
| S3 | recusa por contato bloqueado | 1 | **1** | "quem pediu para sair não vira oportunidade" |
| S4 | `.eq()` do **adaptador** virou no-op | ≥10 (≥2 no instrumento) | **12** (3 no instrumento) | — |
| S5 | `funilDeEntrada` nunca acha o funil (**e2e**) | 3 | **3** | os três casos da prova de tela |

S4 é o que responde "e se o adaptador mentir?": um filtro ignorado derruba 12 dos 18 casos, e 3
deles são do teste do próprio adaptador.

S5 é o controle da prova de tela: os 3 casos passam em ~2s cada, e verde rápido demais merece
desconfiança. Com o nascimento desligado eles levam 22s, 30s e 22s — o tempo do timeout — e
reprovam. O spec mede o card nascendo, não outra coisa que já estivesse na tela.

### Um instrumento morto no caminho, registrado

A primeira rodada de S1 chamou `bash scripts/test-db.sh` direto — `vitest` não estava no PATH, o
script morreu com 127, e o `grep` sobre a saída devolveu **vazio**. Vazio e "nenhum teste reprovou"
têm a mesma cara. Só apareceu porque o exit code foi conferido separado da contagem.

---

## A prova de tela

`tests/e2e/conversa-vira-lead.spec.ts` — **3/3 verdes**. A mensagem entra por
`POST /api/v1/webhooks/waha/[token]`, a mesma rota que o WAHA chama, **sem header de assinatura**
(que é como o WAHA Core real chega). Nenhum `insert` direto em `crm_leads`: insert à mão mente
sobre a origem e provaria só que a tela desenha uma linha que alguém pôs no banco.

| # | o que prova |
|---|---|
| 1 | card no quadro do funil de entrada, com o NOME de quem escreveu — e zero `@c.us`/`@lid` na tela |
| 2 | a timeline diz **"Entrou pelo WhatsApp"** |
| 3 | a segunda mensagem do mesmo contato **não** abre um segundo card |

Evidência: [`evidence/spec-17/card-nascido-da-conversa.png`](evidence/spec-17/card-nascido-da-conversa.png).
Registrada no CI (`e2e.yml`, parte 1) e no mapa de jornadas (J4.22–J4.25).

Ambiente: Supabase local (`.env.e2e`, 127.0.0.1:54321) + `next build` + `next start`. **Sem
`.env.local` nesta worktree** — nenhum risco de escrever na produção.

---

## Passo 2 — o contato deixa de ser anônimo

O passo 2 **não era o que a spec dizia**, e as medições mudaram o trabalho três vezes.

### O que a produção respondeu (31 contatos ativos, leitura em 2026-08-06)

| medida | valor | o que isso derruba |
|---|---:|---|
| sem telefone | 22/31 · **71%** | todos com identidade `lid:` |
| sem e-mail | 25/31 · 81% | |
| `display_name` técnico | **3**/31 | e os três com `notify_name` VAZIO — **não há nome a recuperar** |
| mensagens de cliente COM nome no payload | **269 de 271 · 99,3%** | o nome **não** é o problema |
| payloads `@lid` que trazem o TELEFONE | **76 de 76 · 100%** | o telefone sempre chegou |

### Fatia A — três bugs vivos, uma classe (`10a3560f`, `39a7f8f2`)

O Postgres recusa atribuição a coluna `GENERATED ALWAYS … STORED` (428C9) e **aborta a instrução
inteira**. Três instâncias, cada uma provada contra Postgres real com controle positivo:

| onde | o que quebrava |
|---|---|
| `contacts/_handler.ts` | **salvar o e-mail de um contato pela tela → 500.** É o "não registra o número e email dele" do relato |
| `lgpd/anonymize/route.ts` | **a anonimização LGPD não acontecia** — direito do titular, com prazo legal |
| `waha/ingest.ts` | fim do warm-up abortava o UPDATE e levava junto o `status` do canal |

O que entra de verdade é o **gate**: `colunas-geradas-nao-sao-escritas.test.ts` PERGUNTA ao Postgres
quais colunas são geradas e varre `app/`, `lib/`, `scripts/`. O detector custou duas versões — a
primeira acusou 11 falsos positivos (declaração de tipo, montagem de resposta HTTP), e gate que
grita onde não há defeito é gate que alguém desliga.

Prova de tela: [`evidence/spec-17/contato-com-email-salvo.png`](evidence/spec-17/contato-com-email-salvo.png)
(`contato-salva-email.spec.ts`, J4.26–J4.27).

### Fatia B — o telefone que sempre chegou (migration 0122)

```
"_data": { "key": {
    "remoteJid":    "70192801575156@lid",
    "remoteJidAlt": "558183647258@s.whatsapp.net",
    "addressingMode": "lid" } }
```

A resposta estava em `webhook_events_log`, não na documentação. **Inbound 56/56 e outbound 20/20**
trazem o número — e no outbound o `remoteJid` é o chat do destinatário, então o telefone é do
cliente, não da loja (só o **nome** continua bloqueado ali, porque o `pushName` de `fromMe` é do
operador).

**Gravar o telefone, porém, quebrava o CRM.** `wa_identity` é gerada com o telefone na frente do
lid: preencher `phone_number` num contato nascido `lid` muda a identidade de `lid:X` para `phone:+Y`,
o `on conflict` deixa de casar e **nasce um contato duplicado** — o defeito que a 0027 matou. Daí
`contacts.wa_lid`: correlação do WhatsApp que não depende do telefone, com índice único e dedup
auto-curativa ANTES da constraint.

**E o canal de envio não muda.** `resolveWahaChatId` preferia telefone; com o número gravado, toda
conversa `@lid` viva passaria a sair por `@c.us` — que para contato em modo privacidade
frequentemente não é endereçável. O sintoma seria pior que um erro: mensagem marcada como enviada e
cliente sem resposta. O `lid` passou para a frente, e o **mesmo raciocínio estava numa quarta
instância** (`session-reconciler.ts`), que reenvia o que ficou preso — divergir ali faria o redrive
mandar para um endereço diferente do envio original.

`fn_upsert_wa_contact` ganhou o 7º parâmetro e mudou de regra: antes só mexia em `display_name` no
conflito, com `coalesce` — nome ruim congelava para sempre e nada descoberto depois entrava. Agora
**completa o que falta e nunca sobrescreve**, e reencontra por lid *ou* por telefone (é isso que
impede o cliente já importado de virar um segundo contato ao escrever no WhatsApp).

### O que o mapeamento derrubou

- **`Contato 543134@lid` é legado, não bug vivo.** Nenhum código no HEAD produz a string; o produtor
  morreu no commit `c890b403`. São 3 linhas de resíduo — backfill, não conserto de emissor.
- **O `pushName` não está na raiz do payload.** A hipótese de que o WAHA mandava o nome num campo que
  o código ignorava era a "causa candidata nº 1" — e é falsa: o nome vem em `_data.pushName`, onde o
  código já olha, em 341 de 343 payloads.
- **O regex `^Contato ` colide com `Contato Anonimizado #…`**, que a rota LGPD grava de propósito. O
  backfill leva `and is_anonymized = false` — sem isso, ele reverteria anonimizações (regra L-04,
  exceção "Nenhuma"). Tem caso de teste próprio.

### As sabotagens da Fatia B — predição declarada antes de rodar

| # | o que foi quebrado | previsto | medido |
|---|---|---:|---:|
| B1 | reencontro por `wa_lid` | 2 | **4** |
| B2 | reencontro por telefone | 1 | **1** |
| B3 | telefone SOBRESCREVE em vez de completar | 1 | **1** |
| B4 | guarda `is_anonymized` do backfill | 1 | **0 → 1** |
| B5 | âncora de dígitos do regex | 1 | **1** |
| C1 | telefone volta na frente do lid no envio | 1 | **1** |
| C2 | extrator aceita `@lid` como telefone | 1 | **1** |
| C3 | extrator ignora a faixa E.164 | 1 | **1** |

**B1 reprovou mais que o previsto, e o motivo importa:** eu tinha calculado que
alguns casos "passariam por acidente" ao cair no INSERT. Não passam — o índice
único `uniq_contacts_org_wa_lid` recusa o segundo INSERT com o mesmo lid, então
a função estoura. O crédito era do índice, não do lookup; os dois trabalham.

**B4 reprovou ZERO na primeira tentativa — e era o teste que estava errado.** Ele
executava uma CÓPIA do `update` escrita dentro do próprio arquivo, então sabotar
o `baseline.sql` não o afetava: eu testava a réplica, não o artefato que o
self-hoster aplica. Agora o comando é EXTRAÍDO do baseline em tempo de teste
(com guarda que estoura se achar zero ou mais de um).

Corrigido isso, B4 **ainda** passava — e a segunda razão é outra: `Contato
Anonimizado #<hex>` não casa com o regex ancorado em dígitos, ou seja, o regex
sozinho já protegia e eu creditava a proteção à guarda. Foi preciso um caso que
ISOLE a guarda (contato anonimizado com nome que CASA o regex) para que ela
passe a ser vigiada de fato. Dois mecanismos redundantes, e o teste apontava
para o errado.

### Medições

`pnpm test:db` **75 arquivos / 511 testes** · `pnpm test:unit` **285 / 2935** · `pnpm test:unit` 284 arquivos · typecheck e lint zerados.
19 casos novos entre `telefone-do-lid.test.ts` (banco) e `telefone-alternativo-do-payload.test.ts`
(unit, com payloads TRANSCRITOS da produção — ninguém teria inventado o nome `remoteJidAlt`).

### Fatia C — o rótulo do contato, e o título do card (`42d53ea6`, `41afbe6e`)

Eram **seis** cópias da cadeia `display_name || name || phone_number || <literal>`, com **quatro**
finais diferentes — e duas delas (ficha do contato, tabela de contatos) **nem usavam o telefone**:
quem tinha número e não tinha nome aparecia como "Sem nome" numa tela e com o número em outra.

`lib/contacts/rotulo-do-contato.ts` é a decisão única, com a regra que nenhuma das seis tinha:
**identificador técnico não é nome de gente**. E o commit traz o **gate** junto — um caso varre
`app/`, `lib/` e `components/` atrás da assinatura da cadeia, para que a sétima cópia reprove em
vez de nascer com um quinto final.

Isso destravou um defeito do passo 1: o título do card vinha do PAYLOAD. Como o WAHA manda inbound
sem `pushName` (2 de 271) e TODO ack assim, um cliente conhecido abria card "Novo contato pelo
WhatsApp". Agora vem do cadastro, pela mesma função das telas — título e inbox não podem divergir.

E o comentário que estava naquela linha **mentia**: dizia que "o chamador garante" que o nome não é
técnico, e o chamador passava o payload cru. Typecheck e testes verdes com a afirmação falsa
versionada.

### Fatia D — a fila de confirmação (spec 17 §4b)

**Duas decisões do Rafael**, registradas na spec antes de codar: (a) o dado que o cliente diz vai
para uma FILA, um humano confirma; (b) a base legal ficou a meu critério.

**Escolhi aplicar, não inventar.** A regra **L-05** já nomeia as finalidades (`marketing` /
`transactional` / `profiling`) e o campo `consent.<finalidade>.granted_at`, e sua exceção já cobre o
transacional iniciado pelo próprio cliente. E o formato do jsonb também já existia:
`export-collector.ts:197` **lê** `{escopo:{granted,granted_at,source}}` — o leitor estava lá e o
escritor nunca foi escrito.

#### D1 — o pré-requisito, que já era defeito (`84cd750e`)

| regra | o que o código fazia | agora |
|---|---|---|
| **L-05** | `patch.consent = input.consent` — o objeto INTEIRO | merge por finalidade: gravar `transactional` deixou de apagar `marketing` |
| **L-06** (exceção "Nenhuma") | audit gravava só os NOMES dos campos | `old_`/`new_` dos campos sensíveis, grafia do `team.role_changed`, que já tem guarda |

Perda de consentimento não dá erro — é a base legal de um envio futuro sumindo em silêncio. E sem o
valor anterior, um e-mail dito de brincadeira apaga o correto sem volta, que é o risco que a fila
existe para conter.

**O adaptador `pg-como-supabase` ganhou `update` e `rpc`** — e ganhou porque **ESTOUROU** ao ser
chamado, em vez de devolver vazio. Se tivesse devolvido vazio, os 7 casos novos ficariam verdes
medindo nada.

**O `from/to` não é medido contra Postgres, e isso está declarado:** `audit()` cria o próprio client
admin e o config de teste aponta para porta inalcançável de propósito. Descobri porque o controle
positivo ("a tabela RECEBE a linha") reprovou junto com os outros — ele separou "o campo não está
lá" de "a LINHA não está lá". A cobertura foi para um unit que espia a chamada.

| # | sabotagem | previsto | medido |
|---|---|---:|---:|
| S1 | consent volta a substituir | 2 | **1** (o caso "atualiza" não isola o merge) |
| S2 | audit sem o par antes/depois | 3 | **4** |
| S3 | `update` do adaptador vira no-op | ≥3 | **0 → 6** (filtro inválido devolveu "No test files found") |

#### D2..D6 — construído

| # | peça | commit |
|---|---|---|
| D2 | tabela `contact_field_proposals` (0123) | `03d06e09` |
| D3 | ferramenta de catálogo `crm_propose_contact_field` | `a299c792` |
| D4+D5 | rota de decisão + a tela na ficha do contato | `0b69c542` |
| D6 | o vencimento (0124 + cron agendado) | este |

**A fila fecha o ciclo:** a IA ouve e propõe, a pessoa vê o trecho da conversa e decide, o dado entra
no cadastro com base legal (`transactional`, L-05) e auditoria dos dois lados (L-06), e o que ninguém
decide **vence** — porque prazo que ninguém cobre é pior que prazo nenhum: promete um limite que não
existe e a pendência vira badge permanente, que simula atenção e adia a decisão.

Prova de tela: [`evidence/spec-17/proposta-confirmada.png`](evidence/spec-17/proposta-confirmada.png)
(`confirmar-dado-do-contato.spec.ts`, J4.28–J4.30).

**O e2e passou pelo motivo errado na primeira versão**, e só a evidência pegou: `getByText(email)`
casava com o TRECHO da conversa (que contém o próprio e-mail), então ficava verde sem o dado ter
chegado à ficha. Descobri **olhando a imagem**, que mostrava o campo EMAIL vazio enquanto o teste
dizia verde.

**O vencimento tem cron PRÓPRIO, e não carona no `risk-watcher`.** A tentação era pendurar no que já
varre organizações no mesmo tick — mas ele lista quem tem LEAD ABERTO, e uma organização pode ter
proposta pendente sem nenhum negócio no funil. Nessas, a proposta nunca venceria, e "nada venceu"
tem a mesma cara de "nada vencia ainda". O gate `cron-routes-scheduled` garante que a rota nasceu
agendada: o comentário do `risk-watcher` conta o que aconteceu sem isso — uma rota com teste e doc
que ninguém chamou, por meses.

**O adaptador de teste cresceu por PRESSÃO, três vezes.** `update`, `rpc`, `lt`/`gt` e
`insert().select().maybeSingle()` só existem porque o `naoImplementado` ESTOUROU quando o código real
os chamou. Se ele tivesse devolvido vazio, 7 casos de vencimento ficariam verdes medindo nada —
"nenhuma proposta vencida" é o resultado natural de uma lista vazia.

#### As sabotagens do vencimento — predição declarada antes de rodar

| # | o que foi quebrado | previsto | medido |
|---|---|---:|---:|
| V1 | filtro de prazo (`expires_at < agora`) | 1 | **3** |
| V2 | carimbo de `decided_at` ao vencer | 1 | **4** |
| V3 | reuso do aviso aberto na Central | 2 | **1** |

**Errei as duas primeiras para MENOS, e a razão é a mesma nas duas: cascateamento.** Sem o filtro de
prazo, tudo vence e a contagem do lote quebra junto; sem o carimbo, o CHECK `decisao_datada` recusa
o UPDATE e NADA vence, derrubando todos os casos que dependem de algo ter vencido. Prever a
contagem serve justamente para isso — cada divergência ensinou onde os mecanismos se apoiam.

#### O que ficou FORA da fatia D



O desenho saiu do mapeamento e **copia a forma de `crm_lead_reactivations`**, que já é uma fila de
proposta com prazo, decisão datada, decisor e idempotência por índice parcial:

| # | peça | nota |
|---|---|---|
| D2 | tabela `contact_field_proposals` (migration **0123**) | índice único parcial `where status='pending'` É a idempotência — a décima proposta do mesmo e-mail bate 23505 no banco, não numa checagem racy |
| D3 | ferramenta **de catálogo** `crm_propose_contact_field` | **não pode ser nativa:** o Operador tem ZERO tools nativas e só chama o modelo se `mcp !== null`; nativa não entraria na tela de configuração, no audit `mcp.tool_called` nem na telemetria |
| D4 | rota de confirmar/rejeitar | grava chamando o **handler de contatos**, que já barra contato anonimizado com 403 — L-04 sai de graça |
| D5 | a tela onde o humano confirma | + kind na Central só para o **vencimento** agregado |

Também precisa entrar no cascade de `fn_lgpd_cascade_redact_contact`, no mesmo commit da criação.

---

## Passo 3 — o agente só escreve nos funis marcados

### O que foi medido (produção, 2026-08-07)

Uma **única organização** com **4 funis e 5 agentes de negócios diferentes** — um SDR de vendas,
dois de suporte ao produto e uma atendente de clínica. Funis: `Pedidos` (padrão),
`Comercial - Andrea`, `Comercial - Julia`, `Suporte - IA`. Qualquer um dos cinco alcançava qualquer
um dos quatro.

E não só "mover card": `crm_close_demand` dá o negócio por ganho/perdido (tira do radar e das
cobranças) e `crm_manage_tags` marca o card alheio. Um escopo que cobrisse só a movimentação
protegeria o menos importante.

**Ainda não aconteceu:** a IA só tocou o funil padrão (4 registros) e nenhum negócio tem a IA como
dono. Porta aberta que ninguém atravessou — a melhor hora para fechá-la, sem estado sujo para migrar.

### 🔴 O que apareceu no caminho: vazamento ENTRE ORGANIZAÇÕES

Mapeando os caminhos, achei três furos **piores** que o escopo de funil (`a687a97c`, `db0e70eb`):

| ferramenta | o que fazia |
|---|---|
| ver negócio | **lia** o negócio de outro cliente |
| editar negócio | **reescrevia** o negócio de outro cliente (o teste provou pelo título) |
| listar negócios | entregava ao modelo os negócios de **todos** os clientes do banco |

Anti-pattern 10 do CLAUDE.md: o MCP injeta service-role, que bypassa RLS, e os handlers não
filtravam `organization_id`. Agravante na edição: o audit era gravado **no log da vítima**.

**Ler o código não bastava** — contar menções de `organization_id` devolve 5 para um handler que
não o usava em filtro nenhum. Só medir comportamento com dois tenants resolveu.

**E meu próprio teste mentiu verde, em duas camadas:** `.catch(() => null)` transformava exceção em
lista vazia, e eu lia `r.data` quando o campo é `r.leads`. "Não vazou" passava mesmo vazando.

### O desenho

| decisão | por quê |
|---|---|
| coluna em `ai_agent_versions` | a permissão sobe junto com o resto quando alguém PUBLICA; fora do ciclo rascunho→publicar, o alcance mudaria sem ninguém publicar nada |
| nasce fechado por DUAS origens | `default '{}'` para o agente novo, `?? []` para o clone sem a migration |
| **backfill derivado do histórico** | sem ele, no dia do deploy todo agente pararia de mexer em card, de uma vez. Medido: só 1 de 8 tem histórico |
| gate numa função PURA, chamada onde se sabe que é o agente | os handlers são compartilhados com a rota HTTP e com as automações, onde o funil foi escolhido por um humano de propósito |
| escrita não classificada é **recusada** | impede a ferramenta nº 22 de nascer fora do gate; com teste de vacuidade + controle positivo |
| erro de consulta vira `indisponivel`, nunca "fora do escopo" | traduzir falha de banco em recusa de permissão ensinaria ao modelo que o card não é dele — e ele pararia de tentar para sempre |

**Conserto obrigatório que veio junto:** `fn_ai_agent_version_content_immutable` parava no campo
`followup` e ignorava as **nove** colunas posteriores — todas editáveis numa versão PUBLICADA, sem
virar versão nova e sem trilha. Acrescentar uma PERMISSÃO àquela lista sem consertar isso seria a
própria ausência de escopo, com aparência de controle.

### As sabotagens

| # | o que foi quebrado | previsto | medido |
|---|---|---:|---:|
| X1 | filtro de org no `getLeadHandler` | 1 | **1** |
| X2 | filtro de org no UPDATE (mantendo o do SELECT) | 0 | **0** — declarado: é defesa em profundidade, não vigiada |
| X3 | os dois filtros do update | 1 | **1** |
| X4 | filtro de org na listagem | 1 | **1** |
| S1 | escopo vazio passa a significar TODOS | 3+ | **3** |
| S2 | some o aviso do funil de entrada | 1 | **1** |
| S3 | vacuidade libera o desconhecido | 1 | **1** |

---

## Passos 4 e 5 — a superfície da lacuna e o laço

### Passo 4 — a lacuna de tradução aparece ONDE CUSTA

Medido: 6 de 36 etapas traduzidas, e **três dos quatro funis com ZERO**. Neles o assistente não sabe
para onde mover, e a única forma de descobrir era entrar funil por funil na tela de configuração.

**O passo 3 criou o lugar certo para essa cobrança.** Funil MARCADO sem tradução é promessa que não
se cumpre — o dono marcou achando que o assistente ia organizá-lo. A lacuna passa a aparecer ao lado
da marcação, no momento da decisão. E **só ali**: funil fora do escopo com a mesma lacuna fica
quieto, porque ninguém prometeu nada sobre ele.

Duas distinções que evitam alarme constante: **mudo ≠ incompleto** (com 3 de 5 ele percorre em
parte; com 0 não move nada, nunca) e `won`/`lost` fora da conta (têm coluna própria — cobrá-las
inflaria a lacuna com pendência que não existe, e uma barra que nunca chega a 100% se aprende a
ignorar).

### Passo 5 — o laço (invariante 7)

Os passos 3 e 4 deram limite e visibilidade. Nenhum responde **o que muda quando o assistente
erra** — sem isso o produto tem caminho e não tem ciclo: a IA erra igual amanhã e alguém corrige de
novo, para sempre e em silêncio.

Um humano mover um card que a IA moveu **por último** vira atividade própria
(`agent_move_corrected`), com dois tipos que contam: **devolução** (voltou para onde estava — o
sinal mais forte) e **redirecionamento** ("não era ali", que ignorar perderia metade do sinal).

Metade dos casos de teste existe para o risco OPOSTO: se o movimento anterior foi de outro humano,
mexer no card é trabalho normal de equipe. Contar isso como "a IA errou" inflaria o número com
ruído — e indicador que sobe sem causa se aprende a ignorar.

E o agregado responde "e daí?" (invariante 5): não "12 correções", mas "12 em Qualificando, 11 delas
devoluções" — que diz que o assistente qualifica cedo demais, e o dono sabe o que ajustar.

### A prova de tela dos passos 3 e 4 (DoD 12) — feita em 2026-08-08

`tests/e2e/escopo-de-funil-do-agente.spec.ts`, 2/2 verde, e **na lista do workflow** (`e2e.yml`
linha 243) — prova nova fora do gate seria repetir o defeito que o spec do Operador registra.

A marcação nasce fechada e a tela **explica** em vez de deixar em branco:
[`evidence/spec-17/escopo-nasce-fechado.png`](evidence/spec-17/escopo-nasce-fechado.png). Depois de
marcar, salvar e **recarregar**, ela sobrevive — e o funil marcado sem tradução mostra a cobrança do
passo 4 ao lado do nome:
[`evidence/spec-17/escopo-sobrevive-ao-reload.png`](evidence/spec-17/escopo-sobrevive-ao-reload.png).

**O que as duas falhas do CI eram, e o que elas ensinaram.** Nenhuma era do produto:

1. `getByRole("button", {name: /operação/i})` nunca resolve — o botão diz **"Organiza o sistema"**.
   A tela fala a linguagem do dono do negócio; o rótulo não é o nome interno do papel.
2. O spec logava como **manager**, e só admin edita agente (`readOnly` em `page.tsx`). O sintoma era
   `check()` estourando num input que existe — lê como bug de UI e é permissão funcionando.

E três defeitos de infraestrutura de teste, consertados na classe:

| # | o quê | por que importava |
|---|---|---|
| 1 | `semearCredenciais()` reescreve o `.e2e-creds.json` INTEIRO | é chamado de DENTRO do login (TOTP rotacionado), então derrubava a fixture no meio da execução: o erro aparecia como "rode o seed antes" logo depois de um seed que imprimiu ✅. Afetava os 4 specs que usam o helper |
| 2 | `seed-e2e-capacidades` mandava rodar o pré-requisito | dentro de uma execução do Playwright ninguém pode "rodar antes" coisa alguma — agora ele roda |
| 3 | O seed repunha `tool_ids` e não `pipeline_ids` | mesmo defeito que o comentário do próprio arquivo documenta desde a issue #162: a 2ª execução media o resto da 1ª |

**Sabotagem.** Removi `pipeline_ids` da cópia de leitura (`page.tsx`) e previ 1 reprovação no gate
de colunas: medido **1 failed | 3 passed**. **Não medido:** a sabotagem do caso 2 do e2e (remoção de
TODAS as cópias, que só a tela pega) — o login com MFA não fecha a janela de 30 s com a máquina a
load 27, e o gate de colunas cobre apenas a remoção parcial.

**De brinde:** o banco local estava desatualizado e o sintoma foi `PGRST204` num seed. Reaplicar
`supabase/baseline.sql` em banco existente rodou com **0 erros** — que é o caminho `update.sh` do
clone, provado sem querer.

---

## O épico, em uma tabela

| passo | o que mudou para quem usa |
|---|---|
| 1 | quem escreve no WhatsApp **aparece no funil** — antes, conversa fora do CRM não era cobrada por ninguém |
| 2 | o contato tem **telefone** (o dado sempre chegou e era descartado), e salvar e-mail pela tela **funciona** |
| 3 | cada assistente só mexe **nos funis dele** — 5 agentes de negócios diferentes dividiam 4 funis |
| 4 | funil que o assistente **não sabe percorrer** é sinalizado onde a decisão é tomada |
| 5 | quando alguém **desfaz** o que a IA fez, isso vira sinal — o ciclo fecha |

### Defeitos achados no caminho (não estavam na spec)

| # | defeito | gravidade |
|---|---|---|
| 1 | **agente de uma organização lia e reescrevia negócio de outra** (3 furos) | 🔴 vazamento entre clientes |
| 2 | salvar e-mail de contato pela tela devolvia 500 | 🔴 o item nº 1 do relato original |
| 3 | **a anonimização LGPD não acontecia** | 🔴 direito do titular, com prazo legal |
| 4 | fim do warm-up abortava o UPDATE e congelava o estado do canal | 🟠 |
| 5 | consentimento se perdia ao gravar uma finalidade (apagava as outras) | 🟠 |
| 6 | auditoria não registrava valor anterior (exigência com exceção "Nenhuma") | 🟠 |
| 7 | nove configurações do agente editáveis em versão publicada, sem trilha | 🟠 |
| 8 | organização e agente que já atendeu **não podiam ser apagados** | 🟠 |
| 9 | `GET` com id inválido devolve 500 com a mensagem crua do Postgres | 🟡 declarado, não consertado |
| 10 | a mesma rota tem dois contratos de resposta | 🟡 declarado, não consertado |

---

## 🔧 BLOQUEIO DE INFRAESTRUTURA (não de código)

**O daemon do Docker parou de responder no meio da sessão.** Sintomas medidos:

- o container efêmero do `test:db` sobe e cai imediatamente;
- `docker version` não retorna em 20s;
- o Postgres local aceita conexão TCP (porta 54322 aberta) mas **não completa** conexão;
- `curl` no Supabase local (54321) devolve HTTP 000.

**Consequência:** `pnpm test:db` e toda prova de tela ficaram indisponíveis a partir daí. O que
continua medido: `typecheck`, `lint` e `pnpm test:unit`.

**O que ficou pendente na época — e como fechou (2026-08-08, Docker de volta):**

| # | o quê | desfecho |
|---|---|---|
| 1 | `veto-de-escopo-aparece.test.ts` (invariante novo, nunca rodou) | ✅ verde na suíte |
| 2 | `escopo-de-funil-schema.test.ts` sob suíte completa | ✅ verde na suíte |
| 3 | Prova de tela dos passos 3, 4 e 5 | ✅ passos 3 e 4 (spec acima, 2 evidências). **Passo 5 segue sem tela** — a correção humana é medida por invariante, não por jornada |
| 4 | `pnpm test:db` completo depois da 0125 | ✅ **81 arquivos, 574 passed \| 1 skipped**, exit 0, medido em `ac7f36d6` com árvore limpa |

### Ainda em aberto no passo 3

| # | o quê | por quê |
|---|---|---|
| 1 | O aviso na Central quando a IA é vetada | `fora_do_escopo` **não** pode entrar em `MIRROR_WARN_ONLY`: seria 100% dos movimentos vetados em silêncio no dia 1, e o dono leria como "a IA quebrou" |
| 2 | ~~Prova de tela (DoD 12)~~ | ✅ **fechado em 2026-08-08**: `escopo-de-funil-do-agente.spec.ts` faz salvar → recarregar → conferir, e entrou na lista do `e2e.yml`. (O spec do Operador, esse sim, continua fora de CI nenhum) |
| 3 | Escopo vale só para ESCRITA | declarado, não esquecido: a superfície de descoberta continua aberta (o modelo lê os negócios da org). Filtrar leitura é outro dia, atrás de medição do que quebra no contexto do turno |
| 4 | Funil marcado que é ARQUIVADO | `uuid[]` não tem cascade; a tela não mostra arquivado, então a marcação pode mentir sobre quantos funis valem |

### Ainda em aberto no passo 2

| # | o quê | por quê |
|---|---|---|
| 1 | **A mão do Operador** (salvar e-mail/nome dito na conversa) | **2 decisões são do Rafael:** (a) política de sobrescrita — um e-mail dito de brincadeira substitui o correto, e o audit atual grava só os NOMES dos campos, não from/to, o que a regra L-06 exige; (b) base legal — nenhum código do repo escreve `consent.<finalidade>`, e `lgpd.consent_changed` está declarado e nunca é emitido |
| 2 | Nenhum turno com WAHA real desde a 0122 | o telefone foi provado por payload gravado e por banco, não por mensagem nova ponta a ponta |
| 3 | `GET /api/v1/contacts/<id-invalido>` devolve **500 com a mensagem crua do Postgres** | achado de brinde; não é carona deste passo |
| 4 | A mesma rota tem **dois contratos**: POST devolve `{data:{contact}}`, GET devolve `{data}` | idem — uniformizar é mudança de contrato público |

### Um erro meu, reincidente e registrado

Na bateria de sabotagem da Fatia C escrevi um helper de shell com `git checkout <arquivo>` no fim e
o chamei várias vezes. O checkout ficou **escondido dentro da função** e apagou uma alteração que eu
tinha acabado de escrever e ainda não commitado. Já tenho memória sobre isto — reincidi porque a
memória falava do comando, e o que me pegou foi o FORMATO (o comando dentro de um helper repetido).

O sinal foi a sabotagem seguinte falhar ao aplicar e os testes reprovarem **com o código
restaurado**. Lidas só as contagens, as reprovações do T1 teriam sido registradas como prova — e
vieram do trabalho apagado, não da sabotagem. A memória foi reescrita com esse detalhe.

---

## 🔎 Achado que muda produto (fora do escopo do passo 1)

**Toda organização nasce com o funil "Pedidos", de e-commerce, com 8 etapas hardcoded** —
`fn_seed_default_pipeline_for_org` no baseline: *Carrinho abandonado · Aguardando pagamento · Pago ·
Em separação · Enviado · Entregue · Pós-venda · Cancelado*.

Como o funil de entrada é `is_default`, **numa clínica ou imobiliária recém-instalada o lead nasce
em "Carrinho abandonado"**. Antes do passo 1 isso era invisível (nenhum lead nascia sozinho); agora
é a primeira coisa que o dono vê no kanban.

Não foi mexido aqui: mudar o seed altera o comportamento de todo clone e é decisão de produto, não
consequência deste passo. É insumo direto do **passo 4** (a superfície precisa mostrar onde os
contatos entram e permitir trocar) e candidato a item próprio: um funil neutro de entrada, ou o
onboarding perguntando o nicho.

---

## Deixado para trás (declarado, não escondido)

| # | o quê | por quê | onde fecha |
|---|---|---|---|
| 1 | O adaptador não reproduz **RLS** | conecta como `postgres`; isolamento é medido pelos invariantes de papel restrito | declarado no cabeçalho do arquivo |
| 2 | Nenhum **turno do agente** observado com o lead já nascido | exige WAHA + worker vivos; a prova de tela cobre a ingestão, não o turno | passo 3 |
| 3 | Funil semeado é de e-commerce (acima) | decisão de produto | passo 4 |
| 4 | `sem_funil_de_entrada` e `sem_etapa` só viram **log** | não há aviso na Central para quem configura | passo 4 (superfície) |
| 5 | Lead nasce **sem dono** (`owner_kind` nulo) | atribuição tem regra própria (gov-loop) e misturar as duas aqui seria decidir por cima dela | a decidir no passo 3 |
