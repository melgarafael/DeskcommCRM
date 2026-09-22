/**
 * GET  /api/v1/fiscal-settings — a config fiscal da org (ou null).
 * PUT  /api/v1/fiscal-settings — grava a config (upsert por org).
 *
 * Leitura `viewer`, escrita `manager`: série e CFOP errados geram nota
 * inválida para a empresa inteira.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { configFiscalSchema } from "@/lib/schemas/fiscal";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const COLUNAS =
  "serie, natureza_operacao, cfop_padrao, emitente_documento, ie, crt, logradouro, " +
  "numero_end, bairro, municipio, codigo_municipio, uf, cep, ambiente, provedor, " +
  "certificado_path, updated_at";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "fiscal_settings" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_settings")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao ler a configuração.", 500, { requestId });
  return ok(data ?? null, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "fiscal_settings" });
  if (!authz.ok) return authz.response;

  const parsed = configFiscalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // A senha do certificado nunca grava em plaintext: cifra com a infra
  // compartilhada (mesma dos webhooks/Meta) ou 422 explicando. String vazia
  // ou ausente = mantém a que já está (não zera sem querer).
  const { certificado_senha, ...resto } = parsed.data;
  let senhaCifrada: string | undefined;
  if (certificado_senha !== undefined && certificado_senha !== null && certificado_senha !== "") {
    const admin = createAdminClient();
    const enc = await encryptWebhookSecret(admin, certificado_senha);
    if (enc === null) {
      return fail(
        "validation_failed",
        "Cifra indisponível (chave de criptografia ausente no servidor).",
        422,
        { requestId },
      );
    }
    senhaCifrada = enc;
  }

  const { data, error } = await supabase
    .from("fiscal_settings")
    .upsert(
      {
        organization_id: authz.org.orgId,
        ...resto,
        ...(senhaCifrada !== undefined ? { certificado_senha_encrypted: senhaCifrada } : {}),
      },
      { onConflict: "organization_id" },
    )
    .select(COLUNAS)
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao salvar a configuração.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal_settings.updated",
    resourceType: "fiscal_settings",
    resourceId: authz.org.orgId,
    requestId,
  });

  return ok(data, { requestId });
}
