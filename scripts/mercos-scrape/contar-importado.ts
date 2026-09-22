/** Conta o já importado (progresso real no banco). */
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const org = process.argv[2] ?? "4bc721ce-157a-41b9-97ae-ba633650859c";
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
  const [prods, conts, ords, itens] = await Promise.all([
    admin.from("catalog_products").select("id", { count: "exact", head: true }).eq("organization_id", org),
    admin.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", org),
    admin.from("commercial_orders").select("id", { count: "exact", head: true }).eq("organization_id", org),
    admin.from("commercial_order_items").select("id", { count: "exact", head: true }).eq("organization_id", org),
  ]);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ produtos: prods.count, contatos: conts.count, pedidos: ords.count, itens: itens.count }));
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
