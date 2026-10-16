import type { MetadataRoute } from "next";

import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { marcaDaSaida } from "@/lib/branding/saida";

// A imagem distribuída é construída sem a marca da instalação. Uma função
// async, sozinha, ainda pode ser prerenderizada com o nome de fallback do build.
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const marca = await marcaDaSaida(null);
  const linha = await marcaDaInstalacao();
  const versao = linha?.favicon_path ? `?v=${encodeURIComponent(linha.favicon_path)}` : "";
  return {
    name: marca.nome,
    short_name: marca.nome,
    display: "standalone",
    start_url: "/app",
    background_color: "#faf9f6",
    theme_color: "#ffffff",
    orientation: "any",
    categories: ["business", "productivity"],
    icons: [
      { src: `/app-icon/192${versao}`, sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: `/app-icon/512${versao}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Inbox",
        short_name: "Inbox",
        url: "/app/inbox",
        icons: [{ src: `/app-icon/192${versao}`, sizes: "192x192" }],
      },
      {
        name: "Funis",
        short_name: "Funis",
        url: "/app/kanban",
        icons: [{ src: `/app-icon/192${versao}`, sizes: "192x192" }],
      },
    ],
  };
}
