/**
 * O CONTRATO do que o canal intermediado manda — declarado, e não presumido.
 *
 * ─── O que o `unknown` custava aqui (é diferente dos outros dois canais) ────
 *
 * Este parser nunca estourou: ele lê tudo por `str()`, que devolve `null` para
 * qualquer coisa que não seja string. O preço não era exceção, era **silêncio**.
 * Um `message.conversationId` que chegasse número virava `null`, `parseZernioInbound`
 * devolvia `null`, e a rota respondia **200 `evento_sem_interesse`** — a mesma
 * resposta de um evento que de fato não nos interessa. A mensagem do cliente
 * sumia e o desfecho dizia "normal".
 *
 * Com o contrato, esse payload vira 400 com o campo nomeado, e o corpo cru fica
 * no arquivo de webhook com `status: "error"` — que é onde alguém vai procurar.
 *
 * ─── A REGRA deste arquivo (leia antes de acrescentar campo) ────────────────
 *
 * Um campo ganha tipo quando o LEITOR o normaliza: `str()` para string, `obj()`
 * para objeto (os dois em `./webhook.ts`). É o OPOSTO da regra que este
 * cabeçalho declarava antes — reservar o tipo para o campo lido **sem guarda** —,
 * e a inversão é o ponto: a normalização devolve `null` para a forma errada, e
 * é justamente esse `null` que o tipo transforma em 400 nomeado: `str()` sobre
 * um `conversationId` numérico devolve `null`, o parser devolve `null`, e a
 * rota respondia 200 como se o evento não interessasse (ver o topo).
 *
 * O tipo também segura quem lê o envelope JÁ VALIDADO, sem conferir a forma:
 * `../inbound.ts` chama `payload.event?.startsWith(...)` e lê
 * `payload.number?.phoneNumber` confiando no schema. Afrouxar `event` ou
 * `number` aqui quebra o typecheck ali — e é para quebrar.
 *
 * Sem tipo (o leitor aceita qualquer forma): `attachments`.
 *
 * `attachments` é lido por `Array.isArray(...) ? ... : []`, que trata qualquer
 * forma — exigir array aqui trocaria "anexo ignorado" por "MENSAGEM descartada",
 * que é a regressão que este arquivo existe para não causar.
 *
 * `error.code` é a exceção DECLARADA ao `str()`: chega número no payload real
 * (`"code": 131047`), então o tipo é `z.union([z.string(), z.number()])`.
 *
 * O objeto é `loose` em todo nível: campo que ninguém catalogou passa intacto.
 */
import { z } from "zod";

import { lerEnvelope, type LeituraDeEnvelope } from "@/lib/webhooks/contrato";

const texto = z.string().nullish();

/** Quem está do outro lado. A ordem de precedência das âncoras vive em `webhook.ts`. */
const zernioSenderSchema = z.looseObject({
  phoneNumber: texto,
  businessScopedUserId: texto,
  whatsappUsername: texto,
  name: texto,
  displayName: texto,
});

const zernioMessageSchema = z.looseObject({
  id: texto,
  conversationId: texto,
  platform: texto,
  platformMessageId: texto,
  direction: texto,
  text: texto,
  /** Corpo novo de uma edição — `content`/`text`/`body`, nesta ordem. */
  content: texto,
  body: texto,
  sentAt: texto,
  sender: zernioSenderSchema.nullish(),
  /**
   * Ver a REGRA no cabeçalho: quem lê já aceita qualquer forma.
   *
   * ⚠️ O `.optional()` NÃO é enfeite: no Zod 4 um `z.unknown()` solto dentro
   * de um objeto é OBRIGATÓRIO, e sem ele toda mensagem SEM anexo — a
   * maioria delas — seria recusada.
   */
  attachments: z.unknown().optional(),
});

export const zernioEnvelopeSchema = z.looseObject({
  event: texto,
  accountId: texto,
  /** Detalhe do aviso de número, quando a plataforma o manda solto. */
  reason: texto,
  account: z.looseObject({ id: texto, accountId: texto }).nullish(),
  conversation: z.looseObject({ participantId: texto, participantName: texto }).nullish(),
  template: z.looseObject({ name: texto, status: texto, reason: texto }).nullish(),
  /** `phoneNumber` decide se o evento de número é DESTA sessão (ver `zernioInbound`). */
  number: z.looseObject({ reason: texto, phoneNumber: texto }).nullish(),
  /**
   * O `code` chega como NÚMERO no payload real (`"code": 131047`) e o leitor
   * trata as duas formas — medido nos logs de entrega, ver `explicacaoDoErro`.
   */
  error: z
    .looseObject({
      code: z.union([z.string(), z.number()]).nullish(),
      title: texto,
      explanation: texto,
    })
    .nullish(),
  message: zernioMessageSchema.nullish(),
});

export type ZernioEnvelope = z.infer<typeof zernioEnvelopeSchema>;

export function lerEnvelopeZernio(rawBody: string): LeituraDeEnvelope<ZernioEnvelope> {
  return lerEnvelope(rawBody, zernioEnvelopeSchema);
}
