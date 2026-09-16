# HANDOFF — Follow-up Vivo

> Documento vivo da missão "otimizar o sistema de follow-ups". Atualizado a **cada
> avanço, interrupção, bug encontrado, bug corrigido e pendência**. Quem retoma
> esta missão lê este arquivo primeiro e não precisa de mais nada.

- **Branch de integração:** `feat/followup-vivo` — nascida de `origin/main` `4f89a0da`, zero divergência na criação.
- **Maestro da missão:** terminal `Assistente e Testes` (Lina).
- **Aberto em:** 2026-08-10.
- **Autorização:** Rafael, autonomia total (`workspace.json → guard: off`).

---

## 1. Por que esta missão existe

Sete achados medidos no código em `d59f8292` (worktree principal), antes de
qualquer alteração. Cada um com o arquivo e a linha que o prova.

| # | Achado | Prova |
|---|---|---|
| 1 | **Uma bolinha só de saída.** `NodeCard` renderiza exatamente 1 `Handle type="source"` para os 6 tipos de nó. E não adianta desenhar mais: o nó condicional colapsa N regras em UM booleano (`checks[]` + `combinator`), e a aresta só sabe dizer `cond_result: true\|false`. Não existe vocabulário para "esta aresta sai da regra 2". | `nodes/NodeCard.tsx:69`, `graph-schema.ts:78-95`, `graph-schema.ts:190-200` |
| 2 | **Comparadores crus na tela.** O valor de wire vira rótulo sem tradução: `lead_stage`, `steps_taken`, `eq`, `neq`, `gte`, `lte`, `contains`. | `NodeConfigPanel.tsx:334-338`, `:355-357` |
| 3 | **UUID pedido ao usuário.** "Template de fallback (UUID, opcional)" é um `<Input>` de texto livre. Pior que `eq`. | `NodeConfigPanel.tsx:568`, `:581` |
| 4 | **Jargão.** "Grace (minutos, mín. 15)", "Alvo", "Combinador", "Esgotado". Classes de IA (`hot`/`cold`) chegam sem tradução na aresta — só `no_reply` é traduzido. | `NodeConfigPanel.tsx:442`, `edge-condition-options.ts:23` |
| 5 | **Gatilhos previstos e mortos.** O schema já declara `stage_change` (com `stage_id`) e `conversation_end`; nenhum tem produtor. Só `silence` tem motor vivo. A UI nem os oferece. | `api-schemas.ts:22-42`, `TriggerConfigControl.tsx:19-26`, `silence-sweep.ts` |
| 6 | **BUG — o tempo adaptativo é decorativo.** A tela oferece "Adaptativo (min–max)" e o decisor por LLM já existe escrito. Mas o engine **nunca** enfileira `purpose:'decide_timing'` — `processNode` não devolve `enqueue_turn` para nó `wait`, então o payload de guidance em `engine.ts:165` é código morto. O usuário escolhe adaptativo e o sistema espera **sempre o máximo**, calado. | `node-handlers.ts:206`, `followup-flow-classify.ts:133-137`, `engine.ts:160-167` |
| 7 | **Fila sem dossiê.** `followup_enrollment_events` grava cada passo e nenhuma tela mostra. Única intervenção possível é cancelar. | `QueueTab.tsx`, `/api/v1/ai/followups/queue` |

Somam-se dois defeitos **já catalogados** pelo time no plano do Lina, ambos de
follow-up, ambos em escopo aqui:

- **`IA360-STARVATION`** — o claim é global com teto 20 e ordenado por `next_eval_at`
  crescente; org grande domina os primeiros ticks.

  > **CORRIGIDO PELA MEDIÇÃO (DevVivo, 2026-08-10).** O item do plano dizia
  > *"STARVATION PERSISTENTE … as menores nunca rodam"*. **Não é permanente.**
  > Medido em pg17 com 300 vencidos na org grande e 1 na pequena: a pequena é
  > atendida no **tick 16**, não nunca. Confirmei o mecanismo na fonte —
  > `fn_claim_due_followup_enrollments` faz `set claimed_until = now() + lease` e
  > o `where` exclui `claimed_until >= now()`, então o lote reclamado sai do
  > conjunto de candidatos e o ponteiro avança: `ceil(K/limit)` ticks.
  > A caracterização original veio de **leitura**, não de medição, e estava errada.
  > Continua sendo defeito e o conserto entrou: atraso proporcional **sem teto
  > superior** é 15 min com 300 vencidos e horas com 10 mil, e o tenant pequeno
  > paga por um vizinho grande sem nunca saber.

- **O silêncio do claim** — `runFollowupTick` devolvia `claimed=0` indistinguível de
  "nada vencido".

  > **REFINADO PELA MEDIÇÃO (DevVivo).** O sinal **já existia** na base: `claim_falhou`
  > + `logger.error`, commit `f66f0ddb`, com teste. O que faltava era **consumidor** —
  > a rota de cron só auditava tick com contador não-zero, e claim falhado tem todos
  > zerados. É o anti-pattern nº 3 do `CLAUDE.md` (evento sem consumer), não emissor
  > ausente.
- **`IA360-FLAKY`** — invariante de follow-up instável no `test:db` pinta o CI de
  vermelho aleatoriamente. Dois testes DIFERENTES caindo no mesmo SHA: assinatura de
  interferência de estado, não de defeito de código.

---

## 2. Decisões de produto tomadas (e por quem)

| Decisão | Quem | Racional |
|---|---|---|
| Ramo nomeado é do **nó**, não da aresta isolada — cada regra vira um ramo com id estável e rótulo; a aresta referencia `branch_id`. | Maestro, aprovado por Rafael | Aresta guardando a regra duplicaria a verdade e quebraria ao reordenar regras. |
| A ramificação vale **também para o nó de classificação da IA** — cada classe declarada nasce com a sua própria saída. | Maestro, aprovado por Rafael | Rafael citou o condicional; a estrutura do defeito é a mesma. |
| **UUID sai da tela.** Template vira seletor com nome. | Maestro, aprovado por Rafael | Pedir UUID a um dono de clínica é o defeito de UX mais grave do painel. |
| Retrocompatibilidade é **obrigatória**: fluxo publicado hoje continua rodando sem intervenção. | Maestro | Projeto open-source; clones têm fluxos vivos em produção. |
| O tempo adaptativo é tratado como **bug**, não como feature nova. | Maestro | Controle que a tela oferece e o código ignora mente para o usuário. |

---

## 3. Fronteira de arquivos — quem escreve o quê

**Regra dura: quem não é dono do arquivo não escreve nele.** Precisa mexer em
arquivo alheio? Pede ao dono pelo canal, não edita.

| Frente | Terminal | Arquivos que possui |
|---|---|---|
| **A · Contrato + Ramificação** | Arquiteto | `lib/followup/graph-schema.ts`, `validate-publish.ts`, `graph-mappers.ts`, `edge-condition-options.ts`, `node-handlers.ts` *(só o case `condition`)*, `nodes/NodeCard.tsx`, `nodes/ConditionNode.tsx`, `nodes/ClassifyNode.tsx`, `EdgeConfigPanel.tsx`, `FlowCanvas.tsx`, `NodeConfigPanel.tsx` *(só o `ConditionForm`/`ClassifyForm`)* |
| **B · Motor (tempo neural + starvation)** | DevVivo | `lib/followup/engine.ts`, `turn-bridge.ts`, `node-handlers.ts` *(só o case `wait`)*, `lib/agent-engine/agent/followup-flow-classify.ts`, `followup-turn.ts`, função SQL do claim |
| **C · Gatilhos do sistema** | DevGatilhos | `lib/followup/api-schemas.ts` *(bloco trigger)*, `silence-sweep.ts`, `reactivity.ts`, novos `gatilho-*.ts`, `TriggerConfigControl.tsx`, `app/api/v1/ai/followup-flows/[id]/publish/route.ts`, `app/api/v1/cron/followup-flow-worker/route.ts` |
| **D · Fila viva + dossiê** | Maestro | `app/app/ai/followups/_components/QueueTab.tsx`, novos componentes de dossiê, `app/api/v1/ai/followups/enrollments/**`, `hooks/followup/useFollowupQueue.ts`, `lib/followup/outcome-stats.ts` |
| **E · Linguagem humana** | QAVivo | `lib/followup/vocabulario.ts` *(novo, dono exclusivo)*, `NodeConfigPanel.tsx` *(demais formulários)*, seletor de template, `nodes/nodeVisuals.ts` |

**Ponto de atrito conhecido:** `NodeConfigPanel.tsx` é tocado por A e E. Mitigação —
E quebra o arquivo em um arquivo por formulário **na Wave 0**, antes de A encostar nele.

**Arquivos que mudaram de dono durante a missão** (apontado pelo DevGatilhos — sem
esta linha, quem retomar as frentes descobre no conflito):

| Arquivo | Dono original | Passou para | Por quê |
|---|---|---|---|
| `lib/leads/agent-stage-sync.ts` | ninguém (fora da tabela) | **C · Gatilhos** | decisão do maestro: o conserto do B4 pertence ao emissor, e quem o achou tinha o contexto |
| `lib/followup/turn-bridge.ts` | B · Motor | **compartilhado** com D · Fila | a fila precisa da lista positiva de status para introduzir pausa manual; o motor combina em vez de reverter |
| `tests/invariants/vocabulario-banco-x-typescript.test.ts` | — | **D e E juntos** | os dois o modificam; combinar antes de escrever |

**Faixas de migration reservadas** (evita colisão de numeração):

| Frente | Faixa |
|---|---|
| A · Contrato | `0142` |
| C · Gatilhos | `0143` |
| B · Motor | `0144` |
| D · Fila | `0145` |
| E · Linguagem | `0146` |

Última migration na `main`: `0141`. Toda migration sai com a tripla — arquivo em
`supabase/migrations/` + apêndice idempotente no `supabase/baseline.sql` + linha no
`MANIFEST.md`.

---

## 4. Ondas

### Wave 0 — contrato (bloqueia A e E, não bloqueia B/C/D)

| Item | Dono | Estado |
|---|---|---|
| `W0-CONTRATO` · `graph-schema.ts` v2: ramos nomeados no condicional e no classify, `branch_id` na aresta, retrocompatível, com teste de round-trip de grafo legado | Arquiteto | despachado |
| `W0-VOCAB` · `lib/followup/vocabulario.ts`: dicionário pt-br completo + invariante que reprova valor de wire sem tradução; e quebra do `NodeConfigPanel` em um arquivo por formulário | QAVivo | despachado |

### Wave 1 — arranca junto com a Wave 0 (arquivos disjuntos)

| Item | Dono | Estado |
|---|---|---|
| `W1-GATILHOS` · produtores de `stage_change`, caso aberto e proposta feita + UI do gatilho | DevGatilhos | despachado |
| `W1-FILA` · dossiê do enrollment, timeline de eventos, pausar/adiar/pular | Maestro | despachado |
| `W1-MOTOR` · `decide_timing` vivo, plano de atrasos por enrollment, clamp provado + starvation | DevVivo | despachado |

### Wave 2 — depois da Wave 0

| Item | Dono | Estado |
|---|---|---|
| `W2-RAMOS` · ramificação ponta a ponta: canvas com uma bolinha por regra, engine roteando por `branch_id`, publish validando cobertura | Arquiteto | aguarda W0-CONTRATO |
| `W2-LINGUAGEM` · vocabulário aplicado em todos os formulários, UUID eliminado | QAVivo | aguarda W0-VOCAB |

---

## 5. Critério de aceite — vale para toda frente, em todo marco

Nenhum marco fecha sem os cinco:

1. `pnpm typecheck` e `pnpm lint` zerados.
2. `pnpm test:unit` verde.
3. `pnpm test:db` verde **se tocou schema, RLS ou o motor** — é o único caminho que exercita o `baseline.sql` que o self-hoster aplica.
4. **Spec Playwright dirigindo a tela**, não a API. `curl` é diagnóstico, não prova de UX. Screenshot versionado em `evidence/`.
5. **A prova mostra a IA fazendo o que a tela prometeu.** Não basta o código chamar o decisor: tem que aparecer, na tela, o que a IA escolheu e por quê.

Medida de front-end é por ferramenta (`getBoundingClientRect` / `getComputedStyle`), nunca a olho.

**Teste que não vermelhece não prova.** Todo teste novo passa pela sabotagem: quebre a
linha que ele deveria vigiar, confirme que ele reprova, restaure. Preveja quantas
reprovações espera — reprovar menos que o previsto denuncia mecanismo redundante.

---

## 6. Diário — avanços, bugs, interrupções, pendências

> Ordem cronológica inversa não; cronológica direta. Cada linha declara o SHA.

### 2026-08-10

- **Setup** — `feat/followup-vivo` criada de `origin/main` `4f89a0da`. Cinco worktrees
  (`fv-contrato`, `fv-vocabulario`, `fv-gatilhos`, `fv-fila`, `fv-motor`) + `fv-integra`
  para o maestro. `pnpm install` em cada um.
- **Reconhecimento** — os 7 achados da seção 1, medidos em `d59f8292` antes de tocar
  em qualquer linha.
- **Despacho** — 5 itens abertos no plano do Lina (`FV-W0-CONTRATO`, `FV-W0-VOCAB`,
  `FV-W1-MOTOR`, `FV-W1-GATILHOS`, `FV-W1-FILA`) e repassados com briefing anexado ao
  payload (`lina handoff --context`), não pelo corpo da mensagem — o canal corrompe
  `$`, crase e apóstrofo em silêncio.
- **Troca de dono na frente C** — os dois despachos ao MaestroConexoes foram *roteados*
  sem confirmação de entrega, e ele não deu claim. Não concluí "terminal morto" pelo
  sinal indireto: **conferi o artefato** (plano sem claim, worktree sem arquivo tocado).
  Rafael informou que ele está em outra frente. Terminal `DevGatilhos` (DEVELOPER)
  criado e a frente repassada a ele.
- **Monitor armado** — vigia o **artefato**, não o proxy: commit novo em qualquer
  `fv/*`, terminal em `Blocked`/`Dead`, e frente em silêncio há mais de 25 min. As três
  bordas juntas, porque monitor que só observa o caminho feliz fica calado num
  travamento e o silêncio parece progresso.
  - Limitação medida: `lina history` recusa leitura cross-espaço aqui
    (`leitura cross negada`), então não consigo ler a tela dos colegas. O git é a
    fonte de verdade do monitor — o que é melhor de qualquer forma: branch e SHA são
    fato, estado de terminal é proxy.

#### Ambiente de prova (montado pelo maestro, pronto antes da 1ª entrega)

- **Banco**: Supabase local `pg17` já de pé (`supabase_db_deskcomm-crm`), que é o alvo
  que a doutrina exige (o `baseline.sql` usa `GRANT MAINTAIN`, privilégio pg17+).
- **Isolamento de produção**: os worktrees `fv-*` nasceram do git limpos, **sem
  `.env.local`** — que é exatamente a configuração segura. Esta base já teve
  `pnpm test:e2e` escrevendo organizações e usuários **no banco real**, porque 93
  scripts liam `.env.local` do disco ignorando `process.env`. O repo já tem o conserto
  (`pnpm e2e:env` + `pnpm e2e:build`, que ainda prova que o host de produção não
  sobreviveu no bundle do browser); estou usando essa receita, não uma minha.
- **Porta**: `E2E_PORT=3101`. Há um `next` vivo de **outra sessão** no worktree
  `DeskcommCRM-qa-main`; porta própria para não colidir, e não matei processo nenhum —
  `pkill` amplo nesta máquina mata o trabalho alheio.
- **Ressalva declarada**: o Supabase local é **compartilhado** entre sessões. Não vou
  resetá-lo. As specs semeiam a própria org por rodada; se um vizinho rodar o seed no
  meio, o sintoma típico é "MFA falhou" — que é vizinho, não bug de MFA.

#### Bugs encontrados

| # | Bug | Achado por | Estado |
|---|---|---|---|
| B1 | Modo "Adaptativo" do nó de espera é decorativo — engine sempre usa `max_ms` | Maestro (reconhecimento) | aberto · frente B |
| B2 | Starvation do claim global: org grande monopoliza o tick, pequenas nunca rodam; falha do claim vira `claimed=0` silencioso | MaestroConexoes (W4, pré-existente) | aberto · frente B |
| B3 | Invariante de follow-up instável no `test:db` — CI vermelho aleatório | Maestro (IA 360, pré-existente) | aberto · frente B |
| B4 | **Regras de automação estão mortas para todo card que a IA move.** `lib/leads/agent-stage-sync.ts` grava a atividade em `crm_lead_activities` e **não** emite `lead.stage_changed` em `event_log` — zero ocorrência de `event_log` no arquivo. Só as 3 rotas HTTP emitem (`leads/[id]/move:171`, `_handler.ts:589`, `bulk:200`). E `lib/automation/engine.handler.ts:9` consome exatamente `lead.stage_changed`. Ou seja: a regra que o operador configurou ignora, em silêncio, metade dos movimentos do funil. | DevGatilhos, confirmado por medição independente do maestro | aberto · frente C |

#### Correção de rota — o maestro errou o briefing

O briefing de gatilhos afirmava que `agent-stage-sync.ts:220` emitia `stage_changed` em
`event_log`. **Não emite.** O `type: "stage_changed"` que eu tinha visto num grep é o
tipo da *atividade*, não do evento — inferi o resto. DevGatilhos contradisse, eu remedi
na fonte antes de deferir, e ele estava certo. Briefing corrigido com a ressalva escrita
no próprio arquivo, para não enganar quem o ler depois.

#### Decisões tomadas durante a execução

| Decisão | Quem | Racional |
|---|---|---|
| **"Caso aberto" vira "caso encerrado".** | Maestro, sobre achado do DevGatilhos | Disparar um fluxo no mesmo evento (`ai.handoff_triggered`) que a política de handoff usa para **pausar/cancelar** os follow-ups vivos (`reactivity.ts:226+`) é contradição: o evento que abriria o fluxo é o que mata os outros. E `demandas` abre automaticamente no primeiro inbound de **todo** contato (trigger `trg_demanda_abre_no_inbound`), então o gatilho valeria para qualquer um que escrevesse. O simétrico é coerente e `conversation_end` já está no schema — mesmo trabalho. |
| **"Proposta feita" não precisa de tabela.** | DevGatilhos, aprovado pelo Maestro | `crm_stages.agent_stage_hint` aceita `negotiating` (CHECK, migration `0084`), definido como "há proposta/preço/condições na mesa" — a etapa "Proposta" já carrega o hint. Proposta feita **é** o gatilho de etapa com a etapa certa. Zero tabela nova, doutrina DIRC respeitada no item **C**alcular. |
| **`agent-stage-sync.ts` passa a emitir `event_log`**, em commit próprio, separado do gatilho. | Maestro | Mover card pela IA tem de ser indistinguível de mover pela mão. Regra que ignora metade dos movimentos em silêncio é pior que regra que dispara demais — e o defeito é undiscoverable hoje. Muda comportamento além do follow-up: **está declarado aqui de propósito**. |

#### A prova em tela do B1 — feita, e vermelha de propósito

`tests/e2e/followup-tempo-adaptativo.spec.ts` (commit `e1cc21b6`). Monta o fluxo
pelo canvas, escolhe **"Adaptativo (min–max)"** com janela de **10 a 360 min** e a
orientação *"O lead pediu retorno ainda hoje, em cerca de meia hora"*, publica
pelos botões, matricula um contato, roda o worker e lê o próximo disparo na Fila.

```
Expected: < 360
Received:   360.02346666666665
```

**O motor agendou o teto exato.** A orientação não muda nada e nada na tela deixa
o usuário perceber. Evidência visual versionada, uma imagem para cada metade da
contradição:

- `evidence/followup-vivo/tempo-adaptativo-01-a-promessa-da-tela.png` — o painel
  com a janela de 10 a 360 min e a orientação escrita, que é o que o operador vê.
- `evidence/followup-vivo/tempo-adaptativo-02-o-que-o-motor-agendou.png` — a Fila
  mostrando o disparo no teto, que é o que o motor fez.

> Citadas aqui pelo caminho, e não pela pasta, porque
> `tests/unit/evidencia-citada.test.ts` reprova imagem versionada que nenhum
> documento nomeia — e reprovava: a frase anterior apontava só para o diretório,
> o que deixou o `verify` vermelho até a W2-LINGUAGEM topar com ele.
>
> O rótulo do modo mudou depois desta prova: **"Adaptativo (min–max)"** virou
> **"A IA escolhe a hora"** (W2-LINGUAGEM), e a spec acompanhou. As imagens são
> anteriores à troca.

O teste **nasce vermelho de propósito** — é a metade RED do ciclo e vira o
critério de aceite da frente MOTOR. Continua valendo depois: se alguém voltar a
cair no teto por atalho, inclusive como fallback silencioso quando o modelo não
responde, ele reprova. Cair no teto sem dizer é o defeito, não degradação.

#### A prova em tela da W2-LINGUAGEM — o painel deixou de falar em código

`tests/e2e/followup-linguagem.spec.ts`, porta 3105, verde em 29,2s. Percorre o
painel dos seis tipos de nó e afirma que **nenhum valor de wire aparece no texto
renderizado** e **nenhum campo de texto contém UUID**. A lista do proibido é
derivada do schema (`tests/support/enums-do-grafo.ts`), não escrita à mão.

Uma captura por tipo de nó, que é a unidade da afirmação — se um painel voltar a
falar em código, é numa destas que se vê:

- `evidence/followup-vivo/linguagem-painel-trigger.png`
- `evidence/followup-vivo/linguagem-painel-wait.png` — "Como calcular a espera",
  onde antes se lia "Modo" e "Adaptativo (min–max)".
- `evidence/followup-vivo/linguagem-painel-condition.png` — o seletor que
  mostrava `lead_stage` e `eq`, agora com a frase inteira da condição embaixo.
- `evidence/followup-vivo/linguagem-painel-ai_classify.png` — o antigo "Grace".
- `evidence/followup-vivo/linguagem-painel-action.png` — onde estavam os dois
  campos de UUID de template.
- `evidence/followup-vivo/linguagem-painel-end.png`

Verde de varredura só vale se ela souber ficar vermelha: injetando na lista de
proibidos uma palavra que ESTÁ na tela ("Rótulo"), a spec reprovou uma vez e
nomeou os seis painéis. Previsto 1, medido 1.

#### Bugs de harness achados no caminho (todos fora do escopo pedido)

| # | Bug | Estado |
|---|---|---|
| H1 | `pnpm e2e:env` executava as crases do próprio comentário — o heredoc precisa ficar sem aspas (as `$API_URL` expandem), então o shell fazia substituição de comando em 3 palavras entre crases. 3 × `comando não encontrado` a cada execução, e o comentário saía mutilado no arquivo gerado. | **corrigido** `fec37ba5`, com controle positivo (3 erros antes, 0 depois, script chegando ao fim nas duas vezes) |
| H2 | `followup-builder.spec.ts` teste 6.2 tem corrida com o `autoFocus` do Radix: digita antes do foco chegar, o `fill` se perde, o campo fica vazio, o submit nasce desabilitado e o teste espera um diálogo que nunca fecha. O teste 6.1 do **mesmo arquivo** já tem a guarda. Reproduzido. | aberto — a spec nova já nasce com a guarda; consertar a 6.2 fica para quem tocar naquele arquivo |
| H3 | `NewFlowDialog` chama `create.mutate` **só com `onSuccess`**. POST que falha não mostra nada ao usuário — falha silenciosa na UI. Fato de código, independente de carga. | aberto · atribuído à frente E (linguagem) |

#### Protocolo do ambiente E2E — nasceu de um achado do DevGatilhos

Ele parou antes de rodar a suíte e perguntou, porque percebeu que
`scripts/seed-e2e-credentials.ts` **rotaciona o TOTP do admin** e derrubaria o run
do maestro em andamento. Virou regra escrita para o time
(`/Users/rafaelmelgaco/fv-briefings/PROTOCOLO-E2E.md`): o maestro é o dono do
seed, ninguém mais o roda, credenciais se copiam; nunca criar `.env.local` num
worktree; uma porta por frente (3101–3106); prazo de 60s nas esperas.

#### Uma medição minha que eu tive de retratar

Rodei os testes do contrato e vi **2 falhas em 180**. Quase reportei que o
Arquiteto havia commitado vermelho. **Não reproduz**: em `841528a8` com árvore
limpa dá 180/180, medido três vezes (inclusive repetindo o caminho torto que eu
tinha digitado). A primeira medição foi feita contra uma árvore que podia estar
sendo escrita naquele instante, e eu não declarei o SHA nem o `git status` junto
com o número. A explicação interessante era "ele errou"; a chata — o meu
instrumento — é a que sobreviveu.

#### Dois defeitos que a INTEGRAÇÃO pegou — nenhum teste os pegaria

Os dois vieram de merges que o git resolveu **sem conflito**, que é o modo de falha
mais caro: nada acusa, nada fica vermelho, e o sintoma só aparece em produção.

**1. O guard anti-spam revertido por uma linha de índice.** A migration `0145`
(Fila) recria `idx_followup_enrollments_one_live` com `(pointer_id, contact_id)`.
A definição **em vigor** é `(organization_id, contact_id)` — a DDL original da
tabela cria por `pointer_id` e o apêndice da `0062` derruba e recria por
`organization_id`. Copiaram a linha da DDL original em vez da que está valendo.

Efeito: o índice deixa de garantir **um follow-up vivo por lead na organização** e
passa a garantir um por fluxo. O mesmo contato entra em N fluxos e recebe N
sequências — o bug de spam que a doutrina anti-banimento existe para impedir. E o
argumento do produtor do gatilho de etapa de que **não há laço de re-enrollment**
se apoia exatamente nessa garantia: ela cairia junto, sem ninguém ver a ligação.

Corrigido na integração preservando o `paused_manual` que a Fila precisava, com a
razão escrita no próprio arquivo para o próximo não repetir.

**2. `timing_plan` criado duas vezes**, por duas frentes, com dois
`comment on column` competindo — o último vence. Idempotente, mas é duplicação com
dois donos e nenhuma fonte da verdade. Removido do apêndice da `0145` **só no
baseline** (onde o maestro controla a ordem); na migration da Fila ele **fica**, e
o motivo está no achado seguinte.

#### ALERTA DE REPO: o número de sequência e o timestamp discordam

```
20260810120000_0145_dossie_do_followup.sql
20260810121000_0144_followup_timing_plan.sql
20260810122000_0146_claim_justo_entre_organizacoes.sql
```

Ordenados por **nome de arquivo** (que é como um clone aplica), a `0145` roda
**antes** da `0144`. Sequência e timestamp discordando torna "aplicar em ordem"
ambíguo — e num projeto cujo produto é o self-host, o clone aplica por nome.

Consequência prática já vivida: a defesa da Fila (`add column if not exists` para
uma coluna de outra migration) **não é redundância, é necessidade** — sem ela, a
rota do dossiê encontraria `42703` num clone que aplicou a `0145` primeiro.

Fora do escopo desta missão consertar a numeração retroativamente; fica registrado
para quem definir a convenção.

#### Falso positivo de governança no hook de migration

O hook de pre-commit reprova commit de **merge** alegando `NNNN já existe na branch
de origem` — condição que **todo merge satisfaz por definição**, já que o arquivo
vem de lá. Conferido que não havia colisão real (`0145` só em `fv/fila`) antes de
usar `DESKCOMM_GOV_MIGRATION_EDIT=1`. Falso positivo em gate treina a equipe a
driblar o gate; vale consertar.

#### Quando rodar o conjunto — a regra que faltava

O maestro verificou cada frente separada e **nunca rodou o `test:unit` sobre a
integração**, e foi lá que o QAVivo achou um vermelho com dono (o gate de evidência
citada, defeito do maestro: imagens versionadas com o handoff citando a **pasta** em
vez de cada arquivo).

Mas a autocrítica "eu deveria ter rodado sempre" está errada, e a correção é do
QAVivo: ele rodou o **mesmo commit duas vezes** e teve **3 e 41** reprovas, com **36
das 41** sendo estouro de teto de 15s sob swap de 23 GB. **Conjunto vermelho por
carga ensina a ignorar o gate tão rápido quanto conjunto que nunca roda.**

Regra: **rode o conjunto quando a máquina estiver sã, e declare a carga junto do
número.** Com `load 32`, o sinal ficou limpo: **1 reprova real em 3.519 casos**.

E a ordem importa (DevGatilhos): **isolado primeiro, conjunto depois.** O isolado
responde "o meu trabalho quebra alguma coisa?"; o conjunto responde "o baseline do
self-hoster aguenta as cinco frentes juntas?". Rodar só o conjunto é mais barato e
devolve um número que não responde nenhuma das duas, porque sem a linha de base não
há como separar a causa.

#### A causa real da máquina travada: MEMÓRIA, não CPU

Medido: **swap 22.528 MB usados contra 452 MB livres**, numa máquina de **18 GB de
RAM**, com **8.226.181 pageouts**. A máquina estava em *thrashing*.

Isso reinterpreta tudo o que parecia contenção de CPU: um `next build` parado em
**estado `S` a 0% de CPU não disputa processador — está bloqueado esperando disco
de swap**. Dois builds simultâneos nesta máquina não terminam nenhum dos dois.
(Primeiro visto pelo QAVivo, que reportou 568 MB livres antes de eu medir.)

Regra que entrou em vigor: **um `next build` por vez na máquina inteira**, com o
maestro como dono do token. Vale para `test:db` e Playwright, que sobem container e
browser. **Não** vale para commit, `typecheck` e `lint`.

**Ação do maestro em worktree alheio, registrada de propósito:** matei o `next build`
do `fv-fila` (pids 65417/65480) depois de **duas medições com 12 min de intervalo**,
ambas 0% de CPU e estado `S`, 59 min de vida, zero linhas novas de saída — morto, não
lento. Confirmei o dono por `lsof -p PID -a -d cwd` antes, matei só os dois pelo pid,
reconferi depois. Swap livre subiu de 452 MB para 1.942 MB. Build morto não deixa
artefato aproveitável (o meu, no mesmo estado, tinha `.next` sem `BUILD_ID`), então o
dono perdeu espera, não trabalho. Comunicado a ele com a medição e com a opção de
vetar a prática.

#### O canal mente sobre entrega — e isso escondeu uma frente parada

O `lina handoff` da `W2-LINGUAGEM` respondeu **"ok: enviada"** e **não foi entregue**.
O QAVivo passou horas sem tarefa, e eu o li como parado. Regra: **confirmação de envio
não é prova de entrega; o artefato (claim no plano, commit no git) é o único sinal
confiável.** O inverso, apontado pelo DevGatilhos, é o que mais importa: *"o colega
não respondeu" não se lê como "o colega parou" — olhe a árvore dele antes de cobrar.*
Aconteceu duas vezes comigo no mesmo dia: cobrei o DevVivo por 21 arquivos sem commit
e a mensagem chegou depois de 5 commits dele; cobrei o QAVivo por estar parado quando
ele nunca tinha recebido a tarefa. Nos dois casos o git tinha a resposta.

#### Crédito ao método, não ao caráter

Elogiei o DevGatilhos por ter escrito no código a ressalva sobre o `agent-stage-sync`
e por ter recusado o atalho de ler `crm_lead_activities`. Ele corrigiu o registro para
baixo, e a correção fica: o cabeçalho ele escreveu **no instante em que mediu**, antes
de eu corrigir o briefing — não foi resposta a pedido meu; e recusar o atalho **não lhe
custou nada**, porque o atalho era pior para ele também (dois enrollments no dia em que
o emissor fosse consertado). Creditar a virtude o que veio de estrutura desliga o
alarme: sugere que o bom resultado dependeu de alguém ser cuidadoso, quando dependeu de
o caminho errado ser obviamente pior.

#### A máquina virou o gargalo — e o que isso ensinou

`load average` chegou a **78 em 11 CPUs**. Os consumidores reais **não eram os
builds**: Docker (VM do Supabase) 123%, o app do Lina 115%, Chrome 117% somado,
WindowServer 41%. Um `next build` da integração ficou **48 minutos a 0% de CPU em
estado `S`** — bloqueado, não lento; nenhuma linha nova de saída por mais de uma
hora; `.next` sem `BUILD_ID`, ou seja, artefato inutilizável. Morto e reiniciado
com o cache do Turbopack quente.

Três regras saíram disso:

1. **O critério de serialização não é "isso é uma medição?", é "isso consome a
   máquina?"** (formulação do DevGatilhos, melhor que a minha original). Build não
   contamina resultado, mas é o maior produtor da carga que faz a medição dos
   outros reprovar por teto.
2. **Identifique o processo pelo DONO, nunca pelo nome.** `pgrep -f "next build" |
   head -1` devolvia o processo de *outra frente* — cheguei a reportar tempo de
   build errado por isso. O certo é `lsof -p PID -a -d cwd`. Para matar: confirme o
   dono, mate só o seu pelo pid, e **reconfira depois** que sobrou o que devia.
   `pkill` amplo nesta máquina já matou trabalho de terceiro.
3. **`0% de CPU` com estado `S` é travamento, `R` seria disputa.** A distinção diz
   se você espera ou mata. E uma amostra só não decide: tire três.

#### O exit code que mentiu, de novo

O harness notificou **"completed (exit code 0)"** para o build que eu tinha acabado
de matar. Esse zero era o exit do **último comando da cadeia**, não do build; o
real estava no log: `build exit=143` (SIGTERM). É a mesma classe do
`cmd | tail` que o DevGatilhos apanhou de manhã e que virou regra do time — e o
maestro quase caiu nela três horas depois de escrevê-la. **Sempre leia o exit da
etapa que interessa, gravado por ela mesma, nunca o exit agregado.**

#### Doutrina de medição que esta missão descobriu na prática

Três terminais bateram no **mesmo** muro sem saber, e o custo de cada um
redescobrir sozinho foi o que mais atrasou o dia. Fica escrito:

1. **`user-event` com delay default leva ~16s para abrir um `Select` do Radix sob
   carga** e estoura o teto de 15s do vitest. Reprovação por lentidão, sem defeito
   nenhum. Conserto: `userEvent.setup({ delay: null })`, e teto próprio no teste
   quando ainda faltar — com justificativa **medida no mesmo commit em dois
   estados de máquina** (QAVivo mediu 1,8s livre × 15,7s com seis worktrees
   compilando; 30s é o dobro do pior caso observado).
2. **Nunca validar por pipe.** `cmd | tail` devolve o exit do `tail`: DevGatilhos
   recebeu "exit 0" de um run com 14 falhas, e o pipe comeu justamente as linhas
   que diziam quais. Redirecione para arquivo, capture `$?` na hora, leia depois.
3. **Quem mede tempo não tolera vizinho — e o vizinho pode ser você.** DevGatilhos
   rodava `test:unit`, a suíte de invariantes e o `next build` ao mesmo tempo:
   fabricou a lentidão que reprovou o próprio teste. A contagem dele não era
   comparável nem com a dele mesmo.
4. **Mas nem toda medição é sensível a carga.** `typecheck` e `lint` são
   invariantes: `tsc` erra ou não erra, ficar lento não muda o resultado. Só
   serialize o que tem teto de tempo (vitest, Playwright). Serializar tudo custa
   caro à toa.
5. **Controle no SHA pai.** O Arquiteto rodou `test:unit` em `4f89a0da` e mostrou
   os **mesmos 6 arquivos** falhando sem a mudança dele, nenhum citando follow-up.
   É o que separa "a máquina está lenta" de desculpa.
6. **Número viaja com o alvo.** Toda contagem sai com SHA curto, `git status` e —
   como esta missão aprendeu — **o que mais estava rodando na máquina**. Duas
   vezes hoje o maestro mediu contra árvore em movimento: uma contra o worktree de
   um colega mid-edit (quase virou acusação de commit vermelho, não reproduziu), e
   uma contra a própria árvore no meio de um conflito de merge (o typecheck acusou
   marcadores de conflito).

#### Regra de branch que nasceu de um atrito real

**Branch já consumida pela integração não se reescreve.** `fv/vocabulario` foi
emendada três vezes (`05933159` → `053faadc` → `f2cfa4e1`) depois de eu já ter
mergeado as duas primeiras. Cada reescrita apaga da branch o commit que a
integração consumiu e força um conflito `add/add` no mesmo arquivo. A partir do
primeiro merge do maestro: correção vira **commit novo por cima**, nunca `amend`
nem `rebase`.

#### Pendências abertas

- **H2** e **H3** acima.
- O `e2e` ainda não é check obrigatório na `main` (issue #63). As specs desta
  missão não mudam isso; quem for propor a obrigatoriedade precisa antes de uma
  série verde estável do conjunto atual.

---

## 7. Fechamento — o que ficou, o que está aberto, e para quem

### O padrão que atravessou a missão

Rafael pediu que *"o jeito de configurar execute exatamente a função conforme é
orientado na UI"*. Isso virou o critério que achou **cinco defeitos**, nenhum na
lista original — todos da mesma família: **a tela promete o que o motor não cumpre**.

| # | Onde | O que a tela dizia | O que o motor fazia |
|---|---|---|---|
| 1 | nó de espera | "Adaptativo, 10–360 min" + orientação | esperava **sempre 360** |
| 2 | card da condição | anunciava o combinador | no modo por-regra o motor **não o consulta** |
| 3 | painel da aresta | oferecia "Sim/Não" | nenhum ramo daquele nó casa |
| 4 | dossiê | "escrever a mensagem" | era o turno de **planejar o tempo** |
| 5 | classify (evitado) | canvas desenharia certo | rotearia pelo escape, calado |

O nº 5 **não entrou**: ligar a emissão de ramos no classify sem migrar as arestas
atomicamente produziria exatamente o defeito que a missão existiu para eliminar,
com o canvas desenhando certo. Adiado como item próprio, com a ressalva escrita no
`ClassifyForm` e no cabeçalho do resolvedor — senão o próximo lê como esquecimento.

### E o mesmo padrão nas GUARDAS

Cinco guardas passavam **pelo motivo errado**, e as cinco só apareceram quando
alguém perguntou *"o que exatamente reprovaria se eu quebrasse isto?"*:

- o isolamento de fixture existia em **um** arquivo e faltava nas irmãs;
- a varredura de rótulo cru só olhava valores **com underscore** — pegava
  `waiting_reply`, deixava passar `gte`, `eq`, `and`;
- a lista de dicionários varridos era **escrita à mão** e já nascia incompleta;
- o contador de vazamento ficou **cego** para um status que a `0145` criou;
- o invariante do índice criava o 2º enrollment **no mesmo fluxo**, então não
  distinguia as duas definições de índice — a única coisa que importava.

### Erros do maestro, registrados porque o registro é o que vale

1. **Matou o `next build` de um colega** com medição insuficiente: pai e filho de um
   build ficam em `0% / estado S` **por desenho**, e o trabalho roda num descendente.
   Retratado. Regra nova: percorrer descendentes recursivamente, e **não tocar em
   processo alheio nem com medição** — o dono decide.
2. **Propagou um número sem SHA** ("1 reprova em 3.519") como medição sólida.
   Retirado. E a retirada precisou ser corrigida também: o certo não é "estava
   errado", é **"é irreproduzível, e número irreproduzível não serve para decidir
   mesmo quando por acaso está certo"** (QAVivo).
3. **Entregou contrato incompleto**: pediu ao motor que guardasse `proposto_ms` e deu
   à fila um contrato JSON sem esse campo — cujo propósito era a tela da fila.
4. **Verificou frente por frente e nunca o conjunto** — e foi no conjunto que o
   vermelho estava. Mas a autocrítica "deveria ter rodado sempre" também está errada:
   **conjunto vermelho por carga ensina a ignorar o gate tão rápido quanto conjunto
   que nunca roda**. A regra é *rodar com a máquina sã e declarar a carga*.
5. **Dois proxies que perderam para critérios estruturais de outros**: "até 2 linhas"
   (o certo era *escopo delimitado por estrutura*, e o critério do DevVivo — *"não é o
   tamanho do hunk, é vir com teste"* — é melhor) e "~2× de altura do card" (o certo
   era *custo por ramo*, 19,3px, medido pelo Arquiteto).
6. **Afirmou que o `e2e` não é check obrigatório.** É. Os **quatro** são —
   `verify`, `invariants`, `build-and-size` e `e2e`, medido na branch protection em
   2026-08-08 (`CLAUDE.md` linhas 209-221). A leitura veio de uma versão mais velha
   do documento.

### Pendências abertas, com dono e prioridade

| # | O quê | Dono | Nota |
|---|---|---|---|
| P1 | **Ordem dos dois cron.** `followup-flow-worker` e `event-log-drain` são ambos `* * * * *`. Se o worker reclama antes de o drain terminar de escrever (drain tem `-m45`, worker `-m25`), o enrollment espera o minuto seguinte **sempre**, por ordem de execução — e o conserto do relógio **não** resolve. Medição autorizada; **conserto não**: mexer em ordem de cron é decisão do Rafael com o número na mão. | DevGatilhos | **maior que os 8 abaixo** |
| P2 | 8 outros call sites que agendam com o relógio do processo, nomeados na guarda | a definir | baixa (ver P1 antes) |
| P3 | Migração do classify para ramos (item próprio, ver acima) | Arquiteto | média |
| P4 | Enumeração de status em instrumento de teste sem guarda — hoje sobrevive por coincidência com o CHECK do schema | DevGatilhos | baixa |
| P5 | Falso positivo do hook de migration em commit de **merge** (a condição que ele vigia é satisfeita por todo merge) | — | **treina a equipe a driblar o gate** |
| P6 | Sequência e timestamp das migrations discordam (`0145` ordena antes de `0144` por nome de arquivo) | — | ambiguidade em "aplicar em ordem"; num produto self-host o clone aplica por nome |

### O número de fechamento — condição aceita, ainda não cumprida

Os **três gates verdes no mesmo SHA**, com carga declarada. O maestro aceitou essa
condição do QAVivo em vez de despachar um número parcial: **contagem de teste verde
sem o typecheck ao lado é meio número**, e `test:unit` passa numa árvore que não
compila porque o vitest não typechecka.

Último medido, alvo declarado (`82c88733`, árvore limpa, carga 19,97 → 41,08):
`lint` **0** · `typecheck` **2 causas / 4 linhas** (ambas com dono, ambas
consertadas depois) · `test:unit` **3.578 / 3.580**.

---

## 8. Evidência visual — cada imagem, e o que ela prova

O gate `tests/unit/evidencia-citada.test.ts` reprova imagem versionada que documento
nenhum nomeia. A regra existe porque evidência órfã é indistinguível de sobra: quem
chega depois não sabe se aquilo prova algo ou se foi esquecido.

### Ramificação — uma saída por regra (`evidence/followup-vivo/`)

- **`evidence/followup-vivo/ramos-01-uma-bolinha-por-regra.png`** — o nó de condição com duas regras mostra
  **três saídas separadas**, cada uma com nome legível: *"Tem a etiqueta VIP"*,
  *"Tem a etiqueta atrasado"* e *"Nenhuma delas"*. É a queixa original do Rafael
  resolvida na tela; antes havia **uma bolinha só** para todas as saídas.
- **`evidence/followup-vivo/ramos-02-altura-com-5-regras.png`** — o card com cinco regras, usado para medir
  a altura por ferramenta (43,4px com uma saída → 159,1px com cinco, custo por ramo
  de 19,3px). Registra a decisão de **não** esconder ramo atrás de um "+2 mais":
  ramo escondido perde a bolinha, que é o defeito que a wave conserta.
- **`evidence/followup-vivo/ramos-03-publicado.png`** — o fluxo com ramos nomeados **publicado**, provando
  que `validateFlowForPublish` aceita a forma nova e exige cobertura por ramo.
- **`evidence/followup-vivo/ramos-04-dois-leads-dois-caminhos.png`** — dois leads com etiquetas diferentes
  terminando em **nós diferentes**. É a prova de que a bolinha não é enfeite: o
  roteamento por `branch_id` decide o caminho de verdade.

### Gatilho de caso aberto (`evidence/gatilho-de-caso/`)

- **`evidence/gatilho-de-caso/caso-01-gatilho-armado.png`** — o gatilho "Agente pediu ajuda" escolhido
  pela tela, com o aviso em destaque para começar o fluxo por uma espera. O aviso
  não é dica: abrir um caso não cala o agente, e sem espera o cliente receberia
  duas mensagens ao mesmo tempo.
- **`evidence/gatilho-de-caso/caso-02-publicado.png`** — o fluxo publicado com `kind='case_opened'`, que
  até esta sessão o publish recusava por não haver produtor.
- **`evidence/gatilho-de-caso/caso-03-fila-com-o-followup.png`** — o follow-up na fila, nascido do caso
  que o agente abriu, sem ninguém apertar nada.
- **`evidence/gatilho-de-caso/caso-04-cancelado-apos-resolver.png`** — o outro lado do laço: resolver o
  caso deixa o follow-up **marcado como Cancelado**, e não some da fila. A
  primeira versão da spec cobrava desaparecimento e reprovou — o mecanismo estava
  certo e a asserção errada: linha que evapora não deixa o operador saber o que
  houve.

### Gatilho de etapa (`evidence/gatilho-de-etapa/`)

- **`evidence/gatilho-de-etapa/gatilho-etapa-01-configurado.png`** — o gatilho "Etapa do funil" armado pela
  tela, com o seletor mostrando a etapa **pelo nome**, agrupada por funil — nunca
  UUID — e o rótulo prometendo "poucos minutos" em vez de "na hora", porque o
  produtor roda no tick do cron.
- **`evidence/gatilho-de-etapa/gatilho-etapa-02-publicado.png`** — o fluxo publicado com `kind='stage_change'`,
  que até esta missão o publish **recusava** por não haver produtor.
- **`evidence/gatilho-de-etapa/gatilho-etapa-03-antes-do-movimento.png`** — o estado da fila **antes** de mover
  o lead, que é o controle: sem ele, um enrollment pré-existente seria lido como
  efeito do gatilho.
- **`evidence/gatilho-de-etapa/gatilho-etapa-04-depois-do-movimento.png`** — o quadro **depois** do arrasto,
  com o card na etapa que arma o gatilho. O movimento é pelo teclado, que é a via
  acessível do mesmo `onDragEnd` do mouse — não um atalho por API.
- **`evidence/gatilho-de-etapa/gatilho-etapa-05-fila-com-o-followup.png`** — o follow-up **na fila**, nascido do
  movimento, sem ninguém apertar nada. Esta é a tela que fecha a jornada, e
  nenhuma execução tinha chegado até ela: a spec parava três passos antes.
  Proveniência conferida no banco — o evento do enrollment é
  `enrolled_by_stage_change`, então a fila não está mostrando um follow-up que
  veio por outro caminho.

---

## 9. Fechamento medido

**Alvo:** `f37a04b0` · árvore limpa (0 arquivos) · carga **6,64** no início, **19,58** no fim

```
TYPECHECK_EXIT=0
LINT_EXIT=0
TESTUNIT_EXIT=0

Test Files  334 passed (334)
Tests      3639 passed (3639)
```

As cinco frentes numa árvore, zero pendente, zero reprova.

O número vem com **os três exits capturados separadamente**, e não com o exit
agregado nem só com a contagem de testes — porque `test:unit` passa numa árvore que
não compila (o vitest não typechecka), e porque exit agregado esconde qual etapa
caiu. **Contagem de teste verde sem o typecheck ao lado é meio número** (QAVivo).

### Os cinco eixos que uma frase precisa carimbar

Descobertos um a um ao longo da missão, cada um por uma pessoa diferente, todos da
mesma família: **o instrumento estava certo e o alcance da frase estava errado.**

| Eixo | A frase parece carimbar | E não carimba | Quem achou |
|---|---|---|---|
| **Escopo** | "não há ocorrências" | qual arquivo | maestro (contra si) |
| **Instante** | "após o merge" | qual merge — houve dois | DevGatilhos |
| **Cobertura** | "verde" | qual suíte | QAVivo e DevGatilhos |
| **Dono** | "medi" | qual repositório | DevGatilhos |
| **Posição** | "revoguei as duas origens" | onde no arquivo | guarda do repo |

Os quatro primeiros enganam quem **mede**. O quinto engana quem **revisa** — e é o
pior, porque revisão é a última linha.

**A regra acionável (DevGatilhos):** *a frase precisa carregar o escopo e o instante
junto do número, senão ela viaja mais longe do que a medição alcança.* E o motivo de
essa família atravessar revisão intacta: **a auditoria olha para onde há o que
conferir — e o que há para conferir é o número, que está sempre correto.**

### Doutrina cobre o que alguém já errou; guarda cobre o que ninguém pensou

O caso que fecha: os `revoke` da função nova estavam nas duas origens, como a
doutrina manda — e **a doutrina não fala de ordem**. A função ficaria exposta à chave
anônima com o código parecendo correto. Quem salvou foi uma guarda escrita por alguém
que previu uma função que ainda não existia, com o conserto dentro da mensagem de
erro.

Por isso as **cinco guardas que passavam pelo motivo errado** (seção 7) são o achado
mais grave desta missão: o problema não é o defeito que escapa, é a **rede que parece
existir**.

### Correção do fechamento — CINCO provados em tela, não seis

O maestro escreveu, no anúncio e ao Rafael, *"os seis pedidos provados em tela"*.
**Falso para um deles**, e quem levantou foi o dono do item, sobre o próprio trabalho:

| Pedido | Prova em tela | Spec |
|---|---|---|
| Uma bolinha por regra | ✅ | `followup-ramos` — 4 evidências, 2 leads em caminhos distintos |
| Comparadores em português | ✅ | `followup-linguagem.spec.ts` verde em 29,2s |
| Jargão eliminado / UUID fora | ✅ | idem, 6 capturas |
| Tempo adaptativo real | ✅ | `followup-tempo-adaptativo.spec.ts` |
| Fila com dossiê e intervenção | ✅ | `followup-dossie`, 6 capturas |
| **Gatilho por etapa do funil** | ✅ | `gatilho-de-etapa.spec.ts` **fechada em `eb6ab093`** — 5 capturas, a 05 (o follow-up na fila) inédita. Ver §10 |

**O número honesto era: cinco provados em tela, um com a spec escrita e não fechada.
Com a §10, são seis.**

E o defeito da frase é exatamente o que a missão inteira caçou, agora na prosa do
fechamento: **uma frase agregada que engloba um item que não satisfaz o predicado, e
que ninguém revisa porque o número — seis pedidos — está correto.** É o eixo da
*cobertura* aplicado a uma afirmação de entrega em vez de a um resultado de suíte.

Se tivesse entrado assim, em duas semanas alguém citaria "o gatilho de etapa foi
provado em tela" — e estaria citando o dono do item, que foi justamente quem se
recusou a deixar passar.

### O par simétrico: "conserte a classe" pressupõe ter achado a classe certa

A missão repetiu **"conserte a classe, não a instância"** desde a primeira hora, e
descobriu no fim que a regra tem uma precondição que ninguém enunciava: **você
identificou a classe certa?**

Duas falhas simétricas, no mesmo dia, com a mesma raiz:

| Falha | Quem | Classe escolhida | Erro |
|---|---|---|---|
| **Larga demais** | DevVivo | "arquivos que rodam o tick" | a classe era *"arquivos que exercitam o claim"* — agrupou o que não pertencia junto, e a irmã de fora continuou vazando |
| **Estreita demais** | Maestro / QAVivo | "o predicado velho" | eram **três** classes com o mesmo texto — restauração, reprodução histórica e pergunta. Consertar as três quebraria a réplica; consertar nenhuma deixaria a pergunta respondendo menos que a realidade |

**Raiz comum:** escolher a classe pelo que se **vê** em vez de pelo que a coisa
**faz**. `grep` enxerga texto, não propósito.

Uma sozinha ensina metade: a primeira sugere "amplie o escopo", a segunda sugere
"restrinja". Juntas dizem a coisa certa — **classifique por função, e a semelhança de
texto é só um indício de onde procurar.**

### E autorização precisa de lugar que sobreviva à conversa

Três pedidos de edição de invariante passaram pelo maestro nesta missão. Dois foram
autorizados; **o terceiro se perdeu na fila da conversa e ficou retido a noite
inteira**, com o conserto do `IA360-FLAKY` pronto na árvore de quem pediu — e o
defeito seguiu vivo por isso, inclusive na árvore que o maestro declarou fechada.

O que salvou os patches não foi disciplina: foi alguém ter percebido no meio que o
ponteiro apontava para `/tmp`, que some quando a sessão fecha, e tê-los versionado no
próprio `HANDOFF`. **Pedido que só existe numa mensagem depende de quem centraliza não
esquecer — e quem centraliza esquece.**

### Sabotar o CONSERTO, não só o defeito

A missão cobrou sabotagem a noite inteira, sempre na mesma direção: **quebre o código
e confirme que o teste reprova**. O DevVivo fez o inverso no último achado e ele é o
que mais ensina.

Ele escreveu um invariante para o `LIVE_STATUSES` da reatividade, viu nascer vermelho
como previsto, e então **consertou o defeito** — exigindo que a catraca acusasse a
passagem. **Ela não acusou.**

Motivo, estrutural: `tests/invariants/followup-reactivity.test.ts:55` tem a **própria
cópia** da lista e injeta o próprio adapter. A lista de produção
(`lib/followup/reactivity.ts:63`) **nunca é exercitada por aquele arquivo**.

> **O invariante não pode pegar defeito naquela lista, por construção.** A réplica
> erra igual à original, e concordância entre cópias parece confirmação.

**Ele não commitou.** Um teste vermelho que documenta um defeito que ele não vigia é
pior que teste ausente: ocupa o lugar de um que funcionaria — e viria com a assinatura
completa de rigor (previsão, sabotagem, catraca), então ninguém o revisaria depois.

**A regra:**

| Sabotagem | O que prova |
|---|---|
| quebrar o **defeito** | que o teste **reage** |
| quebrar o **conserto** | que ele reage **ao lugar certo** |

Só a segunda pega teste que não alcança o alvo. E é a que quase ninguém faz, porque a
primeira já dá a sensação de ter verificado.

**Conserto**: `export` no `LIVE_STATUSES` de produção, e o teste importa em vez de
declarar. Uma palavra, sem mudança de comportamento — autorizada com o dono avisado
**antes** e com poder de veto.

### Posse de arquivo: `git log --author` não mede nada nesta máquina

A tabela "não toque" da seção 3 nomeava **pessoas**, e o maestro a escreveu **na primeira
hora, sem medir** — a partir do que cada frente ia fazer. Saiu errado para
`lib/followup/reactivity.ts`, e a atribuição errada foi **repassada três vezes como
fato** antes de alguém conferir.

**A resposta:** o arquivo é da **onda 5** do épico de follow-up (`ba22723e` o criou,
`c5b4f334` é o único outro que o tocou — os dois marcados `[onda 5]`).

**A ressalva de método, que vale mais que a resposta** (DevVivo e MaestroConexoes):

> Nesta máquina **todo commit sai com a mesma identidade git**, então o campo `author`
> não distingue sessão nenhuma. Quem identifica dono aqui é a **etiqueta da onda no
> assunto do commit**, não o autor.
>
> Qualquer varredura de posse com `git shortlog` ou `git log --author` devolve **uma
> pessoa só e parece conclusiva** — e está medindo nada. Quem for varrer os outros
> briefings precisa saber disso **antes** de varrer, senão confirma o erro com um
> instrumento que não mede.

E há **duas perguntas diferentes**, com respostas diferentes, que o briefing colapsou
numa só:

| Pergunta | Como se responde |
|---|---|
| *"De quem é este arquivo?"* | etiqueta da onda no histórico |
| *"Para quem eu despacho este patch agora?"* | `git log <base>..HEAD -- <arquivo>` — quem tocou **nesta missão** |

A origem provável do erro do briefing: quem escreveu leu **proximidade de contexto** (a
pessoa mexia em `silence-sweep.ts` e `api-schemas.ts`, que são vizinhos) em vez de
histórico. Duas linhas de `git log --follow` diziam a resposta, e ninguém rodou.

---

## 10. O gatilho de etapa fecha (sessão de 2026-08-10, noite)

**Alvo:** `eb6ab093` · árvore limpa · carga 5,2 → 9,9 ao longo da sessão.

### O erro real, que a descrição anterior errava

`a653df12` registrou *"'Em andamento' não é encontrada como `option`"*. **Falso.**
Rodando, o erro é o oposto — ela é encontrada **cinco vezes**:

```
strict mode violation: getByRole('option', { name: 'Em andamento', exact: true })
  resolved to 5 elements
  1) … aka getByRole('group', { name: 'E2E Funil Gatilho 1786397109367' })…
```

O Playwright imprimiu o conserto na própria mensagem. Das três hipóteses
declaradas, a do agrupamento por Radix está **refutada** (a opção tem `role=option`
e é achável); a do acúmulo está **confirmada**.

### Eram TRÊS bloqueios, não um

| # | Bloqueio | Origem |
|---|---|---|
| 1 | Seletor ambíguo | a spec |
| 2 | Contato lido em `data.id` num handler que devolve `{contact, action}` — o negócio nascia **sem contato** e o gatilho corretamente não enrollava | a spec |
| 3 | Migrations `0146`/`0147` **não aplicadas** no Postgres local: sem `default now()` em `next_eval_at`, o INSERT do enrollment estourava o CHECK `followup_enrollments_relogio_coerente` | o banco |

O 3 é o mais instrutivo: **código certo, banco velho.** O produtor omite
`next_eval_at` de propósito porque o HEAD promete o default. Nenhum gate pega
isso — `test:db` usa container efêmero do `baseline.sql`, e o Supabase local de
longa duração ficou para trás sem avisar.

### O trabalho já estava feito, e não era meu

Os bloqueios 1 e 2 já estavam consertados em `4bc9f4c1`, na branch `fv/gatilhos`,
commitado às 22:03 — **enquanto eu media**. Os funis que apareceram no banco às
21:58 e 22:01 eram aquela sessão rodando a mesma spec. Trouxe por `cherry-pick`
em vez de reescrever.

**A lição de método:** eu atribuí dois funis novos à minha própria rodada e
escrevi que "o retry se auto-alimenta". `retries: 0`, zero retries no log —
inventei um mecanismo para um número que não era meu. Em máquina compartilhada,
**inventariar quem está vivo vem antes de explicar o número**, não depois.

### O defeito de produto que a auditoria achou

Recebeu ordem explícita de ser cética com *"é só o teste"* — a conclusão que me
pouparia trabalho. Voltou com **PRODUTO**, e o argumento se sustenta sem o banco
sujo: `ETAPAS_INICIAIS` dá a todo funil «Novo / Em andamento / Ganho / Perdido»,
então **dois funis já bastam** para quatro pares homônimos.

O agrupamento por funil não desambiguava: o cabeçalho só existe dentro da lista
aberta e some no seletor fechado e no botão persistente. Armar a homônima errada
levava a `pointers_armados = 0` e `return` mudo — fluxo `active` que nunca
dispara, sem sinal. Invariante 6 do Sistema Vivo. Corrigido em `b688ad22`.

### As guardas, sabotadas uma a uma

| Sabotagem | Previsão | Medido |
|---|---|---|
| `.first()` no lugar do escopo | 1 reprova, no oráculo do `stage_id`, rápida | ✅ 1, `a etapa DESTE funil…`, **14s** |
| emissor de produção quebrado | 1 reprova, no passo 5, ~60s | ✅ 1, `nascer do movimento de etapa`, **78s** |
| funil fora do texto do item | 1 reprova, no clique | ⚠️ 1, mas rotulada `apiRequestContext.post` aos **180s** |

A terceira reprovou **pelo lugar errado**: sem `actionTimeout` no config, o
clique espera o teto do teste e a falha sai colada na chamada seguinte — o
teardown. Consertado em `eb6ab093`; refeita, a mensagem virou
`locator.click: Timeout 60000ms exceeded` em 73s.

**Prever a mensagem, e não só a contagem, é o que pegou isso.** Uma sabotagem que
reprova "1 de 1" e passa batido teria deixado a guarda com vermelho enganoso.

### Erro meu, medido

Reportei "29 funis" e "24 etapas homônimas". Números corretos do **banco inteiro**
(24 organizações) — e irrelevantes: o seletor mostra só a org do usuário, por RLS.
No escopo certo eram 10 e 6. Contei o banco e apresentei como se descrevesse a
tela. **Régua errada, não número errado** — e o "24" era só a contagem de orgs.

E o comentário em `lib/followup/gatilho-etapa.ts:21-28` afirmava que o assistente
**não** emite `lead.stage_changed`. Ele emite desde o conserto do emissor, nesta
mesma missão: **a afirmação falsa sobreviveu ao próprio conserto**, com typecheck,
lint e 3639 testes verdes por cima dela.

### Fica aberto

- **`conversation_end`** continua sem produtor. Rafael pediu "caso aberto"; o que
  existe no schema é o encerramento, e nenhum dos dois foi entregue. Nunca virou
  item — falha de leitura do pedido, não decisão.
- **A ordem dos dois cron** (§ anterior) segue sendo decisão de produção.

---

## 11. O gatilho de CASO ABERTO (2026-08-11)

O último dos três que Rafael listou no início — "lead cai em um estágio / **caso
aberto** / proposta feita". Etapa e proposta saíram na missão; este nunca virou
item, e a falha foi de leitura do pedido, não decisão.

### O que "caso" é neste produto

`agent_cases` — o caso de ESCALAÇÃO: o instante em que o agente de IA trava e diz
que precisa de gente. Quatro entidades disputavam a palavra (`agent_cases`,
`conversations`, `demandas`, `agent_inbox_items`); esta é a que a tela chama de
"Casos" e a que fica ao lado de "proposta feita" na frase do pedido.

### O buraco medido

A tabela não emitia **nada** no barramento. Grep por `emit_event` em
`lib/agent-engine/`, `lib/escalacao/` e `app/api/v1/ai/cases/`: zero linhas
(controle positivo: a mesma sonda acha `agent-stage-sync.ts:308`). Nenhum
consumidor podia reagir a um caso.

### O desenho, e a decisão que mudou por medição

Meu instinto era "caso aberto **e parado há N**", porque abrir um caso **não cala
o agente** — ele continua conversando, e um follow-up no mesmo instante poria
duas vozes na mesma conversa. O levantamento propôs melhor: o atraso vive no **nó
de espera do próprio fluxo** (mais flexível, coerente com os outros gatilhos), e
o par `ai.case_closed` cancela quando o caso resolve rápido. Adotado.

**O par é uma peça só.** Medido: o caso de referência fechou em **6 segundos**.
Follow-up nascido de caso e nunca cancelado só morre por esgotamento ou resposta
— cobraria o cliente sobre um problema já resolvido. Os dois eventos moram no
MESMO handler, para não existir o dia em que só um está registrado.

### Por que TRIGGER e não emissor em código

A abertura tem um escritor; o fechamento tem **cinco**. Caçar emissor deixa a
garantia dependendo de alguém lembrar. Com trigger a garantia é da TABELA — e de
quebra viabiliza a prova em tela, porque **não existe rota de criação de caso**.

Provado no banco antes de escrever o consumidor: INSERT emite `ai.case_opened`
com o contato resolvido; `status→resolved` emite `ai.case_closed`; e mexer só no
`summary` **não** emite (anti-eco).

### O que veio junto

- `followup_enrollments.conversation_id` ganhou o **primeiro escritor do repo**.
  Existia desde a 0054, era lida pelo motor, e só o typegen "escrevia".
- `EventRow.created_at` passa a viajar — sem ele não dá para distinguir evento de
  agora de evento parado em `pending` há três dias, e o drain leva 50 por tick
  sem janela de recência.
- `parseTriggerConfig` degradava kind desconhecido para "manual", e o Salvar
  gravava `{kind:"manual"}` — **destruía o gatilho com um toast de sucesso**.
- O publish virou **allowlist**: recusava um literal e liberava todo o resto,
  publicando `active` sem motor.
- Três eventos de proveniência ganharam tradução no dossiê, incluindo
  `enrolled_by_stage_change`, que aparecia como código cru desde a onda anterior.

### As guardas, sabotadas

| Sabotagem | Previsão | Medido |
|---|---|---|
| volta a denylist no publish | 1 reprova (kind desconhecido) | ✅ 1 de 29 |
| handler registra só a ABERTURA | 1 reprova no passo 6 | ✅ 1, `resolver o caso tem que CANCELAR`, **84s** |

### Duas asserções minhas que estavam erradas (o mecanismo, não)

1. **"a linha some da fila"** — não some, e não deve: a fila mostra todos os
   status com selo, porque linha que evapora não deixa o operador saber o que
   houve. Passou a cobrar o ESTADO ("Cancelado", pela tela).
2. **"basta recarregar a aba"** — cancelar zera o `next_eval_at` e a linha afunda
   na ordenação; num banco com 52 enrollments ela sai da primeira página. A spec
   passa a **buscar pelo nome**, que é o que o operador faria.

### Fica aberto

- **`assignee_kind` / `bot_silenced_until`** não são lidos pela cadeia de envio do
  follow-up. `force_human` é. Atendente que assume sem levantar `force_human` não
  é detectado — declarado no cabeçalho do consumidor, não descoberto depois.
- **`agent_cases.followup_attempts`** continua sem escritor no repo inteiro. O
  painel de Atrito vai reportar `insistencia_media = 0` enquanto este gatilho
  insiste. O ponto de inserção é o nó de envio, compartilhado com os outros três
  kinds — item próprio, não deste.
- **`conversation_end`** segue no Zod sem motor. Sob allowlist ele agora é
  recusado como qualquer desconhecido, então é inofensivo; a remoção é commit
  próprio.
