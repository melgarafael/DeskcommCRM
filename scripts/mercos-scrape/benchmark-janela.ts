/** Benchmark: janela sequencial x paralela (prova da melhora). */
import { createClient } from "@supabase/supabase-js";

import { carregarJanelaDeVendas } from "../../lib/comercial/janela";
import { carregarEnvLocal } from "../lib/env-de-teste";

const ORG = "4bc721ce-157a-41b9-97ae-ba633650859c";

async function main(): Promise<void> {
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });

  let t0 = Date.now();
  let n = 0;
  for (let de = 0; de < 25000; de += 1000) {
    const { data } = await admin
      .from("commercial_orders")
      .select("id")
      .eq("organization_id", ORG)
      .not("status", "in", "(rascunho,cancelado)")
      .order("created_at", { ascending: true })
      .range(de, de + 999);
    if (!data || data.length === 0) break;
    n += data.length;
    if (data.length < 1000) break;
  }
  // eslint-disable-next-line no-console
  console.log(`sequencial: ${n} linhas em ${Date.now() - t0}ms`);

  t0 = Date.now();
  const r = await carregarJanelaDeVendas(admin, ORG, "2025-08-01");
  // eslint-disable-next-line no-console
  console.log(`paralela: ${r.linhas.length} linhas em ${Date.now() - t0}ms`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
