/**
 * O CONTRATO do que chega no webhook deste canal — declarado, e não presumido.
 *
 * Antes daqui o corpo entrava por `JSON.parse(rawBody) as WahaEnvelope`: um
 * **cast**, que é uma promessa do autor ao compilador e nada mais. Em tempo de
 * execução o campo podia ser o que quisesse, e a rota não tinha como saber.
 *
 * ─── O que o cast custava, medido ───────────────────────────────────────────
 *
 * `payload.from` vai direto para `parseChatId`, que chama `.endsWith`. Com um
 * `from` não-string a chamada LANÇA, o `try/catch` da rota engole, e a
 * requisição devolve **200** — o provider risca o evento da fila achando que
 * entregou. Descarte mudo com carimbo de sucesso, no caminho que ingere
 * mensagem de cliente. E `WAHA_WEBHOOK_REQUIRE_SIGNATURE` é `false` por padrão,
 * então esse caminho é alcançável sem segredo nenhum.
 *
 * ─── A REGRA deste arquivo (leia antes de acrescentar campo) ────────────────
 *
 * Um campo ganha tipo quando o código o consome **sem guarda própria** — é aí
 * que o tipo errado vira exceção engolida ou descarte mudo. Campo que o código
 * já trata em qualquer forma (`Array.isArray`, `typeof x === "object"`) fica
 * `z.unknown()`, e campo que ninguém lê não entra: o objeto é **loose**, então
 * o desconhecido passa intacto.
 *
 * Apertar além disso é a regressão que este arquivo existe para não causar. Um
 * webhook de WhatsApp real traz campos que ninguém catalogou; um `.strict()` ou
 * um obrigatório a mais transforma "mensagem entra no CRM" em "mensagem
 * descartada", que é pior que o defeito consertado aqui.
 *
 * `.nullish()` em tudo pelo mesmo motivo: `null` é como todo provider escreve
 * "não tenho este campo", e recusá-lo seria inventar uma exigência que o fio
 * nunca teve.
 */
import { z } from "zod";

import { conferirEnvelope, lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

/** Texto do fio: string, ausente ou `null`. Nunca outro tipo. */
const texto = z.string().nullish();
const numero = z.number().nullish();
const booleano = z.boolean().nullish();

/** WAHA >= 2026.x (NOWEB): a mídia vem aninhada aqui. */
const wahaMediaSchema = z.looseObject({
  url: texto,
  mimetype: texto,
});

/**
 * A chave do Baileys — e o achado que o passo 2 da spec 17 mediu.
 *
 * Quando o chat é `@lid`, o WhatsApp NÃO esconde o telefone: ele o manda em
 * `remoteJidAlt` (chat 1:1) ou `participantAlt` (grupo). Medido em
 * `webhook_events_log` da produção: **76 de 76** payloads @lid com `key` trazem
 * o número. A leitura de que "@lid é opaco por privacidade" valia para o
 * `from`, não para o payload inteiro.
 *
 * Só esses dois ganham tipo: são os que `telefoneAlternativoDe` mede com
 * `.length` e `.endsWith` sem guarda própria. `remoteJid`, `participant`,
 * `addressingMode`, `fromMe` e `id` chegam nos payloads reais e seguem intactos
 * pelo loose — ninguém os lê.
 */
const wahaKeySchema = z.looseObject({
  remoteJidAlt: texto,
  participantAlt: texto,
});

export const wahaPayloadSchema = z.looseObject({
  id: texto,
  from: texto,
  to: texto,
  fromMe: booleano,
  body: texto,
  type: texto,
  hasMedia: booleano,
  ack: numero,
  ackName: texto,
  status: texto,
  timestamp: numero,
  mediaUrl: texto,
  mimetype: texto,
  media: wahaMediaSchema.nullish(),
  /** Id da mensagem ORIGINAL nos eventos `message.edited` / `message.revoked`. */
  editedMessageId: texto,
  revokedMessageId: texto,
  _data: z.looseObject({
    notifyName: texto,
    pushName: texto,
    /**
     * O conteúdo NOWEB (`imageMessage`, `stickerMessage`, …). Fica sem tipo de
     * propósito: `resolveMessageType` já checa `typeof msg === "object"` antes
     * de olhar as chaves, então exigir objeto aqui só criaria uma forma nova de
     * descartar a mensagem inteira.
     *
     * ⚠️ O `.optional()` NÃO é enfeite: no Zod 4 um `z.unknown()` solto dentro de
     * um objeto é OBRIGATÓRIO (a chave ausente reprova com
     * `expected nonoptional`). Sem ele, TODO payload sem `_data.message` — que
     * inclui o ack, 95 dos 438 eventos medidos — seria recusado. Medido ao
     * escrever `contrato-do-webhook-waha.test.ts`, que reprovou por isso.
     */
    message: z.unknown().optional(),
    key: wahaKeySchema.nullish(),
  }).nullish(),
});

export const wahaEnvelopeSchema = z.looseObject({
  event: texto,
  session: texto,
  payload: wahaPayloadSchema.nullish(),
});

export type WahaPayload = z.infer<typeof wahaPayloadSchema>;
export type WahaEnvelope = z.infer<typeof wahaEnvelopeSchema>;

/**
 * ─── Por que a conferência acontece em DOIS momentos ────────────────────────
 *
 * `docs/prd/03-prd-whatsapp-waha.md` §3.3 tem um AC explícito: "webhook com
 * HMAC válido grava raw em `webhook_events_log` mesmo se o parse falhar
 * depois". Recusar pelo contrato inteiro antes de arquivar destruiria
 * justamente a evidência que se quer guardar — o corpo cru de um payload cujo
 * formato mudou é o artefato que responde O QUE mudou.
 *
 * Então o estágio 1 confere só o que a rota precisa ANTES de poder arquivar, e
 * isso depende de QUEM resolve a organização em cada rota:
 *
 *   - rota por token: o token do caminho resolve. O estágio 1 confere o evento
 *     e o id da mensagem (que vai numa coluna do próprio arquivo), e só.
 *   - rota global: a `session` do corpo resolve, então ela entra também.
 *
 * Um estágio 1 único, com `session`, fazia a rota por token recusar ANTES do
 * INSERT um campo que ela nem lê — e o corpo cru sumia (issue #290, item 1). O
 * estágio 2 confere o resto e decide o status com que a linha é arquivada.
 */
export const wahaRoteamentoPorTokenSchema = z.looseObject({
  event: texto,
  payload: z.looseObject({ id: texto }).nullish(),
});

export const wahaRoteamentoSchema = z.looseObject({
  ...wahaRoteamentoPorTokenSchema.shape,
  session: texto,
});

export type WahaRoteamentoPorToken = z.infer<typeof wahaRoteamentoPorTokenSchema>;
export type WahaRoteamento = z.infer<typeof wahaRoteamentoSchema>;

/** Estágio 1 da rota global — o mínimo para resolver o tenant pela sessão e arquivar o corpo. */
export function lerRoteamentoWaha(rawBody: string): LeituraDeEnvelope<WahaRoteamento> {
  return lerEnvelope(rawBody, wahaRoteamentoSchema);
}

/** Estágio 1 da rota por token — o tenant já vem do caminho; só o que vai para o arquivo. */
export function lerRoteamentoWahaPorToken(rawBody: string): LeituraDeEnvelope<WahaRoteamentoPorToken> {
  return lerEnvelope(rawBody, wahaRoteamentoPorTokenSchema);
}

/**
 * Estágio 2 — o contrato completo, sobre o que o estágio 1 já desserializou.
 *
 * Reconferir o objeto do estágio 1 equivale a reconferir o corpo original: o
 * schema é `loose` em todo nível, então o que ele devolve tem as MESMAS chaves
 * que entraram. Provado em `contrato-do-webhook-waha.test.ts`.
 */
export function conferirContratoWaha(
  roteado: WahaRoteamento | WahaRoteamentoPorToken,
): LeituraDeEnvelope<WahaEnvelope> {
  return conferirEnvelope(roteado, wahaEnvelopeSchema);
}
