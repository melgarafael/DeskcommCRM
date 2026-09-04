/**
 * CONFIG CENTRAL DE CAMPANHA → elegibilidade da IA.
 *
 * O caso 2 da elegibilidade: campanhas de Meta/Google que levam direto para o
 * WhatsApp. O lead chega com uma mensagem identificadora ("Quero saber mais
 * sobre marketing para incorporadoras"). A IA só assume se a mensagem
 * corresponder a uma campanha explicitamente registrada.
 *
 * ─── Nada de frase hardcoded no código ──────────────────────────────────────
 *
 * A lista vive em `organizations.settings.campanhas_whatsapp` (jsonb) — o dono
 * registra origem → condição → agente → segmento pela configuração, não por
 * deploy. Este arquivo só valida o formato e casa uma mensagem contra a lista.
 *
 * ─── O match é conservador ──────────────────────────────────────────────────
 *
 * `contains` (substring, case/acento-insensível) e `starts_with`. Sem regex de
 * usuário: uma regex mal-escrita na config viraria ReDoS no caminho de ingestão
 * de toda mensagem. Se um dia precisar, entra como tipo novo com timeout.
 * A condição é comparada com a mensagem inteira normalizada; o dono escolhe uma
 * frase específica o suficiente para não colidir com conversa comum.
 */
import { z } from "zod";

export const CAMPANHA_MATCH_TIPOS = ["contains", "starts_with"] as const;

export const campanhaWhatsappSchema = z.object({
  /** id estável da campanha — entra em `ai_authorized_reason` como `campanha:<id>`. */
  id: z.string().min(1).max(64),
  /** rótulo legível para a tela (a tela ainda não existe — hoje só documenta a config). */
  label: z.string().min(1).max(120).optional(),
  match: z.object({
    tipo: z.enum(CAMPANHA_MATCH_TIPOS),
    /** a frase/prefixo identificador da campanha. */
    valor: z.string().min(3).max(400),
  }),
  /**
   * RESERVADO — ainda NÃO roteado. O match de campanha só torna o contato
   * elegível (`ai_authorized_reason = campanha:<id>`); quem assume o turno é
   * sempre o roteador / agente publicado da sessão (`resolve-turn-agent.ts`).
   * Encaminhar por campanha exige levar o `agent_id` no payload do
   * `ai_agent.dispatch_requested` e o `resolve-turn-agent` respeitá-lo — não
   * feito nesta entrega. Aceito no schema para a config não quebrar quando a
   * rota existir. Ver J20 (dívida declarada) no user-journey-map.
   */
  agent_id: z.string().uuid().optional(),
  /** segmento/nicho, só para contexto e exibição (mesma pendência de tela do `label`). */
  segmento: z.string().min(1).max(64).optional(),
  /** limita a campanha a um canal específico; ausente = qualquer canal da org. */
  channel_session_id: z.string().uuid().optional(),
});
export type CampanhaWhatsapp = z.infer<typeof campanhaWhatsappSchema>;

/**
 * Lê a lista tolerando item malformado: um objeto inválido é DESCARTADO, não
 * derruba os demais (`z.array().catch([])` zeraria tudo por causa de um só). A
 * lista inteira só vira `[]` quando o valor cru nem é um array.
 */
export function parseCampanhas(raw: unknown): CampanhaWhatsapp[] {
  if (!Array.isArray(raw)) return [];
  const out: CampanhaWhatsapp[] = [];
  for (const item of raw.slice(0, 100)) {
    const parsed = campanhaWhatsappSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Normaliza para comparar: minúsculas, sem acento, espaços colapsados. A mesma
 * normalização dos dois lados (mensagem e `match.valor`).
 */
export function normalizarParaMatch(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A primeira campanha cuja condição casa a mensagem, ou `null`. `channelSessionId`
 * filtra campanhas presas a outro canal.
 */
export function casarCampanha(
  texto: string | null,
  campanhas: CampanhaWhatsapp[],
  channelSessionId: string,
): CampanhaWhatsapp | null {
  if (!texto || texto.trim() === "") return null;
  const alvo = normalizarParaMatch(texto);
  if (alvo === "") return null;

  for (const c of campanhas) {
    if (c.channel_session_id !== undefined && c.channel_session_id !== channelSessionId) continue;
    const valor = normalizarParaMatch(c.match.valor);
    if (valor === "") continue;
    const casa = c.match.tipo === "starts_with" ? alvo.startsWith(valor) : alvo.includes(valor);
    if (casa) return c;
  }
  return null;
}

/** Lê e valida a lista do `organizations.settings` (jsonb cru). */
export function lerCampanhas(settings: unknown): CampanhaWhatsapp[] {
  const raw =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>).campanhas_whatsapp
      : undefined;
  return parseCampanhas(raw);
}
