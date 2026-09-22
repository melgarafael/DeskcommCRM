/**
 * Importa as fotos do Mercos para o catálogo (fase 8).
 *
 * Lê produtos-pag-*.json (codigo → foto), baixa cada URL única, sobe para o
 * bucket `product-images` e registra em `product_images` (posicao 0).
 * Pula produto que já tem foto e foto maior que 2 MB (teto da rota).
 * Idempotente: rerun só tenta o que falta.
 *
 * Uso: pnpm exec tsx scripts/mercos-scrape/importar-fotos.ts --org <uuid> [--apply] [--limite N]
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { carregarEnvLocal } from "../lib/env-de-teste";

const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");
const MAX_BYTES = 2 * 1024 * 1024;

function tipoDe(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  return null;
}

async function baixar(url: string): Promise<Uint8Array | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    return tipoDe(buf) ? buf : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const orgId = i >= 0 ? process.argv[i + 1] : null;
  if (!orgId) throw new Error("Passe --org <uuid>.");
  const apply = process.argv.includes("--apply");
  const li = process.argv.indexOf("--limite");
  const limite = li >= 0 ? Number(process.argv[li + 1]) : 1000000;

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // codigo → foto (primeira URL por produto).
  const mapa = new Map<string, string>();
  for (const arq of readdirSync(SAIDA).filter((f) => /^produtos-pag-\d+\.json$/.test(f))) {
    const dados = (JSON.parse(readFileSync(join(SAIDA, arq), "utf8")) as {
      dados: { linhas: { codigo: string; nome: string; foto?: string }[] };
    }).dados;
    for (const l of dados.linhas) {
      const codigo = l.codigo || l.nome.slice(0, 60);
      if (l.nome && l.foto && !mapa.has(codigo)) mapa.set(codigo, l.foto);
    }
  }

  // Produtos da org + quem já tem foto.
  const prodPorCodigo = new Map<string, string>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("catalog_products")
      .select("id, codigo")
      .eq("organization_id", orgId)
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const p of data as { id: string; codigo: string }[]) prodPorCodigo.set(p.codigo, p.id);
    if (data.length < 1000) break;
  }
  const comFoto = new Set<string>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("product_images")
      .select("product_id")
      .eq("organization_id", orgId)
      .range(de, de + 999);
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data as { product_id: string }[]) comFoto.add(r.product_id);
    if (data.length < 1000) break;
  }

  const fila = [...mapa.entries()].filter(([codigo]) => {
    const id = prodPorCodigo.get(codigo);
    return id && !comFoto.has(id);
  }).slice(0, limite);

  const relatorio = { total: mapa.size, fila: fila.length, baixadas: 0, gravadas: 0, puladas: 0, erros: [] as string[] };
  const PARALELO = 5;
  let idx = 0;
  async function operario(): Promise<void> {
    for (;;) {
      const item = fila[idx++];
      if (!item) break;
      const [codigo, url] = item;
      const productId = prodPorCodigo.get(codigo) as string;
      const bytes = await baixar(url);
      if (!bytes) {
        relatorio.puladas++;
        continue;
      }
      relatorio.baixadas++;
      if (!apply) continue;
      const ext = tipoDe(bytes) as string;
      const caminho = `${orgId}/${productId}/${randomUUID()}.${ext}`;
      const { error: eUp } = await admin.storage.from("product-images").upload(caminho, bytes, {
        contentType: ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp",
        upsert: false,
      });
      if (eUp) {
        relatorio.erros.push(`${codigo}: upload ${eUp.message.slice(0, 80)}`);
        continue;
      }
      const { error: eIns } = await admin.from("product_images").insert({
        organization_id: orgId,
        product_id: productId,
        storage_path: caminho,
        posicao: 0,
      });
      if (eIns) {
        await admin.storage.from("product-images").remove([caminho]);
        relatorio.erros.push(`${codigo}: insert ${eIns.message.slice(0, 80)}`);
        continue;
      }
      relatorio.gravadas++;
      if (relatorio.gravadas % 50 === 0) {
        // eslint-disable-next-line no-console
        console.log(`fotos: ${relatorio.gravadas}/${fila.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALELO, fila.length) }, () => operario()));

  mkdirSync(SAIDA, { recursive: true });
  writeFileSync(join(SAIDA, "fotos-resumo.json"), JSON.stringify({ ...relatorio, dryRun: !apply }, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log(`fotos: ${relatorio.gravadas} gravadas, ${relatorio.puladas} puladas, ${relatorio.erros.length} erros${apply ? "" : " (dry-run)"}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
