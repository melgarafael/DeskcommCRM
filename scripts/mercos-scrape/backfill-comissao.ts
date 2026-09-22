/**
 * Backfill de comissao_pct a partir do scrap (produtos-pag-*.json).
 *
 * Exige a migration 0226 aplicada. Idempotente: só atualiza onde mudou.
 * Uso: pnpm exec tsx scripts/mercos-scrape/backfill-comissao.ts --org <uuid> [--apply]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { carregarEnvLocal } from "../lib/env-de-teste";

const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

function pct(txt: string): number | null {
  const m = (txt ?? "").match(/([\d.,]+)\s*%/);
  if (!m) return null;
  const v = Number(m[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v * 100) / 100;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const orgId = i >= 0 ? process.argv[i + 1] : null;
  if (!orgId) throw new Error("Passe --org <uuid>.");
  const apply = process.argv.includes("--apply");

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const regras = new Map<string, number>();
  for (const arq of readdirSync(SAIDA).filter((f) => /^produtos-pag-\d+\.json$/.test(f))) {
    const dados = (JSON.parse(readFileSync(join(SAIDA, arq), "utf8")) as {
      dados: { linhas: { codigo: string; nome: string; comissao: string }[] };
    }).dados;
    for (const l of dados.linhas) {
      const codigo = l.codigo || l.nome.slice(0, 60);
      const p = pct(l.comissao);
      if (p != null && !regras.has(codigo)) regras.set(codigo, p);
    }
  }

  let comRegra = 0;
  let atualizados = 0;
  for (const [codigo, p] of regras) {
    comRegra++;
    if (!apply) continue;
    const { error } = await admin
      .from("catalog_products")
      .update({ comissao_pct: p })
      .eq("organization_id", orgId)
      .eq("codigo", codigo);
    if (!error) atualizados++;
  }
  // eslint-disable-next-line no-console
  console.log(`comissao: ${regras.size} produtos com regra no scrap, ${comRegra} considerados, ${atualizados} atualizados${apply ? "" : " (dry-run)"}`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
