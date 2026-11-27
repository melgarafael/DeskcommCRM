# Webhooks de saída — guia de quem recebe

> **Para quem é:** quem mantém o sistema que RECEBE o aviso da ação
> **"Avisar outro sistema (webhook)"** das automações do CRM.
> **O que responde:** o que chega em cada requisição, como conferir que veio do
> CRM, como recusar uma requisição capturada e repetida, e como reconhecer uma
> retentativa (ou um Reenviar) como a mesma entrega.
> **Fonte da verdade no código:** `lib/automation/actions/call-webhook.ts`.
> A tabela do vetor de referência do fim deste guia é lida por
> `tests/unit/webhooks-de-saida-documento.test.ts`, que confere cada valor
> contra o emissor e executa de verdade o exemplo em Node abaixo contra ela;
> `lib/automation/actions/call-webhook.test.ts` confere o mesmo vetor numa
> entrega real.

---

## 1. O que chega

Um `POST` com `Content-Type: application/json` e este corpo:

```json
{
  "event": "lead.created",
  "occurred_at": "2026-01-01T00:00:00.000Z",
  "happened_at": "2025-12-31T21:00:00.000Z",
  "delivery_id": "209f529f-3a34-5ccb-9486-5e20cd48fb45",
  "data": { "lead": { "id": "lead-1" } }
}
```

| Campo | O que é |
|---|---|
| `event` | O tipo do evento que disparou a automação (o mesmo do cabeçalho `X-Deskcomm-Event`). |
| `occurred_at` | A hora em que o CRM montou esta entrega (o disparo da automação ou o clique em Reenviar), em ISO-8601 UTC com milissegundos. É o que o campo sempre foi. As retentativas automáticas de um mesmo disparo, segundos depois, repetem o corpo e portanto este valor. Para medir a idade da requisição, prefira o `t` de dentro do `X-Webhook-Signature` (seção 3): ele é a hora do envio de **cada tentativa** e também é coberto pela assinatura. |
| `happened_at` | A hora em que o **fato** aconteceu (o lead foi criado, a etapa mudou…), em ISO-8601 UTC com milissegundos. É a mesma em todas as tentativas e no Reenviar, e pode ter horas ou dias de idade (uma automação adiada pela janela de envio do WhatsApp, um Reenviar clicado dias depois). Use-o para ordenar os fatos no seu sistema; nunca para recusar requisição velha. |
| `delivery_id` | O id da entrega — o mesmo valor do cabeçalho `X-Webhook-Delivery`. |
| `data` | Os dados do evento, com a projeção pública do lead, do contato e do compromisso quando existem. O contato pode trazer o bloco `attribution` (seção 1.1). |

### 1.1 A origem do anúncio (`contact.attribution`)

Quando o contato tem origem de anúncio gravada, o `data.contact` traz um bloco
`attribution` com uma lista **fechada** de chaves. Ele é montado dos metadados
do próprio contato, na entrega — não existe chamada extra à API para isso:

```json
{
  "event": "lead.created",
  "data": {
    "contact": {
      "id": "contact-1",
      "name": "Fulano da Silva",
      "attribution": {
        "platform": "google_ads",
        "click_id": "GCLID-abc123",
        "click_source": "site",
        "ad_id": "ad-9",
        "campaign_id": "camp-7",
        "campaign_name": "verao-2026"
      }
    }
  }
}
```

| Campo do bloco | De onde vem (metadados do contato) | O que é |
|---|---|---|
| `platform` | `ad_platform` | A plataforma do anúncio (`meta_ads`, `google_ads`). |
| `click_id` | `ad_source_id` | O clique que abriu a conversa: `ctwa_clid` no clique-pro-WhatsApp, `fbclid`/`gclid` no lead que veio por formulário. |
| `click_source` | `ad_click_source` | Presente quando o clique foi capturado na página (`"site"`). |
| `ad_id` | `ad_id` (ou `google_ad_id`) | O id do anúncio — a peça, não o clique. |
| `campaign_id` | `google_campaign_id` (ou `campaign_id`) | O id da campanha, quando a captura o trouxe. |
| `campaign_name` | `utm_campaign` (ou `campaign_name`) | O texto de campanha que veio no link/captura. |

Regras que o receptor pode contar:

- **Só vem quando o contato tem origem.** Contato sem clique, ou com metadados
  que não têm nenhuma das chaves acima, sai **sem** `attribution` — o `contact`
  é exatamente o de antes.
- **Cada chave só aparece se existir.** Um contato que só tem `ad_platform`
  recebe `attribution` com `platform` e mais nada; nenhum campo é inventado nem
  preenchido com `null`.
- **O jsonb cru nunca sai.** `fbc`, `fbp`, `ad_raw` (o payload inteiro do
  transporte) e ids internos da organização ficam fora do envelope. O bloco é
  uma lista fechada de chaves, e chave nova só entra em versão nova do CRM.
- **Aqui só há ids e o texto da campanha.** O `campaign_name` é o que o link
  carrega, não o nome oficial. Para os nomes de campanha, conjunto e anúncio —
  e para o dado bruto do contato — use as duas rotas da API, com um token de
  Admin › Configurações › Tokens de API (`/app/settings/api-tokens`):
  - `GET /api/v1/contacts/{id}` — o contato, incluindo `source_metadata`;
  - `GET /api/v1/contacts/{id}/hierarquia-do-anuncio` — os nomes oficiais de
    campanha, conjunto e anúncio do contato.

## 2. Os cabeçalhos

| Cabeçalho | Quando sai | O que significa |
|---|---|---|
| `X-Deskcomm-Event` | sempre | O tipo do evento. |
| `X-Webhook-Delivery` | sempre | Id da **entrega** (um uuid). É o mesmo em todas as tentativas da mesma entrega **e** no botão Reenviar da tela de atividade. É a chave para deduplicar. |
| `X-Webhook-Attempt` | sempre | Número da tentativa: `1`, `2`, `3`… O Reenviar continua a contagem (se a entrega já teve 3 tentativas, o Reenviar chega com `4`). É informativo — a chave de deduplicação é o Delivery. |
| `X-Webhook-Timestamp` | sempre | Hora do **envio desta tentativa**, em segundos unix. Muda a cada tentativa. **Informativo:** nenhuma assinatura o cobre. Para a janela de tempo, use o `t` do `X-Webhook-Signature`. |
| `X-Webhook-Signature` | com segredo | `t=<timestamp>,v1=<hex>`, em que `v1 = HMAC-SHA256(segredo, "<t>.<delivery>.<corpo cru>")`. Cobre a hora e o id além do corpo. |
| `X-Deskcomm-Signature` | com segredo | **Legado.** `HMAC-SHA256(segredo, corpo cru)` em hex, sem hora nem id. Continua saindo exatamente igual durante a convivência; a saída dele será anunciada nas notas da versão como mudança que exige ação. |

**O que a assinatura cobre.** O `v1` do `X-Webhook-Signature` autentica o
`t` que vai dentro dele, o `X-Webhook-Delivery` e o corpo — e só isso. Os
cabeçalhos `X-Deskcomm-Event`, `X-Webhook-Attempt` e `X-Webhook-Timestamp`
**não são autenticados**: quem captura uma requisição pode trocá-los sem que a
assinatura deixe de conferir. Em especial, a única cópia assinada da hora do
envio é o `t` dentro do `X-Webhook-Signature`. Um receptor que mede a idade
pelo `X-Webhook-Timestamp` e confere o HMAC com o `t` aceita uma requisição
velha repetida com o `X-Webhook-Timestamp` trocado pela hora atual. Use o
`X-Deskcomm-Event` e o `X-Webhook-Attempt` só para log e roteamento; o tipo do
evento que vale é o `event` do corpo, que é assinado.

Sem segredo configurado na ação, as duas assinaturas não saem — não há o que
assinar. Os nomes dos cabeçalhos são contrato: não mudam numa instalação de
marca própria.

## 3. Como conferir, passo a passo

1. **Leia o corpo CRU**, os bytes exatamente como chegaram, antes de qualquer
   `JSON.parse`. Reserializar o JSON muda espaços e a ordem das chaves, e a
   assinatura deixa de bater.
2. **Exija o `X-Webhook-Signature`.** Se ele não veio, recuse — **não**
   caia para o `X-Deskcomm-Signature` legado como alternativa: quem captura uma
   entrega apaga o `X-Webhook-Signature`, mantém o legado (que só cobre o
   corpo e vale para sempre) e repete a requisição quando quiser, sem que a
   janela do passo 3 seja consultada. Aceitar o legado só faz sentido enquanto o
   CRM que envia ainda não foi atualizado (seção 8).
   **Separe `t` e `v1`** do `X-Webhook-Signature`: pares `chave=valor`
   separados por vírgula. Ignore chaves que você não conhece — versões futuras
   podem acrescentar outras (`v2=`…) sem quebrar quem já confere `v1`.
3. **Recuse se `|agora − t| > 300` segundos**, com o `t` de dentro do
   `X-Webhook-Signature` — nunca com o `X-Webhook-Timestamp`, que não é
   assinado (seção 2). Essa janela é o que torna inútil
   uma requisição capturada e repetida depois. Os 300 s são a recomendação; a
   janela é sua.
4. **Calcule** `HMAC-SHA256(segredo, "<t>.<delivery>.<corpo cru>")` em hex, com
   o `t` como veio no cabeçalho e o `delivery` do `X-Webhook-Delivery`.
5. **Compare em tempo constante** (`crypto.timingSafeEqual` no Node,
   `hmac.compare_digest` no Python). Uma comparação comum (`===`, `==`) devolve
   mais cedo no primeiro caractere diferente, e o tempo de resposta vaza a
   assinatura aos poucos.
6. **Deduplique pelo `X-Webhook-Delivery`**: guarde os ids já processados. Se
   chegar um que você já processou, responda `2xx` sem processar de novo —
   senão o CRM entende como falha e tenta outra vez. **24 horas** de memória
   cobrem as retentativas automáticas, que acabam em segundos. O Reenviar
   **não tem prazo** (seção 4): ele pode chegar dias depois com o mesmo id. Se
   processar duas vezes a mesma entrega custa caro para você (lead ou cobrança
   duplicada), guarde os ids num armazenamento persistente — por exemplo, uma
   chave única no seu banco sobre o `delivery_id` — em vez de um cache que
   expira.
7. **Responda rápido** com `2xx` e deixe o trabalho pesado para depois. O CRM
   espera no máximo **10 segundos** por tentativa, faz até **3 tentativas** por
   entrega (esperando 1 s e depois 5 s entre elas) e trata qualquer status fora
   de `2xx` como falha. Redirecionamento (`3xx`) **não é seguido**: conta como
   falha.

**Relógio.** A janela compara a hora do seu servidor com a do CRM. Mantenha o
relógio sincronizado por NTP; um relógio vários minutos fora faz toda entrega
ser recusada.

## 4. Retentativa e Reenviar

- **Retentativa automática:** mesmo corpo, mesmo `X-Webhook-Delivery`,
  `X-Webhook-Attempt` subindo, `X-Webhook-Timestamp` e
  `X-Webhook-Signature` novos a cada tentativa.
- **Reenviar** (botão na tela de atividade da automação): mesmo
  `X-Webhook-Delivery` da entrega original, `X-Webhook-Attempt` continuando a
  contagem. O corpo é **remontado com os dados atuais** do lead e do contato.
  Como o id é o mesmo, um receptor que **ainda guarda** aquele id descarta o
  Reenviar pela deduplicação. Isso é de propósito: o Reenviar existe para a
  entrega que **não chegou**, não para mandar de novo uma que já chegou. O
  botão não tem prazo — o Reenviar pode chegar muito depois das 24 horas do
  passo 6 da seção 3, e só é descartado se você ainda tiver o id guardado.
- **Quando o id muda:** o id da entrega é derivado do evento, da automação, da
  **posição da ação** na automação **e da lista de ações** da automação (tipo e
  configuração de cada uma, sem o segredo). Se alguém mudar as ações — editar,
  reordenar, acrescentar ou remover qualquer uma — entre o disparo e o
  Reenviar, o Reenviar sai com um id **novo**, e você o processa como entrega
  nova. Ele **nunca** sai com o id de outra ação da mesma automação: a lista
  entra no id justamente para que uma ação que herdou a posição de outra não
  herde também o id dela, e seja descartada como duplicata sem ter sido
  processada. Trocar só o segredo não muda o id.

## 5. Exemplo em Node (18 ou mais novo)

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const JANELA_EM_SEGUNDOS = 300;

/**
 * cabecalhos: nomes em minúsculas (como `req.headers` do Node entrega).
 * corpoCru: string ou Buffer com o corpo exatamente como chegou.
 */
export function verificarWebhook({ segredo, cabecalhos, corpoCru, agoraEmSegundos = Math.floor(Date.now() / 1000) }) {
  const entrega = cabecalhos["x-webhook-delivery"];
  const assinatura = cabecalhos["x-webhook-signature"];
  if (typeof entrega !== "string" || typeof assinatura !== "string") return false;

  const partes = {};
  for (const par of assinatura.split(",")) {
    const i = par.indexOf("=");
    if (i > 0) partes[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  const t = partes.t;
  if (!/^\d+$/.test(t ?? "") || !/^[0-9a-f]{64}$/.test(partes.v1 ?? "")) return false;
  if (Math.abs(agoraEmSegundos - Number(t)) > JANELA_EM_SEGUNDOS) return false;

  const esperado = createHmac("sha256", segredo).update(`${t}.${entrega}.`).update(corpoCru).digest();
  return timingSafeEqual(esperado, Buffer.from(partes.v1, "hex"));
}
```

No Express, leia o corpo cru com `express.raw({ type: "application/json" })`
(e não `express.json()`) e passe `req.body` como `corpoCru`. Depois de
`verificarWebhook` devolver `true`, confira o `X-Webhook-Delivery` contra os
ids já processados.

## 6. Exemplo em Python (3.9 ou mais novo)

```python
import hashlib
import hmac
import re
import time

JANELA_EM_SEGUNDOS = 300


def verificar_webhook(segredo, cabecalhos, corpo_cru, agora_em_segundos=None):
    """corpo_cru: bytes exatamente como chegaram (ex.: request.get_data() no Flask)."""
    cab = {k.lower(): v for k, v in cabecalhos.items()}
    entrega = cab.get("x-webhook-delivery")
    assinatura = cab.get("x-webhook-signature")
    if not entrega or not assinatura:
        return False

    partes = {}
    for par in assinatura.split(","):
        chave, _, valor = par.partition("=")
        partes[chave.strip()] = valor.strip()
    t, v1 = partes.get("t", ""), partes.get("v1", "")
    if not re.fullmatch(r"\d+", t) or not re.fullmatch(r"[0-9a-f]{64}", v1):
        return False

    agora = int(time.time()) if agora_em_segundos is None else agora_em_segundos
    if abs(agora - int(t)) > JANELA_EM_SEGUNDOS:
        return False

    esperado = hmac.new(segredo.encode(), f"{t}.{entrega}.".encode() + corpo_cru, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, v1)
```

## 7. Vetor de referência

Para conferir a sua implementação sem depender do CRM. Os valores foram
calculados de forma independente, e esta tabela é lida pelo teste do projeto:
se um valor daqui deixar de bater com o que o CRM assina, o teste reprova.

| | |
|---|---|
| Segredo | `segredo-de-exemplo-nao-use-em-producao` |
| `t` do `X-Webhook-Signature` (o mesmo valor sai no `X-Webhook-Timestamp`) | `1767225600` |
| `X-Webhook-Delivery` | `209f529f-3a34-5ccb-9486-5e20cd48fb45` |
| Corpo cru (uma linha, sem espaços) | `{"event":"lead.created","occurred_at":"2026-01-01T00:00:00.000Z","happened_at":"2025-12-31T21:00:00.000Z","delivery_id":"209f529f-3a34-5ccb-9486-5e20cd48fb45","data":{"lead":{"id":"lead-1"}}}` |
| `X-Webhook-Signature` esperado | `t=1767225600,v1=bccb00c040649c7e2618d9cd4a3bc79ade96d5dd939c0fb11f26064c538e57a5` |
| `X-Deskcomm-Signature` (legado) esperado | `6aa08c69080a291fadcdd6913d78e79dbd2705a95b3cf87c8a0018491a1a8dab` |

Com `agora = 1767225610` a verificação passa; com `agora = 1767225901`
(301 s depois) ela recusa.

## 8. Migrando do cabeçalho legado

Quem hoje confere o `X-Deskcomm-Signature` não precisa mudar a conferência
agora: ele continua saindo igual. O corpo ganhou dois campos, `delivery_id` e
`happened_at` (a hora do fato), e nenhum campo que já existia mudou de
significado: o `occurred_at` segue sendo a hora em que o CRM montou a entrega.
Se o seu sistema mede a idade da requisição pelo `occurred_at`, ele continua
funcionando como antes, mas a medida certa é o `t` de dentro do
`X-Webhook-Signature`, que é a hora do envio de cada tentativa **e** é coberto
pela assinatura. O `X-Webhook-Timestamp` leva o mesmo número, mas não é
assinado: medir a idade por ele deixa passar uma requisição velha repetida com
esse cabeçalho trocado (seção 2).

Para migrar:

1. Se você mede a idade da requisição pelo `occurred_at`, prefira medir pelo
   `t` do `X-Webhook-Signature` (parágrafo acima).
2. Passe a conferir o `X-Webhook-Signature` (seções 3, 5 e 6) e, **a partir
   desse momento, recuse a requisição que chega sem ele**. Não use o
   `X-Deskcomm-Signature` como alternativa quando a v2 falta: toda entrega sai
   com as duas assinaturas, e quem captura uma entrega remove a v2 e repete a
   requisição sem limite de tempo, porque o legado só cobre o corpo. Se você
   recebe de várias instalações do CRM, aceite o legado sozinho só das que
   ainda não foram atualizadas — nunca como regra geral.
3. Passe a deduplicar pelo `X-Webhook-Delivery`.
4. Pare de ler o `X-Deskcomm-Signature`. Quando ele for removido, as notas da
   versão avisam com antecedência.
