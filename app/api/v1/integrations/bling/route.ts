import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  atualizarFeaturesBling,
  buscarLogsRecentesBling,
  desconectarBling,
  obterConfiguracaoBling,
  salvarCredenciaisBling,
} from "@/lib/integrations/bling/store";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  clientId: z.string().min(1, "Client ID é obrigatório"),
  clientSecret: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresIn: z.number().optional(),
});

const patchSchema = z.object({
  is_enabled: z.boolean().optional(),
  features: z
    .object({
      sync_contacts: z.boolean().optional(),
      sync_products: z.boolean().optional(),
      ai_stock_consult: z.boolean().optional(),
      auto_create_order: z.boolean().optional(),
      invoice_emission: z.boolean().optional(),
      tracking_notifications: z.boolean().optional(),
      financial_bills: z.boolean().optional(),
      ai_fiscal_agent: z.boolean().optional(),
    })
    .optional(),
});

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const config = await obterConfiguracaoBling(admin, orgId);
  const logs = await buscarLogsRecentesBling(admin, orgId, 15);

  return ok({ config, logs }, { requestId });
}

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const body = await req.json().catch(() => null);
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_input", "Dados de credenciais inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const resultado = await salvarCredenciaisBling(admin, orgId, parsed.data);
  if (!resultado.ok) {
    return fail("database_error", resultado.error || "Falha ao salvar credenciais do Bling", 500, {
      requestId,
    });
  }

  audit({
    action: "bling.updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "bling_integration",
    resourceId: orgId,
    requestId,
    metadata: { clientId: parsed.data.clientId },
  });

  const config = await obterConfiguracaoBling(admin, orgId);
  return ok({ success: true, config }, { requestId });
}

export async function PATCH(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_input", "Parâmetros de configuração inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const resultado = await atualizarFeaturesBling(admin, orgId, parsed.data);
  if (!resultado.ok) {
    return fail("database_error", resultado.error || "Falha ao atualizar opções do Bling", 500, {
      requestId,
    });
  }

  audit({
    action: "bling.updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "bling_integration",
    resourceId: orgId,
    requestId,
    metadata: { changes: parsed.data as Record<string, unknown> },
  });

  const config = await obterConfiguracaoBling(admin, orgId);
  return ok({ success: true, config }, { requestId });
}

export async function DELETE(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "bling_integration" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const resultado = await desconectarBling(admin, orgId);
  if (!resultado.ok) {
    return fail("database_error", resultado.error || "Falha ao desconectar Bling", 500, {
      requestId,
    });
  }

  audit({
    action: "bling.disconnected",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "bling_integration",
    resourceId: orgId,
    requestId,
  });

  return ok({ success: true }, { requestId });
}
