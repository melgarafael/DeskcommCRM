/** Sonda variantes de consulta nos que falharam. Uso: pnpm exec tsx scripts/mercos-scrape/sondar-variantes.ts */
const CASOS: { rua: string; num: string | null; cidade: string; uf: string }[] = [
  { rua: "RUA DUQUE DE CAXIAS", num: "969", cidade: "CANOINHAS", uf: "SC" },
  { rua: "R GETULIO VARGAS", num: "805", cidade: "Canoinhas", uf: "SC" },
  { rua: "RUA EXPEDICIONARIO", num: "766", cidade: "Canoinhas", uf: "SC" },
  { rua: "rua major vieira", num: "569", cidade: "canoinhas", uf: "SC" },
  { rua: "R CEL ALBUQUERQUE", num: "268 sala03", cidade: "Canoinhas", uf: "SC" },
  { rua: "R ALINOR VIEIRA CORTE", num: "765", cidade: "CANOINHAS", uf: "SC" },
  { rua: "RUA OROCIMBO CAETANO DA SILVA", num: "65", cidade: "Curitibanos", uf: "SC" },
  { rua: "SENADOR FELIPE SCHIMIDT", num: "658", cidade: "Canoinhas", uf: "SC" },
];

function expandir(s: string): string {
  return s
    .replace(/\bR\b\.?/g, "Rua")
    .replace(/\bAV\.?\b/gi, "Avenida")
    .replace(/\bCEL\.?\b/gi, "Coronel")
    .replace(/\bROD\.?\b/gi, "Rodovia")
    .replace(/\s+/g, " ")
    .trim();
}

function soNumero(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/\d+/);
  return m ? m[0] : null;
}

async function buscar(q: string): Promise<string> {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=3&countrycodes=br&addressdetails=1`,
    { headers: { "User-Agent": "DeskcommCRM-Rotas/1.0" } },
  );
  const j = (await r.json()) as { lat?: string; lon?: string; address?: { road?: string; house_number?: string } }[];
  if (!j?.length) return "ZERO";
  return j
    .map((x) => `${x.lat},${x.lon} road=${x.address?.road ?? "?"} num=${x.address?.house_number ?? "-"}`)
    .join(" | ");
}

async function main(): Promise<void> {
  for (const c of CASOS) {
    const num = soNumero(c.num);
    const variantes: [string, string][] = [
      ["atual", `${c.rua}, ${c.num}, ${c.cidade}, ${c.uf}, Brasil`],
      ["sem-num", `${c.rua}, ${c.cidade}, ${c.uf}, Brasil`],
      ["expandida", `${expandir(c.rua)}, ${num ?? ""}, ${c.cidade}, ${c.uf}, Brasil`],
      ["expandida-sem-num", `${expandir(c.rua)}, ${c.cidade}, ${c.uf}, Brasil`],
    ];
    for (const [nome, q] of variantes) {
      const r = await buscar(q);
      // eslint-disable-next-line no-console
      console.log(`${c.rua} [${nome}] => ${r.slice(0, 160)}`);
      await new Promise((r2) => setTimeout(r2, 1200));
    }
    // eslint-disable-next-line no-console
    console.log("---");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
