import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { randomUUID } from "node:crypto";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { extractBearer } from "@/lib/mcp/auth";
import {
  AJUSTES_DE_ESTILO,
  ajusteDaChavePersistida,
  chavePersistidaDoAjuste,
} from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const corpoDoPut = z
  .object({
    ajuste: z.enum(AJUSTES_DE_ESTILO),
    enabled: z.boolean(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  // Quem chama, pelo portão que o trouxe. Sem Bearer, a sessão segue como era
  // (client de sessão, RLS, `podeEditar` pelo papel). Com Bearer, o cliente é o
  // admin e o filtro de organização abaixo, vindo da linha do token, é a barreira.
  let org: { orgId: string };
  let podeEditar: boolean;
  let db: SupabaseClient;
  if (extractBearer(req.headers.get("authorization"))) {
    const requestId = randomUUID();
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "ai_style_adjustments",
      role: "manager",
      scope: "config:read",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "ai_style_adjustments", requestId);
    if (teto) return teto;
    org = { orgId: authz.organizationId };
    // O token só entra com papel admin (`tokenRole`): pode editar.
    podeEditar = true;
    db = authz.supabase;
  } else {
    const authz = await requireRole("manager", { resource: "ai_style_adjustments" });
    if (!authz.ok) return authz.response;
    org = { orgId: authz.org.orgId };
    podeEditar = roleAtLeast(authz.org.role, "admin");
    db = await createClient();
  }

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
    podeEditar,
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  // Quem chama, pelo portão que o trouxe. Sem Bearer, a sessão segue como era.
  let quem: {
    idioma: Idioma;
    org: { orgId: string };
    autor: string | null;
    apiTokenId: string | null;
    obterDb: () => Promise<SupabaseClient>;
  };
  if (extractBearer(req.headers.get("authorization"))) {
    const requestId = randomUUID();
    const authz = await resolveAuthDual(req, {
      requestId,
      resource: "ai_style_adjustments",
      role: "admin",
      scope: "config:write",
      tokenRole: "admin",
    });
    if (!authz.ok) return authz.response;
    const teto = await tetoDeEscritaDoToken(authz, "ai_style_adjustments", requestId);
    if (teto) return teto;
    quem = {
      idioma: authz.idioma ?? IDIOMA_PADRAO,
      org: { orgId: authz.organizationId },
      autor: authz.actor.type === "user" ? authz.actor.id : null,
      apiTokenId: authz.apiTokenId ?? null,
      obterDb: async () => authz.supabase,
    };
  } else {
    const authz = await requireRole("admin", { resource: "ai_style_adjustments" });
    if (!authz.ok) return authz.response;
    quem = {
      idioma: authz.user.idioma,
      org: { orgId: authz.org.orgId },
      autor: authz.user.id,
      apiTokenId: null,
      obterDb: () => createClient(),
    };
  }
  const t = (texto: string) => traduzir(texto, quem.idioma);
  const org = quem.org;

  const parsed = corpoDoPut.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { details: parsed.error.issues });
  }

  const db = await quem.obterDb();
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
    actorUserId: quem.autor,
    actorApiTokenId: quem.apiTokenId,
    resourceType: "org_guardrail_layers",
    resourceId: null,
    metadata: { ajuste: parsed.data.ajuste, enabled: parsed.data.enabled },
  });

  return ok({ ajuste: parsed.data.ajuste, enabled: gravado.enabled === true });
}
