/** Lista organizações (para escolher o --org do importador). */
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.from("organizations").select("id, display_name, legal_name, slug");
  if (error) throw new Error(error.message);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 1));
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
