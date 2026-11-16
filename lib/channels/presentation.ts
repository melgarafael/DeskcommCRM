/** Display identity belongs to the network, never to the transport vendor. */
export function channelBrand(
  session?: { provider?: string | null; social_platform?: string | null } | null,
) {
  switch (session?.provider) {
    case "waha":
    case "meta_cloud":
    case "zernio":
    case "datafy":
    case "wacalls":
      return "whatsapp";
    case "email":
    case "smtp":
      return "email";
    case "zernio_social":
      if (session.social_platform === "instagram") return "instagram";
      if (session.social_platform === "facebook") return "messenger";
      // O Telegram já está no catálogo de redes (`social/catalog.ts`) como porta
      // intermediada: sem esta linha, conversa dele cairia no genérico e o aviso
      // não teria como dizer de onde veio (#4094).
      if (session.social_platform === "telegram") return "telegram";
      return "unknown";
    default:
      return "unknown";
  }
}

/**
 * A origem que o AVISO da esquina nomeia (`#4094`).
 *
 * Mesma regra de `channelBrand` — a marca é da rede, não do fornecedor — com
 * UMA exceção declarada: o número conectado pela API oficial da Meta sai como
 * `api-oficial`. Para quem atende, "chegou pelo WhatsApp do meu chip" e
 * "chegou pela API oficial" são dois canos com donos e janelas diferentes, e o
 * aviso existe para dizer isso sem abrir a conversa. O logo da lista de
 * conversas continua na rede (`channelBrand`), porque ali o que se procura é
 * a conversa, não o cano.
 */
export function channelBrandDoAviso(
  session?: { provider?: string | null; social_platform?: string | null } | null,
) {
  const rede = channelBrand(session);
  if (rede === "whatsapp" && session?.provider === "meta_cloud") return "api-oficial";
  return rede;
}
