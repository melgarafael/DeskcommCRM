/** Profile das etapas do dashboard (acha os 10s). */
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../lib/env-de-teste";

const ORG = "4bc721ce-157a-41b9-97ae-ba633650859c";

async function main(): Promise<void> {
  const env = carregarEnvLocal();
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
  const t = async (nome: string, fn: () => Promise<unknown>): Promise<void> => {
    const t0 = Date.now();
    await fn();
    // eslint-disable-next-line no-console
    console.log(`${nome}: ${Date.now() - t0}ms`);
  };

  await t("janela", async () => {
    const { carregarJanelaDeVendas } = await import("../../lib/comercial/janela");
    await carregarJanelaDeVendas(admin, ORG, "2025-08-01");
  });
  await t("metas+membros+count", async () => {
    await Promise.all([
      admin.from("commercial_goals").select("vendedor_user_id, valor_cents, ano_mes").eq("organization_id", ORG),
      admin.from("user_organizations").select("user_id").eq("organization_id", ORG).limit(50),
      admin.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", ORG),
    ]);
  });
  const { data: membros } = await admin.from("user_organizations").select("user_id").eq("organization_id", ORG).limit(50);
  const ids = ((membros ?? []) as { user_id: string }[]).map((m) => m.user_id);
  // eslint-disable-next-line no-console
  console.log("membros:", ids.length);
  await t(`nomes(${ids.length}x getUserById)`, async () => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await admin.auth.admin.getUserById(id);
        } catch {
          /* ignora */
        }
      }),
    );
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
