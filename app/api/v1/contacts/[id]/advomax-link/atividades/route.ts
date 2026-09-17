import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  processo_codigo: z.number().int().positive(),
  titulo: z.string().trim().min(1).max(255),
  descricao: z.string().trim().max(5000).optional(),
  data_limite: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/).optional(),
  data_fatal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  chave_idempotencia: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
}).strict();

interface RouteCtx { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_activity_create" });
  if (!authz.ok) return authz.response;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Dados da atividade inválidos.", 422, { requestId });
  const { id } = await ctx.params;
  const supabase = await createClient();
  const { data: contact, error: contactError } = await supabase.from("contacts")
    .select("id").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (contactError) return fail("internal_error", "Não foi possível validar o contato.", 500, { requestId });
  if (!contact) return fail("not_found", "Contato não encontrado.", 404, { requestId });
  const { data: link, error: linkError } = await supabase.from("advomax_contact_links" as never)
    .select("pessoa_codigo,status").eq("organization_id", authz.org.orgId).eq("contact_id", id).maybeSingle();
  if (linkError) return fail("internal_error", "Não foi possível validar o vínculo jurídico.", 500, { requestId });
  const pessoa = link as { pessoa_codigo: number; status: string } | null;
  if (!pessoa || pessoa.status !== "linked") return fail("conflict", "Vincule a Pessoa antes de criar uma atividade.", 409, { requestId });
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    return fail("integration_unavailable", "A integração com o Advomax não está disponível.", 503, { requestId });
  }

  const { chave_idempotencia, processo_codigo, ...atividade } = parsed.data;
  const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/integracoes/crm/pessoas/${pessoa.pessoa_codigo}/processos/${processo_codigo}/atividades`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
      "X-CRM-Organization-Id": authz.org.orgId,
      "X-CRM-User-Email": authz.user.email,
      "X-CRM-Idempotency-Key": chave_idempotencia,
    },
    body: JSON.stringify(atividade),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!response) return fail("bad_gateway", "Não foi possível confirmar a atividade no Advomax. Tente novamente com a mesma solicitação.", 502, { requestId });
  if (response.status === 409) return fail("conflict", "A solicitação conflita com uma atividade anterior ou o processo foi encerrado.", 409, { requestId });
  if (!response.ok) return fail("bad_gateway", "O Advomax não confirmou a atividade.", 502, { requestId });
  const receipt = await response.json().catch(() => null);
  if (!receipt || !Number.isSafeInteger(receipt.codigo) || receipt.codigo <= 0) {
    return fail("bad_gateway", "O Advomax não devolveu um recibo válido.", 502, { requestId });
  }
  await audit({ action: "contact.advomax_activity_created", actorUserId: authz.user.id,
    organizationId: authz.org.orgId, resourceType: "advomax_activity", requestId,
    metadata: { contact_id: id, pessoa_codigo: pessoa.pessoa_codigo, processo_codigo, atividade_codigo: receipt.codigo } });
  return ok({ codigo: receipt.codigo, idempotente: receipt.idempotente === true }, { status: response.status === 201 ? 201 : 200, requestId });
}
