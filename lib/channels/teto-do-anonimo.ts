/**
 * TETO DE RESPOSTAS DA IA PARA VISITANTE ANÔNIMO — seam de canais (F4, Task 1).
 *
 * ## O defeito que este arquivo fecha
 *
 * Um visitante anônimo do chat no site (sem telefone nem e-mail) podia fazer a IA
 * responder quantas vezes quisesse: o teto existente (`teto-de-respostas.ts`) conta
 * respostas por conversa, mas era armado somente pelo turno de entrada. O gate de
 * elegibilidade (`lib/ai/elegibilidade/gate.ts`) é o "deny by default" que decide se
 * a IA responde — é nele que o teto do anônimo deve viver para valer para todos os
 * consumidores (drain e turno).
 *
 * ## Quem sabe se o canal tem teto e quanto vale
 *
 * Apenas o seam de canais (`lib/channels/`) conhece provedor e configuração. O gate e
 * os loaders NÃO nomeiam provedor (`pnpm lint:channels` vigia até comentário): eles
 * perguntam ao seam pelo `tetoDoAnonimoDoCanal(provider, metadata)`.
 *
 * - `null` = o canal não declara teto de anônimo (não se aplica; outros provedores).
 * - número de 1 a 200 = o teto. Ausente/inválido/fora de 1–200 → padrão 20 (nunca
 *   "sem teto": um valor digitado à mão não pode calar o atendimento por acidente).
 */
const PROVIDER_DO_CHAT = "webchat";

/** Padrão quando a configuração está ausente ou inválida. */
export const TETO_ANONIMO_PADRAO = 20;

/** Teto máximo aceito. Acima disso cai no padrão (não vira "sem teto"). */
export const TETO_ANONIMO_MAXIMO = 200;

function objetoJson(valor: unknown): Record<string, unknown> | null {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

/**
 * Lê o teto do anônimo da configuração do canal.
 *
 * @param provider — `channel_sessions.provider` (ex.: `webchat`, `whatsapp`…).
 * @param metadata — `channel_sessions.metadata` cru do banco.
 * @returns `null` quando o canal não tem teto de anônimo; o número efetivo (1–200)
 *   quando tem. O padrão 20 vale para ausência/invalidez — nunca `null` por causa
 *   de um valor digitado à mão.
 */
export function tetoDoAnonimoDoCanal(provider: string, metadata: unknown): number | null {
  if (provider !== PROVIDER_DO_CHAT) return null;
  const bruto = objetoJson(objetoJson(metadata)?.webchat)?.teto_anonimo;
  const n =
    typeof bruto === "number" ? bruto : typeof bruto === "string" ? Number(bruto) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > TETO_ANONIMO_MAXIMO) return TETO_ANONIMO_PADRAO;
  return n;
}
