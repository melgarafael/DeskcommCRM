# Voz no CRM — ElevenLabs para ouvir e falar

**Data:** 2026-10-29
**Estado:** em execução — ver "Progresso" abaixo
**Escopo aprovado:** o agente RESPONDE em áudio (TTS) e OUVE o áudio do cliente (STT/Scribe).
**Fora de escopo:** ligação telefônica em tempo real (Conversational AI) — exige telefonia
(SIP/Twilio) e um caminho de áudio ao vivo que não existe no produto. Projeto separado.

---

## 0. O que já existe (e não deve ser reconstruído)

A integração é menor do que parece, porque três encaixes já estão prontos:

| Encaixe | Onde | O que dá de graça |
|---|---|---|
| Interface de transcrição plugável | `lib/messaging/media/transcription.ts:7` | `TranscriptionProvider` tem um método só. Um provedor novo é um arquivo, não uma refatoração. |
| Caminho de saída de áudio | `app/api/v1/messages/_handler.ts:750` → `lib/channels/adapters/waha.ts:220` → `lib/waha/media-send.ts:31` | Mensagem com `type='audio'` + `media_storage_path` já vira signed URL de 600s e sai como `sendVoice` com `convert: true`. **O MP3 do ElevenLabs serve** — a exigência de OGG/OPUS do WhatsApp é resolvida pelo WAHA, não por nós. |
| Provedor como vocabulário aberto no banco | migration `0127` + apêndice do baseline (`supabase/baseline.sql:11106`) | `ai_provider_credentials.provider = 'elevenlabs'` entra **sem migration nova**. O CHECK que travava em `anthropic\|openai\|google` já foi derrubado nos dois caminhos (banco novo e clone atualizado). |

E um quarto, que decide o desenho da Frente A: `ai_purpose_bindings`
(`supabase/baseline.sql:11025`) já guarda `purpose + provider + credential_id + model_id + base_url`
por organização, e `workers/media-derive-worker.ts` já sabe lê-la (`lerBindingDoPonto`). A escolha
"quem ouve o áudio" não precisa de tabela nem de mecanismo novo — precisa de uma linha ali.

---

## 1. Decisão 1 — onde a chave do ElevenLabs é cadastrada

**O problema.** `app/api/v1/ai/credentials/route.ts:36` valida com `z.enum(IDS_DE_PROVEDOR)`,
derivado de `lib/ai/pontos/provedores.ts`. Aquela lista é casada com o registry de execução por
`tests/unit/provedores-x-registry.test.ts`, que reprova nos dois sentidos — e o sentido que nos
pega é o primeiro: *"a tela ofereceria um provedor que toda chamada recusaria com
`llm_provider_unknown`"*. ElevenLabs não executa turno de conversa. Ele **não pode** entrar
naquela lista.

**Opções consideradas:**

- **(a) Pôr `elevenlabs` em `PROVEDORES` + uma entrada no registry de chat.** Rejeitada: seria
  uma entrada que mente. O segundo assert daquele teste existe exatamente para impedir "provedor
  que o sistema sabe usar e ninguém consegue escolher"; o primeiro, para impedir o inverso.
  Satisfazer os dois com um ElevenLabs falso de chat é desativar a garantia, não cumpri-la.
- **(b) Vocabulário de SERVIÇO, irmão do de chat.** → **escolhida.**
- **(c) Tabela `voice_provider_credentials` própria.** Rejeitada por DIRC (`CLAUDE.md:133`):
  duplicaria AES-256-GCM (`lib/crypto/aes_gcm`), RLS, o trigger de auditoria
  (`trg_ai_provider_credentials_audit`) e a view `ai_provider_credentials_safe`. Quatro cópias de
  coisa sensível para evitar uma lista nova.

**O desenho de (b):**

1. Novo `lib/ai/pontos/provedores-de-servico.ts` — mesma forma de `ProvedorSuportado`, mesmo
   `as const satisfies` (o comentário em `provedores.ts:107` explica por que a anotação de tipo
   apagaria a garantia). Primeira entrada: `elevenlabs`, com `ondePegarAChave`,
   `prefixoDaChave: "sk_…"` e `quandoUsar` escrito para quem não acompanha o mercado.
2. Novo `tests/unit/provedores-de-servico-x-registry.test.ts` — espelho do teste de chat, casando
   a lista com o registry de serviços de voz. Sem ele a garantia só muda de lugar; o cabeçalho do
   teste existente já diz que *"garantia transferida sem guarda é garantia perdida"*.
3. `app/api/v1/ai/credentials/route.ts:36` — `z.enum([...IDS_DE_PROVEDOR, ...IDS_DE_SERVICO])`.
   Mesma mudança em `app/actions/onboarding/chaveDaIa.ts:44` **se** a voz entrar no onboarding
   (recomendo que não entre — ver §5).
4. `app/app/ai/credentials/_components/AddCredentialDialog.tsx` — segundo grupo no select
   ("Serviços de voz"), não um item solto no meio dos modelos de conversa.
5. `lib/ai/provider-validators.ts` — `validateElevenLabsKey`: `GET https://api.elevenlabs.io/v1/voices`
   com header `xi-api-key`, timeout 5s, sem retry, 401/403 → `auth_failed_401`. Devolve as **vozes**
   no campo `models` — reusa `models_available` sem coluna nova, e é o que a tela precisa listar
   para o operador escolher a voz.

**Dois lugares que NÃO mudam, e é decisão, não esquecimento:**

- `lib/ai/agents/validation.ts:21` (`PROVIDERS = IDS_DE_PROVEDOR`) — o provider da versão
  publicada do agente é o de **conversa**. ElevenLabs ali seria um agente que não responde.
- `lib/instalacao/ambiente.ts:70` e `lib/instalacao/prova-de-credito.test.ts` — iteram
  `IDS_DE_PROVEDOR` para exigir prova de crédito no instalador. Voz é opt-in pós-instalação; exigir
  chave de voz para instalar o CRM seria cobrar por algo que a maioria não vai ligar.

---

## 2. Decisão 2 — "ponto fixo" precisa virar "ponto com opções"

`lib/ai/pontos/registro.ts:400` declara `transcricao_de_audio` como `fixo`, com
`usa: { provider: "openai", modelId: "whisper-1" }`. O comentário logo acima conta por que o `usa`
existe: sem ele a tela anunciava `claude-sonnet-5` naquele ponto, contradizendo o próprio texto ao
lado. `fixo` hoje significa duas coisas ao mesmo tempo: *"não é um modelo de conversa"* e
*"não há o que escolher"*.

Com ElevenLabs, a segunda deixa de ser verdade: passam a existir **dois serviços de transcrição**,
e o operador precisa poder escolher — sem que a tela volte a oferecer modelo de chat ali.

**Mudança:** `fixo` ganha `opcoes?: readonly { provider: string; modelId: string; rotulo: string }[]`.
Ausente = travado como hoje. Presente = a tela mostra um select curto entre serviços, e a escolha
grava em `ai_purpose_bindings` (`purpose='transcricao_de_audio'`). Nenhum mecanismo novo: o
`lerBindingDoPonto` do worker já lê aquela tabela, e o `base_url` da linha cobre quem aponta para
um serviço compatível próprio.

Isso vale para os dois pontos da frente — transcrição e síntese.

---

## 3. Frente A — Ouvir (ElevenLabs Scribe)

A menor das duas. Nenhuma migration.

1. **`lib/messaging/media/transcription-elevenlabs.ts` (novo).** Implementa
   `TranscriptionProvider`. **Não é OpenAI-compatível** — por isso arquivo novo e não `baseUrl`
   diferente no `apiTranscriptionProvider`: `POST https://api.elevenlabs.io/v1/speech-to-text`,
   header `xi-api-key` (não `Authorization: Bearer`), multipart com `file` + `model_id=scribe_v1`,
   resposta `{ text }`. O `extFor(mime)` de `transcription.ts:22` é reusável e deve ser exportado em
   vez de copiado.
2. **`workers/media-derive-worker.ts`** — o bloco `let openaiKey` (a resolução que hoje é
   hardcoded em OpenAI, com o comentário sobre o 401 medido nesta VPS) passa a consultar o binding
   de `transcricao_de_audio` antes de cair no padrão OpenAI. Uma branch, no padrão que o binding da
   visão já usa logo acima — inclusive o `catch` que avisa e cai no padrão em vez de derrubar a
   derivação inteira.
3. **O aviso da Central precisa virar provider-aware.** Hoje
   `avisarMidiaNaoLida(orgId, "áudio", "falta uma chave da OpenAI para transcrever")` é texto fixo.
   Numa org que escolheu ElevenLabs, esse aviso manda o operador buscar a chave errada — que é a
   mesma classe de defeito que o comentário do próprio arquivo descreve ("mandá-lo caçar um
   problema que não existe").
4. **Vídeo vem de graça.** `lib/messaging/media/video-derive.ts:60` usa o mesmo `transcriber`.

**Ganho esperado:** precisão melhor em português e diarização (quem falou o quê) em áudio de mais
de uma pessoa. A diarização é informação nova no derivado — vale decidir se entra no texto ou é
descartada; sugiro descartar no MVP, porque o derivado alimenta prompt e falante rotulado infla
token sem o agente ter o que fazer com ele.

---

## 4. Frente B — Falar (TTS)

Aqui estão as decisões que separam a feature boa da embaraçosa.

### 4.1 O ponto e o módulo

- Novo ponto em `lib/ai/pontos/registro.ts`: `id: "sintese_de_voz"`, `rotulo: "Falar com o
  cliente em áudio"`, `papel: "atender"`, `fixo` com `opcoes`,
  `emissor: "lib/ai/voz/sintetizar.ts"`, `sintomaDeFalha` escrito em consequência de negócio.
  **Guardado por `tests/unit/pontos-de-ia-completude.test.ts`**, que varre o AST procurando
  propriedades `purpose:` literais — então o emissor precisa passar `purpose: "sintese_de_voz"`
  de verdade, e o ponto entra **no mesmo commit** da chamada.
- Novo `lib/ai/voz/sintetizar.ts`: `POST /v1/text-to-speech/{voice_id}` → Buffer MP3.
- Config por org em `organizations.settings->'voz'` (`voice_id`, `model_id`, `stability`,
  `similarity_boost`), lida a cada chamada — mesmo padrão de `settings->'llm'` descrito em
  `lib/agent-engine/edge/llm/credentials.ts:17`: trocar voz é UPDATE, sem restart nem deploy.
  Sem migration: é jsonb que já existe.

### 4.2 Decisão 3 — quando o agente fala em vez de escrever

- (a) **Sempre áudio.** Rejeitada: mata a busca no histórico, obriga o vendedor a ouvir a conversa
  inteira para assumir o atendimento, e irrita o cliente que está em reunião.
- (b) **Espelhar o cliente** — fala se a última mensagem recebida foi áudio. O dado já existe
  (`messages.type='audio'`). Zero config.
- (c) **O modelo decide por tool.** Rejeitada no MVP: dá ao modelo uma decisão que gasta dinheiro.
- (d) **Regra do operador, por versão publicada do agente.** → **escolhida**, com (b) como default.

Colunas em `ai_agent_versions`: `voz_enabled boolean not null default false` e
`voz_quando text` (`'nunca' | 'espelhar' | 'sempre'`, default `'espelhar'`). O precedente é
`video_frames_enabled` (migration 0058), já usado em `workers/media-derive-worker.ts` para
exatamente isto: feature que custa dinheiro nasce desligada e por versão publicada.

CHECK nessa coluna **é seguro aqui** e vai entrar, contra a regra geral de vocabulário aberto
(`CLAUDE.md:139`): a coluna é nova, então nenhum clone pode ter linha que a viole, e o `update.sh`
sem `ON_ERROR_STOP` não tem como quebrar nela. A razão fica escrita no cabeçalho da migration,
como a doutrina exige.

### 4.3 O texto falado não é o texto enviado

A resposta do agente tem emoji, markdown, link e preço. Lido em voz alta, isso é lixo:
"asterisco asterisco promoção", "agá tê tê pê dois pontos barra barra".

Novo `lib/ai/voz/texto-falavel.ts`, puro e testável: remove emoji e marcação, troca
`R$ 1.234,56` por "mil duzentos e trinta e quatro reais e cinquenta e seis centavos", tira URL
(áudio não tem link clicável — o link fica na mensagem de texto), e aplica um **teto de
caracteres** (custo é por caractere, e nota de voz de três minutos ninguém ouve).

### 4.4 A conversa não pode ficar sem texto

Se o agente manda só áudio, a thread perde o `body` — e com ele a busca, o export LGPD, o
classificador de follow-up e todo ponto downstream que lê texto. Ficam cegos sem erro nenhum.

**Desenho:** a linha outbound é `type='audio'` com `media_storage_path`, **e** carrega o texto
falado em `media_derived_text`, preenchido no insert. A thread continua legível, a busca continua
achando, e nada downstream precisa saber que aquilo nasceu como voz. *A conferir na
implementação:* hoje `media_derived_text` só é escrito pelo worker de inbound; preencher no
outbound é uso novo da mesma coluna, não coluna nova.

### 4.5 Idempotência — o crash não pode pagar duas vezes

`send_ledger` dá intenção exactly-once e entrega at-least-once
(`lib/agent-engine/edge/crm/send-message.ts:19`). Se a síntese rodar **antes** do ledger, um crash
entre síntese e envio re-sintetiza no retry e paga de novo.

**Regra:** sintetizar e subir para o Storage **dentro** do estado `requested`, gravando o
`media_storage_path` no ledger; o retry que encontra o path **reusa o arquivo** e nunca rechama o
ElevenLabs. Teste dedicado — é o tipo de furo que só aparece na fatura.

### 4.6 O teto de gastos não vê voz hoje — e isso é o defeito de origem do repo

`ai_budgets` é em centavos e o gate soma `llm_calls.cost_cents`.
`lib/agent-engine/edge/llm/pricing.ts:15` só conhece prefixos `claude-*` e devolve `null` para
desconhecido — e `null` **não consome teto** (está escrito no cabeçalho do arquivo). Ou seja: se a
voz entrar sem preço, ela gasta **fora do teto**, e a tela de orçamento segue dizendo que a
organização está protegida.

Isso é textualmente o defeito que o cabeçalho de `credentials.ts:11` chama de *"defeito de
origem"* — a tela editando um lugar e o enforcement lendo outro. Repeti-lo numa feature nova, com
o diagnóstico já escrito no repo, não é opção.

**Então:** `pricing.ts` ganha um caminho de preço **por caractere** (USD por 1k chars) e a chamada
de voz é registrada em `llm_calls` com `cost_cents` preenchido. Mais um teste:
`tests/unit/voz-nao-gasta-fora-do-teto.test.ts`.

### 4.7 Chave de plataforma: declarar nos DOIS envs

`ELEVENLABS_API_KEY` entra em `.env.example` como fallback de plataforma (espelho de
`openaiApiKey` em `LlmEdgeConfig`). **E precisa ser declarada em `lib/env.ts` e em
`lib/agent-engine/env.ts`** — `loadEnv` do worker *remove* o que o schema dele não declara, e o
cabeçalho de `credentials.ts:60` registra que esse exato esquecimento fez a chave "funcionar no app
e sumir no worker", que é onde a IA gasta. `lib/agent-engine/env.ts:26-42` tem os três precedentes,
cada um com o comentário do bug que o originou.

### 4.8 Clonagem de voz: fora do MVP

Só vozes de catálogo do ElevenLabs. Clonar a voz de um vendedor exige consentimento escrito dele e
cria um ativo biométrico dentro do CRM — decisão de produto e de LGPD, não de implementação, e não
vai de carona nesta frente.

---

## Progresso (atualizado 2026-10-29)

| Fase | Status | Onde |
|---|---|---|
| 1 — vocabulário de serviço + credencial + validador | ✅ feito | commit `396778807`→`31d1a5f28`, branch `feature/voz-elevenlabs-fase1` |
| 2 — `fixo.opcoes` (mecanismo de menu) | ✅ feito | commit `d684a1f9f`, junto com a 3 |
| 3 — Scribe plugado no worker | ✅ feito | commit `d684a1f9f` |
| 4 — preço por caractere (`custoDeVozCents`) | ✅ feito (sem migration) | commit `d58e399d0` |
| 5 — `texto-falavel.ts` + `sintetizar.ts` | ✅ feito, **deliberadamente ÓRFÃOS** | commit `d58e399d0` |
| 6a — `sendTurnMessage` aprende a mandar voz (idempotente, com custo) | ✅ feito | commit `ccf267718`, migration 9051 (nasceu 0252; renumerada no merge da main de 2026-10-30) |
| 6b — o AGENTE decide falar (`inbound-turn.ts` + `ai_agent_versions`) | ✅ feito | migration 9052 (nasceu 0253), ver "o que foi construído" abaixo |
| 7 — tela de configuração (ligar voz, escolher voice_id, ouvir prévia) | ✅ feito | ver "Fase 7" abaixo |

**Por que a Fase 5 está "órfã" de propósito.** `sintetizarVoz()` e `custoDeVozCents()` são reais,
testados e chamáveis — mas **nada no runtime do agente os chama ainda**, e o ponto `sintese_de_voz`
**não foi registrado** em `lib/ai/pontos/registro.ts`. Registrar o ponto ou gravar custo em
`llm_calls` sem um chamador de produção seria o defeito que
`tests/unit/pontos-de-ia-completude.test.ts` existe para pegar (ponto/gasto que nenhuma rota, cron
ou tool aciona). A Fase 6 é quem dá o chamador real — e é também a fase mais arriscada que falta:
migration nova, e a mudança entra bem no meio do caminho de ENVIO (`sendTurnMessage` →
`sendMessageHandler` → WAHA), que hoje só sabe mandar `type: 'text'`/`'template'` no turno do
agente — nunca mídia. Avaliado nesta sessão e **deliberadamente deixado para uma rodada própria**,
em vez de emendado às pressas no mesmo commit das Fases 4/5.

**Achado desta sessão — por que a Fase 6 virou DUAS fases, e a segunda é bem maior do que parecia.**

Investigado: `app/api/v1/messages/_handler.ts` **já aceita** `type: 'audio'` + `media_storage_path`
sem gate de ator nenhum (`sendMessageHandler` usa `input: SendMessageInput`, o MESMO tipo da rota
REST; o branch de mídia só olha `input.media_storage_path`, nunca `ctx.actor.type`) — então o item
2 da lista antiga ("o handler precisa aceitar áudio do agente") estava **errado por excesso de
pessimismo**: não precisa de mudança nenhuma ali. O que de fato falta se divide em dois mundos bem
separados, com riscos MUITO diferentes:

**6a — "`sendTurnMessage` sabe mandar voz" (plumbing isolável, mesmo risco das Fases 4/5):**
1. Migration: `send_ledger` ganha `media_storage_path text` — é ONDE a idempotência mora (item 3
   abaixo), e é a única peça de schema que esta sub-fase precisa.
2. `SendMessageInput` (a interface de `lib/agent-engine/edge/crm/send-message.ts`, não o Zod da
   rota) ganha um campo opcional `voz` (texto falado + voiceId + credencial já resolvida). Ausente
   = comportamento atual, byte a byte.
3. Idempotência (plano §4.5): resolvida por um `INSERT ... ON CONFLICT (job_id, seq) DO UPDATE SET
   media_storage_path = coalesce(...)` ANTES de chamar `sendWithLedger` — a mesma identidade
   `(job_id,seq)` que o ledger já usa, sem precisar alterar `sendWithLedger` (função provada,
   usada por TODO envio de texto hoje; o plano é não tocá-la, só chamá-la depois). Precisa expor
   `bodyHash()` de `send-ledger.ts` (hoje um one-liner interno) para o pré-passo calcular o MESMO
   hash e não colidir com o `create()` que `sendWithLedger` ainda vai chamar depois.
4. `ctx: HandlerCtx` ganha `aiVoiceDerivedText?: string | null` (mesmo padrão de
   `serviceBoundary`/`serviceOrigin`: interno, nunca vindo do corpo da requisição) — é o que
   preenche `media_derived_text` no insert da linha (plano §4.4), sem abrir um campo público que
   qualquer chamador da API pudesse usar para inventar texto que não bate com o áudio.
5. O Storage path segue `isMediaPathOwnedBy` (`lib/messaging/media/upload-validation.ts`):
   `${organizationId}/${conversationId}/...` — upload fora desse prefixo é recusado com
   `invalid_media_path`, então o uploader precisa montar o path assim de propósito.
6. **SÓ aqui** o ponto `sintese_de_voz` entra em `registro.ts` — porque só aqui existe um `emissor`
   de verdade (o próprio `sendTurnMessage`, chamado o tempo todo em produção).

**6b — "o agente DECIDE falar" — maior do que o plano original estimava:**

A cadeia real, medida nesta sessão lendo `lib/agent-engine/agent/inbound-turn.ts` (4175 linhas, o
maior e mais denso arquivo do motor): a tool `send_message.execute` tem o `body` do modelo e
`agentConfig` (onde `voz_enabled`/`voz_quando` morariam) em escopo — mas o envio não vai direto a
`sendTurnMessage`. Ele passa por `sendInBubbles` (`lib/agent-engine/agent/split-message.ts`), que
QUEBRA o texto em bolhas e chama `liveChannel().send(...)` **uma vez por bolha**. Voz não bolha —
uma nota de voz é UMA mensagem, não três. Então a decisão "falar" precisa DESVIAR de
`sendInBubbles` inteiro quando ativa, não só acrescentar um campo a ela. Resumo do que falta:

1. Migration: `ai_agent_versions.voz_enabled boolean not null default false` +
   `voz_quando text not null default 'espelhar' check (...)` — precedente: `video_frames_enabled`
   (migration 0058). Mais a config da voz em si (`voice_id`, etc.) — provavelmente
   `organizations.settings->'voz'`, mesmo padrão de `settings->'llm'`.
2. Dentro de `send_message.execute` (inbound-turn.ts): ler `agentConfig.vozEnabled` +
   `agentConfig.vozQuando`, decidir "espelhar" checando se a ÚLTIMA mensagem INBOUND do turno é
   `type:'audio'` (o dado já existe, só falta a leitura), e resolver a credencial ElevenLabs da org
   (mesma função `resolveOrgLlmConfig(..., {provider:'elevenlabs'})` que o worker de transcrição já
   usa) — SEM credencial, cair em texto normal com aviso, nunca travar o turno.
3. Quando a decisão é "falar": pular `sendInBubbles`, chamar `textoFalavel(finalBody)` e invocar
   `liveChannel().send({ ..., voz: {...} })` (o campo novo da 6a) UMA vez com o texto inteiro.
4. `liveChannel()` é uma interface/abstração (closures injetadas via `deps`), não uma chamada direta
   — então o tipo do parâmetro de `.send()` precisa aceitar `voz` em TODOS os pontos que a
   implementam (produção e os dublês de teste), não só no de produção.
5. O MODO PRÉVIA (`agent_preview`) e o `send_template` ficam de fora — voz é resposta real ao
   cliente, não teste nem template aprovado pela Meta.

**O que foi de fato construído na 6b** (depois do mapeamento acima ser confirmado por leitura
direta do código, e com confirmação explícita do usuário antes de editar o motor de turnos):

- Migration 9052 (nasceu 0253): `ai_agent_versions.voz_enabled`/`voz_quando`, com o trigger de imutabilidade de
  versão publicada (`fn_ai_agent_version_content_immutable`, estendido pelas migrations 0125/0181)
  ensinado a conhecer as duas colunas — senão ficariam editáveis numa versão já publicada sem
  virar draft nova, reabrindo o buraco que 0125/0181 fecharam para as colunas delas.
- `lib/agent-engine/agent/voz-do-turno.ts` (`resolverVozDoTurno`): a decisão "falar", resolvida
  UMA vez por turno — nunca-fala/fala-se-cliente-mandou-áudio/sempre-fala, lendo
  `organizations.settings.voz.voice_id` e resolvendo a credencial ElevenLabs via
  `resolveOrgLlmConfig`. Falha SEMPRE para texto (credencial ausente, `voice_id` não configurado,
  erro de rede) — nunca trava o turno.
- `inbound-turn.ts`: `send_message.execute` desvia de `sendInBubbles` inteiro quando
  `vozParaEsteTurno` está presente — uma nota de voz é UMA mensagem física, nunca bolhas. Modo
  prévia (`!preview`) fica de fora.
- `sintese_de_voz` **entrou em `registro.ts`** — só agora, porque só agora existe um `emissor` de
  produção de verdade. Custo registrado em `llm_calls` (`registrarCustoDeVoz`), só quando a
  síntese de fato aconteceu agora (não num retry que reusou o path).
- **Achado tardio, consertado antes do commit:** o apêndice de `baseline.sql` cresce por
  acréscimo, e colar a migration 0253 (que recria uma função) no FIM do arquivo a colocaria DEPOIS
  do bloco "VARREDURA anon" (migration 0116) — que só cura `anon` em EXECUTE para funções que já
  existem no momento em que ela corre. `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` pegou
  isso antes de qualquer commit; o apêndice de 0252/0253 foi movido para ANTES da varredura.

**Achados da revisão de código, corrigidos antes da Fase 7** (ver `.changes/` — pendente — e o
commit `fix(ai-voz)`): `uploadDeVoz` usava `upsert:false`, travando para sempre o retry de um envio
que sintetizou mas falhou no transporte (path determinístico colidia com o antigo). Erro de
síntese que não é um desfecho terminal do ledger derrubava o TURNO INTEIRO em vez de cair para
texto. `registrarCustoDeVoz` não gravava `job_id`, cegando o rollup de custo por execução.

**Fase 7 — a tela, feita:**

1. Editor do agente (`AgentForm.tsx`): `voz_enabled` + `voz_quando` ao lado de "Estilo de
   resposta" (mesmo padrão de `split_messages`) — é POR VERSÃO, porque é aí que `video_frames_
   enabled` também mora. A lista de colunas de `ai_agent_versions` está copiada em SEIS arquivos
   (`tests/unit/agent-version-columns-drift.test.ts` existe por causa disso — achado por esse
   teste: faltavam duas cópias, `app/app/ai/agents/[id]/page.tsx` e `lib/ai/agents/duplicate.ts`,
   que meu primeiro grep não alcançou por procurar só em `app/` com `--include=*.ts`, perdendo
   `.tsx` e `lib/`).
2. `app/api/v1/ai/voz/route.ts` (novo) — GET devolve a voz atual da organização +
   `vozesDisponiveis` (lidas de `models_available` da credencial ElevenLabs — são `voice_id`, não
   nomes; é o botão de prévia que diz qual voz é cada um) + se há credencial validada. PATCH
   grava em `organizations.settings.voz` com o MESMO merge-nunca-sobrescrita do PATCH irmão
   (`settings.llm`). `voice_id`/`model_id` são da ORGANIZAÇÃO (recurso contratado uma vez), não da
   versão — por isso rota própria, fora do editor de agente.
3. `app/api/v1/ai/voz/preview/route.ts` (novo) — sintetiza uma frase curta com a voz escolhida e
   devolve o áudio inline em base64 (nunca Storage, nunca `llm_calls` — prévia é descartável, não
   é mensagem real). A tela toca num `<audio>` oculto.
4. `CartaoDeVoz` no painel de Provedores — sibling de `CartaoDoPadrao`, com o seletor de voz,
   "Ouvir prévia" e "Salvar voz".

**O que ficou de fora, de propósito:** escolher `model_id` (Turbo/Flash) na UI — `custoDeVozCents`
ainda cobra uma taxa fixa, então expor a escolha sem ajustar o preço repetiria o achado #4 da
revisão (cobrança ~2x errada). Fragmento em `.changes/` para o release — achado #8 da revisão,
ainda não escrito. Os outros 4 achados (pacing/digitando ausente na voz, exceção para estado
rotineiro do ledger, duplicação no worker de transcrição e no painel, ida dupla ao ledger por
envio) também continuam em aberto.

**Merge da `main` (2026-10-30), antes do PR.** A branch estava a mais de mil commits da `main`;
30 arquivos em conflito. O que mudou de desenho, e por quê:

1. **Transcrição: o menu Whisper/Scribe virou o degrau 0 da escada.** A `main` trocou o ponto
   fixo `transcricao_de_audio` por uma ESCADA (`lib/messaging/media/escada-de-transcricao.ts`,
   #2171/#2190) que decide quem ouve cada áudio — serviço da instalação → chave OpenAI →
   OpenRouter → modelo de conversa com `audio` → nada com motivo. Fixar "Whisper" como padrão
   apagaria esses degraus. O menu (`fixo.opcoes`) ficou com "Automático" (a escada inteira; o par
   `openai/whisper-1` é só a etiqueta gravada, porque não há como apagar um binding pela tela) e
   "ElevenLabs (Scribe)", que vira o degrau 0 (`elevenlabsEscolhido`, origem
   `elevenlabs_escolhido`). Sem chave do ElevenLabs utilizável, o degrau 0 some e a escada segue —
   nunca um áudio mudo por uma escolha impossível. Painel e worker passam o MESMO degrau.
2. **Envio da voz: dentro de `enviarComFotos`, no lugar de `sendInBubbles`.** A `main` passou o
   envio do turno por saída configurável da prospecção → fotos do produto → bolhas, e moveu o
   "digitando…" e a pausa humana para `esperaForaDoLock` (#654), que roda antes de QUALQUER envio.
   A voz entra no `enviarTexto`: herda rodapé de saída, teto do turno e o "digitando…" — isto
   fecha o achado de revisão "pacing/digitando ausente na voz". Foto com legenda segue foto.
3. **`corpoDoEnvio`** (extraído na `main`) ganhou o parâmetro da voz resolvida; e o texto derivado
   (`aiVoiceDerivedText`) só vai quando a voz de fato saiu — falha de síntese que cai para texto
   não grava mais `media_derived_text` numa mensagem de texto.
4. **`send-ledger`:** a extração `resolverChaveDoLedger` (branch) + a regra da `main` de só procurar
   a mensagem existente em retentativa (`replay`) — `row` não nulo é exatamente esse caso.
5. **Migrations renumeradas: 0252→9051, 0253→9052.** A `main` já tinha 0252/0253 com outro
   conteúdo. Descrição agora no `-- manifest:` do próprio `.sql` (o MANIFEST.md virou histórico).
   A 9052 recria `fn_ai_agent_version_content_immutable` a partir da última definição em vigor
   (0616: `handoff_legal_enabled`, `proposal_ai_draft_enabled`, `inbound_debounce_ms`,
   `search_path = ''`) mais as duas colunas de voz; o apêndice do baseline fica antes da VARREDURA.
6. **Credenciais:** a `main` criou `PROVEDORES_COM_CHAVE` (chat + Jev). A lista de serviço
   (ElevenLabs) continua separada — `provedores-de-decisao-catraca` exige que aquela seja só as
   duas — e as telas usam a união.

---

## 5. Ordem de execução

| Fase | Entrega | Migration? |
|---|---|---|
| **1** | Vocabulário de serviço + validador + tela de credenciais + teste de pareamento (§1) | não |
| **2** | `fixo.opcoes` + a tela do ponto escolher serviço (§2) | não |
| **3** | **Frente A completa** — Scribe plugado, aviso provider-aware (§3) | não |
| **4** | Preço por caractere em `pricing.ts` + log em `llm_calls` (§4.6) | não |
| **5** | `texto-falavel.ts` + `sintetizar.ts` + ponto `sintese_de_voz` (§4.1, §4.3) | não |
| **6** | Colunas `voz_enabled`/`voz_quando` + regra de quando falar + envio idempotente (§4.2, §4.5) — **feita**, ver "Progresso" | **sim** |
| **7** | Tela: ligar a voz na versão do agente, escolher voz, ouvir prévia — **falta só isto** | não |

Fase 1→3 entrega valor sozinha (ouvir melhor) e pode ir para produção antes de qualquer linha de
TTS. **Fase 4 vem antes da 5 de propósito:** medir o gasto antes de habilitar o gasto.

Onboarding (`app/onboarding/setup-ai/_form.tsx`) **não** muda: voz é configuração pós-instalação.

---

## 6. Gates (Definition of Done — `CLAUDE.md:481`)

- `pnpm gov:verify` verde (typecheck, lint, `lint:channels`, `lint:role-rank`, `test:unit`).
  `lint:channels` **não** reclama de "elevenlabs": o padrão proibido
  (`scripts/lint-channels.pattern.ts`) cobre provedor de **canal** (`waha`, `meta_cloud`,
  `zernio`), e serviço de IA é nomeado livremente em `lib/ai/` — como `openai` e `anthropic` já
  são. **Mas** citar o provider de canal em comentário dentro de `lib/ai/` reprova (a catraca lê
  o arquivo inteiro): `sintetizar.ts` citava o `sendVoice` do provider e caiu no gate em 2026-10-30.
- Migration da Fase 6 versionada **+ linha no `supabase/migrations/MANIFEST.md` + apêndice
  idempotente no `supabase/baseline.sql`**. Sem o apêndice a mudança **não chega aos
  self-hosters** (`CLAUDE.md:440`).
- Testes novos: pareamento de serviços, `texto-falavel`, voz-dentro-do-teto, voz-idempotente.
- Spec e2e registrada em `SPECS_PARTE_*` ou em `FORA_DO_CI` **com motivo escrito** —
  `tests/unit/e2e-cobertura-completa.test.ts` reprova spec órfã.
- Evidência visual em `evidence/voz-elevenlabs/` (versionado — doutrina de QA visual em `CLAUDE.md`): áudio
  recebido virando texto, e nota de voz saindo no WhatsApp real.

---

## 7. Riscos

1. **Custo por caractere surpreende.** Mitigado pela Fase 4 vir antes da 5, e pelo default
   `voz_enabled=false`.
2. **`convert: true` do WAHA faz ffmpeg no contêiner do WAHA.** Volume alto de voz mexe na carga
   de lá, não na nossa — medir antes de prometer campanha em áudio.
3. **Latência.** TTS soma ~1-3s ao turno. Com `voz_quando='espelhar'` só paga quem já mandou
   áudio, e esse cliente tolera mais.
4. **Diarização do Scribe inflando o derivado** (§3) — descartar no MVP.
