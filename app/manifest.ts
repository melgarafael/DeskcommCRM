import type { MetadataRoute } from "next";

import { coresDaBarraDoNavegador } from "@/lib/branding/barra-do-navegador";
import { sufixoDoIcone } from "@/lib/branding/icone";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { marcaDaSaida } from "@/lib/branding/saida";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";

// A imagem distribuída é construída sem a marca da instalação. Uma função
// async, sozinha, ainda pode ser prerenderizada com o nome de fallback do build.
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const marca = await marcaDaSaida(null);
  const linha = await marcaDaInstalacao();
  const versao = sufixoDoIcone(linha?.favicon_path);
  // A entrada clara da mesma régua da barra do navegador: o manifest não aceita
  // media query, então não há como declarar o tema escuro aqui.
  const cor = coresDaBarraDoNavegador(REGUA_DO_PRODUTO)[0]?.color;
  // A instalação não tem idioma próprio: o do aparelho que pede (Accept-Language).
  const idioma = await idiomaDoVisitante(null);
  return {
    // Igual ao start_url de sempre: quem já instalou mantém o mesmo app.
    id: "/app",
    name: marca.nome,
    short_name: marca.nome,
    description: traduzir("Atendimento e vendas pelo WhatsApp, também no celular.", idioma),
    display: "standalone",
    start_url: "/app",
    scope: "/",
    ...(cor ? { background_color: cor, theme_color: cor } : {}),
    icons: [
      { src: `/app-icon/192${versao}`, sizes: "192x192", type: "image/png" },
      { src: `/app-icon/512${versao}`, sizes: "512x512", type: "image/png" },
      { src: `/app-icon/maskable${versao}`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
