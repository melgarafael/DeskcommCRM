/**
 * Sonda a taxa de acerto da geocodificação numa amostra real de contatos.
 * Uso: pnpm exec tsx scripts/mercos-scrape/sondar-geocode-amostra.ts --org <uuid> [--n 30]
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { geocodificarComFallback } from "../../lib/rotas/geocodificacao";
import { carregarEnvLocal } from "../lib/env-de-teste";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--org");
  const orgId = i >= 0 ? process.argv[i + 1] : null;
  if (!orgId) throw new Error("Passe --org <uuid>.");
  const n = Number(process.argv[process.argv.indexOf("--n") + 1] ?? 30) || 30;

  const env = carregarEnvLocal();
  const admin: SupabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await admin
    .from("contacts")
    .select("logradouro, numero_end, bairro, cidade, uf")
    .eq("organization_id", orgId)
    .not("logradouro", "is", null)
    .not("cidade", "is", null)
    .limit(1000);  const base = ((data ?? []) as Record<string, string | null>[]).filter((c) => c.logradouro?.trim() && c.cidade?.trim());
  // Embaralha e pega N (amostra honesta, não os 30 primeiros).
  for (let k = base.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [base[k], base[j]] = [base[j]!, base[k]!];
  }
  const conta: Record<string, number> = {};
  for (const c of base.slice(0, n)) {
    const r = await geocodificarComFallback({
      logradouro: c.logradouro,
      numero_end: c.numero_end,
      bairro: c.bairro,
      cidade: c.cidade,
      uf: c.uf,
    });
    const chave = `${r.estado}${r.precisao ? `:${r.precisao}` : ""}`;
    conta[chave] = (conta[chave] ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.log(chave, "|", [c.logradouro, c.numero_end, c.cidade, c.uf].filter(Boolean).join(" | "));
  }
  // eslint-disable-next-line no-console
  console.log("RESUMO:", JSON.stringify(conta));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
