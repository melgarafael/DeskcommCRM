/**
 * Sonda ao vivo do roteirizador: Nominatim + OSRM trip com endereços reais
 * da base (Canoinhas/SC). Uso: pnpm exec tsx scripts/mercos-scrape/sondar-rota.ts
 */
import { geocodificarEndereco } from "../../lib/rotas/geocodificacao";
import { otimizarComFallback, OsmrmProvider } from "../../lib/rotas/osrm";

async function main(): Promise<void> {
  const enderecos = [
    "Rua Caetano Costa, 425, Centro, Canoinhas, SC",
    "Rua Francisco de Paula Pereira, 147, Centro, Canoinhas, SC",
    "Rua Antônio Liller, 585, Canoinhas, SC",
  ];
  const pontos: { lat: number; lng: number }[] = [];
  for (const e of enderecos) {
    const r = await geocodificarEndereco(e);
    // eslint-disable-next-line no-console
    console.log(e, "=>", JSON.stringify(r));
    if (r.estado === "ok" && r.latitude != null && r.longitude != null) {
      pontos.push({ lat: r.latitude, lng: r.longitude });
    }
  }
  if (pontos.length >= 2) {
    const prop = await otimizarComFallback(new OsmrmProvider(), pontos, true);
    // eslint-disable-next-line no-console
    console.log("trip:", JSON.stringify({ ...prop, geometria: `${prop.geometria.length} pts` }));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
