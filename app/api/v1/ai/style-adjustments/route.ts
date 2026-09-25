import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import {
  AJUSTES_DE_ESTILO,
  ajusteDaChavePersistida,
  chavePersistidaDoAjuste,
} from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoDoPut = z
  .object({
    ajuste: z.enum(AJUSTES_DE_ESTILO),
    enabled: z.boolean(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const authz = await requireRole("manager", { resource: "ai_style_adjustments" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const db = await createClient();
  const layers = AJUSTES_DE_ESTILO.map(chavePersistidaDoAjuste);
  const { data, error } = await db
    .from("org_guardrail_layers")
    .select("layer, enabled")
    .eq("organization_id", org.orgId)
    .in("layer", layers);

  if (error) return fail("read_failed", error.message, 500);

  const escolhas = new Map(
    (data ?? []).flatMap((row) => {
      const ajuste = ajusteDaChavePersistida(row.layer as string);
      return ajuste === null ? [] : [[ajuste, row.enabled === true] as const];
    }),
  );

  return ok({
    ajustes: AJUSTES_DE_ESTILO.map((ajuste) => ({
      ajuste,
      enabled: escolhas.get(ajuste) ?? false,
    })),
    podeEditar: roleAtLeast(org.role, "admin"),
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("admin", { resource: "ai_style_adjustments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }

  const db = await createClient();
  const layer = chavePersistidaDoAjuste(parsed.data.ajuste);
  const { data: gravado, error } = await db
    .from("org_guardrail_layers")
    .upsert(
      {
        organization_id: org.orgId,
        layer,
        enabled: parsed.data.enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,layer" },
    )
    .select("layer, enabled")
    .maybeSingle();

  if (error) return fail("save_failed", error.message, 500);
  if (!gravado) {
    return fail("save_failed", t("nada foi gravado — verifique as permissões da organização"), 500);
  }

  void audit({
    action: "ai.style_adjustment_changed",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "org_guardrail_layers",
    resourceId: null,
    metadata: { ajuste: parsed.data.ajuste, enabled: parsed.data.enabled },
  });

  return ok({ ajuste: parsed.data.ajuste, enabled: gravado.enabled === true });
}
