/** GET /api/v1/contacts/[id]/advomax-link/processos. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth/require-role";
import { fail, ok } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }
const processoSchema = z.object({
  codigo: z.number().int().positive(), pasta: z.string().nullable(), numero: z.string().nullable(),
  status: z.number().int(), ultimaMovimentacao: z.string().nullable(), tribunal: z.string().nullable(),
  tipoAcaoCodigo: z.number().int().positive().nullable(), tipoAcaoNome: z.string().nullable(),
}).strip();

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_process_summary" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: link, error: linkError } = await supabase
    .from("advomax_contact_links" as never)
    .select("pessoa_codigo,status")
    .eq("organization_id", authz.org.orgId)
    .eq("contact_id", id)
    .maybeSingle();
  if (linkError) return fail("internal_error", "Não foi possível consultar o vínculo.", 500, { requestId });
  const typedLink = link as { pessoa_codigo: number; status: string } | null;
  if (!typedLink || typedLink.status !== "linked") {
    return fail("conflict", "Vincule e confirme o cadastro jurídico antes de consultar processos.", 409, { requestId });
  }
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return fail("integration_unavailable", "A integração com o Advomax não está configurada.", 503, { requestId });
  }
  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas/${typedLink.pessoa_codigo}/processos`, {
    headers: {
      "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-User-Email": authz.user.email,
      "X-CRM-Organization-Id": authz.org.orgId,
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) return fail("bad_gateway", "Não foi possível consultar os processos no Advomax.", 502, { requestId });
  const body = z.array(processoSchema).safeParse(await response.json().catch(() => null));
  if (!body.success) return fail("bad_gateway", "O Advomax devolveu um resumo inválido.", 502, { requestId });
  return ok(body.data, { requestId });
}
