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
    case "zernio_social":
      if (session.social_platform === "instagram") return "instagram";
      if (session.social_platform === "facebook") return "messenger";
      return "unknown";
    default:
      return "unknown";
  }
}
