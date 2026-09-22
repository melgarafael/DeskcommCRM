/** Liga permite_estoque_negativo na org (vender sem estoque). */
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const org = process.argv[2] ?? "4bc721ce-157a-41b9-97ae-ba633650859c";
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
  const { data: ex } = await admin
    .from("commercial_policies")
    .select("id")
    .eq("organization_id", org)
    .maybeSingle();
  if (ex) {
    const { error } = await admin
      .from("commercial_policies")
      .update({ permite_estoque_negativo: true })
      .eq("organization_id", org);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await admin.from("commercial_policies").insert({
      organization_id: org,
      permite_estoque_negativo: true,
    });
    if (error) throw new Error(error.message);
  }
  // eslint-disable-next-line no-console
  console.log("estoque negativo LIGADO para", org);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
