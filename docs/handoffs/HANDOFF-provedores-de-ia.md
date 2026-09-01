# HANDOFF — Provedores de IA: painel, logs e OpenRouter

> Documento **vivo**. Atualizado a cada avanço, cada bug encontrado e cada
> atividade deixada para trás. Quem assumir esta frente lê daqui.

- **Branch:** `feat/provedores-de-ia` · **Worktree:** `~/SonghaiCRM-provedores`
- **Base:** `9249e6f2` (`origin/main` em 2026-08-07)
- **Última atualização:** 2026-08-08 — quatro frentes entregues e **provadas na tela**; `test:db` completo verde

---

## O pedido, em uma frase

Três coisas em paralelo: (1) painel para configurar o provedor de IA de cada
ponto do sistema, (2) log completo das execuções de IA, (3) OpenRouter com
catálogo que se atualiza sozinho. As três são o mesmo problema visto de ângulos
diferentes — a camada de decisão de modelo não tem dono, nem superfície, nem
rastro.

### Decisões do Rafael (2026-08-07)

1. **Painel agrupado por papel**, com "configuração avançada" que permite
   escolher ponto a ponto. Razão declarada por ele: vem aí **portabilidade com
   IA local**, e modelo local pequeno só é confiável como especialista de uma
   tarefa só — se for genérico, alucina. Isso torna a granularidade fina um
   requisito de arquitetura, não um capricho: o agrupamento é só de exibição, o
   armazenamento é por ponto.
2. **Unificar `ai_invocations` em `llm_calls`** com backfill.
3. **OpenRouter convive com BYOK.** O instalador passa a perguntar qual provedor
   o usuário quer (estilo OpenClaw/Hermes) e então coleta a chave daquele
   provedor.

---

## Diagnóstico medido (SHA `c56416aa`, antes de qualquer mudança)

**Três pilhas paralelas resolvem modelo e não se falam:**

| Pilha | Onde | Como escolhe | Onde grava |
|---|---|---|---|
| Seam do engine | `lib/agent-engine/edge/llm/run-model-call.ts` | BYOK por org + registry | `llm_calls` |
| Gateway | `lib/ai/gateway.ts` | variável de ambiente | `ai_invocations` |
| Runtime antigo | `lib/ai/runtime/agent.ts:134` (`buildModel`) | terceiro `switch` | `ai_agent_runs` |

A duplicidade já dói e está admitida no código: `app/api/v1/ai/usage/route.ts:146`
soma **duas** tabelas de telemetria para dar um número só.

**Achados que explicam o sintoma "falha e não dá para entender por quê":**

1. **`llm_calls` só grava sucesso.** Em `run-model-call.ts` o `generateText` não
   tem `try/catch` e o `INSERT` vem depois dele. Provider recusou? Nada é
   gravado. O log de IA tem um buraco exatamente na forma do problema.
2. **`purpose` existe e não decide nada.** O seam recebe `purpose:
   'stage_classifier'` e o usa só para rotular custo. O gancho do painel já
   estava lá, desconectado.
3. **Modelo e credencial vinham de lugares diferentes** — corrigido no PR #151,
   com a cicatriz documentada em `lib/agent-engine/agent/aux-model-args.ts`: um
   tenant com Anthropic padrão e agente publicado em OpenAI mandava `gpt-5-mini`
   para o endpoint da Anthropic e **o turno inteiro morria**, sem erro na tela.
4. **Transcrição recebia a chave errada.** `workers/media-derive-worker.ts`
   documenta o caso visto em VPS: chave da Anthropic enviada ao Whisper da
   OpenAI, recusa em toda tentativa, com a chave certa no `.env`.
5. **Visão de imagem falha em silêncio.** `media-derive-worker.ts:142` usa o
   modelo de *chat* da org; se ele não enxerga imagem, `describeImage` devolve
   `""` e ninguém é avisado. **Ainda aberto** — ver Pendências.

**Barreira dura para OpenRouter:** três CHECKs travam `provider` em
`anthropic|openai|google` — `ai_agent_versions_provider_check`,
`ai_models_provider_check`, `ai_provider_credentials_provider_check`.

**OpenRouter, medido em 2026-08-07** via `GET https://openrouter.ai/api/v1/models`:
**400 modelos**, **333 com `tools`** em `supported_parameters`, **58 famílias**.
O payload traz `pricing`, `context_length` e `architecture.input_modalities` —
tudo que o catálogo e a validação de capacidade precisam vem na mesma resposta.

---

## Estado por frente

| Frente | Estado | Commit |
|---|---|---|
| **0 — Registro de pontos** | ✅ concluída | `cb06cae6` |
| **1a — Schema + resolvedor** | ✅ concluída | `ab37426c`, `52a7440e` |
| **1b — Seam obedece ao painel** | ✅ concluída | `c2a78b31` |
| **1c — Tela `/app/ai/providers`** | ✅ entregue | `3d012c9c` |
| **2b — Tela `/app/ai/runs`** | ✅ entregue | `85f4532e` |
| **1d — Painel alcança a pilha antiga** | ✅ entregue | `23f7c64f` |
| **2 — Log registra falha** | ✅ concluída | `231c0cf1` |
| **3 — OpenRouter + catálogo** | ✅ concluída | `2910c19f` |

---

## Frente 0 — Registro de Pontos de IA ✅

**Entregue:** `lib/ai/pontos/registro.ts` — os **23 pontos** que chamam modelo,
cada um com rótulo de leigo, o que faz, papel (para o agrupamento da tela),
capacidade exigida (`tools`/`imagem`/`audio`/`embeddingDims`), arquivo emissor,
o **sintoma que o usuário vê** quando falha, e se é fixo-por-arquitetura com a
razão escrita.

Distribuição: 15 pontos passam pelo seam (`purpose`), 8 estão fora dele.

**Correção de rota durante a medição:** `send_message` aparecia no `grep` de
`purpose:` mas **não é ponto de IA** — `followup-turn.ts:348` delega para
`runAgentTurn`, que emite `agent_turn`. Teria virado um ponto fantasma no
painel. Por isso o teste varre o código nos dois sentidos.

**Prova (`tests/unit/pontos-de-ia-completude.test.ts`, 13 testes):**

| Sabotagem | Reprovações previstas | Medidas |
|---|---|---|
| A — remover `agent_turn` do registro | 2 | 2 ✅ |
| B — adicionar ponto fantasma | 1 | 1 ✅ |
| C — sintoma escrito em jargão | 1 | 1 ✅ |
| D — `agent_turn` sem exigir `tools` | 1 | 1 ✅ |
| E — varredura morta (raiz inexistente) | 2 | 2 ✅ |

Árvore limpa de volta: **13/13 passando**. `tsc --noEmit` exit 0, `eslint` exit 0
(medidos sem pipe — `cmd | tail` mascara o código de saída).

A sabotagem **E** é a que justifica o controle positivo: com a varredura morta,
o teste de pontos órfãos **passaria** (lista vazia = nenhum órfão encontrado).
Zero é indistinguível de "está tudo em ordem".

---

---

## Frente 1a — Schema e resolvedor de precedência ✅

**Entregue:**

- `supabase/migrations/20260807120000_0126_ai_purpose_bindings.sql` + apêndice
  idempotente no `baseline.sql` + linha no `MANIFEST.md` (a tripla).
- `lib/ai/pontos/resolver.ts` — a ordem entre as quatro origens que podem
  decidir o modelo de um ponto, com a **origem devolvida junto do valor**.
- `tests/unit/pontos-de-ia-resolver.test.ts` (21 testes) e
  `tests/invariants/ai-purpose-bindings.test.ts` (8 testes).

**A precedência decidida** (do mais forte ao mais fraco):

1. **Versão publicada do agente** — só para `agent_turn` e `operator_turn`. A
   escolha ali já tem tela própria; duas telas mandando na mesma coisa é como
   se cria a configuração que mente. O painel mostra os dois como leitura.
2. **Binding do painel** — os outros 21 pontos.
3. **Variável de ambiente** — os sete knobs herdados. Continuam valendo para
   quem já os usa, mas perdem para quem clicou depois.
4. **Padrão da organização** (`organizations.settings.llm`).

**Prova do baseline** (Postgres 17 local, não Docker — ver bloqueio B1):

| Etapa | Resultado |
|---|---|
| `install` fresh, `ON_ERROR_STOP=1` | exit **0** |
| `update` (re-aplicar em banco populado) | exit **0** |
| Tabela, RLS, policy, constraint única, 5 índices | presentes |

**Prova de comportamento** (não só de existência), com controle positivo antes
de cada medição:

| O quê | Medido |
|---|---|
| Constraint única recusa 2º binding do mesmo ponto | ✅ pelo nome da constraint |
| Mesmo ponto em organizações diferentes | ✅ aceito |
| Cascade da credencial | 1 → 0 |
| Cascade da organização | 1 → 0 |
| Dedup auto-curativo do apêndice | 2 → 1, sobreviveu o mais recente, constraint recriada |
| RLS: A vê só A, B vê só B | ✅ |
| RLS: escrita cruzada | barrada **pela RLS** (mensagem casada), invasor não gravado |

**Sabotagens do invariante** (previsão antes de rodar):

| Sabotagem | Previsto | Medido |
|---|---|---|
| RLS desligada | 2 | 2 ✅ |
| Constraint única removida | 1 | 1 ✅ |
| `CASCADE` → `SET NULL` | 1 | **0 → corrigido → 1** |
| Auto-cura apagada do baseline | 1 | 1 ✅ |

### Três erros meus que viraram guarda no teste

1. **`CASCADE`→`SET NULL` reprovava zero.** O teste contava
   `where credential_id = CRED_A`; sob `SET NULL` a coluna vira nula e a
   contagem também cai a zero — passava exatamente no cenário que existe para
   proibir (binding órfão). Só apareceu porque a contagem foi **prevista** antes
   de rodar. Agora conta a linha por organização.
2. **Asserção contando o banco inteiro.** "Mesmo ponto em orgs diferentes"
   falhou com 4 onde esperava 2 — resíduo de outra suíte. Banco de invariantes
   nunca está limpo; a contagem agora é escopada ao cenário.
3. **Fixture falha em silêncio.** Duas vezes a fixture quebrou (coluna `name`
   inexistente; e-mail duplicado) e a medição seguiu contra tabela vazia,
   devolvendo "não vazou" quando não havia nada para vazar. Por isso todo bloco
   agora abre com controle positivo que aborta.

---

---

## Frentes 1b/1c, 2 e 3 — o que foi entregue

### Frente 1b — o `purpose` passa a DECIDIR (`c2a78b31`)

Toda chamada de modelo já viajava com um `purpose`, usado só para rotular custo.
Agora o seam lê o binding do ponto e o aplica, com a credencial do provedor
ESCOLHIDO viajando junto.

**O alarme que quase passou batido:** os 2984 testes existentes passaram verde
depois da mudança. Isso não era alívio — os testes usam um `pg.Pool` fingido que
não responde à consulta de binding, então a leitura falha, o seam cai no padrão,
e o comportamento observado é o de antes. Verde por ausência de cobertura.
`tests/unit/seam-respeita-o-binding.test.ts` fecha o buraco medindo no argumento
que chega à **fábrica de modelo** — o único lugar que não mente.

### Frente 3 — OpenRouter (`2910c19f`)

- Migration 0127 remove os três CHECKs de provider. **Provado no banco:**
  `openrouter / meta-llama/llama-3.3-70b-instruct` entra; provider vazio é recusado.
- Tradução exercitada contra a **origem real**: 400 modelos, 0 descartados, 0
  duplicados, sanidades limpas. Conversão de preço confere com valores conhecidos
  (`openai/o1-pro` → US$ 150/M; `llama-3.3-70b` → US$ 0,10/M).
- Cron diário (04:15) no `scheduler` do compose.
- Catraca nova: o painel **recusa** modelo sem ferramentas em "Responder o
  cliente" e "Trabalhar o funil".

**Três invariantes reprovaram, todos com razão, nenhum apagado:**
`openrouter-alcance` dizia "o agente continua fora do alcance" e o próprio
cabeçalho avisava que, no dia em que alcançasse, o aviso teria de mudar. A guarda
**mudou de alvo**: antes protegia uma ausência, agora protege a proteção (recusa
+ recíproca + o `.env.example` acompanhando).

### Frente 2 — a falha deixa rastro (`231c0cf1`)

`llm_calls` só gravava sucesso: o INSERT vivia depois do `generateText`, sem
`try`. Agora grava **e relança**. Códigos normalizados pela AÇÃO que exigem de
quem instalou. Tokens em zero e custo em NULL na linha de erro.

| Sabotagem | Previsto | Medido |
|---|---|---|
| não gravar a falha | 6 | **11** (subestimei: a classificação também depende da gravação) |
| não truncar a mensagem | 1 | 1 ✅ |
| colapsar a classificação | 5 | **3** (sabotei só os ramos de `status`; os de regex seguiram classificando) |

---

## Bloqueios

| # | O quê | Estado |
|---|---|---|
| B1 | Docker voltou (28.3.2) e o Supabase local subiu. `pnpm test:db` completo (364 invariantes) **ainda não rodou** nesta frente | parcial |
| B3 | ✅ **RESOLVIDO** — prova na tela completa, 7/7. Detalhes e as três causas de harness abaixo. Texto anterior: **Prova na tela PARCIAL.** Provado dirigindo o browser: login funciona, o app abre, a porta "Provedores" aparece na sidebar, e a tela responde. NÃO provado ainda: o fluxo completo de trocar o modelo de um ponto e ver a troca valer. O `supabase start` passou a falhar aplicando as migrations (cadeia fresh não sobe — conhecido) e a máquina está disputada com outras duas sessões (`t188-recon`, `t188-medidor`). O e2e está escrito em `tests/e2e/prova-painel-provedores.spec.ts` | aberto |
| B2 | **Bug meu, achado pelo e2e e já corrigido:** `carregar()` do painel não tratava exceção e a tela ficava presa em "Carregando…" para sempre — a mesma falha muda que o painel veio acabar, recriada dentro dele | corrigido |

---

## Pendências e dívidas conhecidas

| # | O quê | Onde | Estado |
|---|---|---|---|
| P1 | Visão/áudio ilegível devolvia `""` em silêncio | `workers/media-derive-worker.ts` | ✅ resolvido em `91109c06` (migration 0129) |
| P2 | Pontos sem telemetria | registro | ✅ parcial: mídia agora avisa na Central; `contagem_de_tokens` e `embedding_consultar` seguem sem log próprio (são chamadas HTTP diretas, fora do seam) |
| P3 | `install.sh` truncava o `.env` E apagava chave opcional não-coletada | `hostgator-setup-kit/install.sh` | ✅ resolvido |
| P4 | Sete variáveis de ambiente de modelo continuam válidas e competem com o binding | `lib/agent-engine/env.ts` | ✅ resolvido em `ab37426c` — precedência declarada e testada |
| P5 | `psql-transporte.ts` duplica ~10 linhas do `gov-helpers.ts`. Não estendi o original porque `tests/invariants/**` é congelado por hook, e usar a variável de escape seria decidir sozinho uma questão do dono do repo | `tests/invariants/` | aguarda decisão do Rafael |
| P6 | Resolvedor plugado no seam (`c2a78b31`) | `lib/agent-engine/edge/llm/` | ✅ resolvido |
| P7 | `sentiment_classify` e `bot_respond` agora honram o painel via `lib/ai/gateway-binding.ts` (`23f7c64f`) | `lib/ai/` | ✅ resolvido |
| P10 | `teste_de_agente` marcado como **fixo** — o ensaio usa o modelo da versão que vai ser publicada, e é isso que o faz valer | `lib/ai/pontos/` | ✅ resolvido (com a razão invertida) |
| P11 | `gateway-binding.ts` duplica a instanciação de provider do `createDefaultRegistry`. Ponte consciente: unificar exige que os workers falem `pg.Pool` | `lib/ai/` | aberto |
| P8 | Tela de execuções | `app/app/ai/runs` | ✅ resolvido em `85f4532e` |
| P9 | `ai_invocations` unificada em `llm_calls` (migration 0130), backfill idempotente provado | `app/api/v1/ai/usage` | ✅ resolvido |

---

## Como retomar

```bash
cd ~/SonghaiCRM-provedores
git fetch origin && git merge origin/main     # doutrina de higiene de branches
npx vitest run tests/unit/pontos-de-ia-completude.test.ts
```

Próximo passo: **Frente 1**, começando pela migration de `ai_purpose_bindings` e
pelo resolvedor no seam — a tela vem depois, sobre um resolvedor já provado.


---

## Gates, no fim desta sessão

| Gate | Resultado |
|---|---|
| `tsc --noEmit` | **exit 0** (medido sem pipe) |
| `vitest run` (suíte inteira) | **3053 testes, 295 arquivos, exit 0** |
| `next build` | **exit 0** |
| `eslint` (arquivos da frente) | exit 0 |
| baseline `install` fresh (`ON_ERROR_STOP=1`) | **exit 0** |
| baseline `update` (re-aplicar) | **exit 0** |
| invariante `ai_purpose_bindings` | 8/8 |

**Não rodado:** `pnpm test:db` completo (364 invariantes) e a suíte e2e inteira.

## Duas falhas que a suíte pegou no fim, e que valem registro

1. **`llm_calls_status_check` duplicado no baseline.** Um comando que rodou em
   background completou depois que eu já havia refeito a edição à mão, e o
   apêndice entrou duas vezes. Quem pegou foi `baseline-constraint-reconstruida`
   — um invariante que já existia no repo exatamente para isso.
2. **`navegacao-registry` reprovou a ordem do grupo de IA.** Duas telas novas
   entraram e o teste travava a ordem em três. Atualizado com a razão escrita:
   "Provedores" fecha a etapa de MONTAR, "Execuções" pertence a ACOMPANHAR.


## O furo mais grave da sessão, e como apareceu

Ao revisar as próprias pendências percebi que a tela **oferecia**
`sentiment_classify`, `bot_respond` e o ensaio de agente como configuráveis — e
os três resolviam pela pilha antiga, ignorando o binding. Ou seja: o painel
aceitava a escolha, dizia "salvo", e nada mudava.

É a mesma classe de defeito que `pontos-de-ia-completude.test.ts` proíbe, e ele
não pegou porque casa a **lista** com o código, não a **execução** com a
configuração. Dois dos três estão corrigidos (`23f7c64f`); `teste_de_agente`
segue aberto como P10.

## Erros de método que custaram retrabalho

1. **`git checkout` num arquivo NOVO não restaura nada.** Sabotei
   `gateway-binding.ts` três vezes seguidas sem perceber que ele era untracked;
   as sabotagens se acumularam e as medições B e C saíram contaminadas (3 falhas
   onde deveriam ser 1). Refiz depois de commitar: 3, 1, 1 — o previsto. Agora o
   laço de sabotagem confirma a restauração a cada passo.
2. **Mesma lição, versão anterior:** `git checkout` para desfazer sabotagem
   levou junto a Frente 2 inteira, ainda não commitada.


---

## Fechamento das pendências (2026-08-07, fim da sessão)

| # | Desfecho |
|---|---|
| P1 | ✅ `0129` — mídia ilegível vira marcador no texto derivado **e** aviso na Central |
| P2 | ✅ parcial — falta log próprio de `contagem_de_tokens` e `embedding_consultar` |
| P3 | ✅ dois furos no `install.sh`, não um |
| P8, P9, P10 | ✅ |
| P5, P11 | abertos por decisão, não por esquecimento — ver abaixo |

### O `install.sh` tinha um furo PIOR que o registrado

O handoff dizia "lista fechada trunca o `.env`". Verdade, e consertado. Mas ao
testar apareceu o outro, invisível e mais grave: chaves que **estão** na lista
são escritas como `envq X "${X:-}"` — o valor da variável de shell. Numa
re-execução o shell não as tem (chave opcional não é perguntada no fluxo), então
são reescritas **vazias**. A `OPENROUTER_API_KEY` que a pessoa configurou à mão
era apagada por uma linha que parecia só repassar o valor.

**Corrigido em 2026-08-08 — este parágrafo descrevia um mecanismo que já não
existe.** Ele dizia: *"consertado recarregando o `.env` atual no ambiente antes
de montar o novo; provado com `.env` real em 3 re-execuções"*. Esse `set -a; .
./.env; set +a` foi **removido** do `install.sh` logo depois, porque ele
DESFAZIA a entrevista: a pessoa corrigia um valor errado na tela e o `.`
sobrescrevia com o antigo do disco. A justificativa que ele carregava também era
falsa — `install.sh:674` já faz `load_env .env` e `_common.sh:266` já faz
`printf -v` + `export`, antes da entrevista.

O mecanismo que ficou é outro: o laço `PRESERVADAS` compara cada linha do `.env`
atual contra a lista de variáveis conhecidas, extraída do PRÓPRIO script
(`grep -oE "^\s*envq [A-Z_]+" "$KIT_DIR/install.sh"`) — e o `$KIT_DIR` no lugar
de `"$0"` é o que faz isso funcionar depois do `cd`, que era o defeito da 2ª
execução por caminho relativo.

A alegação das "3 re-execuções" media o código antigo e **não vale mais**. O que
vale hoje está no CI: `hostgator-setup-kit/test-validators.sh` passou a rodar no
job `verify` (via `pnpm test:shell`), com um caso por provedor que afere, no
`--yes`, que o `.env` sai inteiro e que a chave configurada à mão sobrevive.

*Lição, e ela não é sobre o instalador:* código tem catraca, prosa não. Este
parágrafo continuou afirmando uma prova por dois commits depois de o mecanismo
ter sido trocado — e o handoff é o documento de retomada da frente, ou seja, o
lugar onde a afirmação falsa custa mais.

### O que fica aberto, e por quê

- **P5** (`psql-transporte.ts` duplica o `gov-helpers.ts`) — depende de relaxar a
  catraca que congela `tests/invariants/**`, e essa decisão é do dono do repo.
- **P11** (`gateway-binding.ts` duplica a instanciação de provider) — unificar
  exige que os workers legados falem `pg.Pool` em vez de Supabase. É uma
  migração de runtime, não um refactor; fazê-la no fim de uma sessão longa, sem
  poder provar na tela, seria trocar dívida declarada por risco silencioso.
- **Prova na tela completa** — segue bloqueada pelo ambiente (ver B3).


---

## Prova na tela — completa (2026-08-08)

Ambiente do zero: Supabase local pg17, `baseline.sql` em modo install (98 tabelas),
`bootstrap-owner`, `seed-e2e-credentials`. Login como **admin com MFA**, pelo helper
que o repo já tinha.

| Teste (`tests/e2e/prova-painel-provedores.spec.ts`) | Resultado |
|---|---|
| F0/F1 — painel agrupado, 6 papéis, "23 lugares", sintoma de falha, origem | ✅ |
| F1 — ponto fixo mostra a RAZÃO e **não** oferece seletor | ✅ |
| F3 — OpenRouter oferecida, >50 modelos no seletor | ✅ |
| F1 — **trocar o modelo GRAVA e a tela passa a mostrar o novo** | ✅ |
| F1/F3 — ponto que cria o lead exige ferramentas | ✅ |
| F2 — tela de execuções abre pelo resumo | ✅ |
| Porta na navegação das duas telas | ✅ |

Cada linha da tabela acima tem a imagem correspondente:

| Tela | Imagem |
|---|---|
| Painel aberto, agrupado por papel | `evidence/provedores/01-painel-agrupado.png` |
| Configuração avançada, ponto a ponto | `evidence/provedores/02-configuracao-avancada.png` |
| Ponto fixo com a razão escrita | `evidence/provedores/03-ponto-fixo-com-razao.png` |
| Modelos da OpenRouter no seletor | `evidence/provedores/04-modelos-openrouter.png` |
| A troca de modelo valeu | `evidence/provedores/05-troca-valeu.png` |
| Ponto que exige ferramentas | `evidence/provedores/06-exige-ferramentas.png` |
| Tela de execuções | `evidence/provedores/07-execucoes.png` |
| Instalação sem agente publicado, com os dois pontos principais destravados | `evidence/provedores/08-sem-agente-publicado-destravado.png` |

A oitava é de 2026-08-08 e registra um conserto, não a feature: `mandadoPeloAgente`
era incondicional, e numa instalação recém-feita — nenhuma versão de agente
publicada, que é o estado de quem acabou de instalar — o painel mostrava
`agent_turn` e `operator_turn` **sem seletor**, dizendo que são governados por
uma versão publicada que não existe e mandando configurar num lugar vazio. A
condição passou a ser a mesma do resolvedor (`agentePublicado !== null`), e a
imagem mostra "Responder o cliente" e "Trabalhar o funil" com Provedor, Modelo,
Chave e o botão Salvar.

Na mesma execução apareceu, no log do servidor, o que nenhum gate via:
`[audit] insert error invalid input syntax for type uuid: "stage_classifier"`.
`api_audit_log.resource_id` é uuid e a rota mandava o `purpose` — o insert
falhava com 22P02 e o audit, sendo fire-and-forget, engolia. Nenhuma troca de
modelo era auditada. Corrigido no mesmo dia (o `resourceId` passa a ser o id da
linha), com guarda em `tests/unit/provedores-x-registry.test.ts`.

E a confirmação no banco, que é onde o runtime lê:

```
stage_classifier → openrouter / meta-llama/llama-3.3-70b-instruct (ativo: true)
```

### Frente 3 provada contra a origem real

O sincronizador rodou contra `openrouter.ai/api/v1/models`:

| | |
|---|---|
| modelos antes | 24 (semeados por migration) |
| depois da 1ª sincronização | **424** (400 da OpenRouter) |
| **manuais preservados** | **24** — a garantia de não pisar em curadoria alheia |
| com ferramentas / com visão | 333 / 237 |
| 2ª sincronização | 424 (não duplicou) |

### `pnpm test:db` completo — o que nunca havia rodado

```
✓ install ok        ✓ update ok
Test Files  72 passed (72)
Tests  485 passed | 1 skipped (486)
```

### Três causas de HARNESS que apareceram como falha de produto

Vale registrar porque custaram horas e nenhuma era bug da feature:

1. **`next start` com `output: standalone`.** O Next avisa que não funciona, e o
   servidor caía depois de ~2 testes — os seguintes falhavam com
   `ERR_CONNECTION_REFUSED`, que lê como tela quebrada. O caminho certo é
   `node .next/standalone/server.js` (com `.next/static` e `public` copiados ao
   lado).
2. **Servidor morto entre invocações.** Processo iniciado num comando que termina
   morre com ele. O que funcionou foi deixar o Playwright subir o próprio
   servidor e rodar **um teste por invocação**.
3. **MFA e o papel do usuário.** A primeira versão logava como `manager` para
   escapar do 2FA, e os testes de edição falhavam com "o seletor não existe" — a
   tela mostra o painel a um manager mas **não os controles**, porque só admin
   edita provedores. Trocar o papel para simplificar o teste teria provado uma
   tela que ninguém usa para configurar nada.

E `page.reload()` devolvia `net::ERR_ABORTED; maybe frame was detached` nesta
máquina; `page.goto` no lugar resolveu.


---

## O CI pegou o que meu ambiente não pegava (PR #201)

Os três checks obrigatórios passaram de primeira (`verify`, `invariants`,
`build-and-size`). O `e2e` — que não segura merge — reprovou **1 de 51**, e era
meu:

```
navegacao.spec.ts:163 › nenhum grupo fica fora da dobra, e em 900px o menu não rola
```

Eu tinha posto **as duas telas novas na sidebar**, e o menu passou da dobra em
900px. É o mesmo eixo de `feedback_agrupar_cria_overflow`: agrupar o menu o faz
crescer, e a conta só aparece quando alguém mede a altura.

Por que não peguei aqui: rodei `navegacao-registry` e `navegacao-completude`
(unitários, que checam o REGISTRO) e não o e2e de navegação, que é o único que
mede pixel. Registro correto e layout estourado são coisas diferentes.

**Correção:** as duas saíram da sidebar e seguem o padrão das outras nove telas
do grupo IA — alcançáveis pelo hub "Ver tudo em IA". Das 12 telas do grupo, só 3
estavam na sidebar; eu tinha aberto exceção para duas sem perceber que exceção
tem custo de layout. Configurar provedor é tarefa de poucas vezes, e quem abre
Execuções está diagnosticando (chega pelo hub ou pelo link do aviso na Central).

O e2e da frente foi ajustado: a asserção de porta agora olha o hub, não a
sidebar. `navegacao.spec.ts` verde localmente depois da correção.

### E uma armadilha de ambiente que se repetiu

O MFA voltou a falhar com "código inválido" — segredo TOTP dessincronizado por eu
ter rodado o seed várias vezes na sessão. `seed-e2e-credentials.ts` de novo, e os
segredos passam a bater (conferi banco × disco antes de concluir). É
`feedback_seed_compartilhado_rotaciona_totp`, sem vizinho: eu era o vizinho.
