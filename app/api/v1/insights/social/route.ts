import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { consultarInsightsSocial } from "@/lib/social-insights/meta-client";
import type { SocialPlatformFilter } from "@/lib/social-insights/types";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  platform: z.enum(["all", "facebook", "instagram"]).default("all"),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "social_insights" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    platform: url.searchParams.get("platform") ?? "all",
    de: url.searchParams.get("de") ?? undefined,
    ate: url.searchParams.get("ate") ?? undefined,
  });

  if (!parsed.success) {
    return fail("invalid_input", "Parâmetros de consulta inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const hoje = new Date();
  const padraoAte = hoje.toISOString().slice(0, 10);
  const dataDe = new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000);
  const padraoDe = dataDe.toISOString().slice(0, 10);

  const de = parsed.data.de ?? padraoDe;
  const ate = parsed.data.ate ?? padraoAte;
  const platform = parsed.data.platform as SocialPlatformFilter;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const resultado = await consultarInsightsSocial(admin, orgId, platform, de, ate);

  return ok(resultado, { requestId });
}
