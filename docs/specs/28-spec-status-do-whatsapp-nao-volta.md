# Spec 28 — O status da mensagem não volta para trás, e bolha invisível não sai

Status: **PROPOSTA**. Dois defeitos medidos numa instalação 1.89.0 em produção,
em 26/10/2026 entre 10h30 e 11h05 (Brasília), com consulta só de leitura e
sempre filtrada por `organization_id`. As referências ao código citam o símbolo;
as linhas foram conferidas na main `40db34708` (24/10/2026).

## O problema, em duas frases

1. O aviso de entrega do WhatsApp não oficial chega **fora de ordem ou repetido**
   (rajadas de avisos antigos) e o sistema **grava o último que chegou**, não o
   mais avançado: mensagem lida volta a "entregue", entregue volta a "enviada",
   e o aviso de **erro** (`ack = -1`) devolve uma mensagem já enviada para
   "enviando" — que 5 minutos depois vira o alerta crítico "uma resposta não
   chegou ao cliente", com a orientação errada ("verifique a conexão").
2. A trava contra bolha vazia usa `trim()`, que não remove caracteres de
   formatação invisíveis (`U+200E` e afins): uma resposta da IA feita só de um
   caractere invisível passa e chega ao cliente como bolha em branco.

## O que foi medido

| # | Medição (últimos 30 dias, mensagens de saída) | Organização A (1.ª) | Organização B (2.ª) |
|---|---|---|---|
| M1 | Lidas (`read_at` preenchido) com `status` abaixo de `read` | **118** de 694 | **112** de 1.907 |
| M2 | Entregues (`delivered_at` preenchido) com `status` `sent`/`sending` | **141** | **69** |
| M3 | Com `ack = -1` | 4, todas `failed / send_timeout` | 18, todas `failed / send_timeout` |
| M4 | Da IA com corpo sem nenhum caractere visível | 2 | 1 |

Detalhes que mostram a causa:

- **M1 em rajada:** das 95 mensagens "lidas mas com status entregue" da
  organização A, 51 tiveram o `delivered_at` reescrito em 14/10 entre 11h15 e
  11h17; o `delivered_at` delas ficou, em média, **4 dias depois** do `read_at`.
  É o padrão de avisos antigos reenviados de uma vez (reconexão do número), cada
  um sobrescrevendo o estado e a hora.
- **M3, caso de 26/10:** três lembretes saíram às 08h00 com `status = sent` (há
  `message.sent` no `event_log` às 08:00:42, 08:01:00 e 08:01:43, e
  `external_id` preenchido). Numa das conversas o robô da empresa respondeu
  **3 segundos depois** — a mensagem chegou. Depois chegou `ack = -1`;
  `ackToStatus(-1)` devolve `"sending"`; o `recover-stuck-messages` (roda a cada
  5 min, `docker/scheduler/entrypoint.sh`, e corta por `created_at`, que já
  tinha mais de 2 h) marcou `failed / send_timeout` às 10:30 e 10:40 e abriu dois
  avisos críticos — ou seja, o retrocesso aconteceu entre 10:25 e 10:30 e entre
  10:35 e 10:40 (a hora exata do aviso não é gravada). A
  conexão estava `WORKING` e o worker no ar o tempo todo.
- **M4, caso de 26/10 08:01:43:** a mensagem automática de boas-vindas da
  empresa começava com `U+200E`; o agente respondeu com uma bolha de
  comprimento 1 contendo só `U+200E`. Em JavaScript, `"‎".trim()` é
  `"‎"` (comprimento 1), então a trava `if (body.trim() === '')` em
  `inbound-turn.ts` (resultado `corpo_vazio`) não a barrou.

Onde está cada causa no código:

- `ackToStatus` (`lib/types/messaging.ts`): `ack >= 3 → read`, `>= 2 →
  delivered`, `>= 1 → sent`, **qualquer outro (inclusive -1) → sending**. Único
  consumidor: `handleAck` (`lib/waha/ingest.ts`).
- `handleAck` grava `{ ack, status }` sem condição sobre o estado atual, e
  reescreve `delivered_at`/`read_at = now` a cada aviso `>= 2`/`>= 3`.
- O canal Zernio já faz o certo (`lib/channels/zernio/ingest.ts`): o update de
  status tem `.not("status", "in", "(read)")` ("não rebaixa") e a hora do
  desfecho é gravada uma vez (`carimbarHoraDoDesfecho`, `.is(coluna, null)`).
- Bolha: a trava `corpo_vazio` em `inbound-turn.ts` e o `splitMessage`
  (`lib/agent-engine/agent/split-message.ts`, `trim()` + `filter(s => s !== "")`)
  comparam com string vazia depois de `trim()`.

## O que muda

### 1. O aviso do WhatsApp só faz o status andar para a frente

Em `handleAck` (`lib/waha/ingest.ts`), com a mesma régua do Zernio:

- **Ordem:** `sending < sent < delivered < read`. O update de status só acontece
  quando o estado novo é **mais avançado** que o gravado (condição no próprio
  `UPDATE`, sobre a linha vigente — não ler e depois escrever). `failed` pode
  avançar para `delivered`/`read` quando o aparelho confirma a entrega/leitura
  (ACK 2/3), preservando a recuperação já existente na main. ACK 0/1 não prova
  entrega e não recupera a falha. Erro atrasado depois dessa confirmação não
  rebaixa a mensagem nem emite outra falha.
- **Horas:** `delivered_at` e `read_at` são gravados **uma vez** (`is null`);
  `read` sem `delivered` antes carimba as duas com a mesma hora (como o Zernio).
- **Aviso de erro (`ack = -1`):**
  - Mensagem ainda `sending` ou `sent` (nunca confirmada como entregue) → `status
    = failed`, `error_code = 'ack_error'`, `error_message` com o texto da frase
    abaixo, e `emitirFalhaDeEntrega` (`lib/messaging/falha-de-entrega.ts`, o
    mesmo contrato `message.failed` do envio, da Meta e do `recover-stuck`) com
    `erro.codigo = 'ack_error'`. Nunca volta para `sending`.
  - Mensagem já `delivered` ou `read` → status não muda (o aparelho confirmou);
    o `ack` gravado também não regride.
- **Frase** em `FRASES_DE_FALHA` (`lib/channels/frases-de-falha.ts`), com `es`:
  `ack_error`: "O WhatsApp devolveu um erro para esta mensagem depois de
  aceitá-la. Pode ser que ela tenha chegado; confira na conversa antes de
  reenviar."
- `ackToStatus` deixa de devolver `"sending"` para `-1`: passa a devolver
  `null` (ou o tipo equivalente) para "não muda o status", e o comentário dele
  documenta os valores do WAHA (-1 erro, 0 pendente, 1 servidor, 2 aparelho,
  3 lido, 4 ouvido).
- **Aviso na Central:** o `ack_error` NÃO abre o aviso "não chegou ao cliente"
  (aquele é do `recover-stuck`, e continua igual para o envio que nunca saiu). A
  falha fica visível na bolha da conversa, pela frase, e no evento
  `message.failed`.

### 2. Bolha sem nada visível não sai

- Função única `semConteudoVisivel(texto)` (em `lib/agent-engine/agent/`, ao
  lado de `split-message.ts`): verdadeira quando o texto, sem espaços e sem
  caracteres da categoria Unicode **Cf** (formatação: `U+200B`–`U+200F`,
  `U+2060`, `U+FEFF`, …), fica vazio — `/^[\s\p{Cf}]*$/u`.
- A trava `corpo_vazio` de `inbound-turn.ts` passa a usar essa função no lugar
  de `body.trim() === ''` (mesma resposta ao modelo: "o texto ficou vazio").
- `splitMessage` descarta bolha para a qual a função é verdadeira, além da
  vazia de hoje.

## Fora desta spec (de propósito)

- Por que o WhatsApp devolveu erro 2h30 depois de aceitar: o WAHA não guardou
  registro dessa janela; a correção aqui é o sistema não mentir sobre o estado.
- Corrigir os status já regredidos no banco (M1, M2): é dado histórico; a spec
  impede que continue. Uma migration de dados que reconstrua o status a partir
  de `read_at`/`delivered_at` fica como pergunta ao mantenedor no PR.
- O agente repetir a mensagem automática da empresa (visto em 23/10): é conduta
  do agente, não trava de envio.

## Fatias (um PR, um commit por fatia)

1. `fix(whatsapp): o aviso de entrega não faz o status voltar para trás` —
   `handleAck` monotônico e horas gravadas uma vez.
2. `fix(whatsapp): erro do WhatsApp depois de aceitar vira falha com o motivo
   certo` — `ack = -1`, `ack_error`, frase e `message.failed`.
3. `fix(ia): bolha só com caractere invisível não sai` — `semConteudoVisivel`,
   trava `corpo_vazio` e `splitMessage`.

## Como provar

- **Unit, com sabotagem** (cada uma fica vermelha sem a linha do conserto):
  - `read` gravado + aviso `ack = 2` atrasado → continua `read`; `read_at` e
    `delivered_at` não mudam.
  - `delivered` + aviso `ack = 1` → continua `delivered`.
  - `sent` + `ack = -1` → `failed / ack_error` e um `message.failed`; nunca
    `sending`.
  - `delivered` + `ack = -1` → continua `delivered`, sem `message.failed`.
  - `read` sem `delivered` antes → as duas horas gravadas iguais.
  - `semConteudoVisivel("‎")`, `("​\n ")`, `("﻿")` verdadeiras;
    `("ok")`, `("👍")` falsas.
  - `send_message` com corpo `"‎"` devolve `corpo_vazio`; `splitMessage`
    não devolve bolha invisível.
  - Isolamento: o update do aviso continua filtrando `organization_id` (teste
    com duas organizações e o mesmo `external_id`).
- **Lint de canal:** `ack_error` não carrega nome de provedor
  (`pnpm lint:channels`).
- **Na instalação de origem, depois do deploy:** repetir M1–M4 só para
  mensagens criadas depois da atualização (meta: zero regressões novas, zero
  `send_timeout` com `ack = -1`, zero bolha invisível).

## Destino

**Núcleo.** Comportamento de canal e de envio, sem chave nova, sem migration de
schema, sem tela nova.

— Paulo Lima Jr
