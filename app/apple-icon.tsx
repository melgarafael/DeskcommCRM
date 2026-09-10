import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

import { letraDoIcone } from "@/lib/branding/icone";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * `apple-touch-icon` — mesmo par bundled/fallback de `app/icon.tsx` (ver o
 * comentário lá para o porquê de ler do disco e nunca de `logo_url`). Tamanho
 * 180×180 é o que a Apple documenta para o ícone de tela de início mais nítido
 * em telas retina atuais; navegadores/OS pedem este arquivo em `/apple-icon`
 * independente do `<link rel="icon">` normal.
 */
const ICONE_BUNDLED = path.join(process.cwd(), "public", "branding", "verta-icon-180.png");

export const dynamic = "force-dynamic";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  try {
    const bytes = await readFile(ICONE_BUNDLED);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    });
  } catch {
    // Sem arquivo bundled — mesmo fallback de cor + inicial do `icon.tsx`.
  }

  const marca = await marcaDaSaida(null);
  const letra = letraDoIcone(marca.nome);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: marca.accent,
          color: marca.accentFg,
          fontSize: Math.round(size.height * 0.62),
          borderRadius: 0,
        }}
      >
        {letra ?? ""}
      </div>
    ),
    {
      ...size,
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
