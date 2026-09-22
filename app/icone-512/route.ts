import { ImageResponse } from "next/og";
import React from "react";

import { letraDoIcone } from "@/lib/branding/icone";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * O ÍCONE GRANDE DO PWA (`/icone-512`, 512×512).
 *
 * O `/icon` (64px) não serve para instalação (o navegador exige ≥144px).
 * Mesmo desenho, mesma marca em runtime — nunca PNG estático, pela mesma
 * razão do `app/icon.tsx`: a imagem é única para todas as instalações.
 *
 * Sem JSX de propósito: rota (`route.ts`) não passa pelo transform JSX.
 */

export const dynamic = "force-dynamic";

const TAMANHO = 512;

export async function GET(): Promise<Response> {
  const marca = await marcaDaSaida(null);
  const letra = letraDoIcone(marca.nome);

  return new ImageResponse(
    React.createElement(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: marca.accent,
          color: marca.accentFg,
          fontSize: Math.round(TAMANHO * 0.62),
          borderRadius: 0,
        },
      },
      letra ?? "",
    ),
    {
      width: TAMANHO,
      height: TAMANHO,
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
