/** Sincroniza o contador de pedidos com o maior número existente (pós-import). */
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const org = process.argv[2] ?? "4bc721ce-157a-41b9-97ae-ba633650859c";
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });

  // Maior número atual (paginado: limite de 1000 do PostgREST).
  let max = 0;
  for (let de = 0; ; de += 1000) {
    const { data, error } = await admin
      .from("commercial_orders")
      .select("numero")
      .eq("organization_id", org)
      .order("numero", { ascending: false })
      .range(de, de + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { numero: number }[]) {
      if (r.numero > max) max = r.numero;
    }
    if (data.length < 1000) break;
  }

  // O PED-0001 órfão da duplicação vira o próximo da sequência.
  const { data: orfao } = await admin
    .from("commercial_orders")
    .select("id")
    .eq("organization_id", org)
    .eq("numero", 1)
    .maybeSingle();
  let proximo = max;
  if (orfao) {
    proximo = max + 1;
    const { error } = await admin
      .from("commercial_orders")
      .update({ numero: proximo })
      .eq("id", (orfao as { id: string }).id);
    if (error) throw new Error(error.message);
  }

  const { error: eUp } = await admin.from("commercial_order_counters").upsert(
    { organization_id: org, ultimo_numero: proximo },
    { onConflict: "organization_id" },
  );
  if (eUp) throw new Error(eUp.message);
  // eslint-disable-next-line no-console
  console.log(`contador sincronizado em ${proximo}${orfao ? " (órfão renumerado)" : ""}`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
