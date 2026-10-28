/** Ação real + banco local + receiver HTTP. Não é prova de cron/fila/caixa postal. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "../../lib/database.types";
import { destinoEhLocal } from "../lib/env-de-teste";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const receiver = process.env.RESEND_BASE_URL ?? "";
  if (!url || !key || !receiver || !destinoEhLocal(url) || !destinoEhLocal(receiver)) {
    throw new Error("ambiente_local_ausente");
  }
  const sdk = await import("resend");
  if (new sdk.Resend("re_somente_sonda_local").baseUrl !== receiver) {
    throw new Error("sdk_fora_do_receiver");
  }
  // Sem fallback de arquivo: o processo recebe somente o ambiente sintético doCI.
  const db = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  await import("../../lib/automation/actions/send-email");
  const { getAction } = await import("../../lib/automation/actions");
  const action = getAction("send_email");
  if (!action) throw new Error("acao_nao_carregada");
  if (process.argv.includes("--conferir-loader")) {
    process.stdout.write(JSON.stringify({ ok: true, loader: true }) + "\n");
    return;
  }

  const raw = readFileSync(0, "utf8");
  if (raw.length > 4_096) throw new Error("entrada_grande");
  const input = JSON.parse(raw) as {
    organization_id?: unknown;
    recipient?: unknown;
    subject?: unknown;
  };
  if (
    typeof input.organization_id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.organization_id) ||
    typeof input.recipient !== "string" ||
    !/^prova-[a-f0-9-]+@destino\.email-e2e\.invalid$/.test(input.recipient) ||
    typeof input.subject !== "string" ||
    !/^prova-email-[a-f0-9-]+$/.test(input.subject)
  )
    throw new Error("entrada_fora_da_fixture");

  const org = await db
    .from("organizations")
    .select("slug")
    .eq("id", input.organization_id)
    .single();
  if (org.error || !org.data.slug.startsWith("e2e-email-resend-")) {
    throw new Error("organizacao_fora_da_fixture");
  }
  const result = await action.execute(
    {
      admin: db,
      organizationId: input.organization_id,
      ruleId: randomUUID(),
      ruleName: "Prova sintética do e-mail",
      requestId: randomUUID(),
      context: {},
      event: {
        id: randomUUID(),
        organization_id: input.organization_id,
        event_type: "lead.created",
        entity_kind: "crm_lead",
        entity_id: null,
        payload: {},
        metadata: {},
        consumed_by: [],
        attempts: 0,
      },
    },
    {
      destinatario: "fixo",
      email_fixo: input.recipient,
      assunto: input.subject,
      corpo: "Prova sintética da ação de e-mail.",
      formato: "texto",
    },
  );
  // A mensagem técnica do provedor nunca cruza o stdout/stderr do runner.
  process.stdout.write(
    JSON.stringify({
      ok: result.status === "success",
      status: result.status,
      error: result.error ?? null,
      email_id: result.detail?.email_id ?? null,
      via: result.detail?.via ?? null,
    }) + "\n",
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, status: "runner_failed" }) + "\n");
  process.exitCode = 1;
});
