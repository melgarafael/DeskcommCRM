import { ImageResponse } from "next/og";

import { marcaEhADoProduto } from "@/lib/branding";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { letraDoIcone } from "@/lib/branding/icone";
import { marcaDaSaida } from "@/lib/branding/saida";

/** Local supplied artwork only: never fetch a configured URL from the icon route. */
export const dynamic = "force-dynamic";

/** 64 e não 32: a aba pede 16-32 CSS px, e em tela retina isso são 32-64 reais. */
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default async function Icon() {
  const marca = await marcaDaSaida(null);

  if (marcaEhADoProduto({ name: marca.nome, logoUrl: marca.logoUrl })) {
    const artwork = await readFile(path.join(process.cwd(), "public/brand/escreve-ai.png"));
    return new ImageResponse(
      <div
        style={{ width: 64, height: 64, display: "flex", overflow: "hidden", position: "relative" }}
      >
        {/* The viewport isolates the left symbol, without redrawing the uploaded logo. */}
        <img
          alt=""
          src={`data:image/png;base64,${artwork.toString("base64")}`}
          width={(2161 * 64) / 410}
          height={(728 * 64) / 410}
          style={{ position: "absolute", left: (-140 * 64) / 410, top: (-155 * 64) / 410 }}
        />
      </div>,
      { ...size, headers: CACHE },
    );
  }

  const letra = letraDoIcone(marca.nome);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: marca.accent,
        color: marca.accentFg,
        // 62% da altura: a caixa maiúscula do Geist ocupa ~72% do em, então
        // a letra fica com respiro sem virar um selo minúsculo no meio.
        fontSize: Math.round(size.height * 0.62),
        // O ladrilho é quadrado e cheio: o navegador já arredonda o favicon
        // no chrome dele, e arredondar aqui também produz canto duplo.
        borderRadius: 0,
      }}
    >
      {letra ?? ""}
    </div>,
    { ...size, headers: CACHE },
  );
}

// 60s é deliberado, e o par com o TTL da marca: o operador que troca a cor em
// `/admin/marca` vê a aba acompanhar dentro de um minuto. Um `immutable` de um
// ano tornaria a tela de marca uma promessa que o ícone não cumpre; `no-store`
// faria o satori rodar a cada navegação.
const CACHE = { "cache-control": "public, max-age=60, stale-while-revalidate=600" };
