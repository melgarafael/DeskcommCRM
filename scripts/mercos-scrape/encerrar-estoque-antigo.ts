/**
 * Encerra o estoque antigo: pedidos já importados do Mercos com status
 * aprovado/faturado viram ENTREGUE (ciclo encerrado) — uma vez só.
 *
 * Orçamentos (rascunho) NÃO são tocados: virariam venda falsa. Novos pedidos
 * seguem o fluxo normal (nada aqui muda regra de importação).
 *
 * Uso: pnpm exec tsx scripts/mercos-scrape/encerrar-estoque-antigo.ts --org <uuid> [--apply]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const orgId = i >= 0 ? process.argv[i + 1] : null;
  if (!orgId) throw new Error("Passe --org <uuid>.");
  const apply = process.argv.includes("--apply");

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Sem .range() o Supabase devolve no máximo 1000 — pagina tudo.
  const ids: string[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("commercial_orders")
      .select("id")
      .eq("organization_id", orgId)
      .eq("origem", "mercos")
      .in("status", ["aprovado", "faturado"])
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { id: string }[]) ids.push(r.id);
    if (data.length < 1000) break;
  }
  // eslint-disable-next-line no-console
  console.log(`estoque: ${ids.length} pedidos aprovado/faturado para entregue${apply ? "" : " (dry-run)"}`);
  if (!apply || ids.length === 0) return;

  const LOTE = 500;
  let ok = 0;
  for (let k = 0; k < ids.length; k += LOTE) {
    const { error: eUp } = await admin
      .from("commercial_orders")
      .update({ status: "entregue" })
      .eq("organization_id", orgId)
      .in("id", ids.slice(k, k + LOTE));
    if (eUp) throw new Error(eUp.message);
    ok += Math.min(LOTE, ids.length - k);
    // eslint-disable-next-line no-console
    console.log(`encerrados ${ok}/${ids.length}`);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
