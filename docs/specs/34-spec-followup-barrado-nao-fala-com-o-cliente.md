---
title: "Spec Técnica 34 — Follow-up barrado pela trava não fala com o cliente nem passa a conversa para a equipe"
parent: 00-prd-master.md
type: spec
scope: agente (turno de follow-up), cadeia de envio, passagem para humano, Central
status: draft
version: 0.1.0
owner: arquitetura
created_at: 2026-11-09
related:
  - 15-spec-casos-humanos.md
---

# Spec 34 — Follow-up barrado pela trava não fala com o cliente nem passa a conversa para a equipe

Status: **PROPOSTA**. O código citado é o da `main` em `95f3103d1` (09/11/2026). O estado foi
medido nesse dia numa instalação em produção (versão 1.104.0), só com leitura, sempre filtrando por
`organization_id`, numa organização com a trava "valores e negociação só com a equipe" ligada.

## O problema, em duas frases

1. Quando o **follow-up** (a IA puxando uma conversa) escreve um texto que a trava comercial
   barra, o sistema reage como se o **cliente** tivesse perguntado de valores: manda a ele "Vou pedir
   ajuda de alguém da equipe para cuidar disso com você" e passa a conversa para a equipe,
   pausando o automático. Em 4 dos 5 casos medidos, o cliente não tinha nada esperando resposta.
2. Ninguém consegue saber o que foi barrado: o texto não fica em lugar nenhum, e o cartão da
   passagem diz "O assistente não teve confiança suficiente para responder", que não é o que
   aconteceu.

## O que foi medido

### No banco (uma organização, 09/11/2026)

| # | Medição | Resultado |
|---|---|---|
| B1 | Mensagens da conversa do caso (cliente sem resposta desde 05/11) | 2, ambas de saída: o cumprimento do follow-up (05/11) e o aviso de passagem (09/11 08h02). **Nenhuma** de entrada |
| B2 | `job_queue` do caso | 1 job `followup_turn` (passo `action-5` do fluxo); nenhum `inbound_turn` na conversa no dia |
| B3 | `agent_turn_traces` do job | `historico_mensagens = 1`; ferramentas: `crm_get_prospecting_site_audit` ok → `send_message` falhou ("Resposta barrada e necessidade de atendimento humano registrada…") → `open_human_case` ok → `send_message` falhou (atendimento com humano) |
| B4 | `before_send_traces` do job | 3 linhas, todas `tipo_envio = 'disparo'`: (1) veto `commercial_restriction`, `restricted_kind = commercial`; (2) o aviso de passagem, que passou em todas as travas; (3) veto `stop`/`atendimento_com_humano` |
| B5 | `lead_checkpoints` do job | resumo gravado pela própria IA: "não houve resposta do lead" |
| B6 | Vetos `commercial_requires_human` na organização desde 02/11 | **5 em follow-up** (`disparo`, 5 contatos) e 3 em resposta. Nos 5 follow-ups saiu 1 mensagem de saída até 2 min depois; em 2 deles o contato nunca tinha escrito |
| B7 | Onde o texto barrado poderia estar | Não está em `messages`, `send_ledger` (só o aviso, e só o `body_hash`), `llm_calls` (só tamanhos e custo), `agent_turn_traces`, `before_send_traces`, `lead_checkpoints`, nem no log do worker (só `gate=commercial_restriction verdict=veto`). Na tela, Agente › Execuções › Detalhes mostra "Sem trace disponível" |
| B8 | Regras de automação com `send_ai_message` na organização | 0 (o caminho da automação, item C6, só foi medido no código) |
| B10 | Linhas `send_vetoed` em `crm_lead_activities` para os 8 vetos comerciais de B6 (por `source_id` = id do trace) | **8 de 8** gravadas. O texto delas: "Não enviei: bloqueado pela regra \"commercial_restriction\" (commercial_requires_human)". No caso de B1, o veto seguinte (`stop`/`atendimento_com_humano`, a conversa já com a equipe) gravou "Não enviei: o contato pediu para parar de receber mensagens", e o contato não pediu isso |
| B9 | Nos 5 vetos em follow-up de B6: havia mensagem do cliente **sem resposta** na hora do veto (última de entrada depois da última de saída)? | **4 não** (2 sem nenhuma mensagem do cliente, 2 com a mensagem do cliente já respondida). **1 sim**: o cliente escreveu e ficou 2 dias sem resposta até o follow-up rodar |

### No código

| # | Fato | Onde |
|---|---|---|
| C1 | O mesmo turno serve `inbound_turn` e `followup_turn`; o que muda vem em `input` | `lib/agent-engine/agent/inbound-turn.ts`, comentário de `executarTurnoDoAgente` (l. 1907) |
| C2 | Já existe a régua "este turno responde a alguém?": `eTurnoDeResposta(job)` é `true` só para `inbound_turn` e `case_reply_turn` | `inbound-turn.ts:2395` |
| C3 | Veto `commercial_requires_human` no `send_message` e no `send_template` chama `passarComercialParaEquipe`, que **sempre** avisa o cliente (`avisarLeadDaEscalacao`, motivo `outro`) e passa para a equipe (`performHumanHandoff`, motivo `low_confidence`), sem olhar o tipo do turno | `inbound-turn.ts:3271` (definição), `:4410` e `:5014` (chamadas) |
| C4 | O follow-up de texto fixo, barrado pela mesma régua, só marca o passo como `skipped` e fecha o job: sem aviso, sem passagem | `lib/followup/enviar-texto-fixo.ts:228` |
| C5 | A cadeia já grava o tipo do envio: `before_send_traces.tipo_envio in ('resposta','disparo')` | migration `20261004100000_0535_tipo_de_envio_no_trace.sql` |
| C6 | A ação de automação `send_ai_message`, barrada pela mesma régua, chama `triggerHandoff`, e `triggerHandoff` **sempre** avisa o cliente (`avisarLeadDoCrm`, passo 0) | `lib/automation/actions/send-ai-message.ts:235`; `lib/ai/handoff/orchestrator.ts:262–283` |
| C7 | O rastro da cadeia guarda **de propósito só rótulos, nunca o corpo** ("sem PII") | `lib/agent-engine/guardrails/before-send.ts:1834–1838` |
| C8 | O texto livre da passagem vai para `content`, que a cascata de LGPD apaga | `lib/escalacao/passagem.ts:476–485` |
| C9 | O cartão lê a frase do motivo em `FRASE_DO_MOTIVO`; `low_confidence` = "O assistente não teve confiança suficiente para responder" | `lib/escalacao/passagem.ts:137` |
| C10 | O motivo da passagem é uma lista fechada no banco (CHECK de `motivo_codigo` e `aviso_motivo_codigo`); não há código para "trava comercial" | `supabase/baseline.sql:30346`, `:30383`, `:30439`, `:30448` |
| C11 | A prévia (Agente › Teste) só propõe **resposta a uma mensagem do cliente**: o campo é "Mensagem do cliente (sample)", e `kind` é `sandbox` ou `assisted` | `app/app/ai/agents/[id]/_components/TestPanel.tsx:267`; `lib/agent-engine/agent/preview.ts:37`, `:179` |
| C12 | O teste de invariante da trava comercial cobre só `inbound_turn` | `tests/invariants/restricao-comercial-no-send-template.test.ts:170` |
| C13 | O tipo do job **não** diz se o cliente está calado: o `followup_turn` também nasce como reação à resposta do cliente ("O gatilho é a resposta do lead, não o relógio") | `lib/followup/aplicar-inbound.ts:1–4`, `:38–42` |
| C14 | Já existe a régua "mensagens do cliente sem resposta": as de entrada depois da última de saída | `inboundsNaoRespondidos`, `inbound-turn.ts:1818` |
| C15 | Como o passo do fluxo fecha depois do turno do agente: pelo `send_ledger` do job. Com linha aceita, o passo conta como enviado; sem linha, fica `skipped` ("concluiu este passo sem enviar uma mensagem") | `resultadoDoEnvioDoFollowup`, `lib/agent-engine/edge/crm/send-ledger.ts:324–343`; chamada em `lib/agent-engine/agent/followup-turn.ts:892` |
| C16 | Depois do veto, o próprio agente ainda pode passar a conversa: `open_human_case` arma o silêncio (`moverParaHandoffBestEffort`), e a ferramenta de pedir humano avisa o cliente com `pediu_humano` quando nada saiu no turno | `inbound-turn.ts:5592`; `:5405–5412` |
| C18 | Todo veto da cadeia grava a linha `send_vetoed` na timeline do negócio aberto do contato, com `payload {gate, code}` e um `reason` legível; sem negócio aberto (`no_open_lead`) a linha não é gravada | `lib/agent-engine/guardrails/before-send.ts:1866–1880`; `lib/leads/veto-activity.ts` (`emitVetoActivity`, `vetoReason`); `lib/leads/agent-activity.ts:53` |
| C19 | A anonimização da LGPD zera `payload`, `metadata` e `reason` das linhas de `crm_lead_activities` do contato | `supabase/baseline.sql:432–445` |
| C20 | O relatório de Atividades mostra o `reason` como motivo | `lib/reports/atividades.ts:282` |
| C21 | `vetoReason` não tem frase para `commercial_restriction` (cai no genérico com o nome técnico) e dá para o gate `stop` sempre "o contato pediu para parar de receber mensagens", também quando o código é `atendimento_com_humano` | `lib/leads/veto-activity.ts` (`vetoReason`); B10 |
| C22 | A trava comercial da saída responde só sim ou não: `contemAssuntoComercialNaSaida(texto): boolean`, sobre uma lista larga que inclui palavras soltas como "valor", "custo", "oferta", "investimento", "grátis", "pagar" e "orçamento". O veto grava só `restricted_kind: 'commercial'`, sem o trecho | `lib/escalacao/assunto-comercial.ts:15–27`, `:46–68`; `lib/agent-engine/guardrails/before-send.ts:735` |
| C17 | O texto "Resposta comercial barrada…" com o código `low_confidence` sai de 3 lugares: o veto no turno, a passagem antes do modelo (só quando o cliente perguntou) e a automação | `inbound-turn.ts:3271–3282`; `escalarComercialAntesDoModelo`, `:2455–2466`; `send-ai-message.ts:235–246` |

### PRs abertos olhados (09/11/2026)

Comando: `gh pr list -R melgarafael/DeskcommCRM --state open --search "<termo>" -L 20` para os
termos "comercial follow-up", "commercial_requires_human", "aviso passagem follow-up",
"followup_turn veto", "texto barrado", "restrição comercial", "aviso ao lead" e "low_confidence"
(e o mesmo com `gh issue list`). Nenhum PR muda o veto comercial do follow-up. O #3816 toca `inbound-turn.ts` e o aviso ao lead, mas
na passagem de "fail-safe" do #3725 (`git grep` no diff dele: nenhuma ocorrência de
`passarComercialParaEquipe`, `commercial_requires_human` ou `followup_turn`). A issue #2975 (painel
do modo assistido não diz qual veto barrou) é vizinha do item 2 abaixo, mas trata da prévia.

## O que muda

### 1. Follow-up barrado: o texto não sai, e só isso (fatia principal)

- **A régua é a conversa, não o tipo do job.** O `followup_turn` também roda quando o cliente
  acabou de responder (C13), e em 1 dos 5 casos medidos havia mensagem do cliente esperando (B9).
  Por isso a pergunta é: **neste turno, há mensagem do cliente sem resposta** (C14)?
- **Não há** (o cliente está calado, ou o que ele disse já foi respondido): o veto
  `commercial_requires_human` **não** avisa o cliente e **não** passa a conversa para a equipe. O
  texto só não sai.
- **Há**: nada muda. O cliente falou e espera resposta; avisar e passar continua certo, em qualquer
  tipo de turno.
- No caso "não há", a ferramenta devolve ao agente um erro que diz o que fazer: o texto não saiu
  porque toca em valores ou negociação; reescreva sem esse assunto, ou termine sem enviar.
- No caso "não há", o veto também **não** pode virar passagem pela mão do agente: depois dele, o
  turno não abre caso nem passa a conversa por causa do assunto barrado (C16). A regra vale pelo
  sistema, não pela obediência do modelo ao texto do erro. Decisão D3.
- **O passo do fluxo.** Hoje o aviso de passagem entra no `send_ledger` como aceito, então o passo
  conta como **enviado** e o fluxo avança como se o follow-up tivesse saído (C15, B4). Com esta
  mudança, sem nada enviado, o passo fica `skipped` ("concluiu este passo sem enviar uma
  mensagem"), que é o desfecho que já existe para o turno que não envia. Decisão D4: o fluxo
  avança.
- A ação `send_ai_message` (C6), barrada (decisão D1):
  - **não** passa a conversa para a equipe nem avisa o cliente;
  - registra o veto na Atividade da regra, com o texto barrado;
  - escreve a mensagem **uma segunda vez**, dizendo à IA o que foi barrado e por quê;
  - se a segunda também for barrada, o passo fica `skipped` com o motivo, e nada sai;
  - se a segunda passar, ela é enviada pelo caminho de hoje.
- No turno do agente, o erro devolvido já permite reescrever dentro do mesmo turno (acima). O
  limite é o mesmo: **uma** reescrita depois do veto comercial; a segunda barrada encerra o envio.

### 2. O que foi barrado fica visível para quem cuida do agente

- Hoje não há como saber o que a trava barrou (B7), e o rastro guarda só rótulos de propósito (C7).
- Todo veto já vira uma linha "Não enviei: …" (`send_vetoed`) na timeline do negócio (C18), e os 8
  vetos comerciais medidos têm a sua (B10). O texto barrado entra **nessa linha**, junto com o nome
  da trava. Não se cria tabela nem lugar novo.
- Junto com o texto, a linha diz **o motivo concreto**: qual trava barrou e **o trecho do texto que
  a acionou** (por exemplo: "barrada pela trava de valores e negociação: o texto tinha \"sem
  custo\""). Hoje a trava comercial só responde sim ou não (C22), e a cadeia grava só
  `restricted_kind: commercial`. Sem o trecho, o dono não sabe se a trava acertou ou se barrou uma
  palavra inocente, e não tem como corrigir o passo nem a régua.
- A anonimização da LGPD já limpa o conteúdo dessa linha (C19), então o texto barrado e o trecho
  saem junto.
- A linha aparece onde já aparece hoje: em Análise › Atividades, com o motivo (C20).
- Quando o contato não tem negócio aberto, a linha não é gravada (C18). Esse caso continua como
  está; ver a pergunta P1.

### 3. O cartão diz o motivo real

- Quando a passagem nasce da trava comercial (no turno de resposta, que continua passando), o
  cartão "Por que a IA passou para você" diz "A trava de valores e negociação barrou a resposta",
  e não "não teve confiança suficiente".
- Exige um código de motivo novo na lista fechada do banco (C10): migration, apêndice no
  `baseline.sql` e a frase em `FRASE_DO_MOTIVO` e nos dicionários de tradução.
- Vale para os 3 lugares que hoje gravam esse motivo como `low_confidence` (C17).
- A linha "Não enviei" também diz o motivo real (C21): "a mensagem tocava em valores ou
  negociação, que são só com a equipe" para a trava comercial, e "a conversa está com a equipe"
  para o `stop` com `atendimento_com_humano`, no lugar de "o contato pediu para parar".

### 4. O Teste simula um follow-up (fatia separada, opcional)

- A aba Teste ganha a opção "simular follow-up": o agente roda sem mensagem nova do cliente, com a
  instrução de um passo de fluxo escolhido, e mostra o texto e a trava que barraria.
- É recurso novo (C11). Fica fora das fatias 1–3, que não dependem dele.

## Fora desta spec (de propósito)

- Mudar o que a trava comercial considera "comercial". Ela barrou um texto do follow-up que não foi
  guardado (B7), então não há como medir se o veto foi certo; a fatia 2 é o que permite medir.
- Mudar o aviso de passagem nos turnos de resposta (#3816, #3725).
- Os outros vetos do turno de follow-up que abrem caso (`clinical_claim`, `case_promise`). Ver a
  pergunta P2.
- O texto da prévia "Valores e negociação: atendimento exclusivamente humano"
  (`lib/agent-engine/agent/preview.ts:444`): a prévia só simula resposta (C11), então ele continua
  certo.

## Como provar

### Fatia 1

- Teste novo, no molde de `tests/invariants/restricao-comercial-no-send-template.test.ts`, com 3
  casos de `followup_turn`, camada ligada e texto com valor:
  - (a) cliente sem mensagem nenhuma → **nenhuma** mensagem sai, **nenhum** item `handoff` na
    Central, `contacts.force_human` continua `false`, passo do fluxo `skipped`;
  - (b) mensagem do cliente já respondida → igual a (a);
  - (c) mensagem do cliente sem resposta → aviso e passagem, como hoje.
- (d) mesmo em (a), o agente chamando `open_human_case` ou a ferramenta de pedir humano depois do
  veto não produz aviso ao cliente nem passagem por esse assunto.
- O caso de `inbound_turn` que existe hoje (C12) continua verde.
- **Sabotagem:** inverter a régua (avisar sempre) → (a), (b) e (d) ficam vermelhos, (c) verde.
  Inverter para o outro lado (nunca avisar) → (c) vermelho e o de `inbound_turn` vermelho.
- `send_ai_message`, em `lib/automation/actions/send-ai-message-restricao-comercial.test.ts`:
  - 1ª barrada, 2ª limpa → sai a 2ª, sem aviso nem passagem, e o veto fica na Atividade da regra;
  - as duas barradas → nada sai, passo `skipped`, sem aviso nem passagem, sem 3ª tentativa;
  - sabotagem: devolver a passagem → vermelho; tirar a reescrita → o 1º caso fica vermelho.

### Fatia 2

- Um envio barrado grava o texto, o nome da trava e o trecho que a acionou na linha
  `send_vetoed`; Análise › Atividades mostra a linha. Casos: uma palavra de preço solta ("custo"),
  moeda com número ("R$ 99"), parcela ("em 3x"). Sabotagem: não gravar o trecho → vermelho.
- Cascata de LGPD: anonimizar o contato apaga o texto barrado, no molde de
  `tests/invariants/lgpd-cascata-alcanca-a-passagem.test.ts`. Sabotagem: tirar o texto da cascata →
  o teste fica vermelho.

### Fatia 3

- A passagem da trava comercial grava o código novo; o cartão mostra a frase nova; os dicionários
  têm a chave. `tests/invariants/vocabulario-banco-x-typescript.test.ts` (o CHECK do banco igual à
  lista do TypeScript) e `tests/unit/passagem-motivo-em-portugues.test.ts` (toda frase em
  português) cobrem o código novo.

### Na tela (todas)

- Pela tela, num banco fresco do `baseline.sql`: um fluxo de follow-up cujo passo pede um texto com
  preço, a trava ligada, contato sem resposta. Resultado esperado: nenhuma mensagem nova na
  conversa, nada na Central, automático não pausado, e (fatia 2) o texto barrado na linha "Não enviei" em Análise › Atividades.

## Destino

Núcleo. É comportamento da cadeia de envio e do turno do agente, igual para toda instalação.

## Decisões tomadas (pelo autor, depois da medição)

- **D1 (automação barrada):** não passa a conversa para a equipe nem avisa o cliente. Registra o
  veto na Atividade da regra e escreve a mensagem uma segunda vez; a segunda barrada encerra (seção
  1). Com isso, muda a frase da Atividade que hoje diz que "a conversa passou para o atendimento
  humano" (`app/app/webhooks/_components/ActivityTab.tsx:203`), o sentido de
  `commercial_requires_human_sem_passagem` (hoje é a recusa do orquestrador) e a descrição em
  `docs/specs/atendimento-comercial.md:15`.
- **D2 (onde guardar o texto barrado):** na linha `send_vetoed` que já existe (seção 2).
- **D3 (o agente passar por conta própria depois do veto):** o sistema impede, no turno sem
  mensagem do cliente pendente, que o assunto barrado vire caso ou passagem (C16). A regra não
  depende da obediência do modelo.
- **D4 (o fluxo depois do follow-up barrado):** avança para o próximo passo, como já acontece com o
  turno que não envia (C15). A linha da seção 2 dá ao dono do fluxo o que ele precisa para corrigir
  o passo.

## Perguntas ao mantenedor

- **P1. Contato sem negócio aberto.** A linha "Não enviei" só é gravada quando o contato tem negócio
  aberto (C18), então nesse caso o texto barrado continua sem lugar. (A) Fica assim nesta spec. (B)
  O veto passa a ser gravado também no contato. Proposta: (A), porque os 8 vetos medidos tinham
  linha (B10), e (B) muda a timeline para todos os vetos, não só o comercial.
- **P2. Os vetos `clinical_claim` e `case_promise`** (`inbound-turn.ts:5001`, `:5049`) abrem caso
  num follow-up sem aviso automático ao cliente. Eles entram na régua de D3 ou ficam como estão?
