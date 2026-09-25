---
type: research
assunto: Jev (TypeSafe AI) — modelo System One e o que ele resolve no DeskcommCRM
data: 2026-09-19
medido_contra: branch fix/agente-pausado-nao-atende @ 1ecf1ab04
fontes_externas: docs.typesafe.ai (API + llms.txt), typesafe.ai, vídeo de referência (transcrição), registro npm
---

# Jev no DeskcommCRM — relatório de decisão

> **Aviso de régua.** Tudo sobre o Jev abaixo é **afirmação do fornecedor** ou leitura da
> documentação dele — não medi nada contra a API real (não temos chave). Tudo sobre o
> DeskcommCRM foi medido neste repo, e cada afirmação traz o arquivo:linha. As duas
> categorias não se misturam: onde escrevo "eles dizem", ninguém verificou.


> ## ⚠️ Segunda medição, 2026-09-20 02:00 — contra `origin/main` @ `950ba34fd`
>
> Tudo abaixo foi medido contra `fix/agente-pausado-nao-atende` @ `1ecf1ab04`, que estava
> **3.163 commits atrás da main** (a branch é de 28/08). Os números do corpo continuam
> corretos **para aquela régua** e não foram retocados — retocar um documento datado o
> transforma num documento sem data. O que muda contra a main de hoje:
>
> | Afirmação | Medida na branch (1ecf1ab04) | Medida na main (950ba34fd) |
> |---|---|---|
> | pontos de IA no `registro.ts` | 24 | **26** |
> | linha da confiança que é similaridade de RAG | `ai-response-worker.ts:219` | **`:248`** |
> | o defeito em si | presente | **presente — não foi consertado** |
> | os 7 arquivos que parseiam JSON de modelo | 7 | **os 7 continuam existindo** |
> | `reasoning_short` descartado · timeout de 5 s | presentes | **presentes** (`:43`, `:32`) |
>
> **Nenhuma conclusão do relatório se move.** O que muda são dois números de localização, e
> é por isso que o corpo prefere comandos a números onde dá. Para refazer esta tabela:
>
> ```bash
> git fetch origin main && M=origin/main
> git show "${M}:lib/ai/pontos/registro.ts" | grep -cE '^    id: "'
> git show "${M}:workers/ai-response-worker.ts" | grep -n 'citations\[0\]?.similarity ?? 0'
> ```
>
> ⚠️ As aspas em `"${M}:caminho"` não são estilo: em zsh, `$M:lib/...` é lido como o
> modificador `:l` e **come a letra**, devolvendo "arquivo ausente na main" para um arquivo
> que existe. Aconteceu nesta própria remedição, e o falso negativo é indistinguível de
> medição boa.

---

## 1. O que o Jev é — em cinco linhas

Modelo da TypeSafe AI (fundador: Diogo Almeida, ex-OpenAI, RLHF/InstructGPT) que inaugura a
categoria **System One**. Ele **não escreve texto**: recebe um estado e um mapa de perguntas
tipadas, e devolve **valores tipados com probabilidade calibrada**, todas as perguntas
avaliadas **em paralelo numa passada só**. Pós-treino próprio (RLCD — *Reinforcement Learning
for Calibrated Decisions*): otimiza a probabilidade contra o **desfecho**, não contra
preferência humana. Três primitivas, e só elas:

| Primitiva | O que é | Resposta |
|---|---|---|
| `choice` | escolher 1 entre até 255 opções | opção + probabilidade de cada uma + `confidence` |
| `score` | posição numa escala de 2–10 níveis ordenados | número contínuo (ex.: 1.4) + probabilidades + `confidence` |
| `noul` | sim/não | um número de 0 a 1 |

Contrato (`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, `model:
"jev-latest"`, `state` + `questions`). SDK JS oficial: `@typesafe-ai/sdk`, **versão 0.6.0,
publicada em 2026-09-12** (`npm view @typesafe-ai/sdk version time.created` — sete dias de
vida), MIT.

**Números que eles publicam:** latência ponta a ponta 70–500 ms; **US$ 0,042 por milhão de
tokens de entrada, saída gratuita**; "193,6× mais rápido, 444,6× mais barato" que LLM de
fronteira. Produto em **early access, v0.01**, benchmarks internos, sem verificação
independente.

**O que ele não faz** (isto define o escopo inteiro deste relatório): não escreve, não
programa, não explica, não lê imagem nem áudio, e **não sabe nada além do estado que você
mandar**. E "não alucina" quer dizer *não inventa formato* — a nota que ele dá pode estar
errada; o que não acontece é vir um JSON quebrado.

---

## 2. Por que isto interessa a este produto especificamente

O DeskcommCRM já organizou a própria vida de um jeito que torna a pergunta trivial de
responder: **`lib/ai/pontos/registro.ts` cataloga os 24 pontos onde o sistema chama IA**, cada
um com papel e capacidade exigida, e `ai_purpose_bindings` permite ao operador escolher
provedor **por ponto**, sem deploy (`lib/agent-engine/edge/llm/binding-do-ponto.ts`).

Ou seja: a pergunta "onde o Jev caberia?" já tem uma lista pronta e auditada por teste
(`tests/unit/pontos-de-ia-completude.test.ts` reprova ponto oculto e ponto órfão). Cruzei a
lista com as três primitivas.

### 2.1 O cruzamento

| Ponto (`registro.ts`) | O que decide hoje | Primitiva Jev | Cabe? |
|---|---|---|---|
| `intent_router` | qual agente atende | `choice` | **Sim, exato** |
| `stage_classifier` | etapa do funil (7 estágios) | `choice` | **Sim, exato** |
| `sentiment_classify` | clima da conversa (0..1) | `score` | **Sim, exato** |
| `jailbreak_detect` | none/low/high | `score` ou `choice` | **Sim, exato** |
| `followup_classify` | classe da resposta ao follow-up | `choice` | **Sim, exato** |
| `promise_semantic` | é promessa? + trecho suspeito | `noul` + ✗ | **Parcial** — o trecho é texto |
| `followup_decide_timing` | quando retomar | `choice` de janelas | Parcial — hoje devolve plano |
| `flywheel_judge` | nota do próprio atendimento | `score` | Sim |
| `agent_turn`, `compaction`, `flush`, `checkpoint`, `draft_suggestion`, transcrição, visão, embeddings | escrevem/percebem | — | **Não** |

**Cinco pontos são encaixe exato, dois parciais.** Não é coincidência: quem escreveu esses
classificadores já estava, na prática, pedindo a um LLM que fizesse o trabalho de um System
One — e pagando o preço disso.

### 2.2 A prova de que já estávamos pagando esse preço

Três evidências no próprio código, nenhuma delas escrita com o Jev em mente:

1. **Pagamos por saída que jogamos fora.** `workers/ai-sentiment-worker.ts:41` diz, em
   comentário: *"`reasoning_short` é DESCARTADO (só `sentiment_score` e a latência vão para
   `messages.metadata`). Ele existe para o modelo raciocinar antes de pontuar, não para ser
   guardado."* São tokens de **saída** — a parte cara — comprados para serem descartados.
   O Jev não cobra saída porque não produz saída.

2. **Existe código defensivo de parse em 7 arquivos** que leem JSON de modelo
   (`jailbreak/classifier.ts`, `promise/semantic.ts`, `compaction.ts`,
   `followup-flow-classify.ts`, `intent-classifier.ts`, `inbound-turn.ts`, `flywheel/live.ts`).
   O cabeçalho do `intent-classifier.ts` é explícito: *"Defesa contra saída de modelo
   (não-confiável): `parseIntentVerdict` NUNCA lança — JSON malformado, campo faltando,
   intenção alucinada… tudo vira veredito nulo"*. Com resposta tipada por construção, essa
   classe inteira de defesa perde a razão de existir.

3. **O timeout do classificador de sentimento é de 5 segundos**
   (`CLASSIFY_TIMEOUT_MS = 5_000`, `workers/ai-sentiment-worker.ts:29`). Ninguém escreve
   cinco segundos de folga para uma pergunta de uma palavra a menos que a latência seja um
   problema conhecido.

---

## 3. O achado que muda a conversa: nossas três "confianças" não são confiança

Este é o motivo pelo qual eu não trataria o Jev como assunto de custo. O produto toma **três
decisões de negócio** baseadas num número chamado `confidence` — e nenhum dos três é uma
confiança calibrada.

**(a) O gate de handoff humano por baixa confiança usa similaridade de RAG.**

```ts
// workers/ai-response-worker.ts:219
const confidence = response.citations[0]?.similarity ?? 0;
```

Isso mede *"achei um documento parecido na base"*, não *"tenho certeza da resposta"*. E o
`?? 0` faz toda resposta **sem citação nenhuma** valer zero — abaixo de qualquer limiar
(default 0.5), portanto **escala para humano**. Um "bom dia, tudo bem?" respondido
perfeitamente, sem consultar base, aciona o gate. É um falso positivo estrutural, não um
ajuste de limiar. *(Ressalva honesta: isto está no motor legado, o ponto `bot_respond`. Ele
roda — o commit `2511384c1` desta mesma branch trata justamente de comportamento dele em
produção. Não encontrei equivalente de baixa confiança no motor novo: `grep -rn
"low_confidence\|confianca" lib/agent-engine` devolve zero. Ou seja: no motor novo essa
decisão simplesmente **não existe**.)*

**(b) O roteador de intenção pede ao próprio LLM que declare a confiança dele.**

```ts
// lib/agent-engine/agent/intent-classifier.ts:28
'Responda SOMENTE JSON: {"intent": "<…>", "confidence": <0 a 1>}'
```

Confiança auto-declarada por LLM é notoriamente descalibrada — o modelo escreve "0.9" porque
0.9 é um número que aparece muito em textos confiantes. É com esse número que decidimos se o
turno vai para o agente escolhido ou para o `fallbackAgentId`.

**(c) A promessa semântica é binária.** `{isPromise: true|false}`
(`guardrails/promise/semantic.ts`) — um gate que **veta o envio ao cliente** não tem grau de
certeza. Não dá para dizer "veta acima de 0,8, escala ao humano entre 0,5 e 0,8".

O Jev entrega exatamente a peça que falta nos três: probabilidade calibrada contra desfecho,
por construção do pós-treino. **Esse é o argumento de qualidade, e ele é mais forte que o de
custo.**

---

## 4. O uso que eu acho realmente interessante: o que hoje é regex porque LLM não cabia

Trocar haiku por Jev nos classificadores que já existem economiza dinheiro e melhora a
calibração. Bom, mas incremental. O que muda de patamar é outra coisa.

O produto tem decisões **na ingestão** — antes do modelo, no caminho do webhook do WAHA — que
são feitas por expressão regular **porque LLM ali seria lento e caro demais**. Isso está
escrito como decisão consciente: `lib/agent-engine/agent/human-handoff.ts` documenta que o
gatilho determinístico *"roda no runtime ANTES do modelo: o turno não gasta LLM"*.

E as duas maiores cicatrizes documentadas do produto estão exatamente aí:

- **Opt-out.** `lib/opt-out/deteccao.ts` abre com o incidente: numa clínica odontológica, a
  regex antiga bloqueou pacientes que escreveram *"tem como parar a dor?"* e *"preciso sair
  mais cedo da consulta"*, e **deixou passar** *"não quero mais receber nada"*. O CLAUDE.md
  registra 12 falsos positivos num corpus de 32 frases de nicho. O arquivo é uma aula de
  como se acerta isso com regex — e o preço é que **espanhol não é coberto** (`baja`,
  `salir`, `no quiero recibir`, PR #275 em aberto). Cada idioma novo é um mês de vocabulário
  à mão.

- **Pedido de atendimento humano.** `HUMAN_HANDOFF_PATTERNS` são quatro regexes
  *"CONSERVADORES"* por decisão declarada. Conservador aqui significa falso **negativo**:
  quem pede humano de um jeito não previsto ("me tira desse robô", "quero falar com alguém de
  verdade aí") não é atendido. E escalação humana clara é, nas palavras do próprio cabeçalho,
  *"EXIGÊNCIA fiscalizada da Meta, não fallback"*.

**Um `noul` a 70–500 ms e US$ 0,042/Mtok cabe onde um LLM a 3 s e US$ 1/Mtok não cabia.**
Isso é o produto: intenção multilíngue, sem tabela de vocabulário, no caminho de ingestão.

Mesma lógica vale para a **Central de avisos** (`agent_inbox_items`): hoje os itens chegam
sem ordem de urgência. Um `score` por item — em lote, todas as perguntas numa passada — dá
uma fila priorizada por quase nada.

---

## 5. O que barra, e é preciso levar a sério

Nenhum destes é fatal, mas os quatro primeiros mudam **como** se implementa.

1. **O seam não sabe receber um não-LLM.** `ProviderRegistry` é
   `Record<string, (apiKey, modelId, baseUrl?) => LanguageModel>`
   (`edge/llm/providers.ts:26`) e `runModelCall` termina em `generateText`. O Jev não é um
   `LanguageModel` e nunca será um. Fingir que é (um adaptador `LanguageModelV3` que traduz
   prompt em texto para `questions`) é gambiarra: o prompt é texto livre, e as `questions`
   do Jev exigem `criteria` estruturados. **O caminho honesto é um seam irmão**,
   `runDecisionCall`, que reusa tudo o que está em volta — binding por ponto, orçamento
   checado antes de sair byte, gravação em `llm_calls`, allowlist de egress — e troca só a
   ponta que fala com o provedor.

2. **O egress falha fechado.** `edge/egress.ts` valida o host contra allowlist derivada de
   config. `api.typesafe.ai` precisa entrar por configuração, nunca hardcoded — é o desenho
   deliberado da F4-03.

3. **LGPD: é um operador novo, nos EUA, recebendo mensagem de cliente.** O `state` do Jev é
   a conversa. Numa clínica, é dado de saúde. Isso entra no registro de operadores e na
   política de privacidade (`app/legal/privacy/page.tsx`) **antes** de qualquer byte sair.
   Não é detalhe de implementação; é pré-requisito de release.
   *(Não medi a política de retenção/treino da TypeSafe — o `llms.txt` não a documenta.
   Pergunta obrigatória ao fornecedor antes de qualquer piloto.)*

4. **É self-host com chave do cliente.** Cada instalação traria mais uma conta, mais uma
   chave, mais um lugar para quebrar — e o `install.sh` já é a superfície de primeira
   impressão do produto. A doutrina de packaging é clara: variável nova precisa de default
   que não quebre `.env` antigo, e atualização não pede edição manual. **Portanto: opcional,
   desligado por padrão, e com fallback para o caminho atual quando ausente ou fora do ar.**

5. **Maturidade.** SDK com sete dias e versão 0.6.0, produto em v0.01, sem SLA público,
   métricas auto-reportadas. Pôr isso num caminho síncrono de ingestão, que hoje não depende
   de rede, é trocar um problema de precisão por um de disponibilidade.

6. **O adversário é o custo atual, não o custo de fronteira.** Os benchmarks do Jev comparam
   com GPT-6 Astra e Fable 5.1. Nós já usamos `claude-haiku-4` nos classificadores
   (`edge/llm/pricing.ts`: US$ 1/Mtok entrada, US$ 5/Mtok saída). A vantagem real é ~24× na
   entrada e a saída gratuita — enorme, mas um quarto do que o marketing anuncia para o
   nosso caso concreto. Vale escrever o número certo na hora de justificar.

---

## 6. Decisão

**Adotar como provedor opcional de um seam novo de decisão, começando por dois pontos, e
não tocar em nada que já esteja estável.** Não adotar como dependência do produto, não
colocar no caminho de ingestão na primeira rodada, não prometer no changelog antes de medir.

O raciocínio: a arquitetura de pontos e bindings que já existe transforma isso de "aposta em
fornecedor novo" em "mais uma opção num painel que o operador já usa". Se o Jev não se
sustentar, some do painel e nada mais muda — esse é o preço de saída, e ele é baixo o
bastante para justificar entrar agora.

O que **não** faria: substituir a detecção de opt-out por Jev. Essa regra é a que silencia
uma pessoa para sempre, e o módulo é explícito sobre quem pode fazer isso
(*"quem tem o poder de silenciar alguém para sempre é a pessoa"*). A forma certa lá é
**cascata, nunca substituição**: a regex segue sendo a única que bloqueia; o Jev opina
**apenas onde a regex disse não**, e sua opinião **só escala ao humano** — nunca bloqueia
sozinho. Com isso o espanhol é coberto sem inverter a política.

---

## 7. Plano de implementação (3 ondas, cada uma entrega sozinha)

### Onda 1 — o seam e um ponto barato de provar
- `lib/ai/decisao/` — cliente do `POST /v1/systemone` sobre `allowlistedFetch`, com as três
  primitivas tipadas em TypeScript. Sem SDK do fornecedor na primeira onda: são três
  primitivas e um POST; uma dependência de 7 dias no `package.json` do produto custa mais do
  que economiza.
- `runDecisionCall` espelhando `runModelCall`: binding por ponto, orçamento **antes** da
  chamada, linha em `llm_calls` com `purpose` (o Jev devolve `usage.input_tokens`, então a
  atribuição de custo continua funcionando), `agent_id` quando houver.
- Provedor `typesafe` em `lib/ai/pontos/provedores.ts` — sem migration: os CHECKs de
  `provider` caíram na 0127.
- Primeiro ponto: **`sentiment_classify`**. É `score` puro, já descarta o texto do
  raciocínio, roda fora do caminho crítico (worker paralelo) e falha em silêncio por
  desenho. Se quebrar, ninguém do outro lado percebe.
- **Medição obrigatória, lado a lado:** rodar Jev e haiku no mesmo corpus de mensagens reais
  desta instalação, registrar concordância, latência p50/p95 e custo. Sem esse número, a
  onda 2 não abre.

### Onda 2 — onde a calibração conserta um defeito
- **`intent_router`** trocando a confiança auto-declarada pela calibrada. O `choice` do Jev
  devolve a probabilidade de **cada** membro do router — dá para acionar o `fallbackAgentId`
  por distância entre a primeira e a segunda opção, não por um número inventado.
- **Conserto de `workers/ai-response-worker.ts:219`** — este vale independentemente do Jev,
  e eu abriria como PR próprio: usar similaridade de RAG como confiança do bot é defeito com
  ou sem fornecedor novo.
- **`jailbreak_detect`** como `score` de 3 níveis, mantendo o caráter advisório.

### Onda 3 — o que hoje não existe
- **Cascata de opt-out multilíngue** na ingestão, nos termos da seção 6 (Jev só onde a regex
  negou; só escala, nunca bloqueia). Fecha o PR #275 sem tabela de vocabulário por idioma.
- **Pedido de humano** pela mesma cascata: regex segue disparando; o Jev pega o que ela não
  previu e abre item na Central.
- **Fila da Central por urgência** — um `score` por item, em lote.

### 7.1 O desenho do `runDecisionCall` (detalhado em 2026-09-20)

Escrito contra as assinaturas reais do seam, para virar código sem redesenho. Nada aqui foi
implementado ainda.

**As três primitivas, em TypeScript.** O contrato do fornecedor é pequeno o bastante para não
precisar do SDK dele na primeira onda (`@typesafe-ai/sdk` tem sete dias e o produto é
self-host):

```ts
type Pergunta =
  | { tipo: "noul";   instrucao: string; criterios?: { true: string; false: string } }
  | { tipo: "choice"; instrucao: string; criterios: Record<string, string | null> }
  | { tipo: "score";  instrucao: string; criterios: readonly [string, string, ...string[]] };

type Resposta =
  | { tipo: "noul";   noul: number }                     // 0..1
  | { tipo: "choice"; escolha: string; probabilidades: Record<string, number>; confianca: number }
  | { tipo: "score";  score: number;   probabilidades: Record<string, number>; confianca: number };
```

**A assinatura espelha o seam existente**, porque tudo em volta é o que se quer reusar:

```ts
runDecisionCall(db, cfg, {
  tenantId, leadId?, jobId?, agentId?,   // mesma procedência: a ROW do job, nunca o payload
  purpose,                                // 'sentiment_classify' | 'intent_router' | …
  estado: string | object,                // o `state` do Jev
  perguntas: Record<string, Pergunta>,
}): Promise<Record<string, Resposta>>
```

**O que ele reaproveita, sem reescrever:**

| Peça | Como entra |
|---|---|
| escolha de provedor por ponto | `decidirParaOSeam` — o binding já tem `provider`, `credential_id` e `base_url` |
| orçamento da org | mesma checagem **antes** de sair byte; `LlmBudgetExceededError` continua terminal |
| egress | `allowlistedFetch` com o endpoint vindo do binding, **nunca** hardcoded (F4-03) |
| telemetria | `llm_calls` sem coluna nova: `provider='typesafe'`, `model='jev-latest'`, `input_tokens` do `usage`, `output_tokens=0`, `latency_ms`, `origem_da_escolha`, e `status`/`error_code` no caminho de erro |
| preço | uma linha em `pricing.ts` (`jev` → input 0,042 USD/Mtok, output 0) — o match já é por prefixo |

**O fallback é o contrato, não um detalhe.** Toda chamada nasce com o caminho atual do lado:
credencial ausente, 401, 422, 429, 529 e timeout **todos** caem nele, e o turno segue como
hoje. Isso vira teste antes do código — quatro casos, um por classe de falha, mais o de
provedor não configurado. Um piloto que derruba o atendimento quando o fornecedor cai não é
piloto.

**Onde o `422` é diferente dos outros.** Os demais são indisponibilidade; o 422 é **contrato
errado nosso** (pergunta malformada). Ele não deve ser silenciado junto com os outros: cai no
fallback igual, mas com `error_code` próprio e alerta — senão um `criteria` quebrado por uma
edição vira degradação permanente e silenciosa.

**A divergência é o laço de retorno** (invariante 7 da doutrina de sistema vivo): quando Jev e
caminho atual discordam, a divergência vira candidato ao golden set — mesmo padrão que
`stage-classifier.ts` já usa para divergência classificador × modelo. Sem isso o piloto não
produz o dado que decide se ele continua.

### Cercas que entram junto (senão isto vira ilha)
- Ponto novo no `registro.ts` **no mesmo commit** da chamada — é o que
  `tests/unit/pontos-de-ia-completude.test.ts` cobra nos dois sentidos.
- Fallback provado por teste: provedor ausente, 429, 529 e timeout **todos** caem no caminho
  atual. Um piloto que derruba o atendimento quando o fornecedor cai não é piloto, é
  incidente.
- `.env.example` + `lib/env.ts` para a chave, opcional por default.
- Laço de retorno (invariante 7 da doutrina de sistema vivo): divergência Jev × caminho atual
  vira candidato ao golden set, como `stage-classifier.ts` já faz com a divergência
  classificador × modelo.
- Fragmento em `.changes/` declarando `capacidade_nova`.

---

## 8. Resumo em uma frase

O Jev não é um modelo mais barato para as decisões que já tomamos — **é o que torna viáveis
as decisões que hoje entregamos a expressões regulares porque LLM não cabia ali**, e é a
única peça no mercado que entrega a probabilidade calibrada que três gates deste produto
fingem ter.

---

## Fontes externas

- [Documentação do Jev — API](https://docs.typesafe.ai/api.md) · [índice](https://docs.typesafe.ai/llms.txt) · [SDK JS](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe AI](https://typesafe.ai/)
- [Análise "O Que É o Jev? O Modelo System One da TypeSafe AI" (Eigent)](https://www.eigent.ai/pt/blog/typesafe-ai-jev-system-one-models)
- [MarkTechPost — TypeSafe AI Releases Jev](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/)
- [Olhar Digital — cobertura em pt-BR](https://olhardigital.com.br/2026/09/17/inteligencia-artificial/conheca-o-jev-nova-ia-do-cocriador-do-chatgpt-que-nao-conversa-e-foi-criada-para-tomar-decisoes-dentro-de-softwares/)
- [heise online — AI model "Jev" to make machines decide faster](https://www.heise.de/en/news/AI-model-Jev-to-make-machines-decide-faster-11457071.html)
- Vídeo de referência: <https://www.youtube.com/watch?v=QWap6zTgIH8> (benchmark independente do autor, com repositório aberto; conclusão dele: Jev como camada de decisão de *tool calling* reduziu tokens e custo em **todos** os modelos testados, mas introduziu perda de assertividade na escolha de ferramenta quando o contexto passado era pobre)
