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
import { FalhaDeEnvioDoCanal } from "@/lib/channels/falha-de-envio";
import { FRASES_DE_FALHA } from "@/lib/channels/frases-de-falha";
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

/**
 * Memo do check-exists POSITIVO, por (sessão, dígitos).
 *
 * Sem ele, toda bolha a um celular BR faz 1–2 GET ao WAHA antes do envio — uma
 * resposta do agente em 3 bolhas pergunta 3 vezes a mesma coisa em segundos.
 *
 * - Só o positivo entra: negativo ou falha exige consulta fresca na próxima tentativa;
 *   a conta pode ter sido criada depois da última consulta.
 * - A sessão na chave isola os tenants: `waha_session_name` é UNIQUE e cada
 *   `channel_sessions` pertence a uma organização.
 * - 10 min limita o quanto um `@lid` trocado no WhatsApp fica velho aqui.
 * - Nada disto vai para `source_metadata.waha_lid` — ver `lib/waha/send.ts`.
 */
export const TTL_DO_MEMO_CHECK_EXISTS_MS = 10 * 60_000;
export const TETO_DO_MEMO_CHECK_EXISTS = 5000;

const _memoCheckExists = new Map<string, { at: number; r: WahaCheckExistsResult }>();

/** Esvazia o memo. Usado pelos testes. */
export function limparMemoCheckExists(): void {
  _memoCheckExists.clear();
}

type ConsultaDeConta = {
  existe: boolean | null;
  conta: WahaCheckExistsResult | null;
};

async function consultarContaNoWhatsapp(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<ConsultaDeConta> {
  const chave = `${session}\u0000${phone.replace(/\D/g, "")}`;
  const memo = _memoCheckExists.get(chave);
  if (memo && Date.now() - memo.at < TTL_DO_MEMO_CHECK_EXISTS_MS)
    return { existe: true, conta: memo.r };

  const tried = new Set<string>();
  let falhou = false;
  for (const variant of phoneLookupVariants(phone)) {
    const digits = variant.replace(/\D/g, "");
    if (!digits || tried.has(digits)) continue;
    tried.add(digits);
    try {
      const r = await client.checkContactExists(session, digits);
      if (r.numberExists === true) {
        _memoCheckExists.delete(chave);
        if (_memoCheckExists.size >= TETO_DO_MEMO_CHECK_EXISTS)
          _memoCheckExists.delete(_memoCheckExists.keys().next().value!);
        _memoCheckExists.set(chave, { at: Date.now(), r });
        return { existe: true, conta: r };
      }
      // Resposta incompleta também é desconhecido, nunca um negativo definitivo.
      if (r.numberExists !== false) falhou = true;
    } catch {
      falhou = true;
    }
  }
  _memoCheckExists.delete(chave);
  return { existe: falhou || tried.size === 0 ? null : false, conta: null };
}

async function firstExistingOnWhatsapp(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<WahaCheckExistsResult | null> {
  return (await consultarContaNoWhatsapp(client, session, phone)).conta;
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

/**
 * O número tem conta no WhatsApp? Basta UMA grafia existir (o nono dígito no
 * Brasil). Diferente das funções acima, aqui FALHA não é "não": `false` só sai
 * quando TODAS as grafias foram respondidas e nenhuma existe; se alguma
 * consulta lançou e nenhuma existiu, a resposta é `null` ("não deu para
 * saber"). Compartilha o memo positivo com o envio: consultar antes de abrir
 * a conversa não duplica o check no envio. Negativos e falhas não são memorizados.
 */
export async function numeroTemContaNoWhatsapp(
  client: WahaClient,
  session: string,
  phone: string,
): Promise<boolean | null> {
  return (await consultarContaNoWhatsapp(client, session, phone)).existe;
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
  const resposta = await consultarContaNoWhatsapp(client, session, digits);
  if (resposta.existe === false) {
    throw new FalhaDeEnvioDoCanal(
      FRASES_DE_FALHA.numero_sem_whatsapp!,
      "permanente",
      undefined,
      "numero_sem_whatsapp",
    );
  }
  return (resposta.conta && sendChatIdFromCheckResult(resposta.conta)) || chatId;
}
