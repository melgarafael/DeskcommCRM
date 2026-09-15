/**
 * Spike: roda `syncTemplates` contra a WABA REAL e imprime o espelho resultante.
 * Instrumento de prova da Fase 3a Task 3/4, não teste automatizado.
 *
 *   pnpm exec tsx --env-file=.env.local scripts/spike-sync-templates.ts
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { graphVersion } from "@/lib/graph-version";
import { syncTemplates } from "@/lib/channels/meta/template-sync";

async function main() {
  const db = createAdminClient();

  const { data: sessao, error } = await db
    .from("channel_sessions")
    .select("organization_id, meta_waba_id")
    .eq("provider", "meta_cloud")
    .maybeSingle();

  if (error || !sessao?.meta_waba_id) {
    throw new Error(`sem sessão meta_cloud no banco: ${error?.message ?? "nenhuma linha"}`);
  }

  const counts = await syncTemplates({
    organizationId: sessao.organization_id,
    wabaId: sessao.meta_waba_id,
    token: process.env.META_SYSTEM_USER_TOKEN ?? "",
    graphVersion: graphVersion(),
  });

  console.info("sync:", JSON.stringify(counts));

  const { data: linhas } = await db
    .from("meta_templates")
    .select("name, language, status, category, parameter_format, contract_hash")
    .eq("organization_id", sessao.organization_id)
    .order("name");

  console.info(`\nespelho local — ${linhas?.length ?? 0} linhas:`);
  for (const l of linhas ?? []) {
    console.info(
      `  ${String(l.status).padEnd(10)} ${String(l.category ?? "-").padEnd(10)} ` +
        `${String(l.name).padEnd(38)} ${l.language}  ${String(l.parameter_format).padEnd(10)} ` +
        `hash=${String(l.contract_hash).slice(0, 12)}`,
    );
  }

}

void main();
