/**
 * Cartão de contato compartilhado (vCard) — a parte AGNÓSTICA.
 *
 * vCard é formato, não provider: montar e ler o cartão vale para qualquer
 * transporte. O PAYLOAD de cada canal, esse sim, mora na pasta do canal dele —
 * procure por `contact-card.ts` dentro das pastas de canal. Nomear provider
 * fora delas é o que o invariante 1 da doutrina de restrição de canal proíbe, e
 * o `pnpm lint:channels` reprova.
 */

export interface SharedContact {
  contact_id?: string;
  name: string;
  phone_number: string;
}

const VCARD_FN = /^FN:(.+)$/m;
const VCARD_TEL = /^(?:[\w-]+\.)?TEL[^:]*:(.+)$/mi;

/** Extrai nome e telefone de um vCard em texto (mensagem inbound). */
export function parseVcard(body: string | null | undefined): SharedContact | null {
  if (!body?.includes("BEGIN:VCARD")) return null;
  const name = body.match(VCARD_FN)?.[1]?.trim() ?? null;
  const telRaw = body.match(VCARD_TEL)?.[1]?.trim() ?? null;
  if (!name && !telRaw) return null;
  const phone = telRaw ? normalizePhoneForDisplay(telRaw) : "";
  if (!name && !phone) return null;
  return { name: name ?? phone, phone_number: phone || telRaw! };
}

/** Lê o contato que nós mesmos gravamos em metadata ao enviar. */
export function sharedContactFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SharedContact | null {
  const raw = metadata?.shared_contact;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const phone = typeof o.phone_number === "string" ? o.phone_number.trim() : "";
  if (!name && !phone) return null;
  return {
    contact_id: typeof o.contact_id === "string" ? o.contact_id : undefined,
    name: name || phone,
    phone_number: phone,
  };
}

/** Resolve o contato exibível: metadata (outbound) → parse vcard (inbound) → body como nome. */
export function resolveSharedContact(
  message: { type: string; body: string | null; metadata: Record<string, unknown> },
): SharedContact | null {
  if (message.type !== "contact") return null;
  const fromMeta = sharedContactFromMetadata(message.metadata);
  if (fromMeta) return fromMeta;
  const fromVcard = parseVcard(message.body);
  if (fromVcard) return fromVcard;
  if (message.body?.trim() && !message.body.includes("BEGIN:VCARD")) {
    return { name: message.body.trim(), phone_number: "" };
  }
  return null;
}

/** Extrai telefone discável (E.164 com +) de texto livre; null se inválido. */
export function parseDialablePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = phoneToWhatsappId(trimmed);
  if (digits.length < 8 || digits.length > 15) return null;
  return normalizePhoneForDisplay(trimmed.startsWith("+") ? trimmed : `+${digits}`);
}

/** Só dígitos: é assim que os transportes endereçam o número. */
export function phoneToWhatsappId(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Exibição legível; preserva + quando já E.164. */
export function normalizePhoneForDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = phoneToWhatsappId(trimmed);
  return digits.length >= 8 ? `+${digits}` : trimmed;
}

/** Monta um vCard mínimo — o formato que os transportes aceitam no envio. */
export function buildVcard(name: string, phone: string, whatsappId?: string): string {
  const waid = whatsappId ?? phoneToWhatsappId(normalizePhoneForDisplay(phone));
  const telDisplay = whatsappId ? `+${waid}` : normalizePhoneForDisplay(phone);
  const safeName = name.replace(/\n/g, " ").trim() || telDisplay;
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${safeName}`,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${telDisplay}`,
    "END:VCARD",
  ].join("\n");
}
