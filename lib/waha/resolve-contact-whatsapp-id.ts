/**
 * Resolve o wa_id canônico para cartão de contato (vcard).
 *
 * No WhatsApp BR o CRM grava +5531998966398 (13 dígitos) mas o wa_id registrado
 * pode ser 553198966398 (12, sem o nono). vCard com waid errado EXIBE o cartão,
 * porém o toque no app nativo não abre a conversa — exatamente o bug reportado.
 *
 * WAHA documenta `GET /api/contacts/check-exists` para isso; tentamos todas as
 * variantes de busca (phoneLookupVariants) antes de cair no número bruto.
 */
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

import type { WahaClient } from "./client";

export interface WahaCheckExistsResult {
  numberExists: boolean;
  chatId?: string | null;
  pn?: string | null;
}

/** Extrai só dígitos do JID retornado (`5531…@c.us` ou `@lid`). */
export function whatsappIdFromCheckResult(r: WahaCheckExistsResult): string | null {
  const raw = r.pn ?? r.chatId;
  if (!raw) return null;
  const user = raw.split("@")[0] ?? "";
  const digits = user.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * Endereço de ENVIO que o WAHA devolveu. A doc manda usar `chatId` cru:
 * hoje costuma ser `@lid`, e mandar `pn@c.us` no lugar não entrega — o caso
 * de lead novo só com telefone, inclusive o nono dígito BR.
 */
export function sendChatIdFromCheckResult(r: WahaCheckExistsResult): string | null {
  if (!r.numberExists) return null;
  const jid = r.chatId?.trim() ?? "";
  if (jid.endsWith("@lid") || jid.endsWith("@c.us") || jid.endsWith("@s.whatsapp.net")) {
    return jid;
  }
  const id = whatsappIdFromCheckResult(r);
  return id ? `${id}@c.us` : null;
}

async function firstExistingOnWhatsapp(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<WahaCheckExistsResult | null> {
  const tried = new Set<string>();
  for (const variant of phoneLookupVariants(phone)) {
    const digits = variant.replace(/\D/g, "");
    if (!digits || tried.has(digits)) continue;
    tried.add(digits);
    try {
      const r = await client.checkContactExists(session, digits);
      if (r.numberExists && (sendChatIdFromCheckResult(r) || whatsappIdFromCheckResult(r))) {
        return r;
      }
    } catch {
      // ponytail: falha na consulta não bloqueia envio — adapter cai no wa_id bruto
    }
  }
  return null;
}

/**
 * Dígitos do JID de TELEFONE que o check-exists devolveu — `null` quando o único
 * endereço é `@lid`.
 *
 * Existe separado de `whatsappIdFromCheckResult` porque aquele aceita o `@lid`
 * quando não há `pn`, e para um cartão de contato isso é tolerável. Para uma
 * LIGAÇÃO não é: o WaCalls monta o destino com `types.NewJID(dígitos,
 * DefaultUserServer)` (`internal/app/session/commands.go`), ou seja,
 * `<dígitos>@s.whatsapp.net` — dígitos de um lid viram um telefone que não
 * existe.
 */
export function phoneJidDigitsFromCheckResult(r: WahaCheckExistsResult): string | null {
  if (!r.numberExists) return null;
  for (const jid of [r.pn, r.chatId]) {
    if (!jid) continue;
    const [user, server] = jid.split("@");
    if (server !== "c.us" && server !== "s.whatsapp.net") continue;
    // `5531…:12@s.whatsapp.net` — o sufixo `:N` é o aparelho, não o número.
    const digits = (user ?? "").split(":")[0]!.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return digits;
  }
  return null;
}

/**
 * O número, em dígitos, pelo qual o WhatsApp endereça este telefone — o que
 * uma ligação precisa discar. `null` = nenhuma grafia existe, só há `@lid`, ou
 * a consulta falhou; quem chama decide o fallback.
 */
export async function resolvePhoneJidDigitsForCall(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<string | null> {
  const r = await firstExistingOnWhatsapp(client, session, phone);
  return r ? phoneJidDigitsFromCheckResult(r) : null;
}

/** Consulta WAHA; null = não achou ou falhou (caller usa fallback). */
export async function resolveWhatsappIdForContactCard(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<string | null> {
  const r = await firstExistingOnWhatsapp(client, session, phone);
  return r ? whatsappIdFromCheckResult(r) : null;
}

/**
 * Destino de envio alinhado ao que o WhatsApp realmente endereça.
 *
 * Lead cadastrado só com telefone sai como `…@c.us`. O check-exists do WAHA
 * devolve o JID certo (nono dígito e, quando o número está em modo privacidade,
 * `@lid`). Grupo/`@lid` já resolvidos passam intactos.
 */
export async function resolveCanonicalCusChatId(
  client: WahaClient,
  session: string,
  chatId: string,
): Promise<string> {
  if (!chatId.endsWith("@c.us")) return chatId;
  const digits = chatId.slice(0, -"@c.us".length).replace(/\D/g, "");
  const variants = phoneLookupVariants(digits).length;
  if (variants < 2) {
    return chatId;
  }
  const r = await firstExistingOnWhatsapp(client, session, digits);
  return (r && sendChatIdFromCheckResult(r)) || chatId;
}
